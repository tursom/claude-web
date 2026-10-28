import { useSyncExternalStore } from 'react';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const standalone = window.matchMedia('(display-mode: standalone)');
const isStandalone = () =>
  standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
let prompt: InstallPrompt | undefined;
let snapshot = { installed: isStandalone(), available: false };
const listeners = new Set<() => void>();
function publish(installed = snapshot.installed) {
  snapshot = { installed, available: !!prompt };
  listeners.forEach((listener) => listener());
}
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  prompt = event as InstallPrompt;
  publish();
});
window.addEventListener('appinstalled', () => {
  prompt = undefined;
  publish(true);
});
standalone.addEventListener('change', () => publish(isStandalone()));

export function useInstallation() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export async function installApp() {
  const pending = prompt;
  if (!pending) return;
  prompt = undefined; // Browser prompts are single-use, including when dismissed.
  publish();
  await pending.prompt();
  return (await pending.userChoice).outcome;
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((error) => {
    console.warn('应用离线页面注册失败，下次打开时重试。', error);
  });
}
