import { Exit2, Fail, safe, readLines, writeLines, createdLines } from './patch.ts';
import type { BodyLine, Edit } from './patch.ts';
import { matchLines, replacementLines } from './match.ts';

export function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let candidatePath: string | undefined;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      const candidate = lines[i].trim();
      if (candidate !== '' && !candidate.startsWith('```')) candidatePath = candidate;
      i++;
      continue;
    }

    const searchLine = i;
    const path = candidatePath === undefined ? previousPath : candidatePath;
    if (path === undefined) throw new Exit2(`error: parse ${searchLine + 1}`);

    let separator = searchLine + 1;
    while (separator < lines.length && lines[separator].trimEnd() !== '=======') separator++;
    if (separator === lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);

    let terminator = separator + 1;
    while (terminator < lines.length && lines[terminator].trimEnd() !== '>>>>>>> REPLACE') terminator++;
    if (terminator === lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);

    const old = lines.slice(searchLine + 1, separator);
    const replacement = lines.slice(separator + 1, terminator);
    const body: BodyLine[] = [];
    for (const text of old) body.push({ kind: '-', text });
    for (const text of replacement) body.push({ kind: '+', text });

    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const source = tree.get(path);
      if (old.length === 0) {
        if (source !== null) throw new Fail('exists', path);
        tree.now.set(path, createdLines(replacement));
        return;
      }
      if (source === null) throw new Fail('missing', path);
      const file = readLines(source);
      const match = matchLines(file.lines, old, strict);
      if (match === null) throw new Fail('no-match', path);
      if (match.positions.length !== 1) throw new Fail('ambiguous', path);
      const at = match.positions[0];
      const inserted = replacementLines(body, file.lines, at, match.tier);
      file.lines = file.lines.slice(0, at).concat(inserted, file.lines.slice(at + old.length));
      tree.now.set(path, writeLines(file));
    });

    previousPath = path;
    candidatePath = undefined;
    i = terminator + 1;
  }
  return edits;
}
