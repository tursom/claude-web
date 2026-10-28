/** Hold incomplete VT controls: screen serialization cannot save parser state. */
export class TerminalOutput {
  private state: 'ground' | 'escape' | 'intermediate' | 'csi' | 'osc' | 'string' = 'ground';
  private pending = '';
  private discarded = false;
  static readonly maxSequence = 64 * 1024;

  push(data: string): string {
    const output: string[] = [];
    for (const character of data) {
      const code = character.codePointAt(0)!;
      if (this.state === 'ground') {
        const next =
          code === 0x1b
            ? 'escape'
            : code === 0x9b
              ? 'csi'
              : code === 0x9d
                ? 'osc'
                : [0x90, 0x98, 0x9e, 0x9f].includes(code)
                  ? 'string'
                  : undefined;
        if (!next) {
          output.push(character);
          continue;
        }
        this.state = next;
        this.pending = character;
        continue;
      }
      if (!this.discarded) {
        this.pending += character;
        // Discard oversize control payloads as a whole, never display their tail.
        if (this.pending.length > TerminalOutput.maxSequence) {
          this.pending = '';
          this.discarded = true;
        }
      }
      let complete = false;
      if (code === 0x18 || code === 0x1a || code === 0x9c) complete = true;
      else if (code === 0x1b) this.state = 'escape';
      else if (this.state === 'osc') complete = code === 0x07;
      else if (this.state === 'string') {
        /* DCS/SOS/PM/APC terminate on ST. */
      } else if (this.state === 'csi') complete = code >= 0x40 && code <= 0x7e;
      else if (this.state === 'intermediate') complete = code >= 0x30 && code <= 0x7e;
      else {
        if (character === '[') this.state = 'csi';
        else if (character === ']') this.state = 'osc';
        else if (['P', 'X', '^', '_'].includes(character)) this.state = 'string';
        else if (code >= 0x20 && code <= 0x2f) this.state = 'intermediate';
        else complete = code >= 0x30 && code <= 0x7e;
      }
      if (complete) {
        if (!this.discarded) output.push(this.pending);
        this.pending = '';
        this.discarded = false;
        this.state = 'ground';
      }
    }
    return output.join('');
  }
}
