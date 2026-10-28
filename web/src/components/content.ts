import type { Message } from '../../../shared/protocol';

export type Block = Record<string, any>;

/** Preserve the SDK envelope: history uses message.role, live uses type. */
export function envelope(value: Message): Message {
  return value.type === 'event' && value.message ? value.message : value;
}

export function roleOf(value: Message): string {
  const message = envelope(value);
  return ['user', 'assistant', 'result', 'system'].includes(message.type)
    ? message.type
    : (message.role ?? message.message?.role ?? message.type ?? '');
}

export function blocksOf(value: Message): Block[] {
  const message = envelope(value);
  const content = message.message?.content ?? message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** Skill prompts are context injected by the CLI, not messages authored by the user. */
export function isSkillInjectionBlock(value: Message, block: Block): boolean {
  const message = envelope(value);
  return (
    roleOf(message) === 'user' &&
    (message.isSynthetic === true || message.isMeta === true) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    /^\s*Base directory for this skill:[^\S\r\n]+\S[^\r\n]*(?:\r?\n|$)/.test(block.text)
  );
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

export function lineCount(text: string): number {
  return text ? text.replace(/\n$/, '').split('\n').length : 0;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}

export function editsOf(input: Block): { oldText: string; newText: string }[] {
  return (Array.isArray(input.edits) ? input.edits : [input]).map((edit: Block) => ({
    oldText: String(edit.old_string ?? edit.oldText ?? ''),
    newText: String(edit.new_string ?? edit.newText ?? ''),
  }));
}

export function imageSource(block: Block): string | undefined {
  const id = block.imageId ?? block.image_id ?? block.uploadId;
  if (id) return `/api/uploads/${encodeURIComponent(id)}`;
  if (block.source?.type === 'base64') return `data:${block.source.media_type};base64,${block.source.data}`;
  const url = block.source?.url ?? block.url;
  return typeof url === 'string' && /^(https?:|data:image\/|\/api\/uploads\/)/.test(url) ? url : undefined;
}
