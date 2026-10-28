import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Folder, LoaderCircle, Plus, Terminal as TerminalIcon, X } from 'lucide-react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalFrame, TerminalInfo } from '../../../shared/terminal';
import { api } from '../api/client';
import { terminalClient } from '../api/terminal-client';
import './terminal.css';

export interface TerminalPanelProps {
  cwd: string;
  onError?: (message: string) => void;
}
interface ScreenControls {
  key(value: string): void;
  focus(): void;
}
const short = (cwd: string) => cwd.replace(/^\/root(?=\/|$)/, '~');
function storedSelection(cwd: string): string | undefined {
  try {
    return JSON.parse(localStorage.getItem('cw.terminal.selected') ?? '{}')[cwd];
  } catch {
    return;
  }
}
function saveSelection(cwd: string, id: string | undefined) {
  try {
    const value = JSON.parse(localStorage.getItem('cw.terminal.selected') ?? '{}');
    if (id) value[cwd] = id;
    else delete value[cwd];
    localStorage.setItem('cw.terminal.selected', JSON.stringify(value));
  } catch {
    /* Storage can be disabled. */
  }
}

const TerminalScreen = forwardRef<
  ScreenControls,
  {
    terminal: TerminalInfo;
    control: boolean;
    onControl: (value: boolean) => void;
    onReady: (value: boolean) => void;
    onSize: (size: { cols: number; rows: number }) => void;
    onError: (message: string) => void;
  }
>(({ terminal, control, onControl, onReady, onSize, onError }, ref) => {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Terminal | undefined>(undefined);
  const inputReady = useRef(false);
  const controlRef = useRef(control);
  controlRef.current = control;
  const callbacks = useRef({ onControl, onReady, onSize, onError });
  callbacks.current = { onControl, onReady, onSize, onError };
  useImperativeHandle(
    ref,
    () => ({
      focus: () => instance.current?.focus(),
      key: (value) => {
        const term = instance.current;
        if (!term || !inputReady.current) return;
        const arrow = term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
        const data: Record<string, string> = {
          Esc: '\x1b',
          Tab: '\t',
          Enter: '\r',
          '↑': `${arrow}A`,
          '↓': `${arrow}B`,
          '←': `${arrow}D`,
          '→': `${arrow}C`,
        };
        if (data[value]) {
          terminalClient.send({ type: 'terminal.input', terminalId: terminal.terminalId, data: data[value] });
          callbacks.current.onControl(false);
        }
        term.focus();
      },
    }),
    [terminal.terminalId],
  );

  useEffect(() => {
    const element = host.current!;
    let disposed = false;
    let epoch: string | undefined;
    let seq = 0;
    let generation = 0;
    let tail = Promise.resolve();
    let pendingBytes = 0;
    let catchingUp = false;
    let subscribed = false;
    let status = terminal.status;
    let sizeTimer: ReturnType<typeof setTimeout> | undefined;
    let requestedSize = '';
    const term = new Terminal({
      cols: terminal.cols,
      rows: terminal.rows,
      scrollback: 5000,
      cursorBlink: false,
      convertEol: false,
      disableStdin: true,
      allowProposedApi: true,
      linkHandler: { activate: () => {} },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    instance.current = term;
    const ready = (value: boolean) => {
      inputReady.current = value;
      term.options.disableStdin = !value;
      if (term.textarea) term.textarea.disabled = !value;
      callbacks.current.onReady(value);
    };
    ready(false);
    // Terminal output cannot modify the browser clipboard, including during replay.
    term.parser.registerOscHandler(52, () => true);
    // The authoritative headless screen replies once, independent of view count.
    for (const final of ['n', 'c', 't']) {
      term.parser.registerCsiHandler({ final }, () => true);
      for (const prefix of ['?', '>', '=']) term.parser.registerCsiHandler({ prefix, final }, () => true);
    }
    term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => true);
    term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true);
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
    const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
    function fitTerminal() {
      if (
        disposed ||
        !inputReady.current ||
        status !== 'running' ||
        !element.clientWidth ||
        !element.clientHeight
      )
        return;
      const size = fit.proposeDimensions();
      if (!size) return;
      const cols = Math.max(20, Math.min(500, size.cols)),
        rows = Math.max(5, Math.min(300, size.rows));
      const key = `${cols}:${rows}`;
      if (key === requestedSize || (cols === term.cols && rows === term.rows)) return;
      // The server orders resize with the output stream. Do not locally reflow early.
      if (terminalClient.send({ type: 'terminal.resize', terminalId: terminal.terminalId, cols, rows }))
        requestedSize = key;
    }
    const scheduleFit = () => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(fitTerminal, 80);
    };
    function theme() {
      const css = getComputedStyle(element);
      const token = (name: string) => css.getPropertyValue(name).trim();
      term.options.fontFamily = token('--ff-mono');
      term.options.fontSize = parseFloat(token('--fs-code')) || 12.5;
      const measure = document.createElement('canvas').getContext('2d');
      if (measure) {
        measure.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
        const metrics = measure.measureText('W');
        const natural = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
        term.options.lineHeight = Math.max(1, (parseFloat(token('--lh-code')) || 19) / (natural || 19));
      }
      const colors: ITheme = {
        background: token('--bg'),
        foreground: token('--fg'),
        cursor: token('--fg-3'),
        cursorAccent: token('--bg'),
        selectionBackground: token('--accent-soft'),
        selectionForeground: token('--fg'),
        black: token('--fg'),
        red: token('--danger'),
        green: token('--success'),
        yellow: token('--warn'),
        blue: token('--accent'),
        magenta: token('--accent'),
        cyan: token('--success'),
        white: token('--fg-2'),
        brightBlack: token('--fg-3'),
        brightRed: token('--danger'),
        brightGreen: token('--success'),
        brightYellow: token('--warn'),
        brightBlue: token('--accent'),
        brightMagenta: token('--accent'),
        brightCyan: token('--success'),
        brightWhite: token('--fg'),
      };
      term.options.theme = colors;
      scheduleFit();
    }
    theme();
    const themeObserver = new MutationObserver(theme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', theme);
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(element);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', scheduleFit);
    const copy = () => {
      const selection = term.getSelection();
      if (selection)
        void navigator.clipboard
          .writeText(selection)
          .catch((error) => callbacks.current.onError(String(error.message)));
    };
    const paste = () => {
      if (!inputReady.current) return;
      void navigator.clipboard
        .readText()
        .then((value) => {
          if (!disposed && inputReady.current) term.paste(value);
        })
        .catch((error) => callbacks.current.onError(String(error.message)));
    };
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        ['c', 'v'].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'c') copy();
        else paste();
        return false;
      }
      return true;
    });
    const dataListener = term.onData((data) => {
      if (!inputReady.current || status !== 'running') return;
      if (controlRef.current) {
        controlRef.current = false;
        callbacks.current.onControl(false);
        if (data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) data = String.fromCharCode(code & 31);
          else if (data === ' ') data = '\0';
          else if (data === '?') data = '\x7f';
        }
      }
      // Large clipboard payloads are split, never saved for a later connection.
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(data.length, offset + 8192);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
        if (
          !terminalClient.send({
            type: 'terminal.input',
            terminalId: terminal.terminalId,
            data: data.slice(offset, end),
          })
        ) {
          ready(false);
          break;
        }
        offset = end;
      }
    });
    function enqueue(action: () => void | Promise<void>, token = generation) {
      tail = tail
        .then(async () => {
          if (!disposed && token === generation) await action();
        })
        .catch((error) => {
          if (!disposed) {
            ready(false);
            callbacks.current.onError(String(error.message));
          }
        });
    }
    function resubscribe() {
      if (disposed || catchingUp) return;
      catchingUp = true;
      ready(false);
      generation++;
      if (subscribed) {
        terminalClient.unsubscribe(terminal.terminalId);
        subscribed = false;
      }
      void tail.then(() => {
        if (disposed) return;
        catchingUp = false;
        pendingBytes = 0;
        subscribed = true;
        terminalClient.subscribe(terminal.terminalId);
      });
    }
    const unlisten = terminalClient.listen((frame) => {
      if (!('terminalId' in frame) || frame.terminalId !== terminal.terminalId || disposed) return;
      if (frame.type === 'terminal.error') {
        ready(false);
        return;
      }
      if (frame.type === 'terminal.snapshot') {
        epoch = frame.epoch;
        seq = frame.seq;
        status = frame.status;
        requestedSize = '';
        generation++;
        ready(false);
        const snapshotGeneration = generation;
        enqueue(async () => {
          term.reset();
          term.resize(frame.cols, frame.rows);
          await write(frame.screen);
          if (disposed || snapshotGeneration !== generation) return;
          callbacks.current.onSize({ cols: term.cols, rows: term.rows });
          ready(status === 'running' && terminalClient.isConnected());
          scheduleFit();
          if (inputReady.current) term.focus();
        });
      } else if (frame.type === 'terminal.output' || frame.type === 'terminal.resized') {
        if (frame.epoch !== epoch || frame.seq <= seq || catchingUp) return;
        if (frame.seq !== seq + 1) {
          resubscribe();
          return;
        }
        seq = frame.seq;
        if (frame.type === 'terminal.resized')
          enqueue(() => {
            term.resize(frame.cols, frame.rows);
            callbacks.current.onSize({ cols: term.cols, rows: term.rows });
          });
        else {
          const length = frame.data.length;
          pendingBytes += length;
          if (pendingBytes > 2 * 1024 * 1024) {
            resubscribe();
            return;
          }
          enqueue(async () => {
            try {
              await write(frame.data);
            } finally {
              pendingBytes = Math.max(0, pendingBytes - length);
            }
          });
        }
      } else if (frame.type === 'terminal.exited') {
        status = 'exited';
        ready(false);
      }
    });
    const disconnect = terminalClient.onConnection((connected) => {
      ready(false);
      if (!connected) {
        generation++;
        requestedSize = '';
      }
    });
    subscribed = true;
    terminalClient.subscribe(terminal.terminalId);
    return () => {
      disposed = true;
      inputReady.current = false;
      generation++;
      clearTimeout(sizeTimer);
      unlisten();
      disconnect();
      if (subscribed) terminalClient.unsubscribe(terminal.terminalId);
      dataListener.dispose();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      media.removeEventListener('change', theme);
      viewport?.removeEventListener('resize', scheduleFit);
      term.dispose();
      instance.current = undefined;
    };
  }, [terminal.terminalId]);
  return (
    <div
      className="ct-screen"
      ref={host}
      data-terminal-focus="true"
      onKeyDown={(event) => event.stopPropagation()}
    />
  );
});

export function TerminalPanel(props: TerminalPanelProps) {
  return <ProjectTerminals key={props.cwd} {...props} />;
}
function ProjectTerminals({ cwd, onError = () => {} }: TerminalPanelProps) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () =>
      document.documentElement.style.setProperty(
        '--terminal-viewport-height',
        `${viewport?.height ?? innerHeight}px`,
      );
    resize();
    viewport?.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      document.documentElement.style.removeProperty('--terminal-viewport-height');
    };
  }, []);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [selected, setSelected] = useState<string | undefined>(() => storedSelection(cwd));
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [lost, setLost] = useState<TerminalInfo>();
  const [connected, setConnected] = useState(terminalClient.isConnected());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [closing, setClosing] = useState<string>();
  const closingRef = useRef(closing);
  closingRef.current = closing;
  const [ready, setReady] = useState(false);
  const [control, setControl] = useState(false);
  const [size, setSize] = useState({ cols: 80, rows: 24 });
  const controls = useRef<ScreenControls>(null);
  const generation = useRef(0);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  const active =
    terminals.find((term) => term.terminalId === selected) ??
    (lost?.terminalId === selected ? lost : undefined);
  const currentList = useRef(terminals);
  currentList.current = terminals;
  const applyList = useCallback(
    (list: TerminalInfo[]) => {
      setTerminals(list);
      setLoading(false);
      const id = selectedRef.current;
      if (id && list.some((term) => term.terminalId === id)) {
        setLost(undefined);
        return;
      }
      if (id === closingRef.current) {
        setClosing(undefined);
        setLost(undefined);
        setSelected(list[0]?.terminalId);
        return;
      }
      const old = currentList.current.find((term) => term.terminalId === id);
      if (old) {
        setLost({ ...old, status: 'exited' });
        return;
      }
      if (id && !list.length) {
        setLost({
          terminalId: id,
          epoch: '',
          cwd,
          name: '终端',
          cols: 80,
          rows: 24,
          status: 'exited',
          createdAt: 0,
        });
        return;
      }
      setSelected(list[0]?.terminalId);
      setLost(undefined);
    },
    [cwd],
  );
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const list = await api<TerminalInfo[]>(`/api/terminals?cwd=${encodeURIComponent(cwd)}`);
      if (version === generation.current) applyList(list);
    } catch (error) {
      if (version === generation.current) {
        setLoading(false);
        errorCallback.current((error as Error).message);
      }
    }
  }, [cwd, applyList]);
  useEffect(() => {
    const stop = terminalClient.listen((frame) => {
      if (frame.type === 'terminal.list' && frame.cwd === cwd) {
        generation.current++;
        applyList(frame.terminals);
      }
      if (frame.type === 'terminal.exited')
        setTerminals((list) =>
          list.map((term) =>
            term.terminalId === frame.terminalId
              ? { ...term, status: 'exited', exitCode: frame.exitCode, signal: frame.signal }
              : term,
          ),
        );
      if (frame.type === 'terminal.error') {
        if (frame.terminalId === closingRef.current) {
          setClosing(undefined);
          setBusy(false);
        }
        if (frame.terminalId === selectedRef.current && frame.code === 'TERMINAL_NOT_FOUND') void refresh();
      }
    });
    const disconnect = terminalClient.onConnection((value) => {
      setConnected(value);
      setReady(false);
      setControl(false);
      if (value) void refresh();
    });
    void refresh();
    return () => {
      generation.current++;
      stop();
      disconnect();
    };
  }, [cwd, applyList, refresh]);
  useEffect(() => {
    saveSelection(cwd, selected);
    setControl(false);
    setReady(false);
  }, [cwd, selected]);
  const create = async () => {
    if (busy || !connected) return;
    setBusy(true);
    try {
      const value = await api<{ terminalId: string }>('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ cwd, cols: size.cols, rows: size.rows }),
      });
      setLost(undefined);
      setSelected(value.terminalId);
      selectedRef.current = value.terminalId;
      await refresh();
    } catch (error) {
      errorCallback.current((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (!active || !connected) return;
    if (lost?.terminalId === active.terminalId) {
      setLost(undefined);
      setSelected(terminals[0]?.terminalId);
      setConfirm(false);
      return;
    }
    const id = active.terminalId;
    closingRef.current = id;
    setClosing(id);
    if (!terminalClient.send({ type: 'terminal.close', terminalId: id, requestId: crypto.randomUUID() })) {
      setClosing(undefined);
      errorCallback.current('连接已断开，正在重连…');
    }
    setConfirm(false);
  };
  const status =
    active?.status === 'exited' ? '已结束' : !connected ? '连接已断开' : ready ? '已连接' : '连接中';
  const displayed =
    lost && !terminals.some((term) => term.terminalId === lost.terminalId) ? [...terminals, lost] : terminals;
  return (
    <div className="ct-panel" data-terminal-focus="true">
      <div className="ct-toolbar">
        <div className="ct-tabs" role="tablist" aria-label="终端列表">
          {displayed.map((term) => (
            <button
              key={term.terminalId}
              role="tab"
              aria-selected={selected === term.terminalId}
              className={selected === term.terminalId ? 'ct-selected' : ''}
              onClick={() => {
                setSelected(term.terminalId);
                requestAnimationFrame(() => controls.current?.focus());
              }}
            >
              <TerminalIcon />
              <span>{term.name}</span>
              {term.status === 'exited' && <small>已结束</small>}
            </button>
          ))}
        </div>
        <div className="ct-actions">
          <button
            className="ct-icon"
            aria-label="新建终端"
            title="新建终端"
            disabled={!connected || busy}
            onClick={() => void create()}
          >
            <Plus />
          </button>
          <button
            className="ct-icon"
            aria-label="关闭终端"
            title="关闭终端"
            disabled={!active || !connected || !!closing}
            onClick={() => setConfirm(true)}
          >
            <X />
          </button>
        </div>
      </div>
      <div className="ct-directory">
        <Folder />
        <span>启动目录</span>
        <code title={cwd}>{short(cwd)}</code>
      </div>
      {!connected && (
        <div className="ct-connection" role="status">
          <LoaderCircle className="spin" />
          连接已断开，正在重连…
        </div>
      )}
      {loading && !active ? (
        <div className="ct-empty" aria-label="终端" role="status">
          <LoaderCircle className="spin" />
        </div>
      ) : active ? (
        <>
          {lost?.terminalId === active.terminalId ? (
            <div className="ct-screen ct-lost" />
          ) : (
            <TerminalScreen
              key={active.terminalId}
              ref={controls}
              terminal={active}
              control={control}
              onControl={setControl}
              onReady={setReady}
              onSize={setSize}
              onError={onError}
            />
          )}
          {active.status === 'exited' && (
            <div className="ct-exit">
              <span>终端已结束{active.exitCode !== undefined ? ` · 退出码 ${active.exitCode}` : ''}</span>
              <button
                className="btn btn-secondary"
                disabled={busy || !connected}
                onClick={() => void create()}
              >
                重新打开
              </button>
            </div>
          )}
          <div className="ct-aux">
            {['Ctrl', 'Esc', 'Tab', '↑', '↓', '←', '→', 'Enter'].map((key) => (
              <button
                key={key}
                aria-pressed={key === 'Ctrl' ? control : undefined}
                disabled={!ready || active.status !== 'running'}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (key === 'Ctrl') {
                    setControl((value) => !value);
                    controls.current?.focus();
                  } else controls.current?.key(key);
                }}
              >
                {key}
              </button>
            ))}
          </div>
          <footer className="ct-status">
            <span>
              <i className={`dot ${connected ? 'idle' : 'waiting'}`} />
              {status}
            </span>
            <span>
              {size.cols} × {size.rows}
            </span>
          </footer>
        </>
      ) : (
        <div className="ct-empty">
          <TerminalIcon />
          <strong>在项目中打开终端</strong>
          <code>{short(cwd)}</code>
          <button className="btn btn-primary" disabled={busy || !connected} onClick={() => void create()}>
            <Plus />
            新建终端
          </button>
        </div>
      )}
      <Dialog.Root open={confirm} onOpenChange={setConfirm}>
        <Dialog.Portal>
          <Dialog.Overlay className="scrim" />
          <Dialog.Content className="dialog ct-close-dialog">
            <Dialog.Title>关闭终端？</Dialog.Title>
            <Dialog.Description>Shell 及其中运行的任务将结束。</Dialog.Description>
            <div className="ct-close-summary">
              <TerminalIcon />
              <span>{active?.name}</span>
              <code>{short(cwd)}</code>
            </div>
            <div className="dialog-foot">
              <Dialog.Close className="btn btn-ghost">取消</Dialog.Close>
              <button className="btn btn-danger" onClick={close} disabled={!connected}>
                关闭终端
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
