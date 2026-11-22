import type { BodyLine } from './match.ts';
import type { Edit } from './patch.ts';

export function parseSearch(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | undefined;
  for (let at = 0; at < lines.length; at++) {
    if (lines[at].trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = at;
    let path = previousPath;
    for (let before = at - 1; before > previousEnd; before--) {
      const candidate = lines[before].trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    if (path === undefined) throw new Error(`parse ${searchLine + 1}`);
    const old: string[] = [];
    at++;
    while (at < lines.length && lines[at].trimEnd() !== '=======') {
      // A block whose old lines run into REPLACE without a ======= is a fault, not a longer old text.
      if (lines[at].trimEnd() === '>>>>>>> REPLACE') throw new Error(`parse ${searchLine + 1}`);
      old.push(lines[at++]);
    }
    if (at === lines.length) throw new Error(`parse ${searchLine + 1}`);
    const added: string[] = [];
    at++;
    while (at < lines.length && lines[at].trimEnd() !== '>>>>>>> REPLACE') added.push(lines[at++]);
    if (at === lines.length) throw new Error(`parse ${searchLine + 1}`);
    if (old.length === 0) {
      edits.push({ kind: 'create', path, text: added.length ? `${added.join('\n')}\n` : '' });
    } else {
      const body: BodyLine[] = old.map((text) => ({ kind: '-', text }));
      body.push(...added.map((text): BodyLine => ({ kind: '+', text })));
      edits.push({ kind: 'search', path, chunks: [{ line: 0, body }] });
    }
    previousEnd = at;
    previousPath = path;
  }
  return edits;
}
