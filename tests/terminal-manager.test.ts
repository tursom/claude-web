import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalFrame, TerminalInfo, TerminalListener } from '../shared/terminal.js';
import type { Config } from '../server/config.js';
import { Paths } from '../server/paths.js';
import { TerminalManager, terminalEnvironment } from '../server/terminal-manager.js';

let directory: string;
let outside: string;
let shell: string;
let config: Config;
let managers: TerminalManager[];

async function until(check: () => boolean | Promise<boolean>, timeout = 6_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for real PTY output/process');
    await delay(10);
  }
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'terminal-manager-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'terminal-outside-'));
  // Real interactive bash, isolated from developer dotfiles and their prompt commands.
  shell = path.join(directory, 'test-bash');
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o700);
  config = {
    listen: '127.0.0.1:8504',
    owner: 'test@example.com',
    allowedOrigins: ['http://localhost'],
    workspaceRoots: [directory],
    claudePath: '/never-call-claude',
    maxLiveSessions: 4,
    idleCloseMinutes: 30,
    terminal: { shell, maxTerminals: 8, maxPerProject: 4 },
  };
  managers = [];
});

afterEach(async () => {
  try {
    await Promise.all(managers.map((manager) => manager.close()));
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

function manager(terminal = config.terminal): TerminalManager {
  const result = new TerminalManager({ ...config, terminal }, new Paths([directory]));
  managers.push(result);
  return result;
}

async function session(value: TerminalManager, cols = 80, rows = 24, cwd = directory) {
  const info = await value.create(cwd, cols, rows);
  const frames: TerminalFrame[] = [];
  let output = '';
  const listener: TerminalListener = (frame) => {
    frames.push(frame);
    if (frame.type === 'terminal.output') output += frame.data;
  };
  await value.subscribe(info.terminalId, listener);
  await value.input(info.terminalId, "stty -echo; PS1=''; PROMPT_COMMAND=''; printf '\\n__READY__\\n'\r");
  await until(() => output.includes('\r\n__READY__\r\n'));
  return { info, frames, listener, output: () => output };
}

function snapshot(frames: TerminalFrame[]) {
  const frame = frames.find((entry) => entry.type === 'terminal.snapshot');
  if (!frame || frame.type !== 'terminal.snapshot') throw new Error('Missing snapshot');
  return frame;
}

async function screenFrom(frame: ReturnType<typeof snapshot>): Promise<HeadlessTerminal> {
  const screen = new headless.Terminal({
    cols: frame.cols,
    rows: frame.rows,
    scrollback: 5_000,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => screen.write(frame.screen, resolve));
  return screen;
}

function lines(screen: HeadlessTerminal): string[] {
  const buffer = screen.buffer.active;
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(true));
}

async function processRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('TerminalManager real PTYs', () => {
  it('reconnects in the middle of a control sequence without leaking its unfinished parser state', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    await value.input(id, "printf '\\033[2J\\033[Hbefore\\033[3'; sleep 0.3; printf '1mRED\\033[0m\\n'\r");
    await until(() => active.output().includes('before'));
    const frames: TerminalFrame[] = [];
    await value.subscribe(id, (frame) => frames.push(frame));
    const screen = await screenFrom(snapshot(frames));
    try {
      expect(lines(screen)[0]).toBe('before');
      await until(() =>
        frames.some((frame) => frame.type === 'terminal.output' && frame.data.includes('RED')),
      );
      for (const frame of frames)
        if (frame.type === 'terminal.output')
          await new Promise<void>((resolve) => screen.write(frame.data, resolve));
      expect(lines(screen)[0]).toBe('beforeRED');
      expect(screen.buffer.active.getLine(0)!.getCell(6)!.getFgColor()).toBe(1);
    } finally {
      screen.dispose();
    }
  });

  it('answers device queries with no browser attached', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    value.unsubscribe(id, active.listener);
    await value.input(
      id,
      "printf '\\033[6n'; IFS= read -r -s -t 2 -d R response; printf 'QUERY_REPLY:%q\\n' \"$response\"\r",
    );
    const received: TerminalFrame[] = [];
    await until(async () => {
      received.length = 0;
      const listener = (frame: TerminalFrame) => received.push(frame);
      await value.subscribe(id, listener);
      value.unsubscribe(id, listener);
      return snapshot(received).screen.includes('QUERY_REPLY:');
    });
    expect(snapshot(received).screen).toMatch(/QUERY_REPLY:.*\\E\[/);
  });
  it('groups by canonical cwd, broadcasts lists and only disconnects observers', async () => {
    const value = manager();
    const frames: TerminalFrame[] = [];
    const disconnect = value.connect((frame) => frames.push(frame));
    expect(await value.list(directory)).toEqual([]);
    const link = path.join(directory, 'alias');
    await symlink(directory, link);
    const first = await session(value, 80, 24, link);
    expect(first.info).toMatchObject({
      cwd: directory,
      name: 'test-bash 1',
      status: 'running',
      cols: 80,
      rows: 24,
    });
    expect(first.info.epoch).not.toBe(first.info.terminalId);
    expect(frames[0]).toMatchObject({ type: 'terminal.list', cwd: directory, terminals: [first.info] });
    const listed = await value.list(link);
    listed[0].name = 'mutated';
    expect((await value.list(directory))[0].name).toBe('test-bash 1');
    const count = first.frames.length;
    value.unsubscribe(first.info.terminalId, first.listener);
    await value.input(first.info.terminalId, "printf 'still-alive\\n'\r");
    await delay(40);
    expect(first.frames).toHaveLength(count);
    const reconnected: TerminalFrame[] = [];
    await value.subscribe(first.info.terminalId, (frame) => reconnected.push(frame));
    expect(snapshot(reconnected).screen).toContain('still-alive');
    disconnect();
    const listCount = frames.length;
    await value.closeTerminal(first.info.terminalId);
    expect(() => value.unsubscribe(first.info.terminalId, first.listener)).not.toThrow();
    expect(await value.list(directory)).toEqual([]);
    expect(frames).toHaveLength(listCount);
  });

  it('handles Chinese, readline editing, Tab completion, ANSI and Ctrl+C without closing the shell', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    await value.input(id, "printf '中文🙂\\n'\r");
    await until(() => active.output().includes('中文🙂\r\n'));
    await value.input(id, "printf 'editX\x7fY\\n'\r");
    await until(() => active.output().includes('editY\r\n'));
    await writeFile(path.join(directory, 'completion-unique'), 'tab-completed\n');
    await value.input(id, 'cat completion-uni\t\r');
    await until(() => active.output().includes('tab-completed\r\n'));
    await value.input(id, "printf '\\033[2J\\033[H\\033[31m红色\\033[0m\\n'\r");
    await until(() => active.output().includes('\x1b[31m红色'));
    const frames: TerminalFrame[] = [];
    await value.subscribe(id, (frame) => frames.push(frame));
    const screen = await screenFrom(snapshot(frames));
    try {
      expect(lines(screen)[0]).toBe('红色');
      const cell = screen.buffer.active.getLine(0)!.getCell(0)!;
      expect(cell.getFgColor()).toBe(1);
    } finally {
      screen.dispose();
    }
    await value.input(id, 'sleep 30\r');
    await delay(80);
    await value.input(id, '\x03');
    await value.input(id, "printf 'after-interrupt\\n'\r");
    await until(() => active.output().includes('after-interrupt\r\n'));
    expect((await value.list(directory))[0].status).toBe('running');
  });

  it('restores alternate-screen state and later returns to the normal screen', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    await value.input(id, "printf '\\033[2J\\033[Hnormal\\033[?1049h\\033[2J\\033[H替代屏幕'\r");
    await until(() => active.output().includes('替代屏幕'));
    const frames: TerminalFrame[] = [];
    await value.subscribe(id, (frame) => frames.push(frame));
    const screen = await screenFrom(snapshot(frames));
    try {
      expect(screen.buffer.active.type).toBe('alternate');
      expect(lines(screen)[0]).toBe('替代屏幕');
      await new Promise<void>((resolve) => screen.write('\x1b[?1049l', resolve));
      expect(screen.buffer.active.type).toBe('normal');
      expect(lines(screen)[0]).toBe('normal');
    } finally {
      screen.dispose();
    }
  });

  it('orders snapshot/output/resize with a shared seq and synchronizes two windows and the real PTY', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    const second: TerminalFrame[] = [];
    await value.input(id, "printf 'before-resize\\n'\r");
    await until(() => active.output().includes('before-resize\r\n'));
    const subscribing = value.subscribe(id, (frame) => second.push(frame));
    const resizing = value.resize(id, 101, 37);
    await Promise.all([subscribing, resizing]);
    expect(second[0].type).toBe('terminal.snapshot');
    expect(snapshot(second).screen).toContain('before-resize');
    expect(second[1]).toMatchObject({
      type: 'terminal.resized',
      cols: 101,
      rows: 37,
      seq: snapshot(second).seq + 1,
    });
    expect(active.frames.find((frame) => frame.type === 'terminal.resized')).toEqual(second[1]);
    await value.input(id, "stty size; printf 'after-resize\\n'\r");
    await until(() => active.output().includes('37 101\r\n') && active.output().includes('after-resize\r\n'));
    const ordered = second.filter((frame) => 'seq' in frame);
    for (let index = 1; index < ordered.length; index++) {
      expect(ordered[index].seq).toBe(ordered[index - 1].seq + 1);
    }
    const reconnect: TerminalFrame[] = [];
    await value.subscribe(id, (frame) => reconnect.push(frame));
    expect(snapshot(reconnect)).toMatchObject({ cols: 101, rows: 37, epoch: active.info.epoch });
    const screen = await screenFrom(snapshot(reconnect));
    try {
      expect(lines(screen).join('\n')).toContain('after-resize');
    } finally {
      screen.dispose();
    }
  });

  it('cancels queued subscriptions and isolates throwing listeners', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    const cancelled = vi.fn();
    const pending = value.subscribe(id, cancelled);
    value.unsubscribe(id, cancelled);
    await pending;
    expect(cancelled).not.toHaveBeenCalled();
    await value.subscribe(id, () => {
      throw new Error('disconnected');
    });
    value.connect(() => {
      throw new Error('disconnected');
    });
    await value.input(id, "printf 'survived-listener\\n'\r");
    await until(() => active.output().includes('survived-listener\r\n'));
    await value.closeTerminal(id);
  });

  it('delivers all tail output before natural exit and retains a read-only exit snapshot', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    await value.input(
      id,
      "printf '\\033[2J\\033[H'; for ((i=0;i<2000;i++)); do printf 'tail-%04d\\n' \"$i\"; done; exit 7\r",
    );
    await until(() => active.frames.some((frame) => frame.type === 'terminal.exited'));
    const tail = active.output().match(/tail-\d{4}\r\n/g) ?? [];
    expect(tail).toHaveLength(2_000);
    expect(tail[0]).toBe('tail-0000\r\n');
    expect(tail.at(-1)).toBe('tail-1999\r\n');
    expect(active.frames.at(-1)).toMatchObject({ type: 'terminal.exited', exitCode: 7 });
    expect((await value.list(directory))[0]).toMatchObject({ status: 'exited', exitCode: 7 });
    const frames: TerminalFrame[] = [];
    await value.subscribe(id, (frame) => frames.push(frame));
    expect(snapshot(frames)).toMatchObject({ status: 'exited', exitCode: 7 });
    expect(snapshot(frames).screen).toContain('tail-1999');
    await expect(value.input(id, 'echo no\r')).rejects.toMatchObject({
      statusCode: 409,
      code: 'TERMINAL_NOT_RUNNING',
    });
    await expect(value.resize(id, 80, 24)).rejects.toMatchObject({ code: 'TERMINAL_NOT_RUNNING' });
    await value.closeTerminal(id);
    await expect(value.subscribe(id, () => {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('bounds scrollback and pending parsing during large real output without losing the snapshot boundary', async () => {
    const value = manager();
    const active = await session(value);
    const id = active.info.terminalId;
    // Observe queue metrics and native flow control without replacing the actual PTY or parser.
    const record = (
      value as unknown as {
        terminals: Map<
          string,
          {
            pty: { pause(): void; resume(): void };
            screen: HeadlessTerminal;
            pendingBytes: number;
          }
        >;
      }
    ).terminals.get(id)!;
    const pause = vi.spyOn(record.pty, 'pause');
    const resume = vi.spyOn(record.pty, 'resume');
    let peak = 0;
    const monitor = setInterval(() => {
      peak = Math.max(peak, record.pendingBytes);
    }, 1);
    const joined: TerminalFrame[] = [];
    let joinedOutput = '';
    const listener: TerminalListener = (frame) => {
      joined.push(frame);
      if (frame.type === 'terminal.output') joinedOutput += frame.data;
    };
    try {
      // ~2 MB, enough to fill the parsing queue and exceed the scrollback bound twice.
      await value.input(
        id,
        'printf \'\\033[2J\\033[H\'; awk \'BEGIN { for(i=0;i<16000;i++) printf "ROW%05d %0120d\\n",i,0; print "__LARGE_DONE__" }\'\r',
      );
      await until(() => active.output().includes('ROW00100'));
      await value.subscribe(id, listener);
      await until(() => joinedOutput.includes('__LARGE_DONE__\r\n'), 15_000);
      expect(record.screen.buffer.normal.length).toBeLessThanOrEqual(5_000 + 24);
      expect(record.pendingBytes).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
      expect(peak).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
      expect(pause).toHaveBeenCalled();
      expect(resume).toHaveBeenCalled();
      const initial = snapshot(joined);
      const replica = await screenFrom(initial);
      const final: TerminalFrame[] = [];
      await value.subscribe(id, (frame) => final.push(frame));
      const expected = await screenFrom(snapshot(final));
      try {
        const deltas = joined.filter((frame) => frame.type === 'terminal.output');
        for (let index = 0; index < deltas.length; index++)
          expect(deltas[index].seq).toBe(initial.seq + index + 1);
        await new Promise<void>((resolve) => replica.write(joinedOutput, resolve));
        expect(lines(replica)).toEqual(lines(expected));
        expect(lines(expected).join('\n')).toContain('ROW15999');
        expect(lines(expected).join('\n')).not.toContain('ROW00000');
        expect(Buffer.byteLength(snapshot(final).screen)).toBeLessThan(2_000_000);
        const allRows = active.output().match(/ROW\d{5} /g) ?? [];
        expect(allRows).toHaveLength(16_000);
        expect(new Set(allRows).size).toBe(16_000);
      } finally {
        replica.dispose();
        expected.dispose();
      }
    } finally {
      clearInterval(monitor);
    }
  }, 25_000);

  it('drains queued parsing when a large-output process immediately exits', async () => {
    const value = manager();
    const active = await session(value);
    await value.input(
      active.info.terminalId,
      'awk \'BEGIN { for(i=0;i<16000;i++) printf "END%05d %0120d\\n",i,0 }\'; exit 9\r',
    );
    await until(() => active.frames.some((frame) => frame.type === 'terminal.exited'), 15_000);
    const rows = active.output().match(/END\d{5} /g) ?? [];
    expect(rows).toHaveLength(16_000);
    expect(new Set(rows).size).toBe(16_000);
    expect(active.frames.at(-1)).toMatchObject({ type: 'terminal.exited', exitCode: 9 });
    const frames: TerminalFrame[] = [];
    await value.subscribe(active.info.terminalId, (frame) => frames.push(frame));
    expect(snapshot(frames)).toMatchObject({ status: 'exited', exitCode: 9 });
    expect(snapshot(frames).screen).toContain('END15999');
  }, 25_000);

  it('enforces concurrent project/global limits and releases slots only after closing', async () => {
    const value = manager({ shell, maxTerminals: 3, maxPerProject: 2 });
    const other = path.join(directory, 'other');
    await mkdir(other);
    const created = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => value.create(index < 3 ? directory : other, 80, 24)),
    );
    expect(created.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    for (const result of created) {
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({
          statusCode: 409,
          code: 'TERMINAL_LIMIT_REACHED',
          message: '终端数量已达上限，关闭一个后再新建',
        });
    }
    expect((await value.list(directory)).length).toBeLessThanOrEqual(2);
    expect((await value.list(other)).length).toBeLessThanOrEqual(2);
    const [first] = await value.list(directory);
    const broadcasts: TerminalFrame[] = [];
    value.connect((frame) => broadcasts.push(frame));
    await value.closeTerminal(first.terminalId);
    expect(
      broadcasts.some(
        (frame) =>
          frame.type === 'terminal.list' && frame.terminals.some((info) => info.status === 'closing'),
      ),
    ).toBe(true);
    expect(await value.create(directory, 80, 24)).toMatchObject({ status: 'running' });
  });

  it('bounds exited retention globally and per project, evicting oldest exit screens', async () => {
    const value = manager({ shell, maxTerminals: 2, maxPerProject: 1 });
    const other = path.join(directory, 'other');
    const third = path.join(directory, 'third');
    await Promise.all([mkdir(other), mkdir(third)]);
    const exited: TerminalInfo[] = [];
    for (const cwd of [directory, directory, other, third]) {
      const active = await session(value, 80, 24, cwd);
      await value.input(active.info.terminalId, 'exit 3\r');
      await until(async () =>
        (await value.list(cwd)).some(
          (entry) => entry.terminalId === active.info.terminalId && entry.status === 'exited',
        ),
      );
      exited.push(active.info);
    }
    expect(await value.list(directory)).toEqual([]);
    expect(await value.list(other)).toHaveLength(1);
    expect(await value.list(third)).toHaveLength(1);
    for (const info of exited.slice(0, 2))
      await expect(value.subscribe(info.terminalId, () => {})).rejects.toMatchObject({
        code: 'TERMINAL_NOT_FOUND',
      });
    const latest: TerminalFrame[] = [];
    await value.subscribe(exited[3].terminalId, (frame) => latest.push(frame));
    expect(snapshot(latest).exitCode).toBe(3);
  });

  it('waits for foreground job-control groups and preserves output from close traps', async () => {
    const value = manager({ shell, maxTerminals: 1, maxPerProject: 1 });
    const active = await session(value);
    const id = active.info.terminalId;
    const pidFile = path.join(directory, 'foreground.pid');
    // Child shell is in a foreground group different from the interactive shell's group.
    await value.input(
      id,
      `bash --noprofile --norc -c 'trap "printf close-tail; sleep 0.25; exit 0" TERM; trap "" HUP; echo $$ > "${pidFile}"; while :; do sleep 30; done'\r`,
    );
    await until(async () => {
      try {
        return !!(await readFile(pidFile, 'utf8'));
      } catch {
        return false;
      }
    });
    const pid = +(await readFile(pidFile, 'utf8')).trim();
    const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ');
    expect(+fields[4]).toBe(pid);
    expect(+fields[5]).not.toBe(pid);
    const closing = value.closeTerminal(id);
    await expect(value.create(directory, 80, 24)).rejects.toMatchObject({ code: 'TERMINAL_LIMIT_REACHED' });
    expect((await value.list(directory))[0].status).toBe('closing');
    await closing;
    expect(await processRunning(pid)).toBe(false);
    expect(active.output()).toContain('close-tail');
    const exitIndex = active.frames.findIndex((frame) => frame.type === 'terminal.exited');
    expect(exitIndex).toBeGreaterThan(0);
    expect(active.frames.slice(exitIndex + 1).some((frame) => frame.type === 'terminal.output')).toBe(false);
    expect(await value.create(directory, 80, 24)).toMatchObject({ status: 'running' });
  });

  it('escalates to SIGKILL for resistant foreground descendants and closes idempotently', async () => {
    const value = manager();
    const active = await session(value);
    const pidFile = path.join(directory, 'resistant.pid');
    await value.input(
      active.info.terminalId,
      `bash --noprofile --norc -c 'trap "" HUP TERM; echo $$ > "${pidFile}"; exec sleep 30'\r`,
    );
    await until(async () => {
      try {
        return !!(await readFile(pidFile, 'utf8'));
      } catch {
        return false;
      }
    });
    const pid = +(await readFile(pidFile, 'utf8')).trim();
    await Promise.all([
      value.closeTerminal(active.info.terminalId),
      value.closeTerminal(active.info.terminalId),
      value.close(),
      value.close(),
    ]);
    expect(await processRunning(pid)).toBe(false);
    expect(await value.list(directory)).toEqual([]);
    await expect(value.create(directory, 80, 24)).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVER_CLOSING',
    });
  });

  it('cleans background jobs when the shell exits naturally before releasing the slot', async () => {
    const value = manager({ shell, maxTerminals: 1, maxPerProject: 1 });
    const active = await session(value);
    const pidFile = path.join(directory, 'background.pid');
    await value.input(active.info.terminalId, `sleep 30 & echo $! > "${pidFile}"; exit 6\r`);
    await until(async () => (await value.list(directory))[0]?.status === 'exited');
    const pid = +(await readFile(pidFile, 'utf8')).trim();
    expect(await processRunning(pid)).toBe(false);
    expect((await value.list(directory))[0]).toMatchObject({ exitCode: 6 });
    expect(await value.create(directory, 80, 24)).toMatchObject({ status: 'running' });
  });
});

describe('TerminalManager security and validation', () => {
  it('uses an exact environment allowlist in the actual shell', async () => {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'PI_WEB_SESSION',
      'PI_WEB_SESSIOND_SOCKET',
      'OPENAI_API_KEY',
      'OPENPROJECT_KEY',
      'NODE_OPTIONS',
      'BASH_ENV',
      'ENV',
      'LD_PRELOAD',
      'LC_SECRET_KEY',
    ]) {
      vi.stubEnv(key, `terminal-secret-${key}`);
    }
    const environment = terminalEnvironment(shell, {
      HOME: directory,
      USER: 'terminal-test',
      LANG: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      PATH: '/usr/bin:/bin',
      PI_WEB_SESSION: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      LC_SECRET_KEY: 'secret',
      NODE_OPTIONS: 'secret',
    });
    expect(environment).toEqual({
      HOME: directory,
      USER: 'terminal-test',
      LOGNAME: os.userInfo().username,
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      SHELL: shell,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
    const value = manager();
    const active = await session(value);
    await value.input(active.info.terminalId, "env; printf '__ENV_DONE__\\n'\r");
    await until(() => active.output().includes('__ENV_DONE__\r\n'));
    expect(active.output()).toContain('TERM=xterm-256color');
    expect(active.output()).toContain(`SHELL=${shell}`);
    expect(active.output()).not.toContain('terminal-secret-');
    expect(active.output()).not.toMatch(
      /(?:ANTHROPIC|PI_WEB|OPENAI|OPENPROJECT|NODE_OPTIONS|BASH_ENV|LD_PRELOAD|LC_SECRET_KEY)=/,
    );
  });

  it('validates cwd through Paths, including symlink escape and missing paths', async () => {
    const value = manager();
    const escape = path.join(directory, 'escape');
    await symlink(outside, escape);
    for (const cwd of [outside, escape]) {
      await expect(value.create(cwd, 80, 24)).rejects.toMatchObject({
        statusCode: 403,
        code: 'PATH_FORBIDDEN',
      });
      await expect(value.list(cwd)).rejects.toMatchObject({ statusCode: 403, code: 'PATH_FORBIDDEN' });
    }
    for (const cwd of ['relative', '', path.join(directory, 'missing'), shell, '\0']) {
      await expect(value.create(cwd, 80, 24)).rejects.toMatchObject({
        statusCode: 400,
        code: expect.any(String),
      });
    }
    expect(await value.list(directory)).toEqual([]);
  });

  it('validates UUID, dimensions and UTF-8 byte length with stable errors', async () => {
    const value = manager();
    for (const id of ['bad', '../../etc/passwd', '', '0'.repeat(36)]) {
      await expect(value.input(id, 'x')).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_TERMINAL_ID',
      });
      await expect(value.subscribe(id, () => {})).rejects.toMatchObject({ code: 'INVALID_TERMINAL_ID' });
      await expect(value.closeTerminal(id)).rejects.toMatchObject({ code: 'INVALID_TERMINAL_ID' });
      expect(() => value.unsubscribe(id, () => {})).toThrow();
    }
    await expect(value.input(randomUUID(), 'x')).rejects.toMatchObject({
      statusCode: 404,
      code: 'TERMINAL_NOT_FOUND',
    });
    for (const [cols, rows] of [
      [19, 24],
      [501, 24],
      [80, 4],
      [80, 301],
      [80.5, 24],
      [NaN, 24],
      [80, Infinity],
    ]) {
      await expect(value.create(directory, cols, rows)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_TERMINAL_SIZE',
      });
    }
    const active = await session(value, 20, 5);
    for (const [cols, rows] of [
      [19, 24],
      [80, 301],
    ])
      await expect(value.resize(active.info.terminalId, cols, rows)).rejects.toMatchObject({
        code: 'INVALID_TERMINAL_SIZE',
      });
    await value.resize(active.info.terminalId, 500, 300);
    expect((await value.list(directory))[0]).toMatchObject({ cols: 500, rows: 300 });
    await expect(value.input(active.info.terminalId, 'a'.repeat(65_537))).rejects.toMatchObject({
      statusCode: 413,
      code: 'TERMINAL_INPUT_TOO_LARGE',
    });
    await expect(value.input(active.info.terminalId, '中'.repeat(21_846))).rejects.toMatchObject({
      code: 'TERMINAL_INPUT_TOO_LARGE',
    });
    // At the exact byte boundary write harmless control bytes, not an enormous executable command.
    await expect(value.input(active.info.terminalId, '\x00'.repeat(65_536))).resolves.toBeUndefined();
  });

  it('rejects non-executable shell configurations without reserving a slot', async () => {
    for (const invalidShell of ['relative', path.join(directory, 'missing-shell'), directory]) {
      const value = manager({ shell: invalidShell, maxTerminals: 1, maxPerProject: 1 });
      await expect(value.create(directory, 80, 24)).rejects.toMatchObject({
        statusCode: 500,
        code: 'INVALID_TERMINAL_SHELL',
      });
      expect(await value.list(directory)).toEqual([]);
    }
  });

  it('supports omitted terminal settings and the default per-project limit of four', async () => {
    const defaults = new TerminalManager({ ...config, terminal: undefined }, new Paths([directory]));
    managers.push(defaults);
    for (let index = 0; index < 4; index++) await defaults.create(directory, 80, 24);
    await expect(defaults.create(directory, 80, 24)).rejects.toMatchObject({
      code: 'TERMINAL_LIMIT_REACHED',
    });
    expect(await defaults.list(directory)).toHaveLength(4);
  });
});
