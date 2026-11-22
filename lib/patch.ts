import { readFileSync, statSync } from 'node:fs';

export class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
export class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

export const blank = (s: string): boolean => s.trim() === '';

export function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { oldPath: string; newPath: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

export type Edit = (tree: Tree) => void;

export type FileLines = { lines: string[]; br: string; final: boolean };
export type BodyLine = { kind: ' ' | '+' | '-'; text: string; noNewline?: boolean };
export type LineMatch = { tier: number; positions: number[] };

export function readLines(text: string): FileLines {
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

export function writeLines(file: FileLines): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.br) + (file.final ? file.br : '');
}

export function createdLines(lines: string[], final = true): string {
  return writeLines({ lines, br: '\n', final });
}


export function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  return text.slice(start, end);
}

export function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}
