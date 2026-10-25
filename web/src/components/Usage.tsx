import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Gauge, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { emptyUsage, type ExtraUsage, type RateLimitRow, type Usage } from '../../../shared/protocol';
import './usage.css';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const unavailableText = '当前登录方式读不到额度。用订阅账号登录 Claude Code 后才能显示。';
const failedText = '操作失败：额度读取失败';

export function usageRowName(row: RateLimitRow): string {
  if (row.kind === 'session') return '当前时段';
  if (row.kind === 'weekly_all') return '所有模型';
  if (row.kind === 'weekly_scoped')
    return row.scope?.model?.display_name || row.scope?.surface?.display_name || row.kind;
  return (
    row.scope?.display_name || row.scope?.model?.display_name || row.scope?.surface?.display_name || row.kind
  );
}

export function usageGroupName(group: string): string {
  return group === 'session' ? '时段' : group === 'weekly' ? '每周' : group;
}

export function usageSeverity(severity: string): 'normal' | 'warning' | 'critical' {
  return severity === 'warning' || severity === 'critical' ? severity : 'normal';
}

export function activeUsageRow(limits: Usage['limits']): RateLimitRow | undefined {
  return limits?.find((row) => row.is_active) ?? limits?.[0];
}

export function usageProgress(percent: number): number {
  return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}

const clockTime = (date: Date) =>
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const weekday = (date: Date) => `周${'日一二三四五六'[date.getDay()]}`;

export function formatUsageReset(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (!Number.isFinite(date.getTime())) return null;
  const remaining = Math.max(0, date.getTime() - now);
  const minutes = Math.ceil(remaining / MINUTE);
  if (remaining < 60 * MINUTE) return `${minutes} 分钟后重置`;
  if (remaining < DAY) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours} 小时${rest ? ` ${rest} 分` : ''}后重置`;
  }
  if (remaining < 7 * DAY) return `${weekday(date)} ${clockTime(date)} 重置`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clockTime(date)} 重置`;
}

export function formatUsageRecovery(resetsAt: number | undefined, now: number): string | null {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const prefix =
    date.toDateString() === today.toDateString()
      ? ''
      : date.toDateString() === tomorrow.toDateString()
        ? '明天 '
        : `${weekday(date)} `;
  return `${prefix}${clockTime(date)}`;
}

export function isUsageLimited(limited: Usage['limited'], now: number): boolean {
  return limited !== null && (limited.resetsAt === undefined || limited.resetsAt > now);
}

export function formatUsageNotice(limited: Usage['limited'], now: number): string | null {
  if (!isUsageLimited(limited, now)) return null;
  if (limited?.errorCode === 'credits_required')
    return '订阅额度已用完，需要在 claude.ai 购买额外用量后才能继续。';
  const recovery = formatUsageRecovery(limited?.resetsAt, now);
  return recovery ? `额度已用完，${recovery} 后恢复。` : '额度已用完。';
}

export function formatUsageUpdated(fetchedAt: number | null, error: Usage['error'], now: number): string {
  if (fetchedAt === null) return error === 'failed' ? failedText : '额度读取中…';
  const age = Math.max(0, now - fetchedAt);
  const minutes = Math.floor(age / MINUTE);
  if (error === 'failed') return `更新失败，显示的是 ${minutes} 分钟前的数据`;
  return age < MINUTE ? '刚刚更新' : `更新于 ${minutes} 分钟前`;
}

export function formatUsageMoney(minorUnits: number, currency: string | null | undefined): string {
  // The protocol may omit currency; the usage endpoint historically reports USD.
  const code = currency || 'USD';
  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(minorUnits / 10 ** digits);
  } catch {
    // Preserve unrecognised currency data instead of dropping the entire panel.
    return `${code} ${minorUnits}`;
  }
}

export function formatExtraUsage(extra: ExtraUsage): { text: string; percent: number | null } {
  if (!extra.is_enabled) return { text: '额外用量未启用', percent: null };
  const used = extra.used_credits === null ? null : formatUsageMoney(extra.used_credits, extra.currency);
  if (extra.monthly_limit === null)
    return { text: used === null ? '额外用量' : `已用 ${used}`, percent: null };
  return {
    text: `${used ?? '—'} / ${formatUsageMoney(extra.monthly_limit, extra.currency)}`,
    percent:
      extra.used_credits === null
        ? null
        : usageProgress(extra.monthly_limit > 0 ? (extra.used_credits / extra.monthly_limit) * 100 : 0),
  };
}

interface UsageContextValue {
  usage: Usage;
  refreshing: boolean;
  onRefresh: () => void;
  now: number;
}
const UsageContext = createContext<UsageContextValue>({
  usage: emptyUsage(),
  refreshing: false,
  onRefresh: () => {},
  now: Date.now(),
});

export interface UsageProviderProps {
  usage: Usage;
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
}

export function UsageProvider({ usage, refreshing, onRefresh, children }: UsageProviderProps) {
  const [now, setNow] = useState(Date.now);
  const previous = useRef<Usage>(emptyUsage());
  const displayUsage =
    usage.error === 'failed'
      ? {
          ...usage,
          account: usage.account ?? previous.current.account,
          limits: usage.limits ?? previous.current.limits,
          extraUsage: usage.extraUsage ?? previous.current.extraUsage,
          fetchedAt: usage.fetchedAt ?? previous.current.fetchedAt,
        }
      : usage;
  useEffect(() => {
    if (usage.error !== 'failed') previous.current = usage;
  }, [usage]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const resetsAt = usage.limited?.resetsAt;
  useEffect(() => {
    if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= Date.now()) return;
    // Browser timeouts are signed 32-bit; the interval reschedules long waits.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(resetsAt - Date.now(), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetsAt, now]);
  return (
    <UsageContext.Provider
      value={{ usage: displayUsage, refreshing, onRefresh, now: Math.max(now, Date.now()) }}
    >
      {children}
    </UsageContext.Provider>
  );
}

function useMobileUsage() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return mobile;
}

function UsageMeter({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      className="cu-meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usageProgress(percent)}
      aria-valuetext={`${percent}%`}
    >
      <span style={{ width: `${usageProgress(percent)}%` }} />
    </div>
  );
}

function UsageDetails() {
  const { usage, refreshing, onRefresh, now } = useContext(UsageContext);
  if (usage.error === 'unavailable') return <p className="cu-message">{unavailableText}</p>;
  const extra = usage.extraUsage && formatExtraUsage(usage.extraUsage);
  const account = usage.account;
  return (
    <>
      {account && (account.email || account.subscriptionType) && (
        <header className="cu-account">
          <span className="cu-email" title={account.email}>
            {account.email}
          </span>
          {account.subscriptionType && (
            <span className="cu-plan">
              {account.subscriptionType.charAt(0).toUpperCase() + account.subscriptionType.slice(1)}
            </span>
          )}
        </header>
      )}
      {usage.limits?.map((row, index, rows) => (
        <Fragment key={index}>
          {(index === 0 || row.group !== rows[index - 1].group) && (
            <h3 className="cu-group">{usageGroupName(row.group)}</h3>
          )}
          <div className={`cu-row cu-severity-${usageSeverity(row.severity)}`} data-severity={row.severity}>
            <div className="cu-row-line">
              <span className="cu-name">{usageRowName(row)}</span>
              <span
                className="cu-percent"
                title={
                  usageSeverity(row.severity) === 'normal' && row.severity !== 'normal'
                    ? row.severity
                    : undefined
                }
              >
                {row.percent}%
              </span>
            </div>
            <UsageMeter percent={row.percent} label={usageRowName(row)} />
            {formatUsageReset(row.resets_at, now) && (
              <div className="cu-reset">{formatUsageReset(row.resets_at, now)}</div>
            )}
          </div>
        </Fragment>
      ))}
      {extra && (
        <>
          <div className="cu-separator" />
          <div className="cu-row cu-extra">
            <div className="cu-row-line">
              <span>额外用量</span>
              {usage.extraUsage?.is_enabled && (
                <span className="cu-extra-amount">{extra.text === '额外用量' ? '' : extra.text}</span>
              )}
            </div>
            {!usage.extraUsage?.is_enabled && <div className="cu-reset">{extra.text}</div>}
            {extra.percent !== null && <UsageMeter percent={extra.percent} label="额外用量" />}
          </div>
        </>
      )}
      {usage.fetchedAt === null && usage.error !== 'failed' && !usage.limits?.length && !extra && (
        <div className="cu-message cu-loading" role="status">
          <LoaderCircle className="cu-spin" size={16} strokeWidth={1.75} />
          额度读取中…
        </div>
      )}
      <div className="cu-separator" />
      <footer className={`cu-footer${usage.error === 'failed' ? ' cu-warning' : ''}`} aria-busy={refreshing}>
        <span role="status">{formatUsageUpdated(usage.fetchedAt, usage.error, now)}</span>
        <button
          type="button"
          className="cu-icon-button"
          aria-label="刷新"
          title="刷新"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? 'cu-spin' : undefined} size={16} strokeWidth={1.75} />
        </button>
      </footer>
    </>
  );
}

export function UsageIndicator({ location }: { location: 'sidebar' | 'toolbar' }) {
  const { usage, refreshing, onRefresh, now } = useContext(UsageContext);
  const mobile = useMobileUsage();
  const [open, setOpen] = useState(false);
  const row = activeUsageRow(usage.limits);
  const limited = isUsageLimited(usage.limited, now);
  const severity = limited ? 'critical' : usageSeverity(row?.severity ?? 'normal');
  const visible = location === 'sidebar' || limited || severity === 'warning' || severity === 'critical';
  const percent = limited ? 100 : (row?.percent ?? 0);
  const recovery = formatUsageRecovery(usage.limited?.resetsAt, now);
  const unavailable = usage.error === 'unavailable';
  const failed = usage.error === 'failed' && !row;
  const loading = !row && !limited && !unavailable && !failed;
  const reset = row && formatUsageReset(row.resets_at, now);
  const title =
    location === 'toolbar'
      ? limited
        ? (formatUsageNotice(usage.limited, now) ?? '额度已用完。')
        : `${row ? usageRowName(row) : '额度'}额度已用 ${percent}%${reset ? `，${reset}` : ''}。`
      : '账号额度';
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (value && !open && !refreshing && (usage.fetchedAt === null || Date.now() - usage.fetchedAt > MINUTE))
      onRefresh();
  };
  const trigger = (
    <button
      type="button"
      className={`cu-trigger cu-${location} cu-severity-${severity}${limited ? ' cu-limited' : ''}${loading || unavailable ? ' cu-muted' : ''}${failed ? ' cu-warning' : ''}`}
      title={title}
      aria-label={title}
    >
      {location === 'toolbar' ? (
        <>
          <Gauge size={16} strokeWidth={1.75} />
          <span>
            <span className="cu-toolbar-label">额度 </span>
            {percent}%
          </span>
        </>
      ) : (
        <>
          <span className="cu-summary">
            {loading ? (
              <LoaderCircle className="cu-spin" size={14} strokeWidth={1.75} />
            ) : (
              <Gauge size={14} strokeWidth={1.75} />
            )}
            <span className="cu-name">
              {limited
                ? '已达上限'
                : unavailable
                  ? '额度不可用'
                  : failed
                    ? failedText
                    : loading
                      ? '额度读取中…'
                      : usageRowName(row!)}
            </span>
            {!unavailable && !loading && !failed && (
              <span className="cu-summary-value">
                {limited ? recovery && `${recovery} 恢复` : <span className="cu-percent">{percent}%</span>}
              </span>
            )}
          </span>
          {!unavailable && !loading && !failed && (
            <UsageMeter percent={percent} label={limited ? '已达上限' : usageRowName(row!)} />
          )}
          <ChevronRight className="cu-mobile-chevron" size={14} strokeWidth={1.75} />
        </>
      )}
    </button>
  );
  // Keep hooks stable if an open toolbar indicator disappears after a refresh.
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);
  if (!visible) return null;
  if (mobile)
    return (
      <Dialog.Root open={open} onOpenChange={changeOpen}>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="cu-overlay" />
          <Dialog.Content className="cu-sheet" aria-describedby={undefined}>
            <div className="cu-handle" aria-hidden="true" />
            <header className="cu-sheet-head">
              <Dialog.Title>账号额度</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="cu-icon-button" aria-label="关闭">
                  <X size={20} strokeWidth={1.75} />
                </button>
              </Dialog.Close>
            </header>
            <div className="cu-sheet-scroll">
              <UsageDetails />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="cu-popover"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="账号额度"
        >
          <UsageDetails />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function UsageNotice() {
  const { usage, now } = useContext(UsageContext);
  const notice = formatUsageNotice(usage.limited, now);
  return notice ? (
    <div className="cu-notice" role="status">
      <TriangleAlert size={16} strokeWidth={1.75} />
      <span>{notice}</span>
    </div>
  ) : null;
}
