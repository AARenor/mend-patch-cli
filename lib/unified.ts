import type { BodyLine } from './match.ts';
import { trimSpaces } from './match.ts';
import type { Chunk, Edit } from './patch.ts';

interface Section {
  old: string;
  next: string;
  paired: boolean;
  create: boolean;
  remove: boolean;
  chunks: Chunk[];
}

export function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let section: Section | undefined;
  const finish = () => {
    if (!section) return;
    const { old, next, create, remove, chunks } = section;
    if (create || old === '/dev/null') {
      const added = chunks.flatMap((chunk) => chunk.body.filter((line) => line.kind === '+'));
      const text = added.map((line) => line.text).join('\n')
        + (added.length && !added[added.length - 1].noBreak ? '\n' : '');
      edits.push({ kind: 'create', path: next, text });
    } else if (remove || next === '/dev/null') {
      edits.push({ kind: 'delete', path: old });
    } else {
      edits.push({ kind: 'unified', path: old, destination: next === old ? undefined : next, chunks });
    }
  };
  const pathFromHeader = (line: string) => {
    const path = trimSpaces(line.slice(4).split('\t', 1)[0]);
    return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
  };
  const pathsFromDiff = (line: string): [string, string] => {
    // Split at the last ' b/' so a path that itself holds ' b/' keeps its bytes.
    const rest = line.slice(11);
    if (!rest.startsWith('a/')) throw new Error('bad');
    for (let at = rest.length - 3; at > 2; at--) {
      if (rest[at] === ' ' && rest[at + 1] === 'b' && rest[at + 2] === '/') {
        const destination = rest.slice(at + 3);
        if (destination !== '') return [rest.slice(2, at), destination];
      }
    }
    throw new Error('bad');
  };
  for (let at = 0; at < lines.length;) {
    const line = lines[at];
    if (line.startsWith('diff --git ')) {
      let paths: [string, string];
      try {
        paths = pathsFromDiff(line);
      } catch {
        throw new Error(`parse ${at + 1}`);
      }
      finish();
      section = { old: paths[0], next: paths[1], paired: false, create: false, remove: false, chunks: [] };
      at++;
    } else if (line.startsWith('--- ')) {
      if (!lines[at + 1]?.startsWith('+++ ')) {
        if (section && section.chunks.length === 0) throw new Error(`parse ${at + 2}`);
        at++;
        continue;
      }
      if (!section || section.paired || section.chunks.length > 0) {
        finish();
        section = { old: '', next: '', paired: false, create: false, remove: false, chunks: [] };
      }
      section.old = pathFromHeader(line);
      section.next = pathFromHeader(lines[at + 1]);
      section.paired = true;
      at += 2;
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!section || !header) throw new Error(`parse ${at + 1}`);
      const body: BodyLine[] = [];
      const raw: string[] = [];
      at++;
      while (at < lines.length) {
        const item = lines[at];
        if (item.startsWith('diff --git ') || item.startsWith('@@')
          || (item.startsWith('--- ') && lines[at + 1]?.startsWith('+++ '))) break;
        if (item !== '' && ![' ', '-', '+', '\\'].includes(item[0])) break;
        raw.push(item);
        at++;
      }
      while (raw[raw.length - 1] === '') raw.pop();
      for (const item of raw) {
        if (item.startsWith('\\')) {
          if (body.length) body[body.length - 1].noBreak = true;
        } else {
          body.push({ kind: item === '' ? ' ' : item[0] as BodyLine['kind'], text: item.slice(1) });
        }
      }
      section.chunks.push({ line: Number(header[1]), body });
    } else {
      if (section && section.chunks.length === 0) {
        if (!section.paired && line.startsWith('rename from ')) section.old = line.slice(12);
        else if (!section.paired && line.startsWith('rename to ')) section.next = line.slice(10);
        else if (line.startsWith('new file mode')) section.create = true;
        else if (line.startsWith('deleted file mode')) section.remove = true;
      }
      at++;
    }
  }
  finish();
  return edits;
}
