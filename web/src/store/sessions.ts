import type { Message, Meta, Pending, Snapshot, Status, WireEvent } from '../../../shared/protocol';
export interface SessionState {
  epoch?: string;
  seq: number;
  status: Status;
  history: Message[];
  events: WireEvent[];
  pending: Pending[];
  meta: Meta;
  delta: string;
  total: number;
  revision: number;
  generation: number;
}
export function emptyState(): SessionState {
  return {
    seq: 0,
    status: 'closed',
    history: [],
    events: [],
    pending: [],
    meta: {},
    delta: '',
    total: 0,
    revision: 0,
    generation: 0,
  };
}
export function reduceSession(previous: SessionState, frame: WireEvent | Snapshot): SessionState {
  if (frame.type === 'snapshot') {
    const value = frame as Snapshot;
    return {
      epoch: value.epoch,
      seq: value.seq ?? 0,
      status: value.status,
      history: value.history,
      events: value.events,
      pending: value.pending,
      meta: value.meta,
      delta: '',
      total: value.total ?? value.history.length,
      revision: previous.revision + 1,
      generation: previous.generation + 1,
    };
  }
  if (frame.epoch && previous.epoch && frame.epoch !== previous.epoch) return previous;
  if (frame.type === 'meta') return { ...previous, meta: frame.meta };
  if (frame.type === 'delta') {
    const event = frame.event?.event ?? frame.event;
    const text = event?.delta?.text ?? '';
    return { ...previous, delta: previous.delta + text, revision: previous.revision + 1 };
  }
  if (frame.seq !== undefined && frame.seq <= previous.seq) return previous;
  const next = {
    ...previous,
    epoch: frame.epoch ?? previous.epoch,
    seq: frame.seq ?? previous.seq,
    events: [...previous.events, frame],
    revision: previous.revision + 1,
  };
  if (frame.type === 'status') next.status = frame.status!;
  if (frame.type === 'permission.request')
    next.pending = [
      ...previous.pending,
      {
        requestId: frame.requestId!,
        toolName: frame.toolName!,
        input: frame.input!,
        suggestions: frame.suggestions,
      },
    ];
  if (frame.type === 'permission.resolved')
    next.pending = previous.pending.filter((p) => p.requestId !== frame.requestId);
  if (frame.type === 'event' && (frame.message?.type === 'assistant' || frame.message?.type === 'result'))
    next.delta = '';
  return next;
}
export function allMessages(state: SessionState): Message[] {
  const started = new Set(
    state.events.filter((e) => e.type === 'status' && e.activeMessageId).map((e) => e.activeMessageId),
  );
  const cancelled = new Set(state.events.flatMap((e) => e.cancelledMessageIds ?? []));
  return [
    ...state.history,
    ...state.events.filter((e) => e.type === 'event' && e.message).map((e) => e.message!),
  ]
    .filter((m) => !m.cancelled && !cancelled.has(m.uuid))
    .map((m) => (started.has(m.uuid) ? { ...m, queued: false } : m));
}
export function prependHistory(
  state: SessionState,
  generation: number,
  length: number,
  messages: Message[],
): SessionState {
  return state.generation === generation && state.history.length === length
    ? { ...state, history: [...messages, ...state.history] }
    : state;
}
