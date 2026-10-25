import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import {
  ArrowUp,
  AtSign,
  Check,
  ClipboardList,
  Clock,
  CodeXml,
  File,
  Folder,
  Image,
  Plus,
  ShieldCheck,
  Square,
  SquareSlash,
  X,
} from 'lucide-react';
import type { Command, Effort, Meta, Mode, Model, Session } from '../../../shared/protocol';
import { api } from '../api/client';
import './components.css';
import { UsageIndicator } from './Usage';

export interface ComposerProps {
  session: Session;
  meta: Meta;
  send: (text: string, imageIds?: string[]) => boolean | void;
  action: (type: string, data?: Record<string, any>) => void;
  onError: (message: string) => void;
}
interface Attachment {
  key: string;
  preview: string;
  id?: string;
}
interface Completion {
  kind: 'command' | 'file';
  query: string;
  start: number;
  end: number;
}
const efforts: { value: Effort; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最高' },
];
const modes = [
  {
    value: 'default' as Mode,
    label: '编辑前询问',
    description: '改文件或执行命令前都会询问',
    icon: ShieldCheck,
  },
  {
    value: 'acceptEdits' as Mode,
    label: '自动编辑',
    description: '改文件不再询问，执行命令仍会询问',
    icon: CodeXml,
  },
  {
    value: 'plan' as Mode,
    label: '计划模式',
    description: '只读分析，先给方案，不做改动',
    icon: ClipboardList,
  },
];

function Highlight({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query) return <>{text}</>;
  if (index < 0) {
    let at = 0;
    const positions = new Set<number>();
    for (let i = 0; i < text.length && at < query.length; i++)
      if (text[i].toLowerCase() === query[at].toLowerCase()) {
        positions.add(i);
        at++;
      }
    return at === query.length ? (
      <>
        {Array.from(text).map((char, i) =>
          positions.has(i) ? (
            <span className="cc-match" key={i}>
              {char}
            </span>
          ) : (
            char
          ),
        )}
      </>
    ) : (
      <>{text}</>
    );
  }
  return (
    <>
      {text.slice(0, index)}
      <span className="cc-match">{text.slice(index, index + query.length)}</span>
      {text.slice(index + query.length)}
    </>
  );
}

function Info({
  children,
  text,
  className = '',
  interactive = true,
}: {
  children: ReactNode;
  text: string;
  className?: string;
  interactive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {interactive ? (
        <Popover.Trigger asChild>
          <button
            type="button"
            className={`cc-stat ${className}`}
            aria-label={text}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
          >
            {children}
          </button>
        </Popover.Trigger>
      ) : (
        <Popover.Anchor asChild>
          <span
            className={`cc-stat cc-stat-passive ${className}`}
            aria-label={text}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            {children}
          </span>
        </Popover.Anchor>
      )}
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="cc-tip"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {text}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Composer(props: ComposerProps) {
  return <SessionComposer key={props.session.sessionId} {...props} />;
}

function SessionComposer({ session, meta, send, action, onError }: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const alive = useRef(true);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 639px)').matches);
  const [now, setNow] = useState(Date.now());
  const [models, setModels] = useState<Model[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<'plus' | 'model' | 'mode' | null>(null);
  const [effortPending, setEffortPending] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const [selectedEffort, setSelectedEffort] = useState<Effort | undefined>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const currentModel = models.find((model) => model.value === (selectedModel ?? meta.model));
  const currentEffort = selectedEffort ?? meta.effort;
  const mode =
    modes.find((mode) => mode.value === (meta.permissionMode ?? session.permissionMode)) ?? modes[0];
  const ModeIcon = mode.icon;
  const currentEfforts = efforts.filter((effort) =>
    currentModel?.supportedEffortLevels?.includes(effort.value),
  );
  const commandQuery = completion?.kind === 'command' ? completion.query.toLowerCase() : '';
  const matches = commands
    .filter((command) => command.name.toLowerCase().includes(commandQuery))
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(commandQuery)) -
        Number(a.name.toLowerCase().startsWith(commandQuery)),
    );
  const options = completion?.kind === 'command' ? matches.map((command) => command.name) : paths;
  const hasInput = !!text.trim() || attachments.length > 0;
  const uploading = attachments.some((image) => !image.id);
  const stop = session.status === 'running' && !hasInput;
  const updateAttachments = (next: Attachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      attachmentsRef.current.forEach((image) => URL.revokeObjectURL(image.preview));
    };
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    const max = parseFloat(getComputedStyle(element).lineHeight) * (mobile ? 5 : 8) + 22;
    element.style.height = `${Math.min(element.scrollHeight, max)}px`;
  }, [text, mobile]);
  useEffect(() => {
    let cancelled = false;
    void api<Model[]>('/api/models')
      .then((value) => {
        if (!cancelled) setModels(value);
      })
      .catch(() => {});
    void api<Command[]>(`/api/commands?cwd=${encodeURIComponent(session.cwd)}`)
      .then((value) => {
        if (!cancelled) setCommands(value);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session.cwd, session.status, menu]);
  useEffect(() => {
    setActive(0);
    setPaths([]);
    if (completion?.kind !== 'file') return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ paths: string[] }>(
        `/api/fs/search?cwd=${encodeURIComponent(session.cwd)}&q=${encodeURIComponent(completion.query)}`,
        { signal: controller.signal },
      )
        .then((value) => {
          if (!controller.signal.aborted) setPaths(value.paths.slice(0, 50));
        })
        .catch((error) => {
          if (!controller.signal.aborted) onError(error instanceof Error ? error.message : String(error));
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [completion?.kind, completion?.query, session.cwd]);
  useEffect(() => {
    if (session.status === 'running') {
      setEffortPending(false);
      setSelectedEffort(undefined);
    }
  }, [session.status]);
  useEffect(() => {
    setSelectedModel(undefined);
  }, [meta.model]);
  useEffect(() => {
    setSelectedEffort(undefined);
  }, [meta.effort]);
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        menu ||
        completion ||
        session.status !== 'running'
      )
        return;
      const target = event.target as HTMLElement;
      if (target === textarea.current && (text.length > 0 || attachments.length > 0)) {
        event.stopPropagation();
        return;
      }
      if (target?.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return;
      event.preventDefault();
      event.stopPropagation();
      action('interrupt');
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [session.status, menu, completion, text, attachments.length, action]);

  const detectCompletion = (value: string, cursor: number) => {
    const prefix = value.slice(0, cursor);
    const file = /@([^\s@]*)$/.exec(prefix);
    const command = /^\/([^\s]*)$/.exec(prefix);
    if (file) setCompletion({ kind: 'file', query: file[1], start: cursor - file[0].length, end: cursor });
    else if (command) setCompletion({ kind: 'command', query: command[1], start: 0, end: cursor });
    else setCompletion(null);
  };
  const focus = () => textarea.current?.focus();
  const insertToken = (kind: Completion['kind']) => {
    const element = textarea.current;
    const start = kind === 'command' ? 0 : (element?.selectionStart ?? text.length);
    const end = kind === 'command' ? text.length : (element?.selectionEnd ?? start);
    const value = kind === 'command' ? '/' : '@';
    const next = text.slice(0, start) + value + text.slice(end);
    setText(next);
    setMenu(null);
    setCompletion({ kind, query: '', start, end: start + 1 });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + 1, start + 1);
    });
  };
  const choose = (value: string) => {
    if (!completion) return;
    const insertion = `${completion.kind === 'file' ? '@' : '/'}${value} `;
    const next = text.slice(0, completion.start) + insertion + text.slice(completion.end);
    const cursor = completion.start + insertion.length;
    setText(next);
    setCompletion(null);
    requestAnimationFrame(() => {
      focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  };
  const submit = () => {
    if (stop) {
      action('interrupt');
      return;
    }
    if (!hasInput || uploading) return;
    if (send(text, attachments.length ? attachments.map((image) => image.id!) : undefined) === false) return;
    attachments.forEach((image) => URL.revokeObjectURL(image.preview));
    setText('');
    updateAttachments([]);
    setCompletion(null);
    focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (completion) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setCompletion(null);
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) =>
          options.length
            ? (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
            : 0,
        );
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (options[active]) choose(options[active]);
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !mobile) {
      event.preventDefault();
      submit();
    }
  };
  const addImages = (files: FileList | globalThis.File[]) => {
    const images = Array.from(files).filter((file) =>
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type),
    );
    for (const image of images) {
      if (image.size > 5 * 1024 * 1024) {
        onError('图片不能超过 5 MB');
        continue;
      }
      if (attachmentsRef.current.length >= 5) {
        onError('一条消息最多 5 张图片');
        break;
      }
      const attachment = { key: crypto.randomUUID(), preview: URL.createObjectURL(image) };
      updateAttachments([...attachmentsRef.current, attachment]);
      const body = new FormData();
      body.append('file', image);
      void fetch('/api/uploads', { method: 'POST', body })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.message ?? data.error ?? response.statusText);
          if (typeof data.id !== 'string') throw new Error(response.statusText);
          if (alive.current)
            updateAttachments(
              attachmentsRef.current.map((item) =>
                item.key === attachment.key ? { ...item, id: data.id } : item,
              ),
            );
        })
        .catch((error) => {
          if (!alive.current) return;
          URL.revokeObjectURL(attachment.preview);
          updateAttachments(attachmentsRef.current.filter((item) => item.key !== attachment.key));
          onError(error instanceof Error ? error.message : String(error));
        });
    }
  };
  const closeFocus = (event: Event) => {
    event.preventDefault();
    requestAnimationFrame(focus);
  };
  const remaining = meta.cache
    ? meta.cache.refreshedAt + meta.cache.ttlSec * 1000 - Math.max(now, meta.cache.refreshedAt)
    : 0;
  const minutes = Math.ceil(remaining / 60000);
  const cacheTip =
    remaining > 0
      ? `提示缓存还剩 ${minutes} 分钟（${meta.cache?.ttlSec === 3600 ? '1 小时缓存' : '5 分钟缓存'}）。过期后，下一条消息要重新写入缓存，消耗的用量更多。`
      : '提示缓存已过期，下一条消息会重新写入缓存。';
  const compactTokens = (value: number) =>
    value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);

  return (
    <Popover.Root
      open={!!completion}
      onOpenChange={(open) => {
        if (!open) setCompletion(null);
      }}
    >
      <Popover.Anchor asChild>
        <div
          className={`cc-composer${dragging ? ' cc-dragging' : ''}`}
          onDragEnter={(event) => {
            if (Array.from(event.dataTransfer.types).includes('Files')) {
              event.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }
          }}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (--dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            addImages(event.dataTransfer.files);
          }}
        >
          <input
            type="file"
            ref={fileInput}
            hidden
            multiple
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(event) => {
              if (event.target.files) addImages(event.target.files);
              event.target.value = '';
            }}
          />
          {!!attachments.length && (
            <div className="cc-attachments">
              {attachments.map((image) => (
                <div className="cc-attachment" key={image.key}>
                  <a
                    href={image.id ? `/api/uploads/${encodeURIComponent(image.id)}` : image.preview}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img src={image.preview} alt="" />
                  </a>
                  <button
                    type="button"
                    className="cc-remove-image"
                    aria-label="删除图片"
                    onClick={() => {
                      URL.revokeObjectURL(image.preview);
                      updateAttachments(attachmentsRef.current.filter((item) => item.key !== image.key));
                    }}
                  >
                    <X size={12} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textarea}
            autoFocus
            className="cc-composer-input"
            rows={1}
            aria-label="输入消息"
            placeholder={mobile ? '输入消息' : '输入消息，/ 调用命令，@ 引用文件'}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              detectCompletion(event.target.value, event.target.selectionStart);
            }}
            onClick={(event) => detectCompletion(text, event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            role={completion ? 'combobox' : undefined}
            aria-autocomplete="list"
            aria-expanded={!!completion}
            aria-controls={completion ? listId : undefined}
            aria-activedescendant={completion && options[active] ? `${listId}-${active}` : undefined}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === 'file')
                .map((item) => item.getAsFile())
                .filter((file): file is globalThis.File => !!file);
              if (files.some((file) => file.type.startsWith('image/'))) {
                event.preventDefault();
                addImages(files);
              }
            }}
          />
          <div className="cc-composer-toolbar">
            <DropdownMenu.Root open={menu === 'plus'} onOpenChange={(open) => setMenu(open ? 'plus' : null)}>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="cc-icon" aria-label="添加图片或文件">
                  <Plus size={16} strokeWidth={1.75} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="cc-menu"
                  side="top"
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  onCloseAutoFocus={closeFocus}
                >
                  <DropdownMenu.Item className="cc-menu-item" onSelect={() => fileInput.current?.click()}>
                    <Image size={16} strokeWidth={1.75} />
                    <span>上传图片</span>
                    <span />
                    <span className="cc-menu-description">也可以直接粘贴或拖进输入框</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="cc-menu-item" onSelect={() => insertToken('file')}>
                    <AtSign size={16} strokeWidth={1.75} />
                    <span>引用文件</span>
                    <span className="cc-menu-hint">@</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button
              type="button"
              className="cc-icon cc-desktop"
              aria-label="命令"
              onClick={() => insertToken('command')}
            >
              <SquareSlash size={16} strokeWidth={1.75} />
            </button>
            {meta.cache && (
              <Info
                text={cacheTip}
                className={remaining <= 0 ? 'cc-expired' : remaining <= 300000 ? 'cc-warn' : ''}
              >
                <Clock size={16} strokeWidth={1.75} />
                <span>{remaining <= 0 ? '已过期' : remaining < 60000 ? '<1m' : `${minutes}m`}</span>
              </Info>
            )}
            {meta.context && meta.context.percentage >= 50 && (
              <span className="cc-desktop">
                <Info
                  interactive={false}
                  className={meta.context.percentage >= 80 ? 'cc-warn' : ''}
                  text={`上下文已用 ${Math.round(meta.context.percentage)}%（${compactTokens(meta.context.totalTokens)} / ${compactTokens(meta.context.maxTokens)}）`}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    aria-hidden="true"
                  >
                    <circle className="cc-ring-track" cx="12" cy="12" r="9" />
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      strokeDasharray={`${(Math.min(100, meta.context.percentage) / 100) * 56.55} 56.55`}
                      transform="rotate(-90 12 12)"
                    />
                  </svg>
                  <span>{Math.round(meta.context.percentage)}%</span>
                </Info>
              </span>
            )}
            <UsageIndicator location="toolbar" />
            <DropdownMenu.Root
              open={menu === 'model'}
              onOpenChange={(open) => setMenu(open ? 'model' : null)}
            >
              <DropdownMenu.Trigger asChild>
                <button type="button" className="cc-model-pill" aria-label="模型与思考强度">
                  <span className="cc-ellipsis">{currentModel?.displayName ?? meta.model ?? '模型'}</span>
                  {currentEfforts.length > 0 && currentEffort && (
                    <span className="cc-model-effort cc-desktop">
                      {efforts.find((effort) => effort.value === currentEffort)?.label}
                    </span>
                  )}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="cc-menu cc-model-menu"
                  side="top"
                  align="start"
                  sideOffset={8}
                  collisionPadding={12}
                  onCloseAutoFocus={closeFocus}
                >
                  <DropdownMenu.Label className="cc-menu-label">模型</DropdownMenu.Label>
                  <DropdownMenu.RadioGroup
                    value={selectedModel ?? meta.model}
                    onValueChange={(model) => {
                      setSelectedModel(model);
                      action('setModel', { model });
                    }}
                  >
                    {models.map((model) => (
                      <DropdownMenu.RadioItem
                        className="cc-menu-item"
                        value={model.value}
                        key={model.value}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <span />
                        <span>{model.displayName}</span>
                        <DropdownMenu.ItemIndicator>
                          <Check size={16} strokeWidth={1.75} />
                        </DropdownMenu.ItemIndicator>
                        <span className="cc-menu-description">{model.description}</span>
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                  {currentEfforts.length > 0 && (
                    <>
                      <DropdownMenu.Separator className="cc-menu-separator" />
                      <DropdownMenu.Label className="cc-menu-label">思考强度</DropdownMenu.Label>
                      <DropdownMenu.RadioGroup
                        className="cc-efforts"
                        value={currentEffort}
                        onValueChange={(effort) => {
                          setSelectedEffort(effort as Effort);
                          setEffortPending(true);
                          action('setEffort', { effort });
                        }}
                      >
                        {currentEfforts.map((effort) => (
                          <DropdownMenu.RadioItem
                            className="cc-effort"
                            key={effort.value}
                            value={effort.value}
                            onSelect={(event) => event.preventDefault()}
                          >
                            {effort.label}
                          </DropdownMenu.RadioItem>
                        ))}
                      </DropdownMenu.RadioGroup>
                    </>
                  )}
                  {effortPending && <div className="cc-next-turn">下一回合生效</div>}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <span className="cc-grow" />
            <DropdownMenu.Root open={menu === 'mode'} onOpenChange={(open) => setMenu(open ? 'mode' : null)}>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="cc-mode-button" aria-label={mode.label}>
                  <ModeIcon size={16} strokeWidth={1.75} />
                  <span className="cc-desktop">{mode.label}</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="cc-menu"
                  side="top"
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  onCloseAutoFocus={closeFocus}
                >
                  <DropdownMenu.RadioGroup
                    value={mode.value}
                    onValueChange={(value) => action('setMode', { mode: value })}
                  >
                    {modes.map((item) => (
                      <DropdownMenu.RadioItem key={item.value} className="cc-menu-item" value={item.value}>
                        <item.icon size={16} strokeWidth={1.75} />
                        <span>{item.label}</span>
                        <DropdownMenu.ItemIndicator>
                          <Check size={16} strokeWidth={1.75} />
                        </DropdownMenu.ItemIndicator>
                        <span className="cc-menu-description">{item.description}</span>
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <button
              type="button"
              className={`cc-send${stop ? ' cc-stop' : ''}`}
              disabled={!stop && (!hasInput || uploading)}
              aria-label={stop ? '停止' : '发送'}
              onClick={submit}
            >
              {stop ? (
                <Square size={16} strokeWidth={1.75} fill="currentColor" />
              ) : (
                <ArrowUp size={16} strokeWidth={1.75} />
              )}
            </button>
          </div>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="cc-menu cc-completion"
          data-cw-menu="open"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus();
          }}
          onInteractOutside={(event) => {
            if (event.target === textarea.current) event.preventDefault();
          }}
        >
          <div className="cc-completion-query">
            {completion?.kind === 'file' ? '@' : '/'}
            {completion?.query}
          </div>
          <div
            role="listbox"
            id={listId}
            aria-label={completion?.kind === 'file' ? '引用文件' : '命令'}
            className="cc-completion-list"
          >
            {completion?.kind === 'command'
              ? matches.length
                ? matches.map((command, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={active === index}
                      id={`${listId}-${index}`}
                      className={`cc-menu-item${active === index ? ' cc-highlighted' : ''}`}
                      key={command.name}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(command.name)}
                    >
                      <span />
                      <span>
                        <Highlight text={`/${command.name}`} query={completion.query} />
                      </span>
                      <span className="cc-menu-hint">{command.argumentHint}</span>
                      <span className="cc-menu-description">{command.description}</span>
                    </button>
                  ))
                : !commands.length && <div className="cc-menu-empty">发送第一条消息后可用</div>
              : paths.map((path, index) => {
                  const slash = path.replace(/\/$/, '').lastIndexOf('/') + 1;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={active === index}
                      id={`${listId}-${index}`}
                      className={`cc-menu-item${active === index ? ' cc-highlighted' : ''}`}
                      key={path}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(path)}
                    >
                      {path.endsWith('/') ? (
                        <Folder size={16} strokeWidth={1.75} />
                      ) : (
                        <File size={16} strokeWidth={1.75} />
                      )}
                      <span className="cc-ellipsis">
                        <span className="cc-muted">
                          <Highlight text={path.slice(0, slash)} query={completion?.query ?? ''} />
                        </span>
                        <Highlight text={path.slice(slash)} query={completion?.query ?? ''} />
                      </span>
                      <span />
                    </button>
                  );
                })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default Composer;
