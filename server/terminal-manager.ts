import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as nodePty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { TerminalInfo, TerminalFrame, TerminalListener } from '../shared/terminal.js';
import type { Config } from './config.js';
import { HttpError, type Paths } from './paths.js';
import { TerminalProcess } from './terminal-process.js';
import { TerminalOutput } from './terminal-output.js';

const SCROLLBACK = 5_000;
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;
const PARSE_CHUNK = 16 * 1024;
const MAX_INPUT = 64 * 1024;

interface ManagedTerminal {
  info: TerminalInfo;
  pty: nodePty.IPty;
  process: TerminalProcess;
  screen: HeadlessTerminal;
  serializer: SerializeAddon;
  listeners: Set<TerminalListener>;
  subscriptions: Map<TerminalListener, object>;
  tail: Promise<void>;
  seq: number;
  pendingBytes: number;
  paused: boolean;
  ended: boolean;
  output: TerminalOutput;
  retired?: number;
  finishTask?: Promise<void>;
  closeTask?: Promise<void>;
}

/** Explicit names only: e.g. LC_API_KEY must not sneak through an LC_* wildcard. */
export function terminalEnvironment(shell: string, source = process.env): Record<string, string> {
  const user = os.userInfo();
  const env: Record<string, string> = {};
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'LC_COLLATE',
    'LC_MESSAGES',
    'LC_MONETARY',
    'LC_NUMERIC',
    'LC_TIME',
    'LC_ADDRESS',
    'LC_IDENTIFICATION',
    'LC_MEASUREMENT',
    'LC_NAME',
    'LC_PAPER',
    'LC_TELEPHONE',
    'TZ',
  ]) {
    if (source[key] !== undefined) env[key] = source[key]!;
  }
  env.HOME ??= user.homedir;
  env.USER ??= user.username;
  env.LOGNAME ??= user.username;
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin';
  env.LANG ??= 'C.UTF-8';
  env.SHELL = shell;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function emit(listener: TerminalListener, frame: TerminalFrame): boolean {
  try {
    listener(frame);
    return true;
  } catch {
    // Transport failures belong to the connection, not to the PTY or other clients.
    return false;
  }
}

/** In-memory PTYs, independent of Claude runtimes. Closing browsers does not close shells. */
export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly listeners = new Set<TerminalListener>();
  private readonly shell: string;
  private readonly maxTerminals: number;
  private readonly maxPerProject: number;
  private nextName = 0;
  private nextRetired = 0;
  private closing = false;
  private closeTask?: Promise<void>;

  constructor(
    config: Config,
    private readonly paths: Paths,
  ) {
    this.shell = config.terminal?.shell || os.userInfo().shell || '/bin/bash';
    this.maxTerminals = config.terminal?.maxTerminals ?? 8;
    this.maxPerProject = config.terminal?.maxPerProject ?? 4;
  }

  private ensureOpen(): void {
    if (this.closing) throw new HttpError(503, '终端管理器正在关闭', 'SERVER_CLOSING');
  }

  private validateId(id: string): void {
    if (typeof id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) {
      throw new HttpError(400, '终端 ID 必须是有效 UUID', 'INVALID_TERMINAL_ID');
    }
  }

  private get(id: string): ManagedTerminal {
    this.validateId(id);
    const terminal = this.terminals.get(id);
    if (!terminal) throw new HttpError(404, '终端不存在', 'TERMINAL_NOT_FOUND');
    return terminal;
  }

  private running(terminal: ManagedTerminal): void {
    this.ensureOpen();
    if (terminal.info.status !== 'running' || terminal.ended) {
      throw new HttpError(409, '终端已结束或正在关闭', 'TERMINAL_NOT_RUNNING');
    }
  }

  private size(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      cols < 20 ||
      cols > 500 ||
      !Number.isInteger(rows) ||
      rows < 5 ||
      rows > 300
    ) {
      throw new HttpError(400, '终端尺寸应为 20–500 列、5–300 行', 'INVALID_TERMINAL_SIZE');
    }
  }

  private async cwd(value: string): Promise<string> {
    if (typeof value !== 'string') throw new HttpError(400, '启动目录必须是绝对路径', 'INVALID_TERMINAL_CWD');
    try {
      return await this.paths.cwd(value);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, '启动目录不存在或不可访问', 'INVALID_TERMINAL_CWD');
    }
  }

  private infos(cwd: string): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((entry) => entry.info.cwd === cwd)
      .map((entry) => ({ ...entry.info }));
  }

  private broadcastList(cwd: string): void {
    for (const listener of this.listeners) {
      if (!emit(listener, { type: 'terminal.list', cwd, terminals: this.infos(cwd) }))
        this.listeners.delete(listener);
    }
  }

  private broadcast(terminal: ManagedTerminal, frame: TerminalFrame): void {
    for (const listener of terminal.listeners) {
      if (!emit(listener, frame)) this.unsubscribe(terminal.info.terminalId, listener);
    }
  }

  private enqueue<T>(terminal: ManagedTerminal, action: () => T | Promise<T>): Promise<T> {
    const task = terminal.tail.then(action);
    // Keep subsequent operations usable even if an API operation (e.g. resize after exit) fails.
    terminal.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private output(terminal: ManagedTerminal, data: string): void {
    data = terminal.output.push(data);
    // node-pty decodes UTF-8 across read boundaries. Do not split a surrogate pair ourselves.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + PARSE_CHUNK, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const chunk = data.slice(offset, end);
      offset = end;
      const bytes = Buffer.byteLength(chunk, 'utf8');
      terminal.pendingBytes += bytes;
      if (!terminal.paused && terminal.pendingBytes >= HIGH_WATER) {
        terminal.paused = true;
        terminal.pty.pause();
      }
      void this.enqueue(terminal, async () => {
        try {
          await new Promise<void>((resolve) => terminal.screen.write(chunk, resolve));
          this.broadcast(terminal, {
            type: 'terminal.output',
            terminalId: terminal.info.terminalId,
            epoch: terminal.info.epoch,
            seq: ++terminal.seq,
            data: chunk,
          });
        } finally {
          terminal.pendingBytes -= bytes;
          if (terminal.paused && terminal.pendingBytes <= LOW_WATER) {
            terminal.paused = false;
            terminal.pty.resume();
          }
        }
      }).catch(() => {
        // A parser failure must still clean up its owned processes.
        void this.closeTerminal(terminal.info.terminalId).catch(() => {});
      });
    }
  }

  async list(cwd: string): Promise<TerminalInfo[]> {
    const checked = await this.cwd(cwd);
    return this.infos(checked);
  }

  async create(cwd: string, cols: number, rows: number): Promise<TerminalInfo> {
    this.ensureOpen();
    this.size(cols, rows);
    const checked = await this.cwd(cwd);
    if (!path.isAbsolute(this.shell))
      throw new HttpError(500, 'Shell 必须是可执行绝对路径', 'INVALID_TERMINAL_SHELL');
    try {
      await access(this.shell, constants.X_OK);
      if (!(await stat(this.shell)).isFile()) throw new Error('Not a file');
    } catch {
      throw new HttpError(500, 'Shell 不可执行', 'INVALID_TERMINAL_SHELL');
    }
    this.ensureOpen();
    const live = [...this.terminals.values()].filter((entry) => entry.info.status !== 'exited');
    // No await between the capacity check and spawn/reservation, including concurrent creates.
    if (
      live.length >= this.maxTerminals ||
      live.filter((entry) => entry.info.cwd === checked).length >= this.maxPerProject
    ) {
      throw new HttpError(409, '终端数量已达上限，关闭一个后再新建', 'TERMINAL_LIMIT_REACHED');
    }
    const screen = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon();
    screen.loadAddon(serializer);
    let pty: nodePty.IPty;
    try {
      pty = nodePty.spawn(this.shell, ['-i'], {
        cwd: checked,
        cols,
        rows,
        name: 'xterm-256color',
        encoding: 'utf8',
        env: terminalEnvironment(this.shell),
      });
    } catch {
      screen.dispose();
      throw new HttpError(500, '无法启动终端 Shell', 'TERMINAL_SPAWN_FAILED');
    }
    const terminal: ManagedTerminal = {
      info: {
        terminalId: randomUUID(),
        epoch: randomUUID(),
        cwd: checked,
        name: `${path.basename(this.shell)} ${++this.nextName}`,
        cols,
        rows,
        status: 'running',
        createdAt: Date.now(),
      },
      pty,
      process: new TerminalProcess(pty),
      screen,
      serializer,
      listeners: new Set(),
      subscriptions: new Map(),
      tail: Promise.resolve(),
      seq: 0,
      pendingBytes: 0,
      paused: false,
      ended: false,
      output: new TerminalOutput(),
    };
    this.terminals.set(terminal.info.terminalId, terminal);
    // Answer cursor/device queries once, including while browsers are disconnected.
    screen.onData((data) => {
      if (!terminal.ended) {
        try {
          pty.write(data);
        } catch {
          /* Exit raced a query. */
        }
      }
    });
    pty.onData((data) => this.output(terminal, data));
    void terminal.process.exited.then(() => {
      terminal.ended = true;
      void this.finish(terminal).catch(() => {});
    });
    this.broadcastList(checked);
    return { ...terminal.info };
  }

  connect(listener: TerminalListener): () => void {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async subscribe(id: string, listener: TerminalListener): Promise<void> {
    this.ensureOpen();
    const terminal = this.get(id);
    const token = {};
    terminal.subscriptions.set(listener, token);
    terminal.listeners.delete(listener);
    await this.enqueue(terminal, () => {
      if (terminal.subscriptions.get(listener) !== token) return;
      const frame: TerminalFrame = {
        type: 'terminal.snapshot',
        ...terminal.info,
        seq: terminal.seq,
        screen: terminal.serializer.serialize({ scrollback: SCROLLBACK }),
      };
      // No await between serialization, sending the snapshot and installing the listener.
      if (emit(listener, frame) && terminal.subscriptions.get(listener) === token) {
        terminal.listeners.add(listener);
      } else {
        terminal.subscriptions.delete(listener);
      }
    });
  }

  unsubscribe(id: string, listener: TerminalListener): void {
    this.validateId(id);
    // Connections can outlive explicitly closed or automatically evicted terminals.
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.subscriptions.delete(listener);
    terminal.listeners.delete(listener);
  }

  async input(id: string, data: string): Promise<void> {
    const terminal = this.get(id);
    this.running(terminal);
    if (typeof data !== 'string') throw new HttpError(400, '终端输入必须是字符串', 'INVALID_TERMINAL_INPUT');
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT) {
      throw new HttpError(413, '终端输入不能超过 64KB', 'TERMINAL_INPUT_TOO_LARGE');
    }
    terminal.pty.write(data);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    this.size(cols, rows);
    const terminal = this.get(id);
    this.running(terminal);
    await this.enqueue(terminal, () => {
      this.running(terminal);
      if (terminal.info.cols === cols && terminal.info.rows === rows) return;
      terminal.pty.resize(cols, rows);
      terminal.screen.resize(cols, rows);
      terminal.info.cols = cols;
      terminal.info.rows = rows;
      this.broadcast(terminal, {
        type: 'terminal.resized',
        terminalId: id,
        epoch: terminal.info.epoch,
        seq: ++terminal.seq,
        cols,
        rows,
      });
    });
  }

  private finish(terminal: ManagedTerminal): Promise<void> {
    if (terminal.finishTask) return terminal.finishTask;
    const changed = terminal.info.status === 'running';
    if (changed) terminal.info.status = 'closing';
    const task = (async () => {
      try {
        await terminal.process.stop();
      } catch {
        throw new HttpError(500, '终端进程尚未退出，请重试关闭', 'TERMINAL_CLOSE_FAILED');
      }
      const result = await terminal.process.exited;
      await this.enqueue(terminal, () => {
        terminal.info.status = 'exited';
        terminal.info.exitCode = result.exitCode;
        if (result.signal) terminal.info.signal = result.signal;
        terminal.retired = ++this.nextRetired;
        this.broadcast(terminal, {
          type: 'terminal.exited',
          terminalId: terminal.info.terminalId,
          epoch: terminal.info.epoch,
          exitCode: result.exitCode,
          ...(result.signal ? { signal: result.signal } : {}),
        });
        this.pruneExited();
        this.broadcastList(terminal.info.cwd);
      });
    })();
    terminal.finishTask = task;
    if (changed) this.broadcastList(terminal.info.cwd);
    void task.catch(() => {
      if (terminal.finishTask === task) terminal.finishTask = undefined;
    });
    return task;
  }

  private remove(terminal: ManagedTerminal): void {
    this.terminals.delete(terminal.info.terminalId);
    terminal.listeners.clear();
    terminal.subscriptions.clear();
    terminal.screen.dispose();
  }

  /** Keep the newest exited screens: <= global limit, <= per-project limit, plus live PTYs. */
  private pruneExited(): void {
    const exited = [...this.terminals.values()]
      .filter((entry) => entry.info.status === 'exited' && !entry.closeTask)
      .sort((a, b) => b.retired! - a.retired!);
    const counts = new Map<string, number>();
    let retained = 0;
    const changed = new Set<string>();
    for (const entry of exited) {
      const count = counts.get(entry.info.cwd) ?? 0;
      if (retained >= this.maxTerminals || count >= this.maxPerProject) {
        this.remove(entry);
        changed.add(entry.info.cwd);
      } else {
        retained++;
        counts.set(entry.info.cwd, count + 1);
      }
    }
    for (const cwd of changed) this.broadcastList(cwd);
  }

  async closeTerminal(id: string): Promise<void> {
    const terminal = this.get(id);
    if (terminal.closeTask) return terminal.closeTask;
    const task = (async () => {
      if (terminal.info.status !== 'exited') await this.finish(terminal);
      await this.enqueue(terminal, () => this.remove(terminal));
      this.broadcastList(terminal.info.cwd);
    })();
    terminal.closeTask = task;
    void task.catch(() => {
      if (terminal.closeTask === task) terminal.closeTask = undefined;
    });
    return task;
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    const task = (async () => {
      const results = await Promise.allSettled(
        [...this.terminals.keys()].map((id) => this.closeTerminal(id)),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      this.listeners.clear();
    })();
    this.closeTask = task;
    void task.catch(() => {
      if (this.closeTask === task) this.closeTask = undefined;
    });
    return task;
  }
}
