import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  Folder,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import type { TreeEntry } from '../../../shared/protocol';
import { api } from '../api/client';
import { Code } from './Code';
import { DiffView } from './DiffView';
import { HtmlViewer, isHtmlFile } from './HtmlViewer';
import { MarkdownFile, isMarkdownFile } from './Markdown';
import { PanelHeader } from './PanelHeader';
import './layout.css';

const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);
const panelTabs = ['files', 'diff', 'terminal'] as const;
const panelLabels = { files: '文件', diff: 'Diff', terminal: '终端' };

export interface SidePanelProps {
  cwd: string;
  tab: 'files' | 'diff' | 'terminal';
  path?: string;
  onTab: (tab: 'files' | 'diff' | 'terminal') => void;
  onClose: () => void;
  onPath: (path?: string) => void;
  refreshKey?: number;
  expanded?: boolean;
  onExpanded?: (expanded: boolean) => void;
  onError?: (message: string) => void;
}
interface FileContent {
  path: string;
  content: string;
  text: boolean;
  truncated: boolean;
  lines: number;
}
export interface DiffFile {
  path: string;
  status: 'M' | 'A' | 'D';
  added: number;
  deleted: number;
  patch: string;
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function RequestError({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return visible ? (
    <div className="cw-layout-toast" role="alert">
      {message}
    </div>
  ) : null;
}

function gitPath(value: string, stripPrefix = true) {
  let path = value.split('\t')[0];
  if (path.startsWith('"')) {
    try {
      // Git quotes special characters, including UTF-8 bytes as octal escapes.
      path = path.slice(1, path.lastIndexOf('"'));
      const bytes: number[] = [];
      const encoder = new TextEncoder();
      for (const match of path.matchAll(/\\([0-7]{3}|[\\"tnr])|([^\\]+)|\\(.)/g)) {
        if (match[1] && /^[0-7]{3}$/.test(match[1])) bytes.push(parseInt(match[1], 8));
        else
          bytes.push(
            ...encoder.encode(match[2] ?? { t: '\t', n: '\n', r: '\r' }[match[1]] ?? match[1] ?? match[3]),
          );
      }
      path = new TextDecoder().decode(new Uint8Array(bytes));
    } catch {
      /* Keep the server's path if an unusual Git escape cannot be decoded. */
    }
  }
  return stripPrefix ? path.replace(/^[ab]\//, '') : path;
}

export function parseDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];
  return diff
    .split(/(?=^diff --git )/m)
    .filter((block) => block.trim())
    .map((patch) => {
      const lines = patch.split('\n');
      const header = /^diff --git (.+?) ("?b\/.+)$/m.exec(patch);
      const oldHeader = lines.find((line) => line.startsWith('--- '));
      const newHeader = lines.find((line) => line.startsWith('+++ '));
      const renamed = lines.find((line) => line.startsWith('rename to '));
      const added = /^new file mode /m.test(patch) || oldHeader === '--- /dev/null';
      const deleted = /^deleted file mode /m.test(patch) || newHeader === '+++ /dev/null';
      const path = renamed
        ? gitPath(renamed.slice(10), false)
        : newHeader && !deleted
          ? gitPath(newHeader.slice(4))
          : oldHeader
            ? gitPath(oldHeader.slice(4))
            : header
              ? gitPath(header[2])
              : '';
      let additions = 0,
        deletions = 0,
        inHunk = false;
      for (const line of lines) {
        if (line.startsWith('@@ ')) inHunk = true;
        else if (inHunk && line.startsWith('+')) additions++;
        else if (inHunk && line.startsWith('-')) deletions++;
      }
      return {
        path,
        status: added ? ('A' as const) : deleted ? ('D' as const) : ('M' as const),
        added: additions,
        deleted: deletions,
        patch,
      };
    })
    .filter((file) => file.path);
}

function PathLabel({ path }: { path: string }) {
  const lastSlash = path.lastIndexOf('/') + 1;
  return (
    <span className="cw-file-path cw-ellipsis" title={path}>
      <span className="cw-path-directory">{path.slice(0, lastSlash)}</span>
      {path.slice(lastSlash)}
    </span>
  );
}

function TreeBranch({
  cwd,
  directory = '',
  depth = 0,
  open = true,
  refreshKey,
  onPath,
}: {
  cwd: string;
  directory?: string;
  depth?: number;
  open?: boolean;
  refreshKey: number;
  onPath: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<{ key: string; entries: TreeEntry[] }>();
  const [error, setError] = useState('');
  const key = JSON.stringify([cwd, directory, refreshKey]);
  useEffect(() => {
    if (!open || cache?.key === key) return;
    const controller = new AbortController();
    setError('');
    api<{ entries: TreeEntry[] }>(`/api/fs/tree?${new URLSearchParams({ cwd, path: directory })}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setCache({ key, entries: result.entries });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(`操作失败：${errorMessage(error)}`);
      });
    return () => controller.abort();
  }, [cwd, directory, key, open, cache?.key]);

  return (
    <ul className="cw-tree-branch" hidden={!open}>
      {error ? (
        <li>
          <RequestError message={error} />
        </li>
      ) : cache?.key !== key ? (
        <li className="cw-layout-loading" role="status" aria-label="文件">
          <LoaderCircle size={16} strokeWidth={1.75} className="cw-layout-spin" />
        </li>
      ) : (
        cache.entries.map((entry) => {
          const isOpen = expanded.has(entry.path);
          return (
            <li key={entry.path}>
              <button
                type="button"
                className="cw-tree-row"
                style={{ paddingLeft: 12 + depth * 16 }}
                aria-expanded={entry.directory ? isOpen : undefined}
                onClick={() => {
                  if (!entry.directory) {
                    onPath(entry.path);
                    return;
                  }
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  });
                }}
                title={entry.path}
              >
                {entry.directory ? (
                  <>
                    {isOpen ? (
                      <ChevronDown size={16} strokeWidth={1.75} />
                    ) : (
                      <ChevronRight size={16} strokeWidth={1.75} />
                    )}
                    <Folder size={16} strokeWidth={1.75} />
                  </>
                ) : (
                  <>
                    <span className="cw-tree-spacer" />
                    <File size={16} strokeWidth={1.75} />
                  </>
                )}
                <span className="cw-ellipsis">{entry.name}</span>
              </button>
              {entry.directory && entry.expandable !== false && (
                <TreeBranch
                  cwd={cwd}
                  directory={entry.path}
                  depth={depth + 1}
                  open={open && isOpen}
                  refreshKey={refreshKey}
                  onPath={onPath}
                />
              )}
            </li>
          );
        })
      )}
    </ul>
  );
}

function languageFor(path: string) {
  const name = path.split('/').at(-1)?.toLowerCase() || '';
  if (name === 'dockerfile') return 'dockerfile';
  const extension = name.split('.').at(-1) || 'text';
  return (
    (
      {
        ts: 'typescript',
        tsx: 'tsx',
        js: 'javascript',
        jsx: 'jsx',
        mjs: 'javascript',
        cjs: 'javascript',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        sh: 'bash',
        yml: 'yaml',
        md: 'markdown',
        h: 'c',
        kt: 'kotlin',
      } as Record<string, string>
    )[extension] || extension
  );
}

function FilesPanel({
  cwd,
  path,
  onPath,
  refreshKey,
}: Pick<SidePanelProps, 'cwd' | 'path' | 'onPath'> & { refreshKey: number }) {
  const [loaded, setLoaded] = useState<{ path: string; file: FileContent; revision: number }>();
  const file = loaded?.path === path ? loaded?.file : undefined;
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(toastTimer.current);
    },
    [],
  );
  useEffect(() => {
    setError('');
    setLoading(Boolean(path));
    if (!path) {
      setLoaded(undefined);
      return;
    }
    const controller = new AbortController();
    api<FileContent>(`/api/fs/file?${new URLSearchParams({ cwd, path })}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((result) => {
        if (!controller.signal.aborted)
          setLoaded((previous) => ({ path, file: result, revision: (previous?.revision ?? 0) + 1 }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(`操作失败：${errorMessage(error)}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cwd, path, refreshKey, reload]);

  async function copyPath() {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`);
      setToast('已复制');
    } catch (error) {
      setToast(`操作失败：${errorMessage(error)}`);
    }
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3000);
  }

  return (
    <div className="cw-files-panel">
      {!path && (
        <div className="cw-file-list-head">
          <span>项目文件</span>
          <button
            type="button"
            className="cw-file-refresh"
            aria-label="刷新文件列表"
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      )}
      <div className="cw-panel-scroll" hidden={Boolean(path)}>
        <TreeBranch cwd={cwd} refreshKey={refreshKey + reload} onPath={onPath} />
      </div>
      {path && (
        <>
          <header className="cw-file-view-head">
            <button
              type="button"
              className="cw-icon-button"
              onClick={() => onPath(undefined)}
              aria-label="返回"
            >
              <ArrowLeft size={16} strokeWidth={1.75} />
            </button>
            <PathLabel path={path} />
            {file?.text && <span className="cw-file-line-count">{file.lines} 行</span>}
            <button
              type="button"
              className="cw-file-refresh"
              aria-label="刷新文件"
              title="刷新文件"
              disabled={loading}
              onClick={() => setReload((value) => value + 1)}
            >
              <RefreshCw size={16} strokeWidth={1.75} className={loading ? 'cw-layout-spin' : undefined} />
              刷新
            </button>
            <button
              type="button"
              className="cw-icon-button"
              aria-label="复制路径"
              title="复制路径"
              onClick={() => void copyPath()}
            >
              <Copy size={16} strokeWidth={1.75} />
            </button>
          </header>
          {file?.truncated && <div className="cw-file-warning">文件过大，只显示前 1 MB</div>}
          {error && (
            <div className="cw-file-warning" role="alert">
              {error}
              {file ? '；保留上次内容。' : ''}
            </div>
          )}
          <div
            className={`cw-panel-scroll cw-file-content${isHtmlFile(path) ? ' cw-file-html' : isMarkdownFile(path) ? ' cw-file-markdown' : ''}`}
            aria-busy={loading}
          >
            {error && !file ? (
              <div className="cw-layout-empty">无法读取文件，请点击刷新重试。</div>
            ) : !file ? (
              <div className="cw-layout-loading" role="status" aria-label="文件">
                <LoaderCircle size={16} strokeWidth={1.75} className="cw-layout-spin" />
              </div>
            ) : !file.text ? (
              <div className="cw-layout-empty">不是文本文件</div>
            ) : isHtmlFile(path) ? (
              <HtmlViewer
                key={path}
                html={file.content}
                title={path}
                truncated={file.truncated}
                fill
                revision={loaded?.revision}
                refreshing={loading}
                onRefresh={() => setReload((value) => value + 1)}
                refreshError={error ? `${error}；保留上次内容。` : undefined}
              />
            ) : isMarkdownFile(path) ? (
              <MarkdownFile
                key={path}
                text={file.content}
                truncated={file.truncated}
                cwd={cwd}
                documentPath={path}
                onOpenFile={onPath}
              />
            ) : (
              <Code code={file.content} language={languageFor(path)} lines />
            )}
          </div>
        </>
      )}
      {toast && (
        <div className="cw-layout-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function DiffsPanel({ cwd, refreshKey }: { cwd: string; refreshKey: number }) {
  const [staged, setStaged] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedPath, setSelectedPath] = useState<string>();
  const [detail, setDetail] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');
  const requestKey = JSON.stringify([cwd, staged, refresh, refreshKey]);
  const files = useMemo(() => parseDiff(diff), [diff]);
  const selected = files.find((file) => file.path === selectedPath) || files[0];
  const totals = files.reduce(
    (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
    { added: 0, deleted: 0 },
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<{ diff: string }>(`/api/git/diff?${new URLSearchParams({ cwd, staged: String(staged) })}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setDiff(result.diff);
          setLoadedKey(requestKey);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(
            errorMessage(error) === '不是 git 仓库' ? '不是 git 仓库' : `操作失败：${errorMessage(error)}`,
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cwd, staged, requestKey]);
  useEffect(() => {
    setSelectedPath(undefined);
    setDetail(false);
  }, [cwd, staged]);
  const ready = !loading && loadedKey === requestKey;

  return (
    <div className={`cw-diffs-panel${detail ? ' cw-diff-detail' : ''}`}>
      <div className="cw-panel-tools">
        <div className="cw-segment" role="group" aria-label="Diff">
          <button type="button" aria-pressed={!staged} onClick={() => setStaged(false)}>
            工作区
          </button>
          <button type="button" aria-pressed={staged} onClick={() => setStaged(true)}>
            暂存区
          </button>
        </div>
        <span className="cw-diff-summary">
          {ready && !error && (
            <>
              {files.length} 个文件 <span className="cw-diff-plus">+{totals.added}</span>{' '}
              <span className="cw-diff-minus">−{totals.deleted}</span>
            </>
          )}
        </span>
        <button
          type="button"
          className="cw-icon-button"
          onClick={() => setRefresh((value) => value + 1)}
          aria-label="刷新"
          title="刷新"
        >
          <RefreshCw size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="cw-panel-scroll cw-diff-scroll">
        {error ? (
          error === '不是 git 仓库' ? (
            <div className="cw-layout-empty">{error}</div>
          ) : (
            <RequestError message={error} />
          )
        ) : !ready ? (
          <div className="cw-layout-loading" role="status" aria-label="Diff">
            <LoaderCircle size={16} strokeWidth={1.75} className="cw-layout-spin" />
          </div>
        ) : files.length === 0 ? (
          <div className="cw-layout-empty">没有未提交的改动</div>
        ) : (
          <>
            <div className="cw-diff-file-list" aria-label="Diff">
              {files.map((file, index) => (
                <button
                  type="button"
                  key={`${file.path}:${index}`}
                  className={`cw-diff-file-row${selected?.path === file.path ? ' cw-diff-file-selected' : ''}`}
                  onClick={() => {
                    setSelectedPath(file.path);
                    setDetail(true);
                  }}
                  aria-pressed={selected?.path === file.path}
                >
                  <span className={`cw-file-status cw-file-status-${file.status}`}>{file.status}</span>
                  <PathLabel path={file.path} />
                  <span className="cw-diff-plus">+{file.added}</span>
                  <span className="cw-diff-minus">−{file.deleted}</span>
                </button>
              ))}
            </div>
            {selected && (
              <section className="cw-selected-diff" aria-label={selected.path}>
                <header className="cw-diff-file-head">
                  <button
                    type="button"
                    className="cw-icon-button cw-mobile-only"
                    onClick={() => setDetail(false)}
                    aria-label="返回"
                  >
                    <ArrowLeft size={16} strokeWidth={1.75} />
                  </button>
                  <span className={`cw-file-status cw-file-status-${selected.status}`}>
                    {selected.status}
                  </span>
                  <PathLabel path={selected.path} />
                </header>
                {selected.added + selected.deleted > 2000 ? (
                  <div className="cw-layout-empty">改动过大，未显示</div>
                ) : (
                  <DiffView patch={selected.patch} />
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SidePanel({
  cwd,
  tab,
  path,
  onTab,
  onClose,
  onPath,
  refreshKey = 0,
  expanded,
  onExpanded,
  onError,
}: SidePanelProps) {
  return (
    <section className="cw-side-panel" aria-label={panelLabels[tab]}>
      <PanelHeader
        tabs={panelTabs.map((value) => ({ value, label: panelLabels[value] }))}
        value={tab}
        onSelect={onTab}
        expanded={expanded}
        onExpanded={onExpanded}
        onClose={onClose}
      />
      <div className="cw-panel-body" role="tabpanel" aria-label={panelLabels[tab]}>
        {tab === 'files' ? (
          <FilesPanel key={cwd} cwd={cwd} path={path} onPath={onPath} refreshKey={refreshKey} />
        ) : tab === 'terminal' ? (
          <Suspense
            fallback={
              <div className="cw-layout-loading" role="status" aria-label="终端">
                <LoaderCircle className="cw-layout-spin" />
              </div>
            }
          >
            <TerminalPanel cwd={cwd} onError={onError} />
          </Suspense>
        ) : (
          <DiffsPanel key={cwd} cwd={cwd} refreshKey={refreshKey} />
        )}
      </div>
    </section>
  );
}

export default SidePanel;
