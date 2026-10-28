import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['doc/ui/terminal-prototype.tsx'],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css =
  (await readFile('doc/ui/tokens.css', 'utf8')) + '\n' + (await readFile('doc/ui/terminal.css', 'utf8'));
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(
  'doc/ui/terminal.html',
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>claude-web · 终端交互原型</title><style>${css}</style></head>
<body><div id="root"></div><script>${script}</script></body></html>\n`,
);
console.log('Built standalone prototype: doc/ui/terminal.html');
