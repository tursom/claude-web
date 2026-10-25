import { useMemo } from 'react';
import { createTwoFilesPatch } from 'diff';
import './components.css';

export interface DiffViewProps {
  oldText?: string;
  newText?: string;
  patch?: string;
}
interface DiffLine {
  kind: 'hunk' | 'add' | 'del' | 'context';
  text: string;
  old?: number;
  next?: number;
}

export function diffLines(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  let old = 0,
    next = 0,
    oldRemaining = 0,
    nextRemaining = 0,
    inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      nextRemaining = Number(hunk[4] ?? 1);
      inHunk = true;
      result.push({ kind: 'hunk', text: line });
    } else if (inHunk && line.startsWith('+')) {
      result.push({ kind: 'add', text: line.slice(1), next: next++ });
      nextRemaining--;
    } else if (inHunk && line.startsWith('-')) {
      result.push({ kind: 'del', text: line.slice(1), old: old++ });
      oldRemaining--;
    } else if (inHunk && line.startsWith(' ')) {
      result.push({ kind: 'context', text: line.slice(1), old: old++, next: next++ });
      oldRemaining--;
      nextRemaining--;
    }
    if (!oldRemaining && !nextRemaining) inHunk = false;
  }
  return result;
}

export function DiffView({ oldText = '', newText = '', patch }: DiffViewProps) {
  const rows = useMemo(
    () => diffLines(patch ?? createTwoFilesPatch('', '', oldText, newText, '', '', { context: 3 })),
    [patch, oldText, newText],
  );
  if (rows.filter((row) => row.kind === 'add' || row.kind === 'del').length > 2000)
    return <div className="cc-empty">改动过大，未显示</div>;
  return (
    <div className="cc-diff" tabIndex={0} aria-label="Diff">
      <div className="cc-diff-inner">
        {rows.map((row, index) =>
          row.kind === 'hunk' ? (
            <div className="cc-diff-hunk" key={index}>
              {row.text}
            </div>
          ) : (
            <div className={`cc-diff-line cc-diff-${row.kind}`} key={index}>
              <span className="cc-line-number">{row.old}</span>
              <span className="cc-line-number">{row.next}</span>
              <span className="cc-diff-sign">
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
              </span>
              <span className="cc-diff-text">{row.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export default DiffView;
