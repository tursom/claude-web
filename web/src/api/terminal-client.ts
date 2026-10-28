import type { TerminalFrame, TerminalListener } from '../../../shared/terminal';

/** A bridge to the application's sole WebSocket. Input is never queued or replayed. */
export class TerminalClient {
  private listeners = new Set<TerminalListener>();
  private connections = new Set<(connected: boolean) => void>();
  private subscriptions = new Map<string, number>();
  private sender?: (frame: Record<string, unknown>) => boolean;
  private connected = false;

  attach(sender: (frame: Record<string, unknown>) => boolean): () => void {
    this.sender = sender;
    return () => {
      if (this.sender !== sender) return;
      this.connection(false);
      this.sender = undefined;
    };
  }

  connection(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connections) listener(connected);
    if (connected)
      for (const terminalId of this.subscriptions.keys())
        this.send({ type: 'terminal.subscribe', terminalId });
  }

  receive(frame: TerminalFrame) {
    for (const listener of this.listeners) listener(frame);
  }

  listen(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connections.add(listener);
    listener(this.connected);
    return () => {
      this.connections.delete(listener);
    };
  }

  subscribe(terminalId: string) {
    this.subscriptions.set(terminalId, (this.subscriptions.get(terminalId) ?? 0) + 1);
    // A second view also needs a fresh screen. Existing views can safely replace theirs.
    this.send({ type: 'terminal.subscribe', terminalId });
  }

  unsubscribe(terminalId: string) {
    const count = this.subscriptions.get(terminalId) ?? 0;
    if (count > 1) {
      this.subscriptions.set(terminalId, count - 1);
      return;
    }
    this.subscriptions.delete(terminalId);
    this.send({ type: 'terminal.unsubscribe', terminalId });
  }

  send(frame: Record<string, unknown>): boolean {
    return this.connected && !!this.sender?.(frame);
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export const terminalClient = new TerminalClient();
