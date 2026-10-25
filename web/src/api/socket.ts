import type { WireEvent } from '../../../shared/protocol';
export class SessionSocket {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pongTimeout?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private attempt = 0;
  private subscriptions = new Map<string, { epoch?: string; afterSeq?: number }>();
  private resume = () => {
    if (document.visibilityState === 'visible') this.reconnect();
  };
  constructor(
    private onFrame: (frame: WireEvent) => void,
    private onConnection: (connected: boolean) => void,
  ) {
    document.addEventListener('visibilitychange', this.resume);
    window.addEventListener('online', this.resume);
    this.connect();
  }
  private stopHeartbeat() {
    clearInterval(this.heartbeat);
    clearTimeout(this.pongTimeout);
  }
  private reconnect() {
    if (this.disposed) return;
    this.stopHeartbeat();
    clearTimeout(this.timer);
    const old = this.socket;
    if (old) {
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      old.close();
    }
    this.onConnection(false);
    this.timer = setTimeout(() => this.connect(), 0);
  }
  private connect() {
    if (this.disposed) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.socket = ws;
    ws.onopen = () => {
      if (this.disposed || this.socket !== ws) {
        ws.close();
        return;
      }
      this.attempt = 0;
      this.onConnection(true);
      this.heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'ping' }));
        this.pongTimeout = setTimeout(() => this.reconnect(), 10000);
      }, 20000);
      for (const [sessionId, cursor] of this.subscriptions)
        this.send({ type: 'subscribe', sessionId, ...cursor });
    };
    ws.onmessage = (message) => {
      if (this.disposed || this.socket !== ws) return;
      try {
        const frame = JSON.parse(message.data) as WireEvent;
        if (frame.type === 'pong') {
          clearTimeout(this.pongTimeout);
          return;
        }
        if (frame.sessionId && this.subscriptions.has(frame.sessionId)) {
          const cursor = this.subscriptions.get(frame.sessionId)!;
          if (frame.type === 'snapshot')
            this.subscriptions.set(frame.sessionId, { epoch: frame.epoch, afterSeq: frame.seq });
          else if (frame.seq !== undefined && (!cursor.epoch || cursor.epoch === frame.epoch))
            this.subscriptions.set(frame.sessionId, {
              epoch: frame.epoch,
              afterSeq: Math.max(frame.seq, cursor.afterSeq ?? 0),
            });
        }
        this.onFrame(frame);
      } catch {
        /* Ignore malformed server frames. */
      }
    };
    ws.onclose = () => {
      if (this.disposed || this.socket !== ws) return;
      this.stopHeartbeat();
      this.onConnection(false);
      this.timer = setTimeout(
        () => this.connect(),
        Math.min(30000, 500 * 2 ** this.attempt++) + Math.random() * 250,
      );
    };
    ws.onerror = () => ws.close();
  }
  subscribe(sessionId: string) {
    if (this.subscriptions.has(sessionId)) return;
    this.subscriptions.set(sessionId, {});
    this.send({ type: 'subscribe', sessionId });
  }
  unsubscribe(sessionId: string) {
    this.subscriptions.delete(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }
  send(value: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(value));
    return true;
  }
  close() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.stopHeartbeat();
    document.removeEventListener('visibilitychange', this.resume);
    window.removeEventListener('online', this.resume);
    this.socket?.close();
  }
}
