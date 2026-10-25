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
  if (message.type !== 'assistant' || message.parent_tool_use_id) return previous;
  const creation = message.message?.usage?.cache_creation;
  const ttlSec =
    creation?.ephemeral_1h_input_tokens > 0
      ? 3600
      : creation?.ephemeral_5m_input_tokens > 0
        ? 300
        : previous?.ttlSec;
  return ttlSec ? { refreshedAt: now, ttlSec } : undefined;
}

export function closedMeta(history: Message[], lastModified: number): Meta {
  const last = history.findLast((message) => message.type === 'assistant' && !message.parent_tool_use_id);
  const cache = last && cacheMeta(last, undefined, lastModified);
  return { ...(last?.message?.model ? { model: last.message.model } : {}), ...(cache ? { cache } : {}) };
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
