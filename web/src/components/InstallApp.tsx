import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, X } from 'lucide-react';
import { installApp, useInstallation } from '../pwa';
import './install.css';

export function InstallApp() {
  const { installed, available } = useInstallation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const appleMobile =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (installed) return null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="cw-install-button"
          disabled={busy}
          onClick={(event) => {
            setError('');
            if (!available) return;
            event.preventDefault();
            setBusy(true);
            void installApp()
              .catch(() => {
                setError('未能打开安装窗口，请使用浏览器菜单安装。');
                setOpen(true);
              })
              .finally(() => setBusy(false));
          }}
        >
          <Download size={16} aria-hidden="true" />
          {busy ? '正在打开安装…' : '安装应用'}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="cw-session-overlay" />
        <Dialog.Content className="cw-install-dialog">
          <header className="cw-install-head">
            <Dialog.Title>安装 claude-web</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="cw-icon-button" aria-label="关闭安装说明">
                <X size={20} />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description>将应用添加到桌面或主屏幕，下次可直接以独立窗口打开。</Dialog.Description>
          {error && <p role="alert">{error}</p>}
          {!window.isSecureContext ? (
            <p>请通过 HTTPS 访问本站，再使用浏览器的安装功能。</p>
          ) : appleMobile ? (
            <ol>
              <li>用 Safari 打开本站，登录后点“分享”。</li>
              <li>选择“添加到主屏幕”；若有“作为网页 App 打开”，保持开启。</li>
              <li>点“添加”，即可从主屏幕启动。</li>
            </ol>
          ) : (
            <>
              <p>Chrome / Edge：打开浏览器菜单，选择“安装 claude-web”“安装此网站为应用”或“添加到主屏幕”。</p>
              <p>Mac Safari：在“文件”菜单中选择“添加到程序坞”。</p>
              <p>
                如果没有安装选项，请使用最新版 Chrome、Edge 或 Safari
                打开本站；已经安装的应用可以直接从桌面启动。
              </p>
            </>
          )}
          <p className="cw-install-note">会话和终端需要联网使用。</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
