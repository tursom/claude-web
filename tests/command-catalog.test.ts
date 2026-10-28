import { afterEach, expect, it, vi } from 'vitest';
import { CommandCatalog } from '../server/command-catalog';
import { agentSdk } from '../server/sdk';
import { parseConfig } from '../server/config';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
const config = parseConfig({
  authMode: 'proxy',
  allowedOrigins: ['https://cc.example.com'],
  workspaceRoots: ['/tmp'],
  claudePath: '/usr/bin/claude',
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('discovers real CLI catalogs without a prompt, persistence, hooks or MCP startup', async () => {
  const close = vi.fn();
  let input: any;
  vi.spyOn(agentSdk, 'query').mockImplementation((args) => {
    input = args;
    return {
      initializationResult: async () => ({
        commands: [{ name: 'compact', description: 'Compact', argumentHint: '[instructions]' }],
        account: { apiKeySource: 'none', apiProvider: 'firstParty' },
      }),
      close,
    } as unknown as Query;
  });
  const catalog = new CommandCatalog(config);
  try {
    expect(await catalog.read('/tmp')).toEqual([
      { name: 'compact', description: 'Compact', argumentHint: '[instructions]' },
    ]);
    expect(input.options).toMatchObject({
      cwd: '/tmp',
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      tools: [],
    });
    expect(await input.prompt.next()).toMatchObject({ done: true });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await catalog.close();
  }
});
it('shares concurrent requests and cancels initialization on shutdown', async () => {
  const close = vi.fn();
  const query = vi
    .spyOn(agentSdk, 'query')
    .mockReturnValue({ initializationResult: () => new Promise(() => {}), close } as unknown as Query);
  const catalog = new CommandCatalog(config);
  const first = catalog.read('/tmp');
  const second = catalog.read('/tmp');
  expect(second).toBe(first);
  const rejection = expect(first).rejects.toThrow('取消');
  await Promise.resolve();
  await catalog.close();
  await rejection;
  expect(query).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
