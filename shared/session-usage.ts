import type { Message } from './protocol.js';

export interface SessionTokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}
export interface SessionUsageSummary extends SessionTokenUsage {
  costUsd: number;
  models: ({ name: string; costUsd: number | null } & SessionTokenUsage)[];
}
export interface SessionUsageResponse {
  usage: SessionUsageSummary | null;
  source: 'saved' | 'result' | 'unavailable';
}
const amount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** SDK results are cumulative, including subagents and restored totals. Never sum turns. */
export function sessionUsageFromMessages(messages: Message[], sessionId: string): SessionUsageSummary | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.parent_tool_use_id || (message.session_id && message.session_id !== sessionId)) continue;
    if (message.startup_failure_reason) continue;
    const report = message.type === 'assistant' ? message.usage_report?.session : undefined;
    const data = message.type === 'result' ? message : report;
    if (!data) continue;
    const costUsd = amount(data.total_cost_usd);
    if (costUsd === null) continue;
    const raw = message.type === 'result' ? data.modelUsage : data.model_usage;
    const hasModels = !!raw && typeof raw === 'object' && !Array.isArray(raw);
    const models = hasModels
      ? Object.entries(raw).map(([name, value]) => {
          const item = value as Record<string, unknown> | null;
          return {
            name,
            costUsd: amount(item?.costUSD),
            input: amount(item?.inputTokens),
            output: amount(item?.outputTokens),
            cacheRead: amount(item?.cacheReadInputTokens),
            cacheWrite: amount(item?.cacheCreationInputTokens),
          };
        })
      : [];
    const total = (key: keyof SessionTokenUsage) =>
      !hasModels || models.some((item) => item[key] === null)
        ? null
        : models.reduce((sum, item) => sum + item[key]!, 0);
    return {
      costUsd,
      models,
      input: total('input'),
      output: total('output'),
      cacheRead: total('cacheRead'),
      cacheWrite: total('cacheWrite'),
    };
  }
  return null;
}

export function formatSessionCost(costUsd: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(costUsd);
}
