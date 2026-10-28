import { expect, it } from 'vitest';
import { TerminalOutput } from '../server/terminal-output';

it('holds incomplete CSI, OSC and DCS suffixes until they can be replayed safely', () => {
  const stream = new TerminalOutput();
  expect(stream.push('before\x1b[3')).toBe('before');
  expect(stream.push('1m红色\x1b[0m')).toBe('\x1b[31m红色\x1b[0m');
  expect(stream.push('\x1b]0;title')).toBe('');
  expect(stream.push('\x07next')).toBe('\x1b]0;title\x07next');
  expect(stream.push('\x1bP$qm\x1b')).toBe('');
  expect(stream.push('\\ok')).toBe('\x1bP$qm\x1b\\ok');
});
it('bounds oversized strings without displaying their discarded payload', () => {
  const stream = new TerminalOutput();
  expect(stream.push('\x1b]52;c;')).toBe('');
  for (let i = 0; i < 100; i++) expect(stream.push('x'.repeat(8192))).toBe('');
  expect(stream.push('\x07visible')).toBe('visible');
});
it('preserves C1, escape intermediates and explicitly cancelled sequences', () => {
  const stream = new TerminalOutput();
  expect(stream.push('\x9b3')).toBe('');
  expect(stream.push('1m')).toBe('\x9b31m');
  expect(stream.push('\x1b(')).toBe('');
  expect(stream.push('B')).toBe('\x1b(B');
  expect(stream.push('\x1b[123\x18normal')).toBe('\x1b[123\x18normal');
});
