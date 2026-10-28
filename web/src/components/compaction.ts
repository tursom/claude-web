import type { Message, Status } from '../../../shared/protocol';
import { blocksOf, envelope, roleOf } from './content';

export interface Compaction {
  key: string;
  trigger?: 'manual' | 'auto';
  beforeCacheExpiry?: boolean;
  requestId?: string;
  instructions?: string;
  started: boolean;
  finished: boolean;
  boundary: boolean;
  success: boolean;
  summary?: string;
  error?: string;
  interrupted?: boolean;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const textOfMessage = (message: Message) =>
  blocksOf(message)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
const isInternal = (message: Message) =>
  message.isSynthetic === true ||
  message.isMeta === true ||
  message.is_meta === true ||
  message.isReplay === true ||
  message.isCompletedLocalCommand === true;
const compactCommand =
  /^<command-name>\s*\/compact\s*<\/command-name>\s*<command-message>\s*compact\s*<\/command-message>\s*<command-args>([\s\S]*?)<\/command-args>\s*$/;

/** Presentation-only grouping: keep SDK messages untouched for accounting/resume. */
export function collectCompactions(messages: Message[]) {
  const items = new Map<number, Compaction>();
  const hidden = new Set<number>();
  const seen = new Set<string>();
  const restoredAt = new Map<Compaction, number>();
  const groups = new Map<string, { current?: Compaction; pending: Compaction[] }>();
  messages.forEach((raw, index) => {
    const message = envelope(raw);
    const role = roleOf(message);
    const groupKey = message.parent_tool_use_id ?? '';
    let group = groups.get(groupKey);
    if (!group) {
      group = { pending: [] };
      groups.set(groupKey, group);
    }
    const text = textOfMessage(message);
    const completedRequest =
      role === 'user' && message.isCompletedLocalCommand === true ? compactCommand.exec(text.trim()) : null;
    const request =
      completedRequest ??
      (role === 'user' && !isInternal(message) ? /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim()) : null);
    const summary =
      role === 'user' &&
      (message.isCompactSummary === true ||
        (isInternal(message) &&
          /^This session is being continued from a previous conversation that ran out of context\./.test(
            text.trimStart(),
          )));
    const status = role === 'system' && message.subtype === 'status';
    const start = status && message.status === 'compacting';
    const boundary = role === 'system' && message.subtype === 'compact_boundary';
    const outcome = status && (message.compact_result === 'success' || message.compact_result === 'failed');
    const local = message.local_command_run?.command === 'compact' || message.local_command === 'compact';
    const localOutput = role === 'system' && message.subtype === 'local_command_output';
    const stdout =
      (localOutput || (role === 'user' && isInternal(message))) &&
      (localOutput
        ? /^Compacted\b/.test(text.trim())
        : /^<local-command-stdout>\s*Compacted\b[\s\S]*<\/local-command-stdout>\s*$/.test(text.trim()));
    const stderr =
      role === 'user' && isInternal(message)
        ? /^<local-command-stderr>\s*(Error during compaction:[\s\S]*)<\/local-command-stderr>\s*$/.exec(
            text.trim(),
          )
        : null;
    const failure =
      !!stderr ||
      ((role === 'assistant' || localOutput) &&
        (local || group.current || isInternal(message)) &&
        ((local && message.local_command_outcome?.kind === 'failed') ||
          /^Error during compaction:/.test(text)));
    const result =
      role === 'result' &&
      (local || (message.user_message_uuid && message.user_message_uuid === group.current?.requestId));
    if (!(request || summary || start || boundary || outcome || stdout || failure || result)) {
      if (role === 'result' && group.current) {
        group.current.finished = true;
        if (message.interrupted || message.is_interrupted || message.stop_reason === 'interrupt')
          group.current.interrupted = true;
      }
      return;
    }
    hidden.add(index);
    if (message.uuid && seen.has(message.uuid)) return;
    if (message.uuid) seen.add(message.uuid);
    const create = () => {
      const value: Compaction = {
        key: `compact-${message.uuid ?? index}`,
        started: false,
        finished: false,
        boundary: false,
        success: false,
      };
      items.set(index, value);
      return value;
    };
    if (request) {
      const previous = group.current;
      const requestedAt = Date.parse(message.timestamp);
      const summaryAt = previous && restoredAt.get(previous);
      // Restored histories put the summary before preserved old replies, then
      // the completed command. Render that same card at the command's position.
      const restoresCurrent =
        completedRequest &&
        previous &&
        !previous.finished &&
        !previous.requestId &&
        !previous.error &&
        (previous.summary || previous.boundary) &&
        !(Number.isFinite(requestedAt) && summaryAt !== undefined && requestedAt > summaryAt);
      const value = restoresCurrent ? previous : create();
      if (restoresCurrent) {
        for (const [position, item] of items) if (item === value) items.delete(position);
        items.set(index, value);
      }
      value.beforeCacheExpiry = message.autoCompactBeforeExpiry === true;
      value.trigger = value.beforeCacheExpiry ? 'auto' : 'manual';
      value.instructions = request[1]?.trim();
      value.requestId = message.uuid;
      if (completedRequest || !group.current || group.current.finished) group.current = value;
      else group.pending.push(value);
      return;
    }
    if (
      start &&
      (!group.current ||
        group.current.finished ||
        group.current.boundary ||
        group.current.success ||
        group.current.error ||
        (group.current.summary && !group.current.started))
    ) {
      group.current = group.pending.shift() ?? create();
    }
    if (!group.current) group.current = create();
    const value = group.current;
    if (summary || boundary) {
      const at = Date.parse(message.timestamp);
      if (Number.isFinite(at)) restoredAt.set(value, Math.max(restoredAt.get(value) ?? -Infinity, at));
    }
    if (start) value.started = true;
    if (summary) value.summary = text;
    if (boundary) {
      value.boundary = true;
      value.success = true;
      const metadata = message.compact_metadata ?? message.compactMetadata ?? {};
      if (!value.beforeCacheExpiry && (metadata.trigger === 'manual' || metadata.trigger === 'auto'))
        value.trigger = metadata.trigger;
      value.preTokens = number(metadata.pre_tokens ?? metadata.preTokens);
      value.postTokens = number(metadata.post_tokens ?? metadata.postTokens);
      value.durationMs = number(metadata.duration_ms ?? metadata.durationMs);
    }
    if (outcome && message.compact_result === 'success') value.success = true;
    if (outcome && message.compact_result === 'failed')
      value.error = message.compact_error || '未能完成本次上下文压缩。';
    if (failure)
      value.error =
        stderr?.[1]?.trim() ||
        text ||
        String(message.local_command_source ?? '未能完成本次上下文压缩。').replace(
          /<\/?local-command-stderr>/g,
          '',
        );
    if (stdout) {
      value.finished = true;
      if (!value.error) value.success = true;
    }
    if (result) {
      value.finished = true;
      value.durationMs ??= number(message.duration_ms);
      if (message.interrupted || message.is_interrupted || message.stop_reason === 'interrupt')
        value.interrupted = true;
      else if (message.is_error)
        value.error ??=
          (Array.isArray(message.errors) ? message.errors.join('\n') : undefined) ||
          '未能完成本次上下文压缩。';
      // A successful zero-turn /compact result acknowledges the command, not
      // necessarily successful compaction. It must never override an error.
    }
  });
  return { items, hidden };
}

export function compactionState(value: Compaction, status: Status) {
  if (value.error) return value.boundary ? 'warning' : 'failed';
  if (value.boundary || value.success) return 'success';
  if (value.interrupted) return 'interrupted';
  if (value.summary) return 'summary';
  if (value.started && !value.finished && (status === 'running' || status === 'waiting')) return 'running';
  if (value.started) return 'incomplete';
  return 'requested';
}
