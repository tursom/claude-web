import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../server/config.js';
import { Paths } from '../server/paths.js';
import { SessionManager } from '../server/session-manager.js';
import { UploadStore } from '../server/uploads.js';
// Initialize and release two actual CLI processes without sending model prompts.
const cwd = await mkdtemp(path.join(tmpdir(), 'claude-web-runtime-probe-'));
const config = parseConfig({
  owner: 'probe@example.com',
  allowedOrigins: ['http://localhost'],
  workspaceRoots: [cwd],
  claudePath: process.env.CLAUDE_PATH ?? '/usr/bin/claude',
  maxLiveSessions: 2,
});
const paths = new Paths(config.workspaceRoots);
await paths.init();
const uploads = new UploadStore();
const manager = new SessionManager(config, paths, uploads);
const timer = setTimeout(() => void manager.close(), 20000);
const started = Date.now();
try {
  const ids = await Promise.all([manager.create(cwd, 'default'), manager.create(cwd, 'plan')]);
  const initializedMs = Date.now() - started;
  const releasing = Date.now();
  await Promise.all(ids.map((id) => manager.release(id)));
  if (ids.some((id) => manager.get(id))) throw new Error('A released Runtime is still live');
  console.log(
    JSON.stringify(
      {
        initialized: 2,
        initializedMs,
        released: 2,
        releaseMs: Date.now() - releasing,
        modelsAvailable: (await manager.models()).length > 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await manager.close();
  await uploads.close();
  await rm(cwd, { recursive: true, force: true });
}
