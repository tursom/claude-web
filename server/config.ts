import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const schema = z
  .object({
    listen: z.string().default('127.0.0.1:8504'),
    authMode: z.enum(['ownerHeader', 'proxy']).optional(),
    owner: z.email().optional(),
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
    autoCompactBeforeExpiry: z.boolean().optional(),
    sessionAutoCompactBeforeExpiry: z.record(z.uuid(), z.boolean()).optional(),
    usageAudit: z
      .object({
        enabled: z.boolean().default(false),
        dir: z.string().startsWith('/').optional(),
        quotaIntervalMinutes: z.number().int().min(5).max(60).default(10),
        retentionDays: z.number().int().min(1).max(365).default(30),
      })
      .optional(),
    terminal: z
      .object({
        shell: z.string().startsWith('/').optional(),
        maxTerminals: z.number().int().min(1).max(32).default(8),
        maxPerProject: z.number().int().min(1).max(16).default(4),
      })
      .optional(),
  })
  .refine((value) => value.authMode === 'proxy' || !!value.owner, {
    path: ['owner'],
    message: 'owner is required in ownerHeader mode',
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

export function autoCompactSetting(config: Config, sessionId?: string): boolean {
  return (
    (sessionId ? config.sessionAutoCompactBeforeExpiry?.[sessionId] : undefined) ??
    config.autoCompactBeforeExpiry ??
    false
  );
}

/** Called serially by the settings routes; preserve unrelated and unknown config fields. */
export async function saveAutoCompactSetting(
  path: string,
  enabled: boolean,
  sessionId?: string,
): Promise<void> {
  const target = await realpath(path);
  const raw = JSON.parse(await readFile(target, 'utf8'));
  parseConfig(raw);
  const updated = sessionId
    ? {
        ...raw,
        sessionAutoCompactBeforeExpiry: { ...raw.sessionAutoCompactBeforeExpiry, [sessionId]: enabled },
      }
    : { ...raw, autoCompactBeforeExpiry: enabled };
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function listenAddress(value: string) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
  if (!match || +match[3] < 1 || +match[3] > 65535) throw new Error('listen must be host:port');
  return { host: match[1] ?? match[2], port: +match[3] };
}
