import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Eye,
  FilePlus,
  FolderSearch,
  Globe,
  LoaderCircle,
  Pencil,
  Plug,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createTwoFilesPatch } from 'diff';
import type { Message, Pending, Status } from '../../../shared/protocol';
import { Code } from './Code';
import { DiffView, diffLines } from './DiffView';
import {
  blocksOf,
  duration,
  editsOf,
  envelope,
  imageSource,
  lineCount,
  roleOf,
  textOf,
  type Block,
} from './content';
import './components.css';

export interface MessagesProps {
  messages: Message[];
  pending: Pending[];
  status: Status;
  delta: string;
  onOpenFile: (path: string) => void;
  cwd?: string;
  onLoadEarlier?: () => void;
  hasEarlier?: boolean;
}
interface Tool {
  id: string;
  name: string;
  input: Block;
  result?: Block;
  data?: Block;
  started?: number;
  finished?: boolean;
}
type TextItem = { key: string; kind: 'text'; text: string };
type ThinkingItem = { key: string; kind: 'thinking'; text: string; ms?: number };
type Item =
  | TextItem
  | ThinkingItem
  | { key: string; kind: 'user'; blocks: Block[]; images: string[]; queued: boolean }
  | { key: string; kind: 'tool'; tool: Tool }
  | { key: string; kind: 'result'; message: Message };
interface Transcript {
  groups: Map<string, Item[]>;
  tools: Map<string, Tool>;
}

function transcript(messages: Message[]): Transcript {
  const groups = new Map<string, Item[]>();
  const tools = new Map<string, Tool>();
  const results: { block: Block; data: Block }[] = [];
  messages.forEach((raw, index) => {
    const message = envelope(raw);
    const parent = message.parent_tool_use_id ?? '';
    const items = groups.get(parent) ?? [];
    groups.set(parent, items);
    const key = String(message.uuid ?? message.id ?? `message-${index}`);
    const role = roleOf(message);
    const blocks = blocksOf(message);
    if (role === 'result') {
      items.push({ key, kind: 'result', message });
      items.forEach((item) => {
        if (item.kind === 'tool') item.tool.finished = true;
      });
    } else if (role === 'assistant') {
      blocks.forEach((block, at) => {
        const blockKey = `${key}-${at}`;
        if (block.type === 'text' && block.text)
          items.push({ key: blockKey, kind: 'text', text: block.text });
        else if (block.type === 'thinking')
          items.push({
            key: blockKey,
            kind: 'thinking',
            text: block.thinking ?? '',
            ms: block.duration_ms ?? message.thinking_duration_ms,
          });
        else if (block.type === 'tool_use' && block.name !== 'TodoWrite') {
          const tool: Tool = {
            id: block.id ?? blockKey,
            name: block.name,
            input: block.input ?? {},
            started: message.timestamp ? new Date(message.timestamp).getTime() : undefined,
          };
          tools.set(tool.id, tool);
          items.push({ key: blockKey, kind: 'tool', tool });
        }
      });
    } else if (role === 'user') {
      for (const block of blocks)
        if (block.type === 'tool_result')
          results.push({ block, data: message.tool_use_result ?? message.toolUseResult ?? {} });
      const visible = blocks.filter((block) => block.type === 'text' || block.type === 'image');
      const images = Array.isArray(message.imageIds)
        ? message.imageIds.map((id: string) => `/api/uploads/${encodeURIComponent(id)}`)
        : [];
      if (visible.length || images.length)
        items.push({
          key,
          kind: 'user',
          blocks: visible,
          images,
          queued: !!(message.queued || message.status === 'queued'),
        });
    }
  });
  for (const { block, data } of results) {
    const tool = tools.get(block.tool_use_id);
    if (tool) {
      tool.result = block;
      tool.data = data;
      tool.finished = true;
    }
  }
  return { groups, tools };
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="cc-prose">
      <ReactMarkdown
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children, node, ...props }) {
            const code = String(children);
            const language = /language-(\S+)/.exec(className ?? '')?.[1];
            const block =
              !!language || code.endsWith('\n') || node?.position?.start.line !== node?.position?.end.line;
            return block ? (
              <Code code={code.replace(/\n$/, '')} language={language} />
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a({ children, ...props }) {
            return (
              <a {...props} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Thinking({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="cc-thinking">
      <button
        type="button"
        className="cc-thinking-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={16} strokeWidth={1.75} /> : <ChevronRight size={16} strokeWidth={1.75} />}
        思考{item.ms != null ? ` · ${duration(item.ms)}` : ''}
      </button>
      {open && (
        <div className="cc-thinking-content" id={id}>
          {item.text}
        </div>
      )}
    </div>
  );
}

function Output({ text, error = false }: { text: string; error?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  return (
    <>
      <pre className="cc-tool-output">
        {(all || lines.length <= 40 ? lines : lines.slice(-40)).map((line, index) => (
          <Fragment key={index}>
            <span
              className={
                error && /error|fail|exception|stderr|错误|失败|^\s*at\s/i.test(line)
                  ? 'cc-danger'
                  : undefined
              }
            >
              {line}
            </span>
            {'\n'}
          </Fragment>
        ))}
      </pre>
      {!all && lines.length > 40 && (
        <button type="button" className="cc-show-all" onClick={() => setAll(true)}>
          显示全部 {lines.length} 行
        </button>
      )}
    </>
  );
}

const icons: Record<string, LucideIcon> = {
  Bash: Terminal,
  Read: Eye,
  Edit: Pencil,
  MultiEdit: Pencil,
  Write: FilePlus,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  Agent: Bot,
  Task: Bot,
  AskUserQuestion: CircleHelp,
};

function toolSummary(tool: Tool, cwd?: string): string {
  const input = tool.input;
  if (tool.name === 'Bash') return String(input.command ?? '').split('\n')[0];
  if (['Read', 'Edit', 'MultiEdit', 'Write'].includes(tool.name)) {
    const path = String(input.file_path ?? input.path ?? '');
    return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  }
  if (['Grep', 'Glob'].includes(tool.name)) return String(input.pattern ?? '');
  if (tool.name === 'WebFetch') return String(input.url ?? '').replace(/^https?:\/\//, '');
  if (tool.name === 'WebSearch') return String(input.query ?? '');
  if (tool.name === 'Agent' || tool.name === 'Task') return String(input.description ?? '');
  if (tool.name === 'AskUserQuestion') return String(input.questions?.[0]?.question ?? '');
  return JSON.stringify(input);
}

function ToolRow({
  tool,
  pending,
  status,
  groups,
  onOpenFile,
  cwd,
}: {
  tool: Tool;
  pending: Pending[];
  status: Status;
  groups: Transcript['groups'];
  onOpenFile: MessagesProps['onOpenFile'];
  cwd?: string;
}) {
  const output =
    textOf(tool.result?.content) || [tool.data?.stdout, tool.data?.stderr].filter(Boolean).join('\n');
  const denied = !!(
    tool.data?.denied ||
    tool.result?.denied ||
    /permission.*denied|user (?:denied|rejected)|tool use (?:was )?rejected|用户拒绝/i.test(output)
  );
  const error =
    !!(
      tool.result?.is_error ||
      tool.data?.error ||
      (tool.data?.exitCode != null && tool.data.exitCode !== 0)
    ) && !denied;
  const waiting = pending.some(
    (request) =>
      request.toolName === tool.name && JSON.stringify(request.input) === JSON.stringify(tool.input),
  );
  const running =
    !tool.result && !tool.finished && !waiting && (status === 'running' || status === 'waiting');
  const agent = tool.name === 'Agent' || tool.name === 'Task';
  const defaultOpen =
    error ||
    ['Edit', 'MultiEdit'].includes(tool.name) ||
    (tool.name === 'Write' && lineCount(String(tool.input.content ?? '')) <= 30) ||
    (agent && running);
  const [override, setOverride] = useState<{ error: boolean; running: boolean; open: boolean }>();
  const open = override?.error === error && override?.running === running ? override.open : defaultOpen;
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(Date.now());
  const id = useId();
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const ToolIcon = tool.name.startsWith('mcp__') ? Plug : (icons[tool.name] ?? Wrench);
  const name = tool.name.startsWith('mcp__') ? tool.name.slice(5).replace('__', ' · ') : tool.name;
  const input = tool.input;
  const data = tool.data ?? {};
  const count = (value: unknown, fallback: number) =>
    Array.isArray(value) ? value.length : typeof value === 'number' ? value : fallback;
  const edits = ['Edit', 'MultiEdit'].includes(tool.name) ? editsOf(input) : [];
  const changed = edits.flatMap((edit) => diffLines(createTwoFilesPatch('', '', edit.oldText, edit.newText)));
  const added = changed.filter((line) => line.kind === 'add').length;
  const deleted = changed.filter((line) => line.kind === 'del').length;
  let info = '';
  if (running) info = duration(now - (tool.started ?? mounted.current));
  else if (tool.name === 'Bash')
    info =
      error && (data.exitCode ?? data.exit_code) != null
        ? `退出码 ${data.exitCode ?? data.exit_code}`
        : (data.duration_ms ?? data.durationMs ?? tool.result?.duration_ms) != null
          ? duration(data.duration_ms ?? data.durationMs ?? tool.result?.duration_ms)
          : '';
  else if (tool.name === 'Read') info = `${data.file?.numLines ?? data.numLines ?? lineCount(output)} 行`;
  else if (tool.name === 'Write') info = `+${lineCount(String(input.content ?? ''))}`;
  else if (tool.name === 'Grep' && tool.result)
    info = `${count(data.numMatches ?? data.matches, lineCount(output))} 处`;
  else if (tool.name === 'Glob' && tool.result)
    info = `${count(data.numFiles ?? data.filenames ?? data.files, lineCount(output))} 个文件`;
  else if (tool.name === 'WebSearch' && tool.result) info = `${count(data.results, 0)} 条结果`;
  const expandable = tool.name !== 'Read';
  const children = groups.get(tool.id) ?? [];
  return (
    <div className={`cc-tool${error ? ' cc-tool-error' : ''}${agent ? ' cc-agent' : ''}`}>
      <button
        type="button"
        className="cc-tool-head"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? id : undefined}
        onClick={() =>
          expandable
            ? setOverride({ error, running, open: !open })
            : onOpenFile(input.file_path ?? input.path ?? '')
        }
      >
        {expandable &&
          (open ? (
            <ChevronDown size={14} strokeWidth={1.75} className="cc-muted" />
          ) : (
            <ChevronRight size={14} strokeWidth={1.75} className="cc-muted" />
          ))}
        {running ? (
          <LoaderCircle size={16} strokeWidth={1.75} className="cc-spin cc-accent" />
        ) : (
          <ToolIcon size={16} strokeWidth={1.75} className="cc-muted" />
        )}
        <span className="cc-tool-name">{name}</span>
        <span className={`cc-tool-summary cc-ellipsis${denied ? ' cc-strike' : ''}`}>
          {toolSummary(tool, cwd)}
        </span>
        {waiting ? (
          <span className="cc-waiting-tag">待确认</span>
        ) : denied ? (
          <>
            <span className="cc-tool-info">已拒绝</span>
            <Ban size={14} strokeWidth={1.75} className="cc-muted" />
          </>
        ) : (
          <>
            {!!edits.length && !running && (
              <>
                <span className="cc-add-count">+{added}</span>
                <span className="cc-del-count">−{deleted}</span>
              </>
            )}
            <span className="cc-tool-info">{info}</span>
            {!running &&
              (error ? (
                <X size={14} strokeWidth={1.75} className="cc-danger" />
              ) : (
                <Check size={14} strokeWidth={1.75} className="cc-success" />
              ))}
          </>
        )}
      </button>
      {expandable && open && (
        <div className="cc-tool-body" id={id}>
          {edits.length ? (
            edits.map((edit, index) => <DiffView key={index} {...edit} />)
          ) : tool.name === 'Write' ? (
            <DiffView newText={String(input.content ?? '')} />
          ) : agent ? (
            <div className="cc-agent-nested">
              {children.length ? (
                <ItemList
                  items={children}
                  pending={pending}
                  status={status}
                  groups={groups}
                  onOpenFile={onOpenFile}
                  cwd={cwd}
                />
              ) : (
                <Output text={output || String(input.prompt ?? '')} />
              )}
            </div>
          ) : tool.name === 'WebSearch' && Array.isArray(data.results) ? (
            <div className="cc-search-results">
              {data.results.map((result: Block, index: number) =>
                /^https?:\/\//.test(result.url ?? '') ? (
                  <a href={result.url} key={index} target="_blank" rel="noreferrer">
                    {result.title ?? result.url}
                  </a>
                ) : (
                  <span key={index}>{result.title ?? textOf(result)}</span>
                ),
              )}
            </div>
          ) : tool.name === 'AskUserQuestion' ? (
            <div className="cc-question-history">
              {(input.questions ?? []).map((question: Block, index: number) => (
                <div key={index}>
                  <b>{question.question}</b>
                  <p>{input.answers?.[question.question] ?? data.answers?.[question.question] ?? ''}</p>
                </div>
              ))}
              {output && <Output text={output} />}
            </div>
          ) : (
            <Output
              text={
                ['Bash', 'Grep', 'Glob', 'WebFetch'].includes(tool.name)
                  ? output
                  : `${textOf(input)}${output ? `\n\n${output}` : ''}`
              }
              error={error}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Result({ message }: { message: Message }) {
  const interrupted =
    message.subtype === 'interrupted' ||
    message.interrupted ||
    message.is_interrupted ||
    message.stop_reason === 'interrupt';
  const error = !interrupted && (message.is_error || (message.subtype && message.subtype !== 'success'));
  return (
    <div className={`cc-result${error ? ' cc-danger' : ''}`}>
      {interrupted
        ? '已中断'
        : error
          ? `出错：${message.subtype ?? message.error?.type ?? 'error'}`
          : `完成 · ${duration(message.duration_ms ?? 0)} · ${message.num_turns ?? 0} 轮`}
    </div>
  );
}

function ItemList({
  items,
  ...props
}: {
  items: Item[];
  pending: Pending[];
  status: Status;
  groups: Transcript['groups'];
  onOpenFile: MessagesProps['onOpenFile'];
  cwd?: string;
}) {
  return (
    <>
      {items.map((item, index) => {
        if (item.kind === 'tool') {
          if (index > 0 && items[index - 1].kind === 'tool') return null;
          const tools: Extract<Item, { kind: 'tool' }>[] = [];
          for (let at = index; at < items.length && items[at].kind === 'tool'; at++)
            tools.push(items[at] as Extract<Item, { kind: 'tool' }>);
          return (
            <div className="cc-tools" key={item.key}>
              {tools.map((entry) => (
                <ToolRow tool={entry.tool} key={entry.tool.id} {...props} />
              ))}
            </div>
          );
        }
        if (item.kind === 'text') return <Markdown key={item.key} text={item.text} />;
        if (item.kind === 'thinking') return <Thinking key={item.key} item={item} />;
        if (item.kind === 'result') return <Result key={item.key} message={item.message} />;
        const images = [
          ...item.images,
          ...item.blocks
            .filter((block) => block.type === 'image')
            .map(imageSource)
            .filter((value): value is string => !!value),
        ];
        return (
          <div className="cc-user-wrap" key={item.key}>
            <div className="cc-user-message">
              {images.length > 0 && (
                <div className="cc-user-images">
                  {images.map((src, index) => (
                    <a href={src} key={index} target="_blank" rel="noreferrer">
                      <img src={src} alt="" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
              {item.blocks
                .filter((block) => block.type === 'text')
                .map((block, index) => (
                  <div className="cc-user-text" key={index}>
                    {block.text}
                  </div>
                ))}
            </div>
            {item.queued && <div className="cc-queued">排队中</div>}
          </div>
        );
      })}
    </>
  );
}

export function Messages({
  messages,
  pending,
  status,
  delta,
  onOpenFile,
  cwd,
  hasEarlier,
  onLoadEarlier,
}: MessagesProps) {
  const parsed = useMemo(() => transcript(messages), [messages]);
  const items = parsed.groups.get('') ?? [];
  const scroll = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const initialized = useRef(false);
  const [newContent, setNewContent] = useState(false);
  const [externalScroll, setExternalScroll] = useState(false);
  const contentVersion = `${messages.length}:${messages.at(-1)?.uuid ?? messages.at(-1)?.id ?? ''}:${delta}:${pending.length}`;
  const scrollHost = () => scroll.current?.parentElement?.closest<HTMLDivElement>('.chat') ?? scroll.current;
  const scrollToBottom = () => {
    const element = scrollHost();
    if (element) element.scrollTop = element.scrollHeight;
    atBottom.current = true;
    setNewContent(false);
  };
  useEffect(() => {
    const host = scrollHost();
    if (!host) return;
    setExternalScroll(host !== scroll.current);
    const update = () => {
      atBottom.current = host.scrollHeight - host.scrollTop - host.clientHeight <= 80;
      if (atBottom.current) setNewContent(false);
    };
    host.addEventListener('scroll', update);
    return () => host.removeEventListener('scroll', update);
  }, []);
  useEffect(() => {
    if (!initialized.current || atBottom.current) {
      initialized.current = true;
      scrollToBottom();
    } else setNewContent(true);
  }, [contentVersion]);
  useEffect(() => {
    const element = inner.current;
    if (!element) return;
    // Only async media sizing should follow the bottom; opening a tool never does.
    const loaded = () => {
      if (atBottom.current) scrollToBottom();
    };
    element.addEventListener('load', loaded, true);
    return () => element.removeEventListener('load', loaded, true);
  }, []);
  const latestUser = items.findLastIndex((item) => item.kind === 'user');
  const afterUser = items.slice(latestUser + 1);
  const thinking =
    status === 'running' &&
    !delta &&
    !pending.length &&
    !afterUser.some(
      (item) =>
        item.kind === 'text' || item.kind === 'thinking' || item.kind === 'tool' || item.kind === 'result',
    );
  return (
    <div className={`cc-messages-shell${externalScroll ? ' cc-external-scroll' : ''}`}>
      <div className="cc-messages" ref={scroll}>
        <div className="cc-messages-inner" ref={inner}>
          {hasEarlier && onLoadEarlier && (
            <button type="button" className="cc-load-earlier" onClick={onLoadEarlier}>
              加载更早的消息
            </button>
          )}
          <ItemList
            items={items}
            pending={pending}
            status={status}
            groups={parsed.groups}
            onOpenFile={onOpenFile}
            cwd={cwd}
          />
          {delta && <Markdown text={delta} />}
          {thinking && (
            <div className="cc-awaiting">
              <LoaderCircle size={16} strokeWidth={1.75} className="cc-spin" />
              思考中…
            </div>
          )}
        </div>
      </div>
      {newContent && !externalScroll && (
        <button type="button" className="cc-new-messages" onClick={scrollToBottom}>
          ↓ 新消息
        </button>
      )}
    </div>
  );
}

export default Messages;
