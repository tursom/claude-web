// Real /usage verification. Output deliberately excludes account and quota values.
import { randomUUID } from 'node:crypto';
import type { Query, SDKResultMessage, SDKUsageReport, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, parseConfig } from '../server/config.js';
import { agentSdk, assertSubscriptionAuth, InputQueue, sdkEnvironment } from '../server/sdk.js';

async function main(): Promise<void> {
  // Standalone mode needs no service config; CLAUDE_PATH can select the CLI.
  const config = process.argv.includes('--standalone')
    ? parseConfig({
        owner: 'probe@example.invalid',
        allowedOrigins: ['http://localhost'],
        workspaceRoots: [process.cwd()],
        claudePath: process.env.CLAUDE_PATH ?? '/usr/bin/claude',
      })
    : await loadConfig();
  const sessionId = randomUUID();
  const input = new InputQueue<SDKUserMessage>();
  const controller = new AbortController();
  const started = performance.now();
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Probe timed out.')), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 20_000);
  let query: Query | undefined;
  try {
    const q = (query = agentSdk.query({
      prompt: input,
      options: {
        cwd: config.workspaceRoots[0],
        sessionId,
        pathToClaudeCodeExecutable: config.claudePath,
        persistSession: false,
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        tools: [],
        env: sdkEnvironment(),
        abortController: controller,
        stderr: () => {},
      },
    }));
    const verification = await Promise.race([
      (async () => {
        const init = await q.initializationResult();
        controller.signal.throwIfAborted();
        assertSubscriptionAuth(init.account?.apiKeySource, init.account?.apiProvider);
        input.push({
          type: 'user',
          uuid: randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          message: { role: 'user', content: '/usage' },
        });
        let report: SDKUsageReport | undefined;
        let result: SDKResultMessage | undefined;
        let reportMs: number | null = null;
        for await (const message of q) {
          controller.signal.throwIfAborted();
          if (message.type === 'system' && message.subtype === 'init')
            assertSubscriptionAuth(message.apiKeySource);
          if (message.type === 'assistant' && message.usage_report) {
            report = message.usage_report;
            reportMs = Math.round(performance.now() - started);
          }
          if (message.type === 'result') {
            result = message;
            break;
          }
        }
        const resultMs = Math.round(performance.now() - started);
        const account = await q.accountInfo();
        controller.signal.throwIfAborted();
        assertSubscriptionAuth(account.apiKeySource, account.apiProvider);
        const sessions = await agentSdk.listSessions({ dir: config.workspaceRoots[0] });
        return {
          reportMs,
          resultMs,
          subscriptionAuthVerified: true,
          usageReportPresent: !!report,
          rateLimitsPresent: report?.rate_limits != null,
          limitsArrayPresent: Array.isArray(report?.rate_limits?.limits),
          extraUsagePresent: report?.rate_limits?.extra_usage != null,
          accountEmailPresent: !!account.email,
          subscriptionTypePresent: !!account.subscriptionType,
          resultPresent: !!result,
          resultSuccess: result?.subtype === 'success' && !result.is_error,
          resultCostZero: result?.total_cost_usd === 0,
          resultModelUsageEmpty: !!result?.modelUsage && Object.keys(result.modelUsage).length === 0,
          absentFromListWhileLive: !sessions.some((session) => session.sessionId === sessionId),
        };
      })(),
      stopped,
    ]);
    q.close();
    input.close();
    const sessions = await agentSdk.listSessions({ dir: config.workspaceRoots[0] });
    const absentFromListAfterClose = !sessions.some((session) => session.sessionId === sessionId);
    console.log(JSON.stringify({ ...verification, absentFromListAfterClose }, null, 2));
    if (
      !verification.usageReportPresent ||
      !verification.resultSuccess ||
      !verification.resultCostZero ||
      !verification.resultModelUsageEmpty ||
      !verification.absentFromListWhileLive ||
      !absentFromListAfterClose
    )
      process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    input.close();
    try {
      query?.close();
    } finally {
      controller.abort();
    }
  }
}

main().catch(() => {
  // SDK errors can include account data; keep even failure output public-safe.
  console.error(
    JSON.stringify({ probeFailed: true, detail: 'Usage probe failed; no account or quota data logged.' }),
  );
  process.exitCode = 1;
});
