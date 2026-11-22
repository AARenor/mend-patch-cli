import type { BodyLine } from './match.ts';
import { trimSpaces } from './match.ts';
import type { Chunk, Edit } from './patch.ts';

export function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') {
    throw new Error(`parse ${first < 0 ? 1 : first + 1}`);
  }
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (lines[last].trim() !== '*** End Patch') throw new Error(`parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  for (let at = first + 1; at < last;) {
    if (lines[at].trim() === '') {
      at++;
      continue;
    }
    const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(lines[at]);
    if (!header) throw new Error(`parse ${at + 1}`);
    const headerLine = at;
    const path = trimSpaces(header[2]);
    let end = at + 1;
    while (end < last && !/^\*\*\* (Add|Delete|Update) File: /.test(lines[end])) end++;
    let contentEnd = end;
    while (contentEnd > at + 1 && lines[contentEnd - 1].trim() === '') contentEnd--;
    at++;
    if (header[1] === 'Delete') {
      if (at < contentEnd) throw new Error(`parse ${at + 1}`);
      edits.push({ kind: 'delete', path });
    } else if (header[1] === 'Add') {
      const added: string[] = [];
      while (at < contentEnd) {
        if (lines[at] !== '' && !lines[at].startsWith('+')) throw new Error(`parse ${at + 1}`);
        added.push(lines[at].slice(1));
        at++;
      }
      edits.push({ kind: 'create', path, text: added.length ? `${added.join('\n')}\n` : '' });
    } else {
      let destination: string | undefined;
      if (lines[at]?.startsWith('*** Move to: ')) destination = trimSpaces(lines[at++].slice(13));
      const chunks: Chunk[] = [];
      let current: Chunk | undefined;
      while (at < contentEnd) {
        const item = lines[at];
        if (item.startsWith('@@')) {
          current = { line: 0, anchor: trimSpaces(item.slice(2)) || undefined, body: [] };
          chunks.push(current);
        } else if (item === '*** End of File') {
          if (!current || current.eof) throw new Error(`parse ${at + 1}`);
          current.eof = true;
        } else if (item === '' || [' ', '-', '+'].includes(item[0])) {
          if (!current) {
            if (chunks.length) throw new Error(`parse ${at + 1}`);
            current = { line: 0, body: [] };
            chunks.push(current);
          }
          if (current.eof) throw new Error(`parse ${at + 1}`);
          current.body.push({ kind: item === '' ? ' ' : item[0] as BodyLine['kind'], text: item.slice(1) });
        } else throw new Error(`parse ${at + 1}`);
        at++;
      }
      if (chunks.length === 0 && destination === undefined) throw new Error(`parse ${headerLine + 1}`);
      edits.push({ kind: 'v4a', path, destination, chunks });
    }
    at = end;
  }
  return edits;
}
