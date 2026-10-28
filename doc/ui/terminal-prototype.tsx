import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CodeXml,
  File,
  Folder,
  GitBranch,
  Maximize2,
  Minimize2,
  Moon,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  Terminal,
  X,
} from 'lucide-react';

type Pane = 'chat' | 'files' | 'diff' | 'terminal';
type Line = { text: string; tone?: 'muted' | 'success' | 'accent' | 'command' };
type Term = {
  id: number;
  name: string;
  cwd: string;
  lines: Line[];
  phase: 'shell' | 'running' | 'exited';
  history: string[];
};
const projects = ['/root/dev/claude-web', '/root/dev/go-ws-server'];
const short = (cwd: string) => cwd.replace('/root', '~');
const initialLines: Line[] = [
  { text: '~/dev/claude-web $ git status --short', tone: 'command' },
  { text: ' M server/runtime.ts' },
  { text: ' M web/src/components/SidePanel.tsx' },
  { text: '?? server/terminal-manager.ts' },
  { text: '' },
  { text: '~/dev/claude-web $ npm test', tone: 'command' },
  { text: '> claude-web@0.1.0 test' },
  { text: '> vitest run', tone: 'muted' },
  { text: '' },
  { text: ' ✓ tests/runtime.test.ts (24 tests)', tone: 'success' },
  { text: ' ✓ tests/terminal.test.ts (8 tests)', tone: 'success' },
  { text: ' ✓ tests/security.test.ts (7 tests)', tone: 'success' },
  { text: '' },
  { text: ' Test Files  3 passed (3)', tone: 'success' },
  { text: '      Tests  39 passed (39)', tone: 'success' },
  { text: '   Duration  842ms', tone: 'muted' },
  { text: '' },
];
const initial = new URLSearchParams(location.search);

function Prototype() {
  const [theme, setTheme] = useState(initial.get('theme') === 'dark' ? 'dark' : 'light');
  const [width, setWidth] = useState(innerWidth);
  const [cwd, setCwd] = useState(projects[0]);
  const [pane, setPane] = useState<Pane>('terminal');
  const [panelOpen, setPanelOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [panelWidth, setPanelWidth] = useState(480);
  const [leftOpen, setLeftOpen] = useState(true);
  const [mobileList, setMobileList] = useState(false);
  const [terms, setTerms] = useState<Term[]>(
    initial.get('view') === 'empty'
      ? []
      : [
          {
            id: 1,
            name: 'bash 1',
            cwd: projects[0],
            lines: initialLines,
            phase: 'shell',
            history: ['git status --short', 'npm test'],
          },
        ],
  );
  const [selected, setSelected] = useState(1);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [connected, setConnected] = useState(initial.get('view') !== 'disconnected');
  const [frozen, setFrozen] = useState<Record<number, Line[]>>({ 1: initialLines });
  const [closeId, setCloseId] = useState<number>();
  const [ctrl, setCtrl] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number>();
  const [notice, setNotice] = useState('');
  const serial = useRef(1);
  const input = useRef<HTMLInputElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ cols: 60, rows: 24 });
  const mobile = width < 640;
  const tablet = width >= 640 && width < 1024;
  const active = terms.find((t) => t.id === selected && t.cwd === cwd);
  const projectTerms = terms.filter((t) => t.cwd === cwd);
  const text = drafts[selected] ?? '';
  const setText = (value: string) => setDrafts((v) => ({ ...v, [selected]: value }));
  const update = (id: number, change: (term: Term) => Term) =>
    setTerms((v) => v.map((t) => (t.id === id ? change(t) : t)));
  const focus = () => requestAnimationFrame(() => input.current?.focus());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const resize = () => setWidth(innerWidth);
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setSize({
        cols: Math.max(20, Math.floor((element.clientWidth - 32) / 7.6)),
        rows: Math.max(5, Math.floor(element.clientHeight / 19)),
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [active?.id, pane, expanded, panelOpen, width]);
  useEffect(() => {
    if (screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [active?.lines, selected, connected]);
  useEffect(() => {
    setCtrl(false);
    setHistoryIndex(undefined);
  }, [selected]);
  useEffect(() => {
    if (initial.get('view') === 'running') run('npm run dev', 1);
  }, []);

  function createTerm() {
    if (!connected) return;
    if (
      terms.filter((t) => t.phase !== 'exited').length >= 8 ||
      projectTerms.filter((t) => t.phase !== 'exited').length >= 4
    ) {
      setNotice('终端数量已达上限，关闭一个后再新建');
      return;
    }
    const id = ++serial.current;
    setTerms((v) => [...v, { id, name: `bash ${id}`, cwd, lines: [], phase: 'shell', history: [] }]);
    setSelected(id);
    setPane('terminal');
    setPanelOpen(true);
    focus();
  }
  function run(value = text, id = selected) {
    const term = terms.find((t) => t.id === id);
    if (!term || !connected || term.phase !== 'shell') return;
    const command = value.trim();
    if (!command) return;
    const lines: Line[] = [{ text: `${short(term.cwd)} $ ${value}`, tone: 'command' }];
    let phase: Term['phase'] = 'shell';
    if (command === 'clear') {
      update(id, (t) => ({ ...t, lines: [] }));
      setDrafts((v) => ({ ...v, [id]: '' }));
      return;
    }
    if (command === 'pwd') lines.push({ text: term.cwd });
    else if (command === 'ls' || command === 'ls -la')
      lines.push(
        { text: 'doc/  server/  shared/  web/' },
        { text: 'package.json  README.md  tsconfig.json' },
      );
    else if (command.startsWith('git status')) lines.push(...initialLines.slice(1, 4));
    else if (command === 'npm test') {
      phase = 'running';
      lines.push({ text: '> vitest run', tone: 'muted' });
      setTimeout(
        () =>
          update(id, (t) =>
            t.phase !== 'running'
              ? t
              : {
                  ...t,
                  phase: 'shell',
                  lines: [
                    ...t.lines,
                    { text: ' ✓ 39 tests passed (39)', tone: 'success' },
                    { text: '   Duration  842ms', tone: 'muted' },
                    { text: '' },
                  ],
                },
          ),
        1400,
      );
    } else if (command === 'npm run dev') {
      phase = 'running';
      lines.push(
        { text: '> vite --host 127.0.0.1', tone: 'muted' },
        { text: '' },
        { text: '  VITE ready in 168 ms', tone: 'success' },
        { text: '  Local: http://localhost:5173/', tone: 'accent' },
        { text: '  press Ctrl+C to stop', tone: 'muted' },
      );
    } else if (command === 'exit') {
      phase = 'exited';
      lines.push({ text: 'exit', tone: 'muted' });
    } else if (command.startsWith('echo ')) lines.push({ text: command.slice(5) });
    else lines.push({ text: '交互原型未执行此命令。可试 pwd、ls、git status、npm test。', tone: 'muted' });
    update(id, (t) => ({
      ...t,
      lines: [...t.lines, ...lines, ...(phase === 'shell' ? [{ text: '' }] : [])],
      phase,
      history: [...t.history, value],
    }));
    setDrafts((v) => ({ ...v, [id]: '' }));
    setHistoryIndex(undefined);
  }
  function interrupt() {
    if (!active || !connected || active.phase === 'exited') return;
    update(selected, (t) => ({
      ...t,
      phase: 'shell',
      lines: [...t.lines, { text: '^C', tone: 'muted' }, { text: '' }],
    }));
    setText('');
    setCtrl(false);
    focus();
  }
  function historyStep(direction: number) {
    if (!active) return;
    const at = Math.max(
      0,
      Math.min(active.history.length, (historyIndex ?? active.history.length) + direction),
    );
    setHistoryIndex(at);
    setText(active.history[at] ?? '');
    focus();
  }
  function key(value: string) {
    if (!active || !connected || active.phase === 'exited') return;
    if (value === 'Ctrl') {
      setCtrl((v) => !v);
      focus();
      return;
    }
    if (value === 'Esc') {
      setCtrl(false);
      focus();
      return;
    }
    if (value === '↑' || value === '↓') {
      historyStep(value === '↑' ? -1 : 1);
      return;
    }
    if (value === 'Enter') {
      run();
      focus();
      return;
    }
    if (value === 'Tab') {
      const match = ['pwd', 'ls', 'git status', 'npm test', 'npm run dev', 'clear', 'exit'].find((s) =>
        s.startsWith(text),
      );
      if (match) setText(match);
      focus();
      return;
    }
    const position = input.current?.selectionStart ?? text.length;
    focus();
    requestAnimationFrame(() =>
      input.current?.setSelectionRange(
        Math.max(0, Math.min(text.length, position + (value === '←' ? -1 : 1))),
        Math.max(0, Math.min(text.length, position + (value === '←' ? -1 : 1))),
      ),
    );
  }
  function connection(value: boolean) {
    if (!value) setFrozen(Object.fromEntries(terms.map((t) => [t.id, t.lines])));
    setConnected(value);
    setCtrl(false);
  }
  function selectProject(project: string) {
    setCwd(project);
    setSelected(terms.find((t) => t.cwd === project)?.id ?? -1);
    setMobileList(false);
  }
  function choosePane(value: Pane) {
    setPane(value);
    setPanelOpen(value !== 'chat');
  }
  function resize(event: React.PointerEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const x = event.clientX;
    const initialWidth = panelWidth;
    const move = (e: PointerEvent) =>
      setPanelWidth(
        Math.max(
          360,
          Math.min(800, initialWidth + x - e.clientX, width - 480 - (width >= 1280 && leftOpen ? 280 : 0)),
        ),
      );
    const end = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', end);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', end, { once: true });
  }
  const title = cwd === projects[0] ? '给项目加一个终端' : '检查消息服务的启动流程';
  const closeTerm = terms.find((t) => t.id === closeId);

  const sidebar = (
    <aside className="sidebar">
      <header className="side-head">
        <strong>claude-web</strong>
        <button className="icon desktop" title="收起侧栏" onClick={() => setLeftOpen(false)}>
          <PanelLeftClose />
        </button>
      </header>
      <div className="search">
        <Search />
        <span>搜索会话</span>
      </div>
      <div className="side-list">
        {projects.map((project) => (
          <section key={project}>
            <div className="group">
              <ChevronDown />
              {project.split('/').at(-1)}
              <span>1</span>
            </div>
            <button
              className={`session ${cwd === project ? 'selected' : ''}`}
              onClick={() => selectProject(project)}
            >
              <span className="dot" />
              <span>{project === projects[0] ? '给项目加一个终端' : '检查消息服务的启动流程'}</span>
              <small>{project === projects[0] ? '刚刚' : '12 分钟'}</small>
              <div>
                <GitBranch />
                main
              </div>
            </button>
          </section>
        ))}
      </div>
      <div className="side-bottom">
        <div>
          当前时段 <b>34%</b>
        </div>
        <div className="meter">
          <i />
        </div>
        <small>没有运行中的会话</small>
      </div>
    </aside>
  );

  const terminal = (
    <div className="terminal">
      <div className="terminal-toolbar">
        <div className="term-tabs" role="tablist" aria-label="终端列表">
          {projectTerms.map((term) => (
            <button
              role="tab"
              aria-selected={selected === term.id}
              className={selected === term.id ? 'chosen' : ''}
              key={term.id}
              onClick={() => {
                setSelected(term.id);
                focus();
              }}
            >
              <Terminal />
              <span>{term.name}</span>
              {term.phase === 'exited' && <small>已结束</small>}
            </button>
          ))}
        </div>
        <div className="terminal-actions">
          <button
            className="icon"
            aria-label="新建终端"
            title="新建终端"
            disabled={!connected}
            onClick={createTerm}
          >
            <Plus />
          </button>
          {!mobile && (
            <button
              className="icon"
              aria-label={expanded ? '恢复布局' : '放大终端'}
              title={expanded ? '恢复布局' : '放大终端'}
              onClick={() => {
                setExpanded((v) => !v);
                focus();
              }}
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </button>
          )}
          <button
            className="icon"
            aria-label="关闭终端"
            title="关闭终端"
            disabled={!active || !connected}
            onClick={() => setCloseId(selected)}
          >
            <X />
          </button>
        </div>
      </div>
      <div className="directory">
        <Folder />
        <span>启动目录</span>
        <code>{short(cwd)}</code>
      </div>
      {!connected && (
        <div className="connection" role="status">
          <span>连接已断开，正在重连…</span>
          <button onClick={() => connection(true)}>重新连接</button>
        </div>
      )}
      {!active ? (
        <div className="terminal-empty">
          <Terminal />
          <strong>在项目中打开终端</strong>
          <code>{short(cwd)}</code>
          <button className="button primary" disabled={!connected} onClick={createTerm}>
            <Plus />
            新建终端
          </button>
        </div>
      ) : (
        <>
          <div
            className="screen"
            ref={screen}
            role="log"
            aria-label="终端输出"
            tabIndex={0}
            onClick={() => {
              if (!getSelection()?.toString()) focus();
            }}
          >
            {(connected ? active.lines : (frozen[active.id] ?? [])).map((line, index) => (
              <div className={`line ${line.tone ?? ''}`} key={index}>
                {line.text || '\u00a0'}
              </div>
            ))}
            {active.phase === 'shell' && (
              <div className="screen-prompt">
                {short(cwd)} $ <span className="cursor" />
              </div>
            )}
          </div>
          {active.phase === 'exited' ? (
            <div className="exit-bar">
              <span>终端已结束 · 退出码 0</span>
              <button
                className="button"
                disabled={!connected}
                onClick={() => {
                  setTerms((v) => v.filter((t) => t.id !== selected));
                  createTerm();
                }}
              >
                重新打开
              </button>
            </div>
          ) : (
            <div className="terminal-input">
              <span aria-hidden="true">{active.phase === 'running' ? '›' : '$'}</span>
              <input
                ref={input}
                aria-label="终端命令"
                placeholder={
                  connected
                    ? active.phase === 'running'
                      ? '任务运行中，Ctrl+C 中断'
                      : '输入命令'
                    : '连接恢复后可继续输入'
                }
                value={text}
                disabled={!connected}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if ((e.ctrlKey || ctrl) && e.key.toLowerCase() === 'c') {
                    e.preventDefault();
                    e.stopPropagation();
                    interrupt();
                    return;
                  }
                  if (ctrl) {
                    setCtrl(false);
                    if (e.key.toLowerCase() === 'd') {
                      e.preventDefault();
                      run('exit');
                      return;
                    }
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    run();
                  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    historyStep(e.key === 'ArrowUp' ? -1 : 1);
                  } else if (e.key === 'Tab') {
                    e.preventDefault();
                    key('Tab');
                  } else if (e.key === 'Escape') {
                    e.stopPropagation();
                    setCtrl(false);
                  }
                }}
              />
              <button
                className="icon"
                aria-label="中断命令"
                title="Ctrl+C"
                disabled={!connected}
                onClick={interrupt}
              >
                <span className="ctrl-c">^C</span>
              </button>
            </div>
          )}
          {mobile && (
            <div className="aux-keys">
              {['Ctrl', 'Esc', 'Tab', '↑', '↓', '←', '→', 'Enter'].map((value) => (
                <button
                  disabled={!connected || active.phase === 'exited'}
                  aria-pressed={value === 'Ctrl' ? ctrl : undefined}
                  className={value === 'Ctrl' && ctrl ? 'pressed' : ''}
                  key={value}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => key(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
          <footer className="terminal-status">
            <span>
              <i className={`dot ${!connected ? 'offline' : ''}`} />
              {active.phase === 'exited' ? '已结束' : connected ? '已连接' : '连接已断开'}
            </span>
            <span>
              {size.cols} × {size.rows}
            </span>
          </footer>
        </>
      )}
    </div>
  );
  const panel = (
    <section className={`panel ${expanded ? 'expanded' : ''}`}>
      <header className="panel-head">
        <div role="tablist" aria-label="工作区">
          {(['files', 'diff', 'terminal'] as Pane[]).map((value) => (
            <button
              role="tab"
              aria-selected={pane === value}
              className={pane === value ? 'active' : ''}
              key={value}
              onClick={() => choosePane(value)}
            >
              {value === 'files' ? '文件' : value === 'diff' ? 'Diff' : '终端'}
            </button>
          ))}
        </div>
        <button
          className="icon"
          aria-label="收起面板"
          title="收起面板"
          onClick={() => {
            setPanelOpen(false);
            setExpanded(false);
          }}
        >
          <PanelRightClose />
        </button>
      </header>
      {pane === 'terminal' ? (
        terminal
      ) : pane === 'files' ? (
        <div className="file-view">
          {['doc', 'server', 'shared', 'web'].map((name) => (
            <div key={name}>
              <ChevronRight />
              <Folder />
              {name}/
            </div>
          ))}
          <div>
            <File />
            package.json
          </div>
          <div>
            <File />
            README.md
          </div>
        </div>
      ) : (
        <div className="diff-view">
          <header>
            工作区 <span>1 个文件 +3 −1</span>
          </header>
          <div className="diff-file">web/src/components/SidePanel.tsx</div>
          <pre className="removed">− type Tab = 'files' | 'diff';</pre>
          <pre className="added">+ type Tab = 'files' | 'diff' | 'terminal';</pre>
        </div>
      )}
      {!mobile && !tablet && !expanded && (
        <div
          role="separator"
          aria-label="面板宽度"
          aria-orientation="vertical"
          aria-valuenow={panelWidth}
          aria-valuemin={360}
          aria-valuemax={800}
          tabIndex={0}
          className="resize"
          onPointerDown={resize}
          onDoubleClick={() => setPanelWidth(480)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              setPanelWidth((v) =>
                Math.max(360, Math.min(width - 480, 800, v + (e.key === 'ArrowLeft' ? 16 : -16))),
              );
            }
          }}
        />
      )}
    </section>
  );

  return (
    <>
      <div className="prototype-bar">
        <span>
          <b>终端原型</b>
          <span className="prototype-note">模拟交互 · 不执行真实命令</span>
        </span>
        <div>
          <label>
            <span className="sr-only">演示状态</span>
            <select
              aria-label="演示状态"
              defaultValue="default"
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'offline') connection(false);
                else {
                  connection(true);
                  if (value === 'default') {
                    const id = ++serial.current;
                    setTerms((v) => [
                      ...v.filter((t) => t.cwd !== cwd),
                      {
                        id,
                        name: `bash ${id}`,
                        cwd,
                        lines: initialLines.map((line) => ({
                          ...line,
                          text: line.text.replaceAll('~/dev/claude-web', short(cwd)),
                        })),
                        phase: 'shell',
                        history: ['git status --short', 'npm test'],
                      },
                    ]);
                    setSelected(id);
                  }
                  if (value === 'empty') setTerms((v) => v.filter((t) => t.cwd !== cwd));
                  if (value === 'running') {
                    if (active?.phase === 'shell') run('npm run dev');
                    else setNotice('先新建一个终端，再演示长任务');
                  }
                }
              }}
            >
              <option value="default">默认状态</option>
              <option value="running">长任务</option>
              <option value="offline">模拟断线</option>
              <option value="online">恢复连接</option>
              <option value="empty">空状态</option>
            </select>
          </label>
          <button
            className="icon"
            aria-label="切换明暗"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
        </div>
      </div>
      <div
        className={`app ${expanded && !mobile && !tablet ? 'focus-mode' : ''} ${!panelOpen ? 'panel-hidden' : ''}`}
        style={{ '--terminal-panel-width': `${Math.min(panelWidth, width - 480)}px` } as CSSProperties}
      >
        {((width >= 1280 && leftOpen) || (mobile && mobileList)) && sidebar}
        {!(mobile && mobileList) && (
          <div className="workspace">
            <div className="conversation">
              <header className="topbar">
                {mobile ? (
                  <button className="icon" aria-label="返回会话列表" onClick={() => setMobileList(true)}>
                    <ArrowLeft />
                  </button>
                ) : width >= 1280 && !leftOpen ? (
                  <button className="icon" aria-label="展开侧栏" onClick={() => setLeftOpen(true)}>
                    <ChevronRight />
                  </button>
                ) : null}
                <div>
                  <strong>{title}</strong>
                  <small>
                    {mobile ? '空闲 · ' : ''}
                    {short(cwd)} · main
                  </small>
                </div>
                <span className="badge desktop">
                  <i className="dot" />
                  空闲
                </span>
                {!mobile && (!panelOpen || tablet) && (
                  <button
                    className="icon"
                    aria-label="展开面板"
                    onClick={() => {
                      setPanelOpen(true);
                      if (pane === 'chat') setPane('terminal');
                    }}
                  >
                    <PanelRightOpen />
                  </button>
                )}
              </header>
              {mobile && (
                <nav className="mobile-nav">
                  {(['chat', 'files', 'diff', 'terminal'] as Pane[]).map((value) => (
                    <button
                      className={pane === value ? 'active' : ''}
                      key={value}
                      onClick={() => choosePane(value)}
                    >
                      {{ chat: '对话', files: '文件', diff: 'Diff', terminal: '终端' }[value]}
                    </button>
                  ))}
                </nav>
              )}
              {mobile && pane !== 'chat' ? (
                panel
              ) : (
                <>
                  <div className="chat">
                    <div className="user-message">我想直接在网页里运行命令，顺便看一下测试结果。</div>
                    <p>可以从右侧的终端检查项目。对话与终端使用同一工作目录，你可以一边看说明，一边操作。</p>
                    <div className="tool">
                      <ChevronRight />
                      <CodeXml />
                      <b>Read</b>
                      <code>package.json</code>
                      <Check />
                    </div>
                    <p>
                      先运行 <code>npm test</code>。如果需要启动开发服务，可以再开一个终端运行{' '}
                      <code>npm run dev</code>。
                    </p>
                    <div className="result">完成 · 12 秒 · 2 轮</div>
                  </div>
                  <div className="chat-compose">
                    <div>输入消息，/ 调用命令，@ 引用文件</div>
                    <footer>
                      <Plus />
                      <span>Opus 5.5</span>
                      <span className="grow" />
                      <ShieldCheck />
                      <span>编辑前询问</span>
                      <ArrowUp />
                    </footer>
                  </div>
                </>
              )}
            </div>
            {!mobile && !tablet && panelOpen && panel}
          </div>
        )}
      </div>
      {tablet && (
        <Dialog.Root
          open={panelOpen}
          onOpenChange={(open) => {
            setPanelOpen(open);
            if (!open) setExpanded(false);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="overlay" />
            <Dialog.Content
              className={`tablet-drawer ${expanded ? 'full' : ''}`}
              aria-describedby={undefined}
            >
              <Dialog.Title className="sr-only">工作区</Dialog.Title>
              {panel}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      <Dialog.Root
        open={closeId !== undefined}
        onOpenChange={(open) => {
          if (!open) setCloseId(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content className="close-dialog">
            <Dialog.Title>关闭终端？</Dialog.Title>
            <Dialog.Description>Shell 及其中运行的任务将结束。</Dialog.Description>
            <div className="close-summary">
              <Terminal />
              <span>{closeTerm?.name}</span>
              <code>{short(closeTerm?.cwd ?? cwd)}</code>
            </div>
            <footer>
              <Dialog.Close asChild>
                <button className="button">取消</button>
              </Dialog.Close>
              <button
                className="button danger-button"
                onClick={() => {
                  const remaining = projectTerms.filter((t) => t.id !== closeId);
                  setTerms((v) => v.filter((t) => t.id !== closeId));
                  if (selected === closeId) setSelected(remaining[0]?.id ?? -1);
                  setCloseId(undefined);
                }}
              >
                关闭终端
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Prototype />);
