import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const schema = z.object({
  listen: z.string().default('127.0.0.1:8504'),
  owner: z.email(),
  allowedOrigins: z
    .array(
      z
        .url()
        .refine(
          (v) => /^https?:\/\//.test(v) && new URL(v).origin === v,
          'Origin must contain only scheme and host',
        ),
    )
    .min(1),
  workspaceRoots: z.array(z.string().startsWith('/')).min(1),
  claudePath: z.string().startsWith('/'),
  maxLiveSessions: z.number().int().min(1).max(32).default(4),
  idleCloseMinutes: z.number().positive().default(30),
});
export type Config = z.infer<typeof schema>;
export function parseConfig(value: unknown): Config {
  return schema.parse(value);
}
export async function loadConfig(path = process.env.CLAUDE_WEB_CONFIG ?? 'config.json'): Promise<Config> {
  if (process.env.ANTHROPIC_API_KEY)
    throw new Error('ANTHROPIC_API_KEY must not be set: claude-web requires CLI subscription login');
  return parseConfig(JSON.parse(await readFile(path, 'utf8')));
}
export function listenAddress(value: string) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  if (!match || +match[3] < 1 || +match[3] > 65535) throw new Error('listen must be host:port');
  return { host: match[1] ?? match[2], port: +match[3] };
}
