import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { IPty } from 'node-pty';

interface ProcessInfo {
  pid: number;
  parent: number;
  group: number;
  session: number;
  foreground: number;
  start: string;
  state: string;
}

async function processInfo(pid: number): Promise<ProcessInfo | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // comm may itself contain spaces and parentheses. Fields start after its last ')'.
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return {
      pid,
      state: fields[0],
      parent: +fields[1],
      group: +fields[2],
      session: +fields[3],
      foreground: +fields[5],
      start: fields[19],
    };
  } catch (error) {
    // Unrelated users' entries can be unreadable under procfs hidepid policies.
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}

function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Owns only this forkpty session. No service processes or caller process groups are signalled. */
export class TerminalProcess {
  readonly exited: Promise<{ exitCode: number; signal?: number }>;
  private shellExited = false;
  private stopTask?: Promise<void>;
  private readonly known = new Map<number, ProcessInfo>();

  constructor(private readonly pty: IPty) {
    this.exited = new Promise((resolve) => {
      pty.onExit((event) => {
        this.shellExited = true;
        resolve(event);
      });
    });
  }

  private async members(): Promise<ProcessInfo[]> {
    const entries = await readdir('/proc');
    const table = (
      await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map((entry) => processInfo(+entry)))
    ).filter((entry): entry is ProcessInfo => !!entry);
    const owned = new Set<number>();
    for (const entry of table) {
      // forkpty creates a new session with the shell PID as its session ID. This also
      // finds job-control groups after the shell has exited and children are reparented.
      if (entry.session === this.pty.pid || this.known.get(entry.pid)?.start === entry.start)
        owned.add(entry.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of table) {
        if (!owned.has(entry.pid) && owned.has(entry.parent)) {
          owned.add(entry.pid);
          changed = true;
        }
      }
    }
    const result = table.filter((entry) => owned.has(entry.pid));
    for (const entry of result) this.known.set(entry.pid, entry);
    // Zombies have already exited; only their unrelated reaper can remove the /proc entry.
    return result
      .filter((entry) => entry.state !== 'Z' && entry.state !== 'X')
      .sort((a, b) => Number(b.group === b.foreground) - Number(a.group === a.foreground));
  }

  private async signalMembers(
    members: ProcessInfo[],
    value: NodeJS.Signals,
    sent: Map<number, string>,
    groups: Set<string>,
  ): Promise<void> {
    for (const entry of members) {
      const current = await processInfo(entry.pid);
      if (!current || current.start !== entry.start) continue;
      const identity = `${current.start}:${value}`;
      if (sent.get(current.pid) === identity) continue;
      const groupKey = `${current.group}:${value}`;
      // Never signal an external session's group, even if one descendant joined it.
      // Verify a live member before using a negative PID; never trust a stale tpgid alone.
      if (current.session === this.pty.pid && current.group > 1 && !groups.has(groupKey)) {
        groups.add(groupKey);
        signal(-current.group, value);
        for (const member of members) {
          if (member.group === current.group && member.session === this.pty.pid) {
            sent.set(member.pid, `${member.start}:${value}`);
          }
        }
      } else {
        // A newly forked member of a group already signalled gets its own signal;
        // do not repeatedly interrupt the other members' graceful-exit traps.
        signal(current.pid, value);
      }
      sent.set(current.pid, identity);
    }
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const task = this.stopOwned();
    this.stopTask = task;
    void task.catch(() => {
      // A failed close retains its capacity reservation and can be retried.
      if (this.stopTask === task) this.stopTask = undefined;
    });
    return task;
  }

  private async stopOwned(): Promise<void> {
    if (process.platform !== 'linux') {
      // POSIX fallback: forkpty's original group. Linux additionally covers job control.
      if (!this.shellExited) signal(-this.pty.pid, 'SIGHUP');
      const timer = setTimeout(() => {
        if (!this.shellExited) signal(-this.pty.pid, 'SIGKILL');
      }, 1_000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    const started = Date.now();
    let sentHangup = false;
    const sent = new Map<number, string>();
    const groups = new Set<string>();
    for (;;) {
      const members = await this.members();
      if (!members.length && this.shellExited) return;
      const elapsed = Date.now() - started;
      await this.signalMembers(members, elapsed < 1_000 ? 'SIGTERM' : 'SIGKILL', sent, groups);
      // Interactive shells commonly ignore TERM. HUP asks the shell to exit normally.
      if (!sentHangup) {
        const shell = members.find((entry) => entry.pid === this.pty.pid);
        if (shell) {
          const current = await processInfo(shell.pid);
          if (current?.start === shell.start) signal(shell.pid, 'SIGHUP');
        }
        sentHangup = true;
      }
      if (elapsed > 5_000) throw new Error('Timed out waiting for terminal processes to exit');
      await delay(25);
    }
  }
}
