import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Maximize2, X } from 'lucide-react';
import { Code } from './Code';
import { renderMermaid } from './mermaid-render';
import './markdown.css';

function isDark() {
  return (
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

export function Mermaid({ code }: { code: string }) {
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dark, setDark] = useState(isDark);
  const [result, setResult] = useState<{ code: string; dark: boolean; svg?: string; error?: string }>();
  useEffect(() => {
    const update = () => setDark(isDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, []);
  useEffect(() => {
    if (source) return;
    const controller = new AbortController();
    // Coalesce streaming fragments; never publish stale output after a newer edit.
    const timer = window.setTimeout(() => {
      void renderMermaid(code, dark, controller.signal)
        .then((svg) => {
          if (!controller.signal.aborted) setResult({ code, dark, svg });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setResult({
              code,
              dark,
              error: error instanceof Error ? error.message.slice(0, 600) : '图表语法无效',
            });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [code, dark, source]);
  const current = result?.code === code && result.dark === dark ? result : undefined;
  const drawing = current?.svg ? (
    <div className="cw-mermaid-svg" dangerouslySetInnerHTML={{ __html: current.svg }} />
  ) : null;
  return (
    <section className="cw-mermaid" aria-label="Mermaid 图表">
      <div className="cw-mermaid-toolbar">
        <span className="cw-mermaid-label">mermaid</span>
        <div className="cw-markdown-modes" role="group" aria-label="Mermaid 查看方式">
          <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
            图表
          </button>
          <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
            源码
          </button>
        </div>
        {!source && drawing && (
          <Dialog.Root open={expanded} onOpenChange={setExpanded}>
            <Dialog.Trigger asChild>
              <button type="button" className="cw-diagram-icon" aria-label="放大图表" title="放大图表">
                <Maximize2 size={16} />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="cw-diagram-overlay" />
              <Dialog.Content className="cw-diagram-dialog" aria-describedby={undefined}>
                <header className="cw-mermaid-toolbar">
                  <Dialog.Title>Mermaid 图表</Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" className="cw-diagram-icon" aria-label="关闭放大图表">
                      <X size={20} />
                    </button>
                  </Dialog.Close>
                </header>
                <div className="cw-mermaid-canvas">{drawing}</div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>
      {source ? (
        <Code code={code} language="mermaid" />
      ) : current?.error ? (
        <>
          <p className="cw-markdown-note" role="status">
            暂时无法渲染图表，内容补全后会自动重试。
          </p>
          <details className="cw-mermaid-error">
            <summary>查看错误</summary>
            <pre>{current.error}</pre>
          </details>
          <Code code={code} language="mermaid" />
        </>
      ) : drawing ? (
        <div className="cw-mermaid-canvas">
          {expanded ? <p className="cw-markdown-note">图表已在放大视图中打开</p> : drawing}
        </div>
      ) : (
        <p className="cw-markdown-note" role="status">
          正在渲染图表…
        </p>
      )}
    </section>
  );
}
