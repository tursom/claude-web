import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  ChevronDown,
  GitBranch,
  LoaderCircle,
  Menu as MenuIcon,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRightOpen,
} from 'lucide-react';
import { emptyUsage, type Usage, type Session, type WireEvent } from '../../shared/protocol';
import { api, ApiError } from './api/client';
import { SessionSocket } from './api/socket';
import { allMessages, emptyState, prependHistory, reduceSession, type SessionState } from './store/sessions';
import { sessionUsageFromMessages } from './store/session-usage';
import { useSessionUsage } from './store/use-session-usage';
import { Sidebar } from './components/Sidebar';
import { SidePanel } from './components/SidePanel';
import { ResizeHandle } from './components/ResizeHandle';
import { NewSession } from './components/NewSession';
import { Messages } from './components/Messages';
import { Composer } from './components/Composer';
import { MessageQueue } from './components/MessageQueue';
import { PermissionCard } from './components/PermissionCard';
import { TodoBar } from './components/TodoBar';
import { UsageProvider, UsageNotice } from './components/Usage';
import { terminalClient } from './api/terminal-client';
import type { TerminalFrame } from '../../shared/terminal';

type PanelTab = 'files' | 'diff' | 'terminal';
type PageTab = 'chat' | PanelTab;

function load<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const labels = { running: '运行中', waiting: '待确认', idle: '空闲', closed: '未运行' };
const getRoute = () => ({
  id: /^\/s\/([^/]+)/.exec(location.pathname)?.[1],
  tab: (['files', 'diff', 'terminal'].includes(new URLSearchParams(location.search).get('tab') ?? '')
    ? new URLSearchParams(location.search).get('tab')
    : 'chat') as PageTab,
  path: new URLSearchParams(location.search).get('path') ?? undefined,
});
const short = (path: string) => path.replace(/^\/root(?=\/|$)/, '~');
export function App() {
  const [route, setRoute] = useState(getRoute);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [usage, setUsage] = useState<Usage>(emptyUsage);
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  const [states, setStates] = useState<Record<string, SessionState>>({});
  const [forbidden, setForbidden] = useState(false);
  const [toast, setToast] = useState('');
  const [maxLive, setMaxLive] = useState(4);
  const [connected, setConnected] = useState(false);
  const [banner, setBanner] = useState(false);
  const [viewport, setViewport] = useState(innerWidth);
  const [sidebar, setSidebar] = useState(() => load('cw.sidebar', { open: true, width: 280 }));
  const [panel, setPanel] = useState(() =>
    load('cw.panel', { open: true, width: 480, tab: 'diff' as PanelTab }),
  );
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => load('cw.theme', 'system'));
  const [leftDrawer, setLeftDrawer] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newCwd, setNewCwd] = useState<string>();
  const [conflict, setConflict] = useState<{
    sessionId: string;
    requestId: string;
    text: string;
    imageIds?: string[];
    seconds: number;
  }>();
  const [sessionError, setSessionError] = useState('');
  const [unread, setUnread] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const socket = useRef<SessionSocket>(undefined);
  const pendingSends = useRef(
    new Map<string, { sessionId: string; requestId: string; text: string; imageIds?: string[] }>(),
  );
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const currentId = useRef(route.id);
  currentId.current = route.id;
  const mobile = viewport < 640,
    desktop = viewport >= 1024;
  const refresh = useCallback(async () => {
    try {
      setSessions(await api<Session[]>('/api/sessions'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setForbidden(true);
      else setToast(`操作失败：${(error as Error).message}`);
    }
  }, []);
  const notify = useCallback(
    (message: string) => setToast(message.startsWith('操作失败：') ? message : `操作失败：${message}`),
    [],
  );
  const navigate = useCallback((id?: string, tab: PageTab = 'chat', path?: string) => {
    const query = new URLSearchParams();
    if (tab !== 'chat') query.set('tab', tab);
    if (path) query.set('path', path);
    history.pushState(null, '', id ? `/s/${id}${query.size ? `?${query}` : ''}` : '/');
    setRoute(getRoute());
    setLeftDrawer(false);
    follow.current = true;
    setSessionError('');
  }, []);
  useEffect(() => {
    const update = () => setViewport(innerWidth);
    const pop = () => setRoute(getRoute());
    const deny = () => setForbidden(true);
    addEventListener('resize', update);
    addEventListener('popstate', pop);
    addEventListener('cw:forbidden', deny);
    return () => {
      removeEventListener('resize', update);
      removeEventListener('popstate', pop);
      removeEventListener('cw:forbidden', deny);
    };
  }, []);
  useEffect(() => {
    void refresh();
    void api('/api/me')
      .then((me) => setMaxLive(me.maxLiveSessions))
      .catch(() => {});
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const ws = new SessionSocket(
      (frame: WireEvent) => {
        if (frame.type.startsWith('terminal.')) {
          terminalClient.receive(frame as unknown as TerminalFrame);
          return;
        }
        if (frame.type === 'usage') {
          setUsage(frame.usage);
          setUsageRefreshing(frame.refreshing);
          return;
        }
        if (frame.type === 'error') {
          if (frame.terminalId)
            terminalClient.receive({
              type: 'terminal.error',
              terminalId: frame.terminalId,
              code: frame.code,
              message: String(frame.message),
            });
          const pending = pendingSends.current.get(frame.requestId ?? '');
          if (frame.code === 'TERMINAL_ACTIVE' && pending && pending.sessionId === frame.sessionId)
            setConflict({ ...pending, seconds: frame.seconds ?? 0 });
          else if (frame.code === 'MAX_LIVE_SESSIONS' || frame.code === 'SESSION_LIMIT')
            setSessionError(frame.message as unknown as string);
          else notify(String(frame.message));
          return;
        }
        if (!frame.sessionId) return;
        if (frame.type === 'event' && frame.message?.type === 'user' && frame.message.uuid)
          pendingSends.current.delete(frame.message.uuid);
        setStates((prev) => ({
          ...prev,
          [frame.sessionId]: reduceSession(prev[frame.sessionId] ?? emptyState(), frame),
        }));
        if (frame.type === 'status') {
          setSessions((prev) =>
            prev.map((s) =>
              s.sessionId === frame.sessionId ? { ...s, status: frame.status!, lastModified: Date.now() } : s,
            ),
          );
        }
        if (frame.type === 'event' && frame.message?.type === 'result') void refresh();
      },
      (value) => {
        setConnected(value);
        terminalClient.connection(value);
      },
    );
    socket.current = ws;
    const detach = terminalClient.attach((frame) => ws.send(frame));
    return () => {
      detach();
      ws.close();
    };
  }, [notify, refresh]);
  useEffect(() => {
    if (connected) setBanner(false);
    else {
      const timer = setTimeout(() => setBanner(true), 1000);
      return () => clearTimeout(timer);
    }
  }, [connected]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    save('cw.sidebar', sidebar);
  }, [sidebar]);
  useEffect(() => {
    save('cw.panel', panel);
  }, [panel]);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    save('cw.theme', theme);
  }, [theme]);
  useEffect(() => {
    for (const s of sessions) if (s.status !== 'closed') socket.current?.subscribe(s.sessionId);
  }, [sessions]);
  useEffect(() => {
    if (route.id) {
      socket.current?.subscribe(route.id);
      follow.current = true;
      setUnread(false);
    }
  }, [route.id]);
  useEffect(() => {
    if (!route.id && !mobile && sessions.length) navigate(sessions[0].sessionId);
  }, [route.id, mobile, sessions, navigate]);
  useEffect(() => {
    if (route.tab !== 'chat') {
      setPanel((p) => ({ ...p, open: true, tab: route.tab as PanelTab }));
      if (!mobile && !desktop) setRightDrawer(true);
    }
  }, [route.tab, mobile, desktop]);
  useEffect(() => {
    setPanelExpanded(false);
  }, [route.id, panel.tab]);
  const session = sessions.find((s) => s.sessionId === route.id);
  const state = route.id ? (states[route.id] ?? emptyState()) : emptyState();
  const messages = allMessages(state);
  const queuedMessages = messages.filter((message) => message.type === 'user' && message.queued);
  const transcriptMessages = messages.filter((message) => !queuedMessages.includes(message));
  const sessionUsage = useMemo(
    () => (route.id ? sessionUsageFromMessages(allMessages(state), route.id) : null),
    [route.id, state.history, state.events],
  );
  const sessionUsageState = useSessionUsage(route.id, state.epoch, sessionUsage);
  const status = states[route.id ?? '']?.status ?? session?.status ?? 'closed';
  const waitingQuestion =
    state.pending.length > 0 && state.pending.every((p) => p.toolName === 'AskUserQuestion');
  const title = session?.customTitle || session?.summary || session?.firstPrompt || 'claude-web';
  const setLeft = (open: boolean) => {
    if (desktop) {
      if (open && viewport - sidebar.width - (panel.open ? 360 : 0) < 480)
        setPanel((p) => ({ ...p, open: false }));
      setSidebar((s) => ({ ...s, open }));
    } else setLeftDrawer(open);
  };
  const setRight = (open: boolean) => {
    if (!open) setPanelExpanded(false);
    if (desktop) setPanel((s) => ({ ...s, open }));
    else setRightDrawer(open);
  };
  let sidebarWidth = Math.max(220, Math.min(420, sidebar.width));
  let panelWidth = Math.max(360, Math.min(800, panel.width));
  let sidebarVisible = desktop && sidebar.open;
  const panelVisible = desktop && panel.open && !!session;
  const expandedPanel = panelExpanded && !mobile && !!session && (desktop ? panelVisible : rightDrawer);
  if (!expandedPanel && panelVisible && viewport - panelWidth - (sidebarVisible ? sidebarWidth : 0) < 480)
    panelWidth = Math.max(360, viewport - 480 - (sidebarVisible ? sidebarWidth : 0));
  if (
    !expandedPanel &&
    viewport - (panelVisible ? panelWidth : 0) - (sidebarVisible ? sidebarWidth : 0) < 480
  )
    sidebarVisible = false;
  const openFile = (path: string) => {
    navigate(route.id, 'files', path);
    setPanel((p) => ({ ...p, open: true, tab: 'files' }));
    if (!desktop && !mobile) setRightDrawer(true);
  };
  const action = (type: string, data: Record<string, any> = {}) => {
    const sent = socket.current?.send({ type, sessionId: route.id, ...data }) ?? false;
    if (!sent) notify('连接已断开，正在重连…');
    return sent;
  };
  const send = (text: string, imageIds?: string[]) => {
    if (!route.id) return false;
    setSessionError('');
    const requestId = crypto.randomUUID();
    pendingSends.current.set(requestId, { sessionId: route.id, requestId, text, imageIds });
    const sent = action('send', { text, imageIds, requestId });
    if (!sent) pendingSends.current.delete(requestId);
    return sent;
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setToast('已复制');
    } catch (error) {
      notify((error as Error).message);
    }
  };
  const create = (cwd?: string) => {
    setNewCwd(cwd);
    setNewOpen(true);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('[data-terminal-focus]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (event.altKey) setRight(!(desktop ? panel.open : rightDrawer));
        else setLeft(!(desktop ? sidebarVisible : leftDrawer));
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!sidebarVisible) setLeft(true);
        setTimeout(
          () => document.querySelector<HTMLInputElement>('input[placeholder="搜索会话"]')?.focus(),
          0,
        );
      }
      if (
        event.key === 'Escape' &&
        status === 'running' &&
        !document.querySelector('[role="menu"], [role="dialog"], [data-cw-menu="open"]')
      ) {
        const target = event.target as HTMLTextAreaElement;
        if ((target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') && target.value) return;
        action('interrupt');
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    if (follow.current)
      requestAnimationFrame(() => {
        node.scrollTop = node.scrollHeight;
        setUnread(false);
      });
    else setUnread(true);
  }, [state.revision, route.id]);
  const sidebarContent = (
    <Sidebar
      sessions={sessions}
      selectedId={route.id}
      onSelect={(id) => navigate(id)}
      onNew={() => create()}
      onClose={() => setLeft(false)}
      maxLiveSessions={maxLive}
      theme={theme}
      onTheme={() => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))}
    />
  );
  const sidePanel = session ? (
    <SidePanel
      cwd={session.cwd}
      tab={panel.tab}
      path={route.path}
      onTab={(tab) => {
        setPanel((p) => ({ ...p, tab }));
        navigate(route.id, tab);
      }}
      onClose={() => setRight(false)}
      onPath={(path) => navigate(route.id, 'files', path)}
      refreshKey={messages.filter((m) => m.type === 'result').length}
      expanded={panelExpanded}
      onExpanded={setPanelExpanded}
      onError={notify}
    />
  ) : null;
  const loadOlder = async () => {
    if (!route.id || olderBusy) return;
    setOlderBusy(true);
    try {
      const offset = Math.max(0, state.total - state.history.length - 200);
      const data = await api<{ messages: any[]; total: number }>(
        `/api/sessions/${route.id}/messages?offset=${offset}&limit=${Math.min(200, state.total - state.history.length)}`,
      );
      const id = route.id;
      const node = scroll.current;
      const before = node?.scrollHeight ?? 0;
      let applied = false;
      follow.current = false;
      setStates((prev) => {
        const next = prependHistory(prev[id], state.generation, state.history.length, data.messages);
        applied = next !== prev[id];
        return applied ? { ...prev, [id]: next } : prev;
      });
      requestAnimationFrame(() => {
        if (applied && node && currentId.current === id) node.scrollTop += node.scrollHeight - before;
      });
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setOlderBusy(false);
    }
  };
  if (forbidden) return <div className="center-page">没有访问权限</div>;
  return (
    <UsageProvider
      usage={usage}
      refreshing={usageRefreshing}
      session={session ? { name: title, ...sessionUsageState } : undefined}
      onRefresh={() => {
        socket.current?.send({ type: 'usage.refresh' });
      }}
    >
      <div
        className={`app${expandedPanel ? ' panel-expanded' : ''}`}
        style={{ '--sidebar-w': `${sidebarWidth}px`, '--panel-w': `${panelWidth}px` } as CSSProperties}
      >
        {(sidebarVisible || (mobile && !route.id)) && (
          <aside className={`sidebar-shell ${mobile ? 'mobile-list' : ''}`}>
            {sidebarContent}
            {desktop && (
              <ResizeHandle
                side="left"
                width={sidebarWidth}
                min={220}
                max={Math.min(420, viewport - 480 - (panelVisible ? panelWidth : 0))}
                onWidth={(width) => setSidebar((s) => ({ ...s, width }))}
                onOpen={(open) => setSidebar((s) => ({ ...s, open }))}
              />
            )}
          </aside>
        )}
        {(!mobile || route.id) && (
          <main className="main" hidden={desktop && expandedPanel}>
            {session || route.id ? (
              <>
                <header className="topbar">
                  {mobile ? (
                    <button className="btn btn-icon" aria-label="返回" onClick={() => navigate()}>
                      <ArrowLeft />
                    </button>
                  ) : !sidebarVisible ? (
                    <button
                      className="btn btn-icon has-dot"
                      aria-label="展开侧栏"
                      onClick={() => setLeft(true)}
                    >
                      {desktop ? <PanelLeftOpen /> : <MenuIcon />}
                      {sessions.some((s) => s.status === 'waiting') && <span className="btn-dot" />}
                    </button>
                  ) : null}
                  <div className="tb-title">
                    <span className="t ellipsis">{title}</span>
                    <span className="m ellipsis">
                      {mobile && (
                        <>
                          <i className={`dot ${status}`} />
                          {waitingQuestion ? '待回答' : labels[status]} ·{' '}
                        </>
                      )}
                      <span className="mono ellipsis">{short(session?.cwd ?? '')}</span>
                      {!mobile && session?.gitBranch && (
                        <>
                          {' '}
                          · <GitBranch />
                          {session.gitBranch}
                        </>
                      )}
                    </span>
                  </div>
                  {!mobile && (
                    <span className={`badge ${status}`}>
                      <i className={`dot ${status}`} />
                      {waitingQuestion ? '待回答' : labels[status]}
                    </span>
                  )}
                  <Menu.Root>
                    <Menu.Trigger asChild>
                      <button className="btn btn-icon" aria-label="更多">
                        <MoreHorizontal />
                      </button>
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Content className="pop" align="end" sideOffset={4}>
                        {status !== 'closed' && (
                          <Menu.Item
                            className="pop-item"
                            onSelect={() =>
                              void api(`/api/sessions/${route.id}/release`, { method: 'POST' })
                                .then(refresh)
                                .catch((e) => notify(e.message))
                            }
                          >
                            释放进程
                          </Menu.Item>
                        )}
                        <Menu.Item
                          className="pop-item"
                          onSelect={() => void copy(`claude --resume ${route.id}`)}
                        >
                          复制恢复命令
                        </Menu.Item>
                        <Menu.Item className="pop-item" onSelect={() => create(session?.cwd)}>
                          在此目录新建会话
                        </Menu.Item>
                      </Menu.Content>
                    </Menu.Portal>
                  </Menu.Root>
                  {!mobile && (!panelVisible || !desktop) && (
                    <button className="btn btn-icon" aria-label="展开面板" onClick={() => setRight(true)}>
                      <PanelRightOpen />
                    </button>
                  )}
                </header>
                {mobile && (
                  <nav className="mobile-tabs seg">
                    {(['chat', 'files', 'diff', 'terminal'] as const).map((tab) => (
                      <button
                        key={tab}
                        className={route.tab === tab ? 'on' : ''}
                        onClick={() => navigate(route.id, tab)}
                      >
                        {tab === 'chat'
                          ? '对话'
                          : tab === 'files'
                            ? '文件'
                            : tab === 'diff'
                              ? 'Diff'
                              : '终端'}
                      </button>
                    ))}
                  </nav>
                )}
                {banner && (
                  <div className="banner">
                    <LoaderCircle className="spin" />
                    连接已断开，正在重连…
                  </div>
                )}
                {mobile && route.tab !== 'chat' ? (
                  <div className="mobile-panel">{sidePanel}</div>
                ) : (
                  <>
                    <div
                      className="chat"
                      ref={scroll}
                      onScroll={() => {
                        const node = scroll.current!;
                        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 80;
                        if (follow.current) setUnread(false);
                      }}
                    >
                      <div className="chat-inner">
                        {state.total > state.history.length && (
                          <button
                            className="btn btn-ghost older"
                            onClick={() => void loadOlder()}
                            disabled={olderBusy}
                          >
                            加载更早的消息
                          </button>
                        )}
                        <Messages
                          key={route.id}
                          messages={transcriptMessages}
                          pending={state.pending}
                          status={status}
                          delta={state.delta}
                          onOpenFile={openFile}
                          cwd={session?.cwd}
                        />
                      </div>
                    </div>
                    <div className="bottom">
                      <div className="bottom-inner">
                        {unread && (
                          <button
                            className="btn btn-secondary new-messages"
                            onClick={() => {
                              follow.current = true;
                              scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
                              setUnread(false);
                            }}
                          >
                            <ChevronDown />
                            新消息
                          </button>
                        )}
                        <TodoBar messages={messages} />
                        <UsageNotice />
                        {sessionError && <p className="danger">{sessionError}</p>}
                        <MessageQueue
                          messages={queuedMessages}
                          connected={connected}
                          cancel={(messageId) => action('queue.cancel', { messageId })}
                        />
                        {state.pending.length ? (
                          <PermissionCard
                            key={`${state.pending[0]?.requestId}:${connected}`}
                            pending={state.pending}
                            respond={(requestId, data) =>
                              action('permission.respond', { requestId, ...data })
                            }
                          />
                        ) : session ? (
                          <Composer
                            key={session.sessionId}
                            session={{ ...session, status }}
                            meta={state.meta}
                            send={send}
                            action={action}
                            onError={notify}
                          />
                        ) : null}
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="empty">
                <p>选择一个会话，或新建会话</p>
                <button className="btn btn-secondary" onClick={() => create()}>
                  新建会话
                </button>
              </div>
            )}
          </main>
        )}
        {panelVisible && (
          <section className="panel-shell">
            {sidePanel}
            {!expandedPanel && (
              <ResizeHandle
                side="right"
                width={panelWidth}
                min={360}
                max={Math.min(800, viewport - 480 - (sidebarVisible ? sidebarWidth : 0))}
                onWidth={(width) => setPanel((p) => ({ ...p, width }))}
                onOpen={(open) => setPanel((p) => ({ ...p, open }))}
              />
            )}
          </section>
        )}
        {!desktop && !mobile && (
          <>
            <Dialog.Root open={leftDrawer} onOpenChange={setLeftDrawer}>
              <Dialog.Portal>
                <Dialog.Overlay className="scrim" />
                <Dialog.Content className="drawer drawer-left" aria-describedby={undefined}>
                  <Dialog.Title className="sr-only">claude-web</Dialog.Title>
                  {sidebarContent}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <Dialog.Root open={rightDrawer} onOpenChange={setRight}>
              <Dialog.Portal>
                <Dialog.Overlay className="scrim" />
                <Dialog.Content
                  className={`drawer drawer-right${expandedPanel ? ' drawer-panel-expanded' : ''}`}
                  aria-describedby={undefined}
                  onEscapeKeyDown={(event) => {
                    if ((event.target as HTMLElement)?.closest('[data-terminal-focus]'))
                      event.preventDefault();
                  }}
                >
                  <Dialog.Title className="sr-only">
                    {panel.tab === 'files' ? '文件' : panel.tab === 'diff' ? 'Diff' : '终端'}
                  </Dialog.Title>
                  {sidePanel}
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </>
        )}
        <NewSession
          open={newOpen}
          onOpenChange={setNewOpen}
          sessions={sessions}
          initialCwd={newCwd}
          onCreated={(id) => {
            void refresh();
            navigate(id);
            setNewOpen(false);
            setTimeout(() => document.querySelector('textarea')?.focus(), 50);
          }}
          onError={notify}
        />
        <Dialog.Root
          open={!!conflict}
          onOpenChange={(open) => {
            if (!open) setConflict(undefined);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="scrim" />
            <Dialog.Content className="dialog conflict">
              <Dialog.Title>终端可能正在使用这个会话</Dialog.Title>
              <Dialog.Description>
                这个会话 {conflict?.seconds} 秒前被其他程序修改过。同时在两处使用会把记录写乱。
              </Dialog.Description>
              <div className="dialog-foot">
                <Dialog.Close className="btn btn-ghost">取消</Dialog.Close>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    if (conflict) socket.current?.send({ type: 'send', ...conflict, confirm: true });
                    setConflict(undefined);
                  }}
                >
                  仍然发送
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </UsageProvider>
  );
}
