import type { Command } from '../../../shared/protocol';
export interface Completion {
  kind: 'command' | 'file';
  query: string;
  start: number;
  end: number;
}
export function detectCompletion(value: string, cursor: number): Completion | null {
  const prefix = value.slice(0, cursor);
  const command = /^\/(\S*)$/.exec(prefix);
  const file = /@([^\s@]*)$/.exec(prefix);
  const match = file ?? command;
  if (!match) return null;
  const suffix = /^[^\s@]*/.exec(value.slice(cursor))![0];
  return {
    kind: file ? 'file' : 'command',
    query: match[1],
    start: file ? cursor - match[0].length : 0,
    end: cursor + suffix.length,
  };
}
export function matchCommands(commands: Command[], query: string): Command[] {
  const needle = query.toLowerCase();
  const names = new Set<string>();
  return commands
    .map((command) => ({ ...command, name: command.name.replace(/^\//, '') }))
    .filter((command) => {
      if (names.has(command.name) || !command.name.toLowerCase().includes(needle)) return false;
      names.add(command.name);
      return true;
    })
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)),
    );
}
export function insertCompletion(text: string, completion: Completion, value: string) {
  const insertion = `${completion.kind === 'file' ? '@' : '/'}${value} `;
  return {
    text: text.slice(0, completion.start) + insertion + text.slice(completion.end).replace(/^ /, ''),
    cursor: completion.start + insertion.length,
  };
}
