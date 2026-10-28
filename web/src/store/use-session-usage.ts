import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionUsageResponse, SessionUsageSummary } from './session-usage';
import { api } from '../api/client';

/** Keep remote counters scoped to this session/epoch and its latest known result. */
export function useSessionUsage(
  sessionId: string | undefined,
  epoch: string | undefined,
  local: SessionUsageSummary | null,
): SessionUsageResponse & { refreshing: boolean; error: boolean; onRefresh: () => void } {
  const key = JSON.stringify([sessionId, epoch, local]);
  const hasLocal = local !== null;
  const [state, setState] = useState<{
    key: string;
    response?: SessionUsageResponse;
    pending: boolean;
    error: boolean;
  }>();
  const active = useRef<{ key: string; controller: AbortController }>(undefined);
  const refresh = useCallback(() => {
    if (!sessionId || active.current?.key === key) return;
    active.current?.controller.abort();
    const controller = new AbortController();
    active.current = { key, controller };
    setState((previous) => ({
      key,
      response: previous?.key === key ? previous.response : undefined,
      pending: true,
      error: false,
    }));
    void api<SessionUsageResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/usage`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((response) => {
        if (
          !response ||
          !['saved', 'result', 'unavailable'].includes(response.source) ||
          !('usage' in response)
        )
          throw new Error('Invalid session usage response');
        if (!controller.signal.aborted) setState({ key, response, pending: false, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState((previous) => ({
            key,
            response: previous?.key === key ? previous.response : undefined,
            pending: false,
            error: true,
          }));
      })
      .finally(() => {
        if (active.current?.controller === controller) active.current = undefined;
      });
  }, [sessionId, key]);
  useEffect(() => {
    // A result already contains cumulative counters. Fetch only when none have
    // arrived (e.g. opening saved history), or when the user explicitly refreshes.
    if (!hasLocal) refresh();
    return () => {
      active.current?.controller.abort();
      active.current = undefined;
    };
  }, [refresh, hasLocal]);
  const current = state?.key === key ? state : undefined;
  const remote = current?.response?.usage ? current.response : undefined;
  return {
    usage: remote?.usage ?? local,
    source: remote?.source ?? (local ? 'result' : 'unavailable'),
    refreshing: current?.pending ?? (!!sessionId && !local),
    error: current?.error ?? false,
    onRefresh: refresh,
  };
}
