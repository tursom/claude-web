import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = 'INVALID_REQUEST',
  ) {
    super(message);
  }
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export class Paths {
  constructor(public roots: string[]) {}
  async init() {
    this.roots = await Promise.all(this.roots.map((p) => realpath(p)));
  }
  async cwd(value: string) {
    if (!value || !path.isAbsolute(value)) throw new HttpError(400, 'cwd must be an absolute path');
    const canonical = await realpath(value);
    const roots = await Promise.all(this.roots.map((p) => realpath(p)));
    if (!roots.some((root) => within(root, canonical)))
      throw new HttpError(403, 'Path is outside workspaceRoots', 'PATH_FORBIDDEN');
    if (!(await stat(canonical)).isDirectory()) throw new HttpError(400, 'cwd is not a directory');
    return canonical;
  }
  async file(cwd: string, value = '.') {
    const root = await this.cwd(cwd);
    if (value.includes('\0')) throw new HttpError(400, 'Invalid path');
    const canonical = await realpath(path.resolve(root, value));
    if (!within(root, canonical)) throw new HttpError(403, 'Path is outside cwd', 'PATH_FORBIDDEN');
    return canonical;
  }
}
