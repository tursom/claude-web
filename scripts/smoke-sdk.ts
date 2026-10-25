import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, getSessionMessages, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue, sdkEnvironment } from '../server/sdk.js';
// This intentionally uses subscription model calls. It never accesses credentials.
const cwd = await mkdtemp(path.join(tmpdir(), 'claude-web-smoke-'));
const active: ReturnType<typeof query>[] = [];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 55000);
const results: any[] = [];
async function turn(sessionId: string, resume = false, interrupt = false) {
  const input = new InputQueue<SDKUserMessage>();
  const q = query({
    prompt: input,
    options: {
      cwd,
      ...(resume ? { resume: sessionId } : { sessionId }),
      pathToClaudeCodeExecutable: process.env.CLAUDE_PATH ?? '/usr/bin/claude',
      env: sdkEnvironment(),
      abortController: controller,
      tools: [],
      includePartialMessages: true,
      model: 'haiku',
      maxTurns: 1,
      settingSources: [],
    },
  });
  active.push(q);
  await q.initializationResult();
  input.push({
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: interrupt
        ? 'Count from one to one hundred, each on its own line.'
        : 'Reply exactly SDK_OK. Do not use tools.',
    },
  });
  let source: string | undefined;
  let text = '';
  let cacheFields: string[] = [];
  let stopped = false;
  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'init') source = message.apiKeySource;
    if (message.type === 'assistant') {
      text += message.message.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
      cacheFields = Object.keys((message.message.usage as any)?.cache_creation ?? {});
    }
    if (interrupt && !stopped && message.type === 'stream_event') {
      stopped = true;
      await q.interrupt();
    }
    if (message.type === 'result') {
      results.push({
        resume,
        interrupt,
        apiKeySource: source,
        subtype: message.subtype,
        interrupted: stopped,
        text: interrupt ? undefined : text,
        cacheFields,
      });
      break;
    }
  }
  input.close();
  q.close();
}
try {
  const a = randomUUID();
  await Promise.all([turn(a), turn(randomUUID(), false, true)]);
  await turn(a, true);
  const historyMessages = (await getSessionMessages(a, { dir: cwd })).length;
  if (
    results.length !== 3 ||
    results.filter((v) => !v.interrupt).some((v) => v.text !== 'SDK_OK' || v.subtype !== 'success') ||
    !results.some((v) => v.interrupted) ||
    historyMessages < 4
  )
    throw new Error('SDK smoke assertions failed');
  console.log(JSON.stringify({ cwd, results, historyMessages }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({ cwd, error: error instanceof Error ? error.message : String(error), results }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  controller.abort();
  active.forEach((q) => q.close());
}
