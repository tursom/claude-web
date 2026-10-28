import { expect, it } from 'vitest';
import { detectCompletion, insertCompletion, matchCommands } from '../web/src/components/completion';
it('matches command names with prefixes first and preserves CLI descriptions', () => {
  expect(
    matchCommands(
      [
        { name: 'security-review', description: 'audit' },
        { name: '/review', description: 'review', argumentHint: '[path]' },
        { name: 'release', description: 'release' },
        { name: 'review', description: 'duplicate' },
      ],
      'RE',
    ).map((v) => v.name),
  ).toEqual(['review', 'release', 'security-review']);
});
it('replaces the entire command token when completing with the caret in its middle', () => {
  const text = '/compct keep these arguments';
  const completion = detectCompletion(text, 4)!;
  expect(completion).toEqual({ kind: 'command', query: 'com', start: 0, end: 7 });
  expect(insertCompletion(text, completion, 'compact')).toEqual({
    text: '/compact keep these arguments',
    cursor: 9,
  });
});
it('does not treat paths or command arguments as slash command names', () => {
  expect(detectCompletion('please read /server', 19)).toBeNull();
  expect(detectCompletion('/compact instructions', 21)).toBeNull();
  expect(detectCompletion('/plugin:skill', 13)?.query).toBe('plugin:skill');
});
