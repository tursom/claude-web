import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

type SavedSessionUsage = { total_cost_usd: number; modelUsage: Record<string, unknown> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function usage(record: Record<string, unknown>): SavedSessionUsage | null {
  if (record.type !== 'cost-state' || !nonnegative(record.totalCostUSD) || !object(record.modelUsage))
    return null;
  for (const model of Object.values(record.modelUsage)) {
    if (!object(model) || !nonnegative(model.costUSD)) return null;
    if (!tokenFields.every((key) => nonnegative(model[key]) && Number.isSafeInteger(model[key]))) return null;
    // Preserve CLI extension fields, but never forward invalid numeric usage.
    if (Object.values(model).some((value) => typeof value === 'number' && !nonnegative(value))) return null;
  }
  return { total_cost_usd: record.totalCostUSD, modelUsage: record.modelUsage };
}

async function canonicalCwd(cwd: string): Promise<string> {
  const path = await realpath(cwd).catch(() => resolve(cwd));
  return process.platform === 'darwin' ? path.normalize('NFC') : path;
}

function projectKey(cwd: string): string {
  // claude-agent-sdk 0.3.310: sanitize, then truncate at 200 UTF-16 code units
  // and append the absolute signed 32-bit string hash in base 36.
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function* lines(file: FileHandle): AsyncGenerator<string> {
  const stream = file.createReadStream({ encoding: 'utf8', autoClose: false });
  let pending = '';
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let start = 0;
      let end: number;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        yield pending.slice(start, end);
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    if (pending) yield pending;
  } finally {
    stream.destroy();
  }
}

async function readCandidate(path: string, sessionId: string) {
  let file: FileHandle | undefined;
  try {
    // The config root is canonical. Reject symlinks in projects, the project
    // directory, and the transcript itself, including links to another project.
    if ((await realpath(path)) !== path) return null;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await file.stat();
    if (!opened.isFile() || (await realpath(path)) !== path) return null;
    const current = await lstat(path);
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) return null;

    let latest: SavedSessionUsage | null = null;
    let cwd: string | undefined;
    let relocatedCwd: string | undefined;
    for await (const line of lines(file)) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // Includes an unfinished final append; never log transcript text.
      }
      if (!object(record) || record.sessionId !== sessionId) continue;
      // Match the SDK's first cwd / latest relocation metadata semantics.
      if (cwd === undefined && typeof record.cwd === 'string') cwd = record.cwd;
      if (record.type === 'relocated' && typeof record.relocatedCwd === 'string')
        relocatedCwd = record.relocatedCwd;
      const next = usage(record);
      if (next) latest = next;
    }
    return { usage: latest, cwd: relocatedCwd ?? cwd };
  } catch {
    // Missing, unreadable, or concurrently replaced files have no usable snapshot.
    return null;
  } finally {
    await file?.close();
  }
}

/** Caller must first authorize this session and workspace using SDK session info. */
export async function readSavedSessionUsage(
  sessionId: string,
  cwd: string,
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
): Promise<SavedSessionUsage | null> {
  if (sessionId.length !== 36 || !uuid.test(sessionId) || !isAbsolute(cwd) || cwd.includes('\0')) return null;
  try {
    const workspace = await canonicalCwd(cwd);
    const projects = join(await realpath(configDir), 'projects');
    if ((await realpath(projects)) !== projects) return null;
    const preferred = projectKey(workspace);
    const matches = async (recorded: string) =>
      isAbsolute(recorded) && !recorded.includes('\0') && (await canonicalCwd(recorded)) === workspace;
    const direct = await readCandidate(join(projects, preferred, `${sessionId}.jsonl`), sessionId);
    // The authorized SDK lookup plus the exact project key is sufficient for
    // cost-only files. If cwd metadata exists, also detect encoding collisions.
    if (direct && (direct.cwd === undefined || (await matches(direct.cwd)))) return direct.usage;

    // CLI versions / project-name overrides can use different keys. Inspect only
    // this UUID in immediate project directories, never indexes or other sessions.
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === preferred) continue;
      const candidate = await readCandidate(join(projects, entry.name, `${sessionId}.jsonl`), sessionId);
      if (candidate?.cwd !== undefined && (await matches(candidate.cwd))) return candidate.usage;
    }
    return null;
  } catch {
    return null;
  }
}
