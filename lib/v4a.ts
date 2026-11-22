import { Exit2, Fail, blank, trimSpaces, safe, readLines, writeLines, createdLines } from './patch.ts';
import type { BodyLine, Edit } from './patch.ts';
import { matchLines, replacementLines } from './match.ts';

export function v4aEdits(lines: string[], strict: boolean): Edit[] {
  type Chunk = { anchor: string; body: BodyLine[]; old: string[]; endOfFile: boolean };
  type SectionKind = 'add' | 'delete' | 'update';

  const sectionKind = (line: string): SectionKind | null => {
    if (line.startsWith('*** Add File: ')) return 'add';
    if (line.startsWith('*** Delete File: ')) return 'delete';
    if (line.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sectionPath = (line: string, kind: SectionKind): string => {
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    return trimSpaces(line.slice(prefix.length));
  };

  let first = 0;
  while (first < lines.length && blank(lines[first])) first++;
  if (first === lines.length) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last--;
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i])) {
      i++;
      continue;
    }
    const kind = sectionKind(lines[i]);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = sectionPath(lines[i], kind);
    let boundary = i + 1;
    while (boundary < last && sectionKind(lines[boundary]) === null) boundary++;
    let end = boundary;
    while (end > i + 1 && blank(lines[end - 1])) end--;

    if (kind === 'add') {
      const content: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const line = lines[j];
        if (line === '') content.push('');
        else if (line.startsWith('+')) content.push(line.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdLines(content));
      });
    } else if (kind === 'delete') {
      if (end > i + 1) throw new Exit2(`error: parse ${i + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let j = i + 1;
      let moveTo: string | undefined;
      if (j < end && lines[j].startsWith('*** Move to: ')) {
        moveTo = trimSpaces(lines[j].slice('*** Move to: '.length));
        j++;
      }
      const chunks: Chunk[] = [];
      let current: Chunk | null = null;
      for (; j < end; j++) {
        const line = lines[j];
        if (line.startsWith('@@')) {
          current = { anchor: trimSpaces(line.slice(2)), body: [], old: [], endOfFile: false };
          chunks.push(current);
        } else if (line === '*** End of File') {
          if (current === null) throw new Exit2(`error: parse ${j + 1}`);
          current.endOfFile = true;
          current = null;
        } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
          if (current === null) {
            if (chunks.length !== 0) throw new Exit2(`error: parse ${j + 1}`);
            current = { anchor: '', body: [], old: [], endOfFile: false };
            chunks.push(current);
          }
          const kind: BodyLine['kind'] = line === '' ? ' ' : line[0] as BodyLine['kind'];
          const text = line === '' ? '' : line.slice(1);
          current.body.push({ kind, text });
          if (kind !== '+') current.old.push(text);
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${i + 1}`);

      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const source = tree.get(path);
        if (source === null) throw new Fail('missing', path);
        if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        let result = source;
        if (chunks.length !== 0) {
          const file = readLines(source);
          let cursor = 0;
          for (const chunk of chunks) {
            if (chunk.anchor !== '') {
              const anchor = matchLines(file.lines, [chunk.anchor], strict, cursor);
              if (anchor === null) throw new Fail('no-match', path);
              cursor = anchor.positions[0] + 1;
            }

            let at: number;
            let tier = 0;
            if (chunk.old.length === 0) {
              at = chunk.endOfFile ? file.lines.length : cursor;
            } else {
              const match = matchLines(file.lines, chunk.old, strict, cursor, chunk.endOfFile);
              if (match === null) throw new Fail('no-match', path);
              at = match.positions[0];
              tier = match.tier;
            }
            const inserted = replacementLines(chunk.body, file.lines, at, tier);
            file.lines = file.lines.slice(0, at).concat(inserted, file.lines.slice(at + chunk.old.length));
            cursor = at + inserted.length;
          }
          result = writeLines(file);
        }

        if (moveTo === undefined) {
          tree.now.set(path, result);
        } else {
          tree.now.set(path, null);
          tree.now.set(moveTo, result);
          tree.moves.push({ oldPath: path, newPath: moveTo });
        }
      });
    }
    i = boundary;
  }
  return edits;
}
