import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8504', '/ws': { target: 'ws://127.0.0.1:8504', ws: true } },
    fs: { allow: ['..'] },
  },
});
