import { Check, LoaderCircle, Minimize2, TriangleAlert, X } from 'lucide-react';
import type { Status } from '../../../shared/protocol';
import { compactionState, type Compaction } from './compaction';
import { duration } from './content';
import './compaction.css';

export function CompactionCard({ value, status }: { value: Compaction; status: Status }) {
  const state = compactionState(value, status);
  const title = {
    running: '正在压缩上下文…',
    requested: '已请求压缩上下文',
    success: '上下文已压缩',
    summary: '压缩摘要',
    warning: '上下文已压缩，命令报告异常',
    failed: '会话压缩失败',
    interrupted: '压缩已中断',
    incomplete: '未收到压缩完成信息',
  }[state];
  const Icon =
    state === 'running'
      ? LoaderCircle
      : state === 'success'
        ? Check
        : state === 'warning'
          ? TriangleAlert
          : state === 'failed'
            ? X
            : Minimize2;
  const limited = value.error && /session limit|rate.?limit|usage limit|credits_required/i.test(value.error);
  return (
    <section
      className={`cc-compaction cc-compaction-${state}`}
      aria-label="会话压缩"
      aria-busy={state === 'running'}
    >
      <div className="cc-compaction-head">
        <Icon size={16} className={state === 'running' ? 'cc-spin' : undefined} />
        <strong role="status">{title}</strong>
        {value.trigger && (
          <span>
            {value.beforeCacheExpiry ? '缓存到期前自动' : value.trigger === 'auto' ? '自动' : '手动'}
          </span>
        )}
      </div>
      {(value.preTokens !== undefined || value.durationMs !== undefined) && (
        <div className="cc-compaction-meta">
          {value.preTokens !== undefined && (
            <span>
              上下文 {value.preTokens.toLocaleString('en-US')}
              {value.postTokens !== undefined && <> → {value.postTokens.toLocaleString('en-US')}</>} tokens
            </span>
          )}
          {value.durationMs !== undefined && <span>耗时 {duration(value.durationMs)}</span>}
        </div>
      )}
      {limited && <p className="cc-compaction-error">额度已用完，请等待恢复后再继续。</p>}
      {value.error && (
        <details className="cc-compaction-details">
          <summary>查看错误详情</summary>
          <pre>{value.error}</pre>
        </details>
      )}
      {value.instructions && (
        <details className="cc-compaction-details">
          <summary>压缩要求</summary>
          <pre>{value.instructions}</pre>
        </details>
      )}
      {value.summary && (
        <details className="cc-compaction-details">
          <summary>查看压缩摘要</summary>
          <pre>{value.summary}</pre>
        </details>
      )}
    </section>
  );
}
