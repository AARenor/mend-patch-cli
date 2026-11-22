import type { Edit } from './patch.ts';

function decodeEdit(value: unknown, line: number): Edit {
  const invalid = () => new Error(`parse ${line}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const object = value as Record<string, unknown>;
  if (typeof object.path !== 'string') throw invalid();
  const path = object.path;
  if (object.command === 'create' && typeof object.file_text === 'string') {
    return { kind: 'create', path, text: object.file_text };
  }
  if (object.command === 'str_replace' && typeof object.old_str === 'string' && object.old_str !== ''
    && (object.new_str === undefined || typeof object.new_str === 'string')) {
    return { kind: 'replace', path, old: object.old_str, text: object.new_str as string | undefined ?? '' };
  }
  if (object.command === 'insert' && Number.isInteger(object.insert_line) && typeof object.new_str === 'string') {
    return { kind: 'insert', path, insertLine: object.insert_line as number, text: object.new_str };
  }
  throw invalid();
}

export function parseJson(lines: string[]): Edit[] {
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return [];
  if (lines[first].trimStart().startsWith('[')) {
    try {
      const array: unknown = JSON.parse(lines.join('\n'));
      if (!Array.isArray(array)) throw new Error();
      return array.map((value) => decodeEdit(value, first + 1));
    } catch {
      throw new Error(`parse ${first + 1}`);
    }
  }
  const edits: Edit[] = [];
  for (let at = 0; at < lines.length; at++) {
    if (lines[at].trim() === '') continue;
    try {
      edits.push(decodeEdit(JSON.parse(lines[at]), at + 1));
    } catch {
      throw new Error(`parse ${at + 1}`);
    }
  }
  return edits;
}
