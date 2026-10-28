import * as sdk from '@anthropic-ai/claude-agent-sdk';
import type { Meta, Message } from '../shared/protocol.js';

// A small seam for tests; production always uses the installed SDK.
export const agentSdk = {
  query: sdk.query,
  listSessions: sdk.listSessions,
  getSessionInfo: sdk.getSessionInfo,
  getSessionMessages: sdk.getSessionMessages,
};

export class SessionError extends Error {
  readonly statusCode: number;
  constructor(
    public readonly code: string,
    message: string,
    public readonly seconds?: number,
  ) {
    super(message);
    this.name = 'SessionError';
    this.statusCode =
      code === 'INVALID_MESSAGE'
        ? 400
        : code === 'API_AUTH_FORBIDDEN'
          ? 403
          : code === 'SESSION_NOT_FOUND' || code === 'PERMISSION_NOT_FOUND'
            ? 404
            : code === 'SERVER_CLOSING'
              ? 503
              : 409;
  }
}

/** Keep HOME/PATH and local CLI login, never pass service API/OAuth credentials. */
export function sdkEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !/^ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|FOUNDRY_API_KEY|FOUNDRY_RESOURCE|BEDROCK_BASE_URL|VERTEX_BASE_URL)(?:_|$)/i.test(
          key,
        ) &&
        !/^CLAUDE_CODE_(?:OAUTH|SESSION_ACCESS_TOKEN|API_KEY|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|USE_MANTLE|USE_ANTHROPIC)/i.test(
          key,
        ) &&
        !/^CLAUDE_AGENT_SDK_(?:AUTH|API_KEY|BASE_URL)/i.test(key) &&
        key !== 'CLAUDECODE',
    ),
  );
}

export function assertSubscriptionAuth(source: string | undefined, provider?: string): void {
  if (
    (source !== undefined && source !== 'none' && source !== 'oauth') ||
    (provider !== undefined && provider !== 'firstParty')
  ) {
    throw new SessionError(
      'API_AUTH_FORBIDDEN',
      'Claude must use the local subscription login; API key and external provider authentication are disabled.',
    );
  }
}

/** Cache reads refresh an already known TTL; subagent caches are independent. */
export function cacheMeta(message: Message, previous?: Meta['cache'], now = Date.now()): Meta['cache'] {
  if (
    message.type !== 'assistant' ||
    message.parent_tool_use_id ||
    message.parent_agent_id ||
    message.isReplay ||
    message.is_replay ||
    message.message?.model === '<synthetic>'
  )
    return previous;
  const creation = message.message?.usage?.cache_creation;
  const usage = message.message?.usage;
  if (!(
    usage?.cache_read_input_tokens > 0 ||
    usage?.cache_creation_input_tokens > 0 ||
    creation?.ephemeral_1h_input_tokens > 0 ||
    creation?.ephemeral_5m_input_tokens > 0
  ))
    return previous;
  const ttlSec =
    creation?.ephemeral_1h_input_tokens > 0
      ? 3600
      : creation?.ephemeral_5m_input_tokens > 0
        ? 300
        : previous?.ttlSec;
  const refreshedAt = message.timestamp === undefined ? now : recordedAt(message, now);
  if (refreshedAt === undefined || (previous && refreshedAt < previous.refreshedAt)) return previous;
  return ttlSec ? { refreshedAt, ttlSec } : undefined;
}

function recordedAt(message: Message, now: number): number | undefined {
  if (typeof message.timestamp !== 'string') return undefined;
  const timestamp = Date.parse(message.timestamp);
  return Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now ? timestamp : undefined;
}

/** File mtime is not cache activity: shutdown/cost saves can update it hours later. */
export function closedMeta(history: Message[]): Meta {
  const now = Date.now();
  let compactedAt = -Infinity;
  let unknownBoundary = false;
  for (const message of history) {
    if (message.parent_tool_use_id || message.parent_agent_id) continue;
    if (
      (message.type === 'system' && message.subtype === 'compact_boundary') ||
      (message.type === 'user' && (message.isCompactSummary || message.is_compact_summary))
    ) {
      const at = recordedAt(message, now);
      if (at === undefined) unknownBoundary = true;
      else compactedAt = Math.max(compactedAt, at);
    }
  }
  let cache: Meta['cache'];
  let model: string | undefined;
  for (const message of history) {
    if (
      message.type !== 'assistant' ||
      message.parent_tool_use_id ||
      message.parent_agent_id ||
      message.message?.model === '<synthetic>'
    )
      continue;
    const nextModel = message.message?.model;
    if (typeof nextModel === 'string') {
      if (nextModel !== model) cache = undefined;
      model = nextModel;
    }
    const at = recordedAt(message, now);
    // Compaction may preserve older assistant blocks AFTER the summary in the
    // returned history. Their cache belongs to the previous conversation prefix.
    if (unknownBoundary || at === undefined) cache = undefined;
    else if (at > compactedAt) cache = cacheMeta(message, cache, now);
  }
  return { ...(model ? { model } : {}), ...(cache ? { cache } : {}) };
}

/** An AsyncIterable whose pending next() is settled on close as well as push. */
export class InputQueue<T> implements AsyncIterableIterator<T> {
  private values: T[] = [];
  private readers: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) throw new SessionError('SESSION_CLOSED', 'The session is closed.');
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value });
    else this.values.push(value);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.readers.push(resolve));
  }

  close(): void {
    this.ended = true;
    this.values = [];
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
