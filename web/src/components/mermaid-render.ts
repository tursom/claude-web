// Mermaid's configuration is global. Serialize initialization and rendering so
// concurrent diagrams/theme changes cannot overwrite one another's settings.
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

export function renderMermaid(code: string, dark: boolean, signal: AbortSignal): Promise<string> {
  const result = queue.then(async () => {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (code.length > 50_000) throw new Error('图表超过 50,000 字符，请缩小图表后重试。');
    const { default: mermaid } = await import('mermaid');
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      theme: dark ? 'dark' : 'default',
      fontFamily: 'system-ui, sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'dompurifyConfig',
        'themeCSS',
        'htmlLabels',
      ],
    });
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
    container.setAttribute('aria-hidden', 'true');
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`cw-mermaid-${++sequence}`, code, container);
      return svg;
    } finally {
      container.remove();
    }
  });
  queue = result.catch(() => {});
  return result;
}
