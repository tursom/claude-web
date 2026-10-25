// Local control-plane probe. It sends no prompt and performs no model generation.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20000);
const env = { ...process.env };
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE'])
  delete env[key];
async function* input(): AsyncGenerator<any> {
  await new Promise<void>((resolve) =>
    controller.signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
const q = query({
  prompt: input(),
  options: {
    cwd: process.cwd(),
    sessionId: randomUUID(),
    pathToClaudeCodeExecutable: process.env.CLAUDE_PATH ?? '/usr/bin/claude',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    abortController: controller,
    env,
    canUseTool: async () => ({ behavior: 'deny', message: 'Local initialization probe' }),
  },
});
try {
  const init = await q.initializationResult();
  const [models, account, context] = await Promise.all([
    q.supportedModels(),
    q.accountInfo(),
    q.getContextUsage({ detail: 'summary' }).catch(() => undefined),
  ]);
  console.log(
    JSON.stringify(
      {
        initialized: true,
        initializationFields: Object.keys(init),
        effort: (init as any).effortLevel ?? (init as any).effort,
        apiKeySource: account.apiKeySource,
        tokenSource: account.tokenSource,
        models: models.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          supportedEffortLevels: m.supportedEffortLevels,
        })),
        contextFields: context ? Object.keys(context) : [],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({ initialized: false, error: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort();
  q.close();
}
