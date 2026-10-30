import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { api } from '../api/client';

export function CacheSettings({
  sessionId,
  children,
  description,
  className,
  onError,
}: {
  sessionId: string;
  children: ReactNode;
  description: string;
  className?: string;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [readVersion, setReadVersion] = useState(0);
  const saveController = useRef<AbortController | null>(null);
  const settingsPath = `/api/sessions/${encodeURIComponent(sessionId)}/settings`;
  useEffect(() => {
    setEnabled(undefined);
    setSaving(false);
    setError('');
    return () => saveController.current?.abort();
  }, [sessionId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setEnabled(undefined);
    setError('');
    void api<{ autoCompactBeforeExpiry: boolean }>(settingsPath, { signal: controller.signal })
      .then((settings) => {
        if (typeof settings.autoCompactBeforeExpiry !== 'boolean') throw new Error('Invalid settings');
        if (!controller.signal.aborted) setEnabled(settings.autoCompactBeforeExpiry);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('暂时无法加载设置。');
      });
    return () => controller.abort();
  }, [open, readVersion, settingsPath]);
  const toggle = async () => {
    if (enabled === undefined || saving) return;
    const controller = new AbortController();
    saveController.current = controller;
    setSaving(true);
    try {
      const settings = await api<{ autoCompactBeforeExpiry: boolean }>(settingsPath, {
        method: 'PATCH',
        body: JSON.stringify({ autoCompactBeforeExpiry: !enabled }),
        signal: controller.signal,
      });
      if (typeof settings.autoCompactBeforeExpiry !== 'boolean') throw new Error('设置保存失败');
      if (!controller.signal.aborted) setEnabled(settings.autoCompactBeforeExpiry);
    } catch (error) {
      if (!controller.signal.aborted) onError(error instanceof Error ? error.message : '设置保存失败');
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`cc-stat ${className ?? ''}`}
          aria-label="缓存与自动压缩"
          title={description}
          disabled={saving}
        >
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="cc-menu cc-cache-settings"
          aria-label="缓存设置"
        >
          <p>{description}</p>
          <button
            type="button"
            role="switch"
            aria-label="缓存到期前自动压缩"
            aria-checked={enabled ?? false}
            disabled={enabled === undefined || saving}
            className="cc-menu-item"
            onClick={() => void toggle()}
          >
            <span>自动压缩</span>
            <strong>
              {saving
                ? '保存中…'
                : error
                  ? '暂不可用'
                  : enabled === undefined
                    ? '加载中…'
                    : enabled
                      ? '已开启'
                      : '已关闭'}
            </strong>
          </button>
          <p>缓存过期前 5 分钟，趁会话空闲时整理上下文，减少下次继续对话的用量。</p>
          <p>此开关仅对当前会话生效，仅在浏览器连接此会话时执行。压缩本身也会消耗额度。</p>
          {error && (
            <div className="cc-cache-error">
              <span role="alert">{error}</span>
              <button type="button" className="btn" onClick={() => setReadVersion((value) => value + 1)}>
                重试
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
