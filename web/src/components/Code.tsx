import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { bundledLanguages, codeToHtml } from 'shiki';
import './components.css';

export interface CodeProps {
  code: string;
  language?: string;
  lines?: boolean;
}

export function Code({ code, language = 'text', lines = false }: CodeProps) {
  const [rendered, setRendered] = useState({ code: '', language: '', html: '' });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const lang = language in bundledLanguages ? (language as keyof typeof bundledLanguages) : 'text';
    void codeToHtml(code, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
      .then((html) => {
        if (!cancelled) setRendered({ code, language, html });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [code, language]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 3000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const html = rendered.code === code && rendered.language === language ? rendered.html : '';
  const plainLines = code.split('\n');
  return (
    <div className={`cc-code${lines ? ' cc-code-numbered' : ''}`}>
      {!lines && (
        <div className="cc-code-head">
          <span>{language}</span>
          <button
            type="button"
            className="cc-icon"
            aria-label="复制"
            onClick={() => {
              void navigator.clipboard
                .writeText(code)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            <Copy size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {html ? (
        <div className="cc-code-content" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>
            {plainLines.map((line, index) => (
              <span className="line" key={index}>
                {line}
                {index < plainLines.length - 1 ? '\n' : ''}
              </span>
            ))}
          </code>
        </pre>
      )}
      {copied && (
        <div className="cc-copy-toast" role="status">
          已复制
        </div>
      )}
    </div>
  );
}

export default Code;
