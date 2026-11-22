import { splitPatch } from './match.ts';
import type { BodyLine } from './match.ts';
import { parseJson } from './json.ts';
import { parseSearch } from './search_replace.ts';
import { parseUnified } from './unified.ts';
import { parseV4a } from './v4a.ts';

export type Format = 'unified' | 'search-replace' | 'v4a' | 'json';

export interface Chunk {
  body: BodyLine[];
  line: number;
  anchor?: string;
  eof?: boolean;
}

export interface Edit {
  path: string;
  destination?: string;
  kind: 'create' | 'delete' | 'unified' | 'search' | 'v4a' | 'replace' | 'insert';
  text?: string;
  old?: string;
  insertLine?: number;
  chunks?: Chunk[];
}

export function parsePatch(text: string, requested: Format | 'auto'): Edit[] {
  const lines = splitPatch(text);
  let format = requested;
  if (format === 'auto') {
    const first = lines.find((line) => line.trim() !== '')?.trim() ?? '';
    if (first === '*** Begin Patch') format = 'v4a';
    else if (first.startsWith('[') || first.startsWith('{')) format = 'json';
    else if (lines.some((line) => line.trimEnd() === '<<<<<<< SEARCH')) format = 'search-replace';
    else if (lines.some((line, at) => line.startsWith('diff --git ')
      || (line.startsWith('--- ') && lines[at + 1]?.startsWith('+++ ')))) format = 'unified';
    else throw new Error('format');
  }
  const readers = { json: parseJson, 'search-replace': parseSearch, unified: parseUnified, v4a: parseV4a };
  const edits = readers[format](lines);
  if (edits.length === 0) throw new Error('parse 1');
  return edits;
}
