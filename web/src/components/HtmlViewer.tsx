import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Maximize2, RefreshCw, X } from 'lucide-react';
import { Code } from './Code';
import './html-viewer.css';

// Static previews match PI WEB; interactive previews opt into inline scripts only.
// The iframe owns sandboxing; CSP sandbox/frame-ancestors are not valid in a meta tag.
const previewPolicy =
  "default-src 'none'; base-uri about:; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; worker-src 'none'";
const maxPreviewBytes = 1024 * 1024;
const modeKey = 'cw.html.viewMode';
type ViewMode = 'source' | 'preview' | 'interactive';

export function isHtmlFile(path: string) {
  return /\.html?$/i.test(path);
}

function storedMode(): 'source' | 'preview' {
  try {
    return localStorage.getItem(modeKey) === 'preview' ? 'preview' : 'source';
  } catch {
    return 'source';
  }
}

export function HtmlViewer({
  html,
  title = 'HTML 代码块',
  fill = false,
  truncated = false,
  revision = 0,
  refreshing = false,
  onRefresh,
  refreshError,
}: {
  html: string;
  title?: string;
  fill?: boolean;
  truncated?: boolean;
  revision?: number;
  refreshing?: boolean;
  onRefresh?: () => void;
  refreshError?: string;
}) {
  const [mode, setMode] = useState<ViewMode>(() => (fill ? storedMode() : 'source'));
  const [expanded, setExpanded] = useState(false);
  const interactive = mode === 'interactive';
  const tooLarge = useMemo(
    () => truncated || new TextEncoder().encode(html).byteLength > maxPreviewBytes,
    [html, truncated],
  );
  const document = useMemo(
    () =>
      tooLarge
        ? ''
        : // srcdoc otherwise inherits the host URL as its base: clicking #route
          // would load the app (and its proxy challenge) inside the preview.
          `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${interactive ? previewPolicy.replace("script-src 'none'", "script-src 'unsafe-inline'") : previewPolicy}"><base href="about:srcdoc"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"></head>${html}`,
    [html, tooLarge, interactive],
  );
  const preview = mode !== 'source' && !tooLarge;

  function select(next: ViewMode) {
    setMode(next);
    if (fill) {
      try {
        // Script execution is a choice for this document, never inherited by the next file.
        localStorage.setItem(modeKey, next === 'interactive' ? 'preview' : next);
      } catch {
        /* Private browsing may disable storage. */
      }
    }
  }

  function frame(large = false) {
    return (
      <iframe
        key={`${mode}:${revision}`}
        className="cw-html-frame"
        title={`${large ? '放大预览' : 'HTML 预览'}：${title}`}
        srcDoc={document}
        sandbox={interactive ? 'allow-scripts' : ''}
        allow=""
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <section className={`cw-html-viewer${fill ? ' cw-html-fill' : ''}`} aria-label={title}>
      <div className="cw-html-toolbar">
        <div className="cw-html-modes" role="group" aria-label="HTML 查看方式">
          <button type="button" aria-pressed={!preview} onClick={() => select('source')}>
            源码
          </button>
          <button
            type="button"
            aria-pressed={preview && !interactive}
            disabled={tooLarge}
            onClick={() => select('preview')}
          >
            预览
          </button>
          <button
            type="button"
            aria-pressed={preview && interactive}
            disabled={tooLarge}
            onClick={() => select('interactive')}
          >
            交互预览
          </button>
        </div>
        {preview && (
          <span
            className="cw-html-note"
            title={
              interactive
                ? '运行本页内联脚本；外部资源、网络接口和主界面访问保持隔离。'
                : '支持 HTML、内联 CSS 和嵌入图片；脚本和外部资源不加载。'
            }
          >
            {interactive ? '隔离运行' : '静态预览'}
          </span>
        )}
        {preview && (
          <Dialog.Root open={expanded} onOpenChange={setExpanded}>
            <Dialog.Trigger asChild>
              <button type="button" className="cw-html-icon" aria-label="放大预览" title="放大预览">
                <Maximize2 size={16} />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="cw-html-overlay" />
              <Dialog.Content className="cw-html-dialog" aria-describedby={undefined}>
                <header className="cw-html-dialog-head">
                  <Dialog.Title title={title}>{title}</Dialog.Title>
                  {onRefresh && (
                    <button
                      type="button"
                      className="cw-file-refresh"
                      aria-label="刷新文件"
                      onClick={onRefresh}
                      disabled={refreshing}
                    >
                      <RefreshCw size={16} className={refreshing ? 'cw-layout-spin' : undefined} />
                      刷新
                    </button>
                  )}
                  <Dialog.Close asChild>
                    <button type="button" className="cw-html-icon" aria-label="关闭放大预览">
                      <X size={20} />
                    </button>
                  </Dialog.Close>
                </header>
                {refreshError && (
                  <p className="cw-html-limit" role="alert">
                    {refreshError}
                  </p>
                )}
                {frame(true)}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>
      {tooLarge && (
        <p className="cw-html-limit" role="status">
          HTML 超过 1 MB 或内容不完整，暂不提供预览。
        </p>
      )}
      {preview ? (
        html.trim() ? (
          frame()
        ) : (
          <p className="cw-html-empty">文件为空</p>
        )
      ) : (
        <div className="cw-html-source">
          <Code code={html} language="html" lines={fill} />
        </div>
      )}
    </section>
  );
}
