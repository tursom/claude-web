import { useEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Sun,
} from 'lucide-react';
import type { Session, Status } from '../../../shared/protocol';
import './layout.css';
import { UsageIndicator } from './Usage';

export interface SidebarProps {
  sessions: Session[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  maxLiveSessions: number;
  theme: 'system' | 'light' | 'dark';
  onTheme: () => void;
}

const projectName = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) || '/';
const statusNames: Record<Status, string> = {
  running: '运行中',
  waiting: '待确认',
  idle: '空闲',
  closed: '未运行',
};

function relativeTime(timestamp: number, now: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const age = Math.max(0, now - timestamp);
  if (age < 60_000) return '刚刚';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟`;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '昨天';
  if (date.getFullYear() === new Date(now).getFullYear())
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function readCollapsed(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('cw.groups.collapsed') || '[]');
    return new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function Sidebar({
  sessions,
  selectedId,
  onSelect,
  onNew,
  onClose,
  maxLiveSessions,
  theme,
  onTheme,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [allGroups, setAllGroups] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now);
  const searchRef = useRef<HTMLInputElement>(null);
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;
  const themeLabel = theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色' : '深色';
  const searching = query.trim().length > 0;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const focusSearch = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.altKey &&
        window.matchMedia('(min-width: 640px)').matches &&
        searchRef.current?.getClientRects().length
      ) {
        event.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', focusSearch);
    };
  }, []);

  const { waiting, groups } = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    const filtered = sessions
      .filter((session) =>
        [session.customTitle, session.summary, session.firstPrompt, session.cwd].some((value) =>
          value?.toLocaleLowerCase().includes(term),
        ),
      )
      .sort((a, b) => b.lastModified - a.lastModified);
    const byProject = new Map<string, Session[]>();
    for (const session of filtered) {
      if (session.status === 'waiting') continue;
      const group = byProject.get(session.cwd) || [];
      group.push(session);
      byProject.set(session.cwd, group);
    }
    return { waiting: filtered.filter((session) => session.status === 'waiting'), groups: [...byProject] };
  }, [sessions, query]);
  const liveCount = sessions.filter((session) => session.status !== 'closed').length;

  function toggleGroup(cwd: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      try {
        localStorage.setItem('cw.groups.collapsed', JSON.stringify([...next]));
      } catch {
        /* Storage may be disabled. */
      }
      return next;
    });
  }

  function sessionRow(session: Session, inWaiting = false) {
    return (
      <button
        type="button"
        key={session.sessionId}
        className={`cw-session${selectedId === session.sessionId ? ' cw-session-selected' : ''}`}
        onClick={() => onSelect(session.sessionId)}
        aria-current={selectedId === session.sessionId ? 'page' : undefined}
      >
        <span
          className={`cw-dot cw-dot-${session.status}`}
          role="img"
          aria-label={statusNames[session.status]}
        />
        <span className="cw-session-title cw-ellipsis">
          {session.customTitle || session.summary || session.firstPrompt || '新建会话'}
        </span>
        <time
          className="cw-session-time"
          dateTime={
            Number.isFinite(new Date(session.lastModified).getTime())
              ? new Date(session.lastModified).toISOString()
              : undefined
          }
        >
          {relativeTime(session.lastModified, now)}
        </time>
        <span className="cw-session-meta cw-ellipsis">
          {inWaiting ? (
            <span className="cw-ellipsis">
              {projectName(session.cwd)}
              {session.gitBranch ? ` · ${session.gitBranch}` : ''}
            </span>
          ) : (
            <>
              <GitBranch className="cw-branch-icon" size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="cw-ellipsis">{session.gitBranch}</span>
            </>
          )}
        </span>
      </button>
    );
  }

  return (
    <aside className="cw-sidebar" aria-label="会话">
      <header className="cw-sidebar-head">
        <span className="cw-app-name">claude-web</span>
        <button
          type="button"
          className="cw-icon-button cw-desktop-only"
          onClick={onTheme}
          title={themeLabel}
          aria-label={themeLabel}
        >
          <ThemeIcon size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="cw-icon-button cw-desktop-only"
          onClick={onClose}
          title="收起侧栏 (Ctrl+B)"
          aria-label="收起侧栏"
        >
          <PanelLeftClose size={16} strokeWidth={1.75} />
        </button>
        <button type="button" className="cw-icon-button cw-mobile-only" onClick={onNew} aria-label="新建会话">
          <Plus size={20} strokeWidth={1.75} />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="cw-icon-button cw-mobile-only" aria-label="更多">
              <MoreHorizontal size={20} strokeWidth={1.75} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="cw-layout-menu" align="end" sideOffset={4}>
              <DropdownMenu.Item className="cw-layout-menu-item" onSelect={onTheme}>
                <ThemeIcon size={16} strokeWidth={1.75} />
                {themeLabel}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      <label className="cw-session-search">
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话"
          aria-label="搜索会话"
          type="search"
        />
      </label>
      <div className="cw-sidebar-new cw-desktop-only">
        <button type="button" className="cw-layout-button cw-secondary" onClick={onNew}>
          <Plus size={16} strokeWidth={1.75} />
          新建会话
        </button>
      </div>
      <div className="cw-sidebar-list">
        {waiting.length > 0 && (
          <section aria-label="待确认">
            <div className="cw-group-title cw-group-fixed">
              待确认 <span className="cw-group-count">{waiting.length}</span>
            </div>
            {waiting.map((session) => sessionRow(session, true))}
          </section>
        )}
        {groups.map(([cwd, items]) => {
          const folded = !searching && collapsed.has(cwd);
          const liveStatus = items.some((session) => session.status === 'running')
            ? 'running'
            : items.some((session) => session.status === 'idle')
              ? 'idle'
              : undefined;
          const showAll = searching || allGroups.has(cwd);
          return (
            <section key={cwd} aria-label={projectName(cwd)}>
              <button
                type="button"
                className="cw-group-title"
                title={cwd}
                aria-expanded={!folded}
                onClick={() => toggleGroup(cwd)}
              >
                {folded ? (
                  <ChevronRight size={14} strokeWidth={1.75} />
                ) : (
                  <ChevronDown size={14} strokeWidth={1.75} />
                )}
                <span className="cw-ellipsis">{projectName(cwd)}</span>
                <span className="cw-group-count">{items.length}</span>
                {folded && liveStatus && (
                  <span
                    className={`cw-dot cw-dot-${liveStatus}`}
                    role="img"
                    aria-label={statusNames[liveStatus]}
                  />
                )}
              </button>
              {!folded && (
                <>
                  {(showAll ? items : items.slice(0, 5)).map((session) => sessionRow(session))}
                  {!showAll && items.length > 5 && (
                    <button
                      type="button"
                      className="cw-show-all"
                      onClick={() => setAllGroups((current) => new Set(current).add(cwd))}
                    >
                      显示全部 {items.length} 个
                    </button>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
      <UsageIndicator location="sidebar" />
      <footer className="cw-sidebar-footer cw-desktop-only">
        {liveCount > 0 ? (
          <>
            <span
              className={`cw-dot cw-dot-${sessions.some((session) => session.status === 'running') ? 'running' : sessions.some((session) => session.status === 'waiting') ? 'waiting' : 'idle'}`}
              aria-hidden="true"
            />
            {liveCount} 个运行中 · 上限 {maxLiveSessions}
          </>
        ) : (
          '没有运行中的会话'
        )}
      </footer>
    </aside>
  );
}

export default Sidebar;
