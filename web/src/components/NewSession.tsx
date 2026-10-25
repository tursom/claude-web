import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Folder, LoaderCircle, X } from 'lucide-react';
import type { Mode, Session, TreeEntry } from '../../../shared/protocol';
import { api } from '../api/client';
import './layout.css';

export interface NewSessionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: Session[];
  initialCwd?: string;
  onCreated: (id: string) => void;
  onError: (msg: string) => void;
}
interface Directories {
  path?: string;
  parent?: string;
  entries: TreeEntry[];
  roots: string[];
}
const shortPath = (path: string) => path.replace(/^\/(?:root|home\/[^/]+)(?=\/|$)/, '~');
const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) || '/';
const modes: { value: Mode; label: string }[] = [
  { value: 'default', label: '编辑前询问' },
  { value: 'acceptEdits', label: '自动编辑' },
  { value: 'plan', label: '计划模式' },
];

export function NewSession({
  open,
  onOpenChange,
  sessions,
  initialCwd,
  onCreated,
  onError,
}: NewSessionProps) {
  const [location, setLocation] = useState<string>();
  const [dirs, setDirs] = useState<Directories>();
  const [mode, setMode] = useState<Mode>('default');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const recent = useMemo(
    () =>
      [
        ...new Set(
          [...sessions].sort((a, b) => b.lastModified - a.lastModified).map((session) => session.cwd),
        ),
      ].slice(0, 5),
    [sessions],
  );

  useEffect(() => {
    if (open) {
      setLocation(initialCwd);
      setDirs(undefined);
      setMode('default');
    }
  }, [open, initialCwd]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setDirs(undefined);
    api<Directories>(`/api/dirs${location ? `?path=${encodeURIComponent(location)}` : ''}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!location && !result.path && result.roots.length === 1) setLocation(result.roots[0]);
        else setDirs(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          errorRef.current(`操作失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, location]);

  const selected = !loading ? dirs?.path : undefined;
  const roots = dirs?.roots || [];
  const crumbs = useMemo(() => {
    if (!dirs?.path) return [];
    const root = [...roots]
      .sort((a, b) => b.length - a.length)
      .find((rootPath) => dirs.path === rootPath || dirs.path?.startsWith(`${rootPath.replace(/\/$/, '')}/`));
    const start = root || '/';
    const parts = dirs.path
      .slice(start === '/' ? 1 : start.length)
      .split('/')
      .filter(Boolean);
    let current = start.replace(/\/$/, '');
    return [
      { path: start, label: shortPath(start) },
      ...parts.map((label) => {
        current += `/${label}`;
        return { path: current, label };
      }),
    ];
  }, [dirs, roots]);

  async function create() {
    if (!selected || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const result = await api<{ sessionId: string }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selected, permissionMode: mode }),
      });
      onOpenChange(false);
      onCreated(result.sessionId);
    } catch (error) {
      errorRef.current(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!creatingRef.current) onOpenChange(value);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="cw-session-overlay" />
        <Dialog.Content className="cw-new-session" aria-describedby={undefined}>
          <div className="cw-sheet-handle" aria-hidden="true" />
          <header className="cw-new-session-head">
            <Dialog.Title className="cw-new-session-title">新建会话</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="cw-icon-button" aria-label="关闭" disabled={creating}>
                <X size={20} strokeWidth={1.75} />
              </button>
            </Dialog.Close>
          </header>
          <div className="cw-new-session-scroll">
            {recent.length > 0 && (
              <section aria-label="最近项目">
                <h3 className="cw-section-label">最近项目</h3>
                {recent.map((cwd) => (
                  <button
                    type="button"
                    className="cw-directory-row"
                    key={cwd}
                    onClick={() => setLocation(cwd)}
                    disabled={creating}
                    title={cwd}
                  >
                    <Folder size={18} strokeWidth={1.75} />
                    <span className="cw-ellipsis">{baseName(cwd)}</span>
                    <span className="cw-directory-parent cw-ellipsis">
                      {shortPath(cwd.slice(0, cwd.lastIndexOf('/')) || '/')}
                    </span>
                  </button>
                ))}
              </section>
            )}
            <section aria-label="浏览目录" aria-busy={loading}>
              <h3 className="cw-section-label">浏览目录</h3>
              <nav className="cw-directory-crumbs" aria-label="浏览目录">
                {roots.length > 1 && dirs?.path && (
                  <>
                    <button type="button" onClick={() => setLocation(undefined)} disabled={creating}>
                      浏览目录
                    </button>
                    <ChevronRight size={14} strokeWidth={1.75} />
                  </>
                )}
                {crumbs.map((crumb, index) => (
                  <span key={crumb.path} className="cw-directory-crumb">
                    <button
                      type="button"
                      onClick={() => setLocation(crumb.path)}
                      disabled={creating}
                      aria-current={index === crumbs.length - 1 ? 'location' : undefined}
                    >
                      {crumb.label}
                    </button>
                    {index < crumbs.length - 1 && <ChevronRight size={14} strokeWidth={1.75} />}
                  </span>
                ))}
              </nav>
              {loading ? (
                <div className="cw-layout-loading" role="status" aria-label="浏览目录">
                  <LoaderCircle className="cw-layout-spin" size={16} strokeWidth={1.75} />
                </div>
              ) : (
                <>
                  {!dirs?.path &&
                    roots.map((root) => (
                      <button
                        type="button"
                        className="cw-directory-row"
                        key={root}
                        onClick={() => setLocation(root)}
                        disabled={creating}
                      >
                        <Folder size={18} strokeWidth={1.75} />
                        <span className="cw-ellipsis cw-mono">{shortPath(root)}</span>
                        <ChevronRight className="cw-directory-next" size={14} strokeWidth={1.75} />
                      </button>
                    ))}
                  {dirs?.path &&
                    dirs.entries
                      .filter((entry) => entry.directory)
                      .map((entry) => (
                        <button
                          type="button"
                          key={entry.path}
                          className="cw-directory-row"
                          disabled={creating}
                          onClick={() => setLocation(entry.path)}
                        >
                          <Folder size={18} strokeWidth={1.75} />
                          <span className="cw-ellipsis">{entry.name}</span>
                          <ChevronRight className="cw-directory-next" size={14} strokeWidth={1.75} />
                        </button>
                      ))}
                </>
              )}
            </section>
          </div>
          <section className="cw-new-session-permissions" aria-label="权限模式">
            <h3 className="cw-section-label">权限模式</h3>
            <div className="cw-segment cw-permissions" role="group" aria-label="权限模式">
              {modes.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  aria-pressed={mode === item.value}
                  disabled={creating}
                  onClick={() => setMode(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>
          <div className="cw-new-session-footer">
            <button
              type="button"
              className="cw-layout-button cw-primary"
              disabled={!selected || creating}
              onClick={create}
            >
              {creating && <LoaderCircle size={16} strokeWidth={1.75} className="cw-layout-spin" />}
              <span className="cw-ellipsis">{selected ? `在 ${shortPath(selected)} 创建` : '选择目录'}</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default NewSession;
