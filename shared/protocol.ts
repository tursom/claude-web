export type Status = 'closed' | 'running' | 'waiting' | 'idle';
export type Mode = 'default' | 'acceptEdits' | 'plan';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface Meta {
  model?: string;
  effort?: Effort;
  permissionMode?: Mode;
  cache?: { refreshedAt: number; ttlSec: number };
  context?: { percentage: number; totalTokens: number; maxTokens: number };
}
// SDK wire messages differ between history and live streams; content stays in Anthropic format.
export type Message = Record<string, any>;
export interface Pending {
  requestId: string;
  toolName: string;
  input: Record<string, any>;
  suggestions?: any[];
}
export interface WireEvent {
  type: string;
  sessionId: string;
  epoch?: string;
  seq?: number;
  message?: Message;
  status?: Status;
  requestId?: string;
  toolName?: string;
  input?: Record<string, any>;
  suggestions?: any[];
  behavior?: string;
  [key: string]: any;
}
export interface Snapshot {
  type: 'snapshot';
  sessionId: string;
  epoch?: string;
  seq?: number;
  status: Status;
  history: Message[];
  events: WireEvent[];
  pending: Pending[];
  meta: Meta;
  total?: number;
}
export interface Session {
  sessionId: string;
  cwd: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
  gitBranch?: string;
  lastModified: number;
  status: Status;
  [key: string]: any;
}
export interface Model {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Effort[];
}
export interface Command {
  name: string;
  description: string;
  argumentHint?: string;
}
export interface TreeEntry {
  name: string;
  path: string;
  directory: boolean;
  expandable?: boolean;
}
export interface RateLimitRow {
  kind: string;
  group: string;
  percent: number;
  resets_at: string | null;
  scope?: {
    model?: { display_name: string } | null;
    surface?: { display_name: string } | null;
    display_name?: string;
    [key: string]: unknown;
  } | null;
  severity: string;
  is_active: boolean;
}
export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency?: string | null;
}
export interface Usage {
  account: { email?: string; subscriptionType?: string } | null;
  limits: RateLimitRow[] | null;
  extraUsage: ExtraUsage | null;
  fetchedAt: number | null;
  error: 'unavailable' | 'failed' | null;
  limited: { resetsAt?: number; errorCode?: string } | null;
}
export const emptyUsage = (): Usage => ({
  account: null,
  limits: null,
  extraUsage: null,
  fetchedAt: null,
  error: null,
  limited: null,
});
