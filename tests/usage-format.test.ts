import { describe, expect, it } from 'vitest';
import { emptyUsage, type RateLimitRow } from '../shared/protocol';
import {
  activeUsageRow,
  formatExtraUsage,
  formatUsageMoney,
  formatUsageNotice,
  formatUsageRecovery,
  formatUsageReset,
  formatUsageUpdated,
  isUsageLimited,
  usageGroupName,
  usageProgress,
  usageRowName,
  usageSeverity,
} from '../web/src/components/Usage';

const row = (changes: Partial<RateLimitRow> = {}): RateLimitRow => ({
  kind: 'session',
  group: 'session',
  percent: 34,
  resets_at: null,
  severity: 'normal',
  is_active: false,
  ...changes,
});
// Local constructors intentionally test local-time labels independently of TZ.
const now = new Date(2026, 4, 11, 12, 0).getTime();
const after = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

describe('usage row presentation', () => {
  it('uses kind names and scoped model before surface, preserving unknown values', () => {
    expect(usageRowName(row({ scope: { display_name: 'ignored' } }))).toBe('当前时段');
    expect(usageRowName(row({ kind: 'weekly_all' }))).toBe('所有模型');
    expect(
      usageRowName(
        row({
          kind: 'weekly_scoped',
          scope: { model: { display_name: 'Opus' }, surface: { display_name: 'Code' } },
        }),
      ),
    ).toBe('Opus');
    expect(usageRowName(row({ kind: 'weekly_scoped', scope: { surface: { display_name: 'Code' } } }))).toBe(
      'Code',
    );
    expect(usageRowName(row({ kind: 'future', scope: { display_name: 'Future limit' } }))).toBe(
      'Future limit',
    );
    expect(usageRowName(row({ kind: 'future' }))).toBe('future');
    expect(usageGroupName('session')).toBe('时段');
    expect(usageGroupName('weekly')).toBe('每周');
    expect(usageGroupName('future-group')).toBe('future-group');
  });
  it('selects the active row, falls back to the first and never sorts input', () => {
    const limits = [row({ percent: 99 }), row({ is_active: true, percent: 10 })];
    expect(activeUsageRow(limits)).toBe(limits[1]);
    expect(activeUsageRow(limits.map((item) => ({ ...item, is_active: false })))?.percent).toBe(99);
    expect(limits.map((item) => item.percent)).toEqual([99, 10]);
    expect(activeUsageRow(null)).toBeUndefined();
    expect(activeUsageRow([])).toBeUndefined();
  });
  it('uses server severity without guessing percentage thresholds', () => {
    expect(usageSeverity('future')).toBe('normal');
    expect(usageSeverity('normal')).toBe('normal');
    expect(usageSeverity('warning')).toBe('warning');
    expect(usageSeverity('critical')).toBe('critical');
    expect(usageProgress(123)).toBe(100);
    expect(usageProgress(-4)).toBe(0);
    expect(usageProgress(34.5)).toBe(34.5);
    expect(usageProgress(Number.NaN)).toBe(0);
  });
});

describe('local reset times and global limit notices', () => {
  it('formats minute, hour, day and week boundaries', () => {
    expect(formatUsageReset(null, now)).toBeNull();
    expect(formatUsageReset('invalid', now)).toBeNull();
    expect(formatUsageReset(after(-1), now)).toBe('0 分钟后重置');
    expect(formatUsageReset(after(0.1), now)).toBe('1 分钟后重置');
    expect(formatUsageReset(after(41), now)).toBe('41 分钟后重置');
    expect(formatUsageReset(after(60), now)).toBe('1 小时后重置');
    expect(formatUsageReset(after(161), now)).toBe('2 小时 41 分后重置');
    expect(formatUsageReset(after(24 * 60), now)).toBe('周二 12:00 重置');
    expect(formatUsageReset(new Date(2026, 4, 14, 9).toISOString(), now)).toBe('周四 09:00 重置');
    expect(formatUsageReset(after(7 * 24 * 60), now)).toBe('5月18日 12:00 重置');
  });
  it('uses today, tomorrow and weekday recovery labels including midnight', () => {
    expect(formatUsageRecovery(now + 150 * 60_000, now)).toBe('14:30');
    expect(formatUsageRecovery(new Date(2026, 4, 12, 9).getTime(), now)).toBe('明天 09:00');
    expect(formatUsageRecovery(new Date(2026, 4, 14, 9).getTime(), now)).toBe('周四 09:00');
    expect(formatUsageRecovery(new Date(2026, 4, 12, 0).getTime(), now)).toBe('明天 00:00');
    expect(formatUsageRecovery(undefined, now)).toBeNull();
  });
  it('expires at the exact reset timestamp, with timeless and credits-required variants', () => {
    expect(isUsageLimited(null, now)).toBe(false);
    expect(isUsageLimited({ resetsAt: now }, now)).toBe(false);
    expect(isUsageLimited({ resetsAt: now + 1 }, now)).toBe(true);
    expect(isUsageLimited({}, now)).toBe(true);
    expect(formatUsageNotice(null, now)).toBeNull();
    expect(formatUsageNotice({ resetsAt: now }, now)).toBeNull();
    expect(formatUsageNotice({}, now)).toBe('额度已用完。');
    expect(formatUsageNotice({ resetsAt: now + 150 * 60_000 }, now)).toBe('额度已用完，14:30 后恢复。');
    expect(formatUsageNotice({ errorCode: 'credits_required' }, now)).toBe(
      '订阅额度已用完，需要在 claude.ai 购买额外用量后才能继续。',
    );
  });
});

describe('extra usage money', () => {
  it('converts currency-specific minor units with Intl rather than assuming cents', () => {
    expect(formatUsageMoney(1240, 'USD')).toBe('$12.40');
    expect(formatUsageMoney(1240, 'JPY')).toBe('¥1,240');
    expect(formatUsageMoney(1240, 'KWD')).toBe('KWD\u00a01.240');
    expect(formatUsageMoney(1240, null)).toBe('$12.40');
    expect(formatUsageMoney(1240, 'invalid')).toBe('invalid 1240');
  });
  it('shows used amount only and no meter for a null monthly limit', () => {
    expect(
      formatExtraUsage({
        is_enabled: true,
        monthly_limit: null,
        used_credits: 1240,
        utilization: 80,
        currency: 'USD',
      }),
    ).toEqual({ text: '已用 $12.40', percent: null });
    expect(
      formatExtraUsage({
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 1240,
        utilization: 80,
        currency: 'USD',
      }),
    ).toEqual({ text: '$12.40 / $50.00', percent: 24.8 });
    expect(
      formatExtraUsage({ is_enabled: false, monthly_limit: 5000, used_credits: 1240, utilization: 80 }),
    ).toEqual({ text: '额外用量未启用', percent: null });
    expect(
      formatExtraUsage({ is_enabled: true, monthly_limit: 5000, used_credits: null, utilization: null }),
    ).toEqual({ text: '— / $50.00', percent: null });
    expect(
      formatExtraUsage({ is_enabled: true, monthly_limit: 0, used_credits: 0, utilization: null }).percent,
    ).toBe(0);
  });
});

describe('refresh labels', () => {
  it('distinguishes fresh, stale, retained failure data and initial failures', () => {
    expect(formatUsageUpdated(now - 59_999, null, now)).toBe('刚刚更新');
    expect(formatUsageUpdated(now - 60_000, null, now)).toBe('更新于 1 分钟前');
    expect(formatUsageUpdated(now - 12 * 60_000, 'failed', now)).toBe('更新失败，显示的是 12 分钟前的数据');
    expect(formatUsageUpdated(null, 'failed', now)).toBe('操作失败：额度读取失败');
    expect(formatUsageUpdated(null, null, now)).toBe('额度读取中…');
    expect(formatUsageNotice(emptyUsage().limited, now)).toBeNull();
  });
});
