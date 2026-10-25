import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './paths.js';

const maxSize = 5 * 1024 * 1024;
export function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
}
export class UploadStore {
  private directory?: Promise<string>;
  private entries = new Map<string, { mime: string; expires: number; path: string }>();
  private timer = setInterval(() => void this.sweep(), 60_000).unref();
  async put(bytes: Buffer, declaredMime: string) {
    if (bytes.length > maxSize) throw new HttpError(413, '图片不能超过 5 MB');
    const mime = imageType(bytes);
    if (!mime || mime !== declaredMime) throw new HttpError(400, 'Unsupported image format');
    this.directory ??= mkdtemp(join(tmpdir(), 'claude-web-'));
    const id = randomUUID();
    const path = join(await this.directory, id);
    await writeFile(path, bytes, { mode: 0o600 });
    this.entries.set(id, { mime, expires: Date.now() + 3_600_000, path });
    return id;
  }
  async get(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.expires <= Date.now()) throw new HttpError(404, 'Image expired or not found');
    return { mime: entry.mime, bytes: await readFile(entry.path) };
  }
  async content(ids: string[]) {
    if (ids.length > 5) throw new HttpError(400, '一条消息最多 5 张图片');
    return Promise.all(
      ids.map(async (id) => {
        const { bytes, mime } = await this.get(id);
        return {
          type: 'image',
          source: { type: 'base64', media_type: mime, data: bytes.toString('base64') },
        };
      }),
    );
  }
  private async sweep() {
    for (const [id, entry] of this.entries)
      if (entry.expires <= Date.now()) {
        this.entries.delete(id);
        await rm(entry.path, { force: true }).catch(() => {});
      }
  }
  async close() {
    clearInterval(this.timer);
    if (this.directory) await rm(await this.directory, { recursive: true, force: true });
    this.entries.clear();
  }
}
