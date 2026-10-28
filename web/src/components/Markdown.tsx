import { createContext, useContext, useId, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code } from './Code';
import { HtmlViewer } from './HtmlViewer';
import { Mermaid } from './Mermaid';
import { resolveWorkspaceFile, workspaceFileHref } from './file-links';
import './markdown.css';

interface FileLinks {
  cwd?: string;
  documentPath?: string;
  onOpenFile?: (path: string) => void;
}
const FileLinkContext = createContext<FileLinks>({});

const MarkdownLink: NonNullable<Components['a']> = ({ children, node: _node, ...props }) => {
  const { cwd, documentPath, onOpenFile } = useContext(FileLinkContext);
  const path = cwd && onOpenFile ? resolveWorkspaceFile(props.href, cwd, documentPath) : undefined;
  const href = path ? workspaceFileHref(path, window.location.pathname) : undefined;
  if (path && href && onOpenFile)
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey ||
            event.defaultPrevented
          )
            return;
          event.preventDefault();
          onOpenFile(path);
        }}
      >
        {children}
      </a>
    );
  const anchor = props.href?.startsWith('#');
  return (
    <a {...props} target={anchor ? undefined : '_blank'} rel={anchor ? undefined : 'noopener noreferrer'}>
      {children}
    </a>
  );
};

// Keep component identities stable while streamed text changes, so diagram/source
// selections survive ReactMarkdown updates instead of remounting each token.
const components: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, node, ...props }) {
    const code = String(children);
    const language = /language-(\S+)/.exec(className ?? '')?.[1];
    const block =
      !!language || code.endsWith('\n') || node?.position?.start.line !== node?.position?.end.line;
    if (!block)
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    const content = code.replace(/\n$/, '');
    if (language?.toLowerCase() === 'mermaid') return <Mermaid code={content} />;
    if (/^(html|htm)$/i.test(language ?? '')) return <HtmlViewer html={content} />;
    return <Code code={content} language={language} />;
  },
  table({ children }) {
    return (
      <div className="cw-markdown-table" role="region" aria-label="表格，可横向滚动" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
  a: MarkdownLink,
};

export function Markdown({ text, cwd, documentPath, onOpenFile }: { text: string } & FileLinks) {
  const prefix = `md-${useId().replace(/[^a-zA-Z0-9-]/g, '')}-`;
  const links = useMemo(() => ({ cwd, documentPath, onOpenFile }), [cwd, documentPath, onOpenFile]);
  return (
    <FileLinkContext.Provider value={links}>
      <div className="cc-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: '脚注' }}
          components={components}
          urlTransform={(url, key, node) =>
            key === 'href' &&
            node.tagName === 'a' &&
            cwd &&
            onOpenFile &&
            /^file:/i.test(url) &&
            resolveWorkspaceFile(url, cwd, documentPath)
              ? url
              : defaultUrlTransform(url)
          }
        >
          {text}
        </ReactMarkdown>
      </div>
    </FileLinkContext.Provider>
  );
}

export function isMarkdownFile(path: string) {
  return /\.(md|markdown)$/i.test(path);
}

export function MarkdownFile({
  text,
  truncated,
  ...links
}: { text: string; truncated: boolean } & FileLinks) {
  const [preview, setPreview] = useState(() => {
    try {
      return localStorage.getItem('cw.markdown.viewMode') === 'preview';
    } catch {
      return false;
    }
  });
  function select(value: boolean) {
    setPreview(value);
    try {
      localStorage.setItem('cw.markdown.viewMode', value ? 'preview' : 'source');
    } catch {
      /* Optional preference. */
    }
  }
  return (
    <section className="cw-markdown-file" aria-label="Markdown 文件">
      <div className="cw-markdown-modes" role="group" aria-label="Markdown 查看方式">
        <button type="button" aria-pressed={!preview} onClick={() => select(false)}>
          源码
        </button>
        <button type="button" aria-pressed={preview} onClick={() => select(true)}>
          预览
        </button>
      </div>
      {preview && truncated && <p className="cw-markdown-note">文件已截断，预览仅包含已读取的内容。</p>}
      <div className={preview ? 'cw-markdown-rendered' : 'cw-markdown-source'}>
        {preview ? (
          text.trim() ? (
            <Markdown text={text} {...links} />
          ) : (
            <p className="cw-markdown-note">文件为空</p>
          )
        ) : (
          <Code code={text} language="markdown" lines />
        )}
      </div>
    </section>
  );
}
