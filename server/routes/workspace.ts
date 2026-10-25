import type { FastifyInstance } from 'fastify';
import { readdir, stat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Paths, HttpError } from '../paths.js';
import type { TreeEntry } from '../../shared/protocol.js';
const exec = promisify(execFile);
const skip = new Set(['.git', 'node_modules', '.next', 'dist', '.cache']);
const query = (request: { query: unknown }) => request.query as Record<string, string | undefined>;
export async function registerWorkspace(app: FastifyInstance, paths: Paths) {
  async function entries(cwd: string, dir: string, onlyDirs = false): Promise<TreeEntry[]> {
    const result: TreeEntry[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const target = path.join(dir, entry.name);
      try {
        const canonical = await paths.file(cwd, target);
        const isDir = (await stat(canonical)).isDirectory();
        if (onlyDirs && !isDir) continue;
        result.push({
          name: entry.name,
          path: path.relative(cwd, target),
          directory: isDir,
          expandable: isDir && !skip.has(entry.name),
        });
      } catch {
        /* Hide inaccessible files and links outside the workspace. */
      }
    }
    return result.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  app.get('/api/dirs', async (request) => {
    const value = query(request).path;
    if (!value)
      return {
        roots: paths.roots,
        entries: paths.roots.map((root) => ({
          name: path.basename(root),
          path: root,
          directory: true,
          expandable: true,
        })),
      };
    const cwd = await paths.cwd(value);
    const parent = path.dirname(cwd);
    let allowedParent: string | undefined;
    try {
      allowedParent = await paths.cwd(parent);
    } catch {
      /* At workspace root. */
    }
    return {
      path: cwd,
      parent: allowedParent,
      roots: paths.roots,
      entries: (await entries(cwd, cwd, true)).map((item) => ({
        ...item,
        path: path.resolve(cwd, item.path),
      })),
    };
  });
  app.get('/api/fs/tree', async (request) => {
    const q = query(request);
    const cwd = await paths.cwd(q.cwd ?? '');
    const dir = await paths.file(cwd, q.path);
    if (
      path
        .relative(cwd, dir)
        .split(path.sep)
        .some((part) => skip.has(part))
    )
      return { entries: [] };
    return { entries: await entries(cwd, dir) };
  });
  app.get('/api/fs/file', async (request) => {
    const q = query(request);
    const cwd = await paths.cwd(q.cwd ?? '');
    const file = await paths.file(cwd, q.path);
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new HttpError(400, 'Not a file');
      const limit = 1024 * 1024;
      const bytes = Buffer.alloc(Math.min(info.size, limit));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const data = bytes.subarray(0, bytesRead);
      let content = '';
      let text = !data.includes(0);
      if (text) {
        try {
          content = new TextDecoder('utf8', { fatal: true }).decode(data, { stream: info.size > limit });
        } catch {
          text = false;
        }
      }
      return {
        path: path.relative(cwd, file),
        content,
        text,
        truncated: info.size > limit,
        lines: text ? content.split('\n').length : 0,
      };
    } finally {
      await handle.close();
    }
  });
  const cache = new Map<string, { at: number; files: string[] }>();
  app.get('/api/fs/search', async (request) => {
    const q = query(request);
    const cwd = await paths.cwd(q.cwd ?? '');
    let item = cache.get(cwd);
    if (!item || Date.now() - item.at > 30_000) {
      let files: string[];
      try {
        const result = await exec(
          'git',
          ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
          { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
        );
        files = result.stdout.split('\0').filter(Boolean);
      } catch {
        files = [];
        const walk = async (dir: string) => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (skip.has(entry.name) || files.length >= 50_000) continue;
            const target = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            files.push(path.relative(cwd, target) + (entry.isDirectory() ? '/' : ''));
            if (entry.isDirectory()) await walk(target);
          }
        };
        await walk(cwd);
      }
      const all = new Set(files);
      for (const f of files) {
        let dir = path.dirname(f);
        while (dir !== '.') {
          all.add(`${dir}/`);
          const next = path.dirname(dir);
          if (next === dir) break;
          dir = next;
        }
      }
      item = { at: Date.now(), files: [...all] };
      cache.set(cwd, item);
    }
    const needle = (q.q ?? '').toLowerCase().slice(0, 200);
    const score = (s: string) => {
      const v = s.toLowerCase();
      const i = v.indexOf(needle);
      if (i >= 0) return i;
      let index = 0;
      for (const c of v) if (c === needle[index]) index++;
      return index === needle.length ? 1000 + s.length : Infinity;
    };
    const candidates = item.files
      .map((file) => ({ file, score: score(file) }))
      .filter((v) => Number.isFinite(v.score))
      .sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));
    const found: string[] = [];
    for (const { file } of candidates) {
      try {
        await paths.file(cwd, file);
        found.push(file);
      } catch {}
      if (found.length === 50) break;
    }
    return { paths: found };
  });
  app.get('/api/git/diff', async (request) => {
    const q = query(request);
    const cwd = await paths.cwd(q.cwd ?? '');
    try {
      await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 });
      const result = await exec(
        'git',
        [
          '-C',
          cwd,
          '-c',
          'core.quotePath=false',
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          ...(q.staged === 'true' ? ['--cached'] : []),
          '--',
          '.',
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
      );
      return { diff: result.stdout };
    } catch (error: any) {
      if (error.stderr?.includes('not a git repository'))
        throw new HttpError(400, '不是 git 仓库', 'NOT_GIT_REPOSITORY');
      throw new HttpError(400, 'Unable to read git diff');
    }
  });
}
