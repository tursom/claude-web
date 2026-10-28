import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Command } from '../shared/protocol.js';
import type { Config } from './config.js';
import { agentSdk, assertSubscriptionAuth, InputQueue, sdkEnvironment, SessionError } from './sdk.js';

/** Read the local CLI command catalog without sending a prompt or resuming history. */
export class CommandCatalog {
  private inflight?: { cwd: string; result: Promise<Command[]> };
  private cancel?: () => void;
  private closed = false;
  constructor(private config: Config) {}

  read(cwd: string): Promise<Command[]> {
    if (this.closed) return Promise.reject(new SessionError('SERVER_CLOSING', '服务正在关闭'));
    if (this.inflight)
      return this.inflight.cwd === cwd
        ? this.inflight.result
        : Promise.reject(new SessionError('COMMANDS_BUSY', '正在读取其他项目的命令，请稍后重试'));
    const result = Promise.resolve()
      .then(() => this.probe(cwd))
      .finally(() => {
        this.inflight = undefined;
      });
    this.inflight = { cwd, result };
    return result;
  }

  private async probe(cwd: string): Promise<Command[]> {
    if (this.closed) throw new SessionError('SERVER_CLOSING', '服务正在关闭');
    const input = new InputQueue<SDKUserMessage>();
    const controller = new AbortController();
    this.cancel = () => controller.abort();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(new Error('读取命令超时或已取消')), {
        once: true,
      }),
    );
    let query: Query | undefined;
    try {
      query = agentSdk.query({
        prompt: input,
        options: {
          cwd,
          pathToClaudeCodeExecutable: this.config.claudePath,
          persistSession: false,
          settingSources: ['user', 'project', 'local'],
          settings: { disableAllHooks: true },
          strictMcpConfig: true,
          mcpServers: {},
          tools: [],
          env: sdkEnvironment(),
          abortController: controller,
        },
      });
      const init = await Promise.race([query.initializationResult(), aborted]);
      assertSubscriptionAuth(init.account?.apiKeySource, init.account?.apiProvider);
      return init.commands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
      }));
    } finally {
      clearTimeout(timeout);
      input.close();
      query?.close();
      controller.abort();
      this.cancel = undefined;
    }
  }
  async close() {
    this.closed = true;
    this.cancel?.();
    await this.inflight?.result.catch(() => {});
  }
}
