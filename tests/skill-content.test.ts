import { describe, expect, it } from 'vitest';
import { blocksOf, isSkillInjectionBlock } from '../web/src/components/content';

const text =
  'Base directory for this skill: /tmp/claude-0/bundled-skills/dataviz\n\n# Data Visualization\nInternal skill instructions';

describe('injected Skill content visibility', () => {
  it('recognizes synthetic live messages and metadata-marked history in either content shape', () => {
    for (const flags of [{ isSynthetic: true }, { isMeta: true }]) {
      for (const content of [text, [{ type: 'text', text }]]) {
        const message = { type: 'user', ...flags, message: { role: 'user', content } };
        expect(isSkillInjectionBlock(message, blocksOf(message)[0])).toBe(true);
        expect(isSkillInjectionBlock({ type: 'event', message }, blocksOf(message)[0])).toBe(true);
      }
    }
  });
  it('preserves user-authored text, assistant explanations, and unrelated synthetic messages', () => {
    expect(isSkillInjectionBlock({ type: 'user' }, { type: 'text', text })).toBe(false);
    expect(isSkillInjectionBlock({ type: 'user', isSynthetic: false }, { type: 'text', text })).toBe(false);
    expect(isSkillInjectionBlock({ type: 'assistant', isSynthetic: true }, { type: 'text', text })).toBe(
      false,
    );
    expect(
      isSkillInjectionBlock(
        { type: 'user', isSynthetic: true },
        { type: 'text', text: 'Please explain this Skill error' },
      ),
    ).toBe(false);
    expect(
      isSkillInjectionBlock(
        { type: 'user', isSynthetic: true },
        { type: 'text', text: `Quoted text:\n${text}` },
      ),
    ).toBe(false);
  });
  it('filters only the injected text block and preserves tool results, errors and attachments', () => {
    const message = { type: 'user', isSynthetic: true };
    const blocks = [
      { type: 'text', text },
      { type: 'tool_result', tool_use_id: 'skill1', is_error: true, content: 'Skill not found' },
      { type: 'image', source: {} },
      { type: 'text', text: 'Another visible note' },
    ];
    expect(blocks.filter((block) => !isSkillInjectionBlock(message, block))).toEqual(blocks.slice(1));
  });
});
