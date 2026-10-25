import { test, expect, vi } from 'vitest';
import { SessionSocket } from '../web/src/api/socket';
test('times out half-open sockets and resubscribes with the last acknowledged cursor', () => {
  vi.useFakeTimers();
  const instances: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    frames: any[] = [];
    onopen: any;
    onclose: any;
    onerror: any;
    onmessage: any;
    constructor(_url: string) {
      instances.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(raw: string) {
      this.frames.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    message(frame: unknown) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('location', { protocol: 'https:', host: 'cc.example.com' });
  const onConnection = vi.fn();
  const connection = new SessionSocket(vi.fn(), onConnection);
  try {
    connection.subscribe('session');
    instances[0].open();
    instances[0].message({ type: 'snapshot', sessionId: 'session', epoch: 'epoch', seq: 17 });
    vi.advanceTimersByTime(20000);
    expect(instances[0].frames.at(-1)).toEqual({ type: 'ping' });
    vi.advanceTimersByTime(10001);
    expect(instances).toHaveLength(2);
    expect(onConnection).toHaveBeenLastCalledWith(false);
    instances[1].open();
    expect(instances[1].frames[0]).toEqual({
      type: 'subscribe',
      sessionId: 'session',
      epoch: 'epoch',
      afterSeq: 17,
    });
    vi.advanceTimersByTime(20000);
    instances[1].message({ type: 'pong' });
    vi.advanceTimersByTime(10001);
    expect(instances).toHaveLength(2);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1);
    expect(instances).toHaveLength(3);
  } finally {
    connection.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
