// mend applies the four patch formats in SPEC.md using only the Node standard library.
// Parsing finishes before file access, and edits are staged until every edit succeeds.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
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

type Edit = (tree: Tree) => void;

type FileLines = { lines: string[]; br: string; final: boolean };
type BodyLine = { kind: ' ' | '+' | '-'; text: string; noNewline?: boolean };
type LineMatch = { tier: number; positions: number[] };

function readLines(text: string): FileLines {
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines(file: FileLines): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.br) + (file.final ? file.br : '');
}

function createdLines(lines: string[], final = true): string {
  return writeLines({ lines, br: '\n', final });
}

function horizontalTrim(line: string, leading: boolean): string {
  let start = 0;
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (leading) {
    while (start < end && (line[start] === ' ' || line[start] === '\t')) start++;
  }
  return line.slice(start, end);
}

function matchLines(file: string[], old: string[], strict: boolean, start = 0, endOnly = false): LineMatch | null {
  const last = file.length - old.length;
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const source = tier === 0 ? file : file.map((line) => horizontalTrim(line, tier === 2));
    const wanted = tier === 0 ? old : old.map((line) => horizontalTrim(line, tier === 2));
    const positions: number[] = [];
    for (let at = endOnly ? last : start; at <= last; at++) {
      if (at < start) continue;
      let matched = true;
      for (let i = 0; i < wanted.length; i++) {
        if (source[at + i] !== wanted[i]) {
          matched = false;
          break;
        }
      }
      if (matched) positions.push(at);
      if (endOnly) break;
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function indentation(line: string): string {
  let end = 0;
  while (end < line.length && (line[end] === ' ' || line[end] === '\t')) end++;
  return line.slice(0, end);
}

function replacementLines(body: BodyLine[], file: string[], at: number, tier: number): string[] {
  const oldFirst = body.find((line) => line.kind !== '+');
  const patchIndent = indentation(oldFirst?.text ?? '');
  const fileIndent = indentation(file[at] ?? '');
  const result: string[] = [];
  let cursor = at;
  for (const line of body) {
    if (line.kind === ' ') result.push(file[cursor++]!);
    else if (line.kind === '-') cursor++;
    else {
      const text = line.text;
      result.push(tier === 2 && !blank(text) && text.startsWith(patchIndent)
        ? fileIndent + text.slice(patchIndent.length)
        : text);
    }
  }
  return result;
}

function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  return text.slice(start, end);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type Hunk = { oldStart: number; body: BodyLine[] };
  type Section = {
    gitOld: string | undefined;
    gitNew: string | undefined;
    renameOld: string | undefined;
    renameNew: string | undefined;
    pairOld: string | null | undefined;
    pairNew: string | null | undefined;
    hasPair: boolean;
    create: boolean;
    remove: boolean;
    header: boolean;
    hunks: Hunk[];
  };

  const sections: Section[] = [];
  let section: Section | undefined;

  function startSection(gitOld?: string, gitNew?: string): Section {
    const next: Section = {
      gitOld,
      gitNew,
      renameOld: undefined,
      renameNew: undefined,
      pairOld: undefined,
      pairNew: undefined,
      hasPair: false,
      create: false,
      remove: false,
      header: true,
      hunks: [],
    };
    sections.push(next);
    return next;
  }

  function headerPath(line: string): string | null {
    const rest = line.slice(4);
    const tab = rest.indexOf('\t');
    const part = tab < 0 ? rest : rest.slice(0, tab);
    let start = 0;
    let end = part.length;
    while (start < end && part[start] === ' ') start++;
    while (end > start && part[end - 1] === ' ') end--;
    const path = part.slice(start, end);
    if (path === '/dev/null') return null;
    return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^diff --git(?:\s|$)/.test(line)) {
      const prefix = 'diff --git a/';
      const delimiter = line.startsWith(prefix) ? line.indexOf(' b/', prefix.length) : -1;
      if (delimiter < 0) throw new Exit2(`error: parse ${i + 1}`);
      section = startSection(line.slice(prefix.length, delimiter), line.slice(delimiter + 3));
      i++;
      continue;
    }

    const pair = line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
    if (pair) {
      if (section === undefined || !section.header) section = startSection();
      section.pairOld = headerPath(line);
      section.pairNew = headerPath(lines[i + 1]);
      section.hasPair = true;
      i += 2;
      continue;
    }

    if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (header === null || section === undefined) throw new Exit2(`error: parse ${i + 1}`);
      section.header = false;
      const oldStart = Number(header[1]);
      i++;
      const bodyStart = i;
      while (i < lines.length) {
        const bodyLine = lines[i];
        if (bodyLine.startsWith('diff --git ') ||
            (bodyLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ '))) break;
        if (bodyLine !== '' && bodyLine[0] !== ' ' && bodyLine[0] !== '-' &&
            bodyLine[0] !== '+' && bodyLine[0] !== '\\') break;
        i++;
      }
      let bodyEnd = i;
      while (bodyEnd > bodyStart && lines[bodyEnd - 1] === '') bodyEnd--;
      const body: BodyLine[] = [];
      let previous: BodyLine | undefined;
      for (let j = bodyStart; j < bodyEnd; j++) {
        const text = lines[j];
        if (text.startsWith('\\')) {
          if (previous !== undefined) previous.noNewline = true;
          previous = undefined;
        } else {
          const kind: BodyLine['kind'] = text === '' ? ' ' : text[0] as BodyLine['kind'];
          previous = { kind, text: text === '' ? '' : text.slice(1) };
          body.push(previous);
        }
      }
      section.hunks.push({ oldStart, body });
      continue;
    }

    if (section !== undefined && section.header) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) section.renameOld = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) section.renameNew = line.slice('rename to '.length);
      else if (line === 'new file mode' || line.startsWith('new file mode ') || line.startsWith('new file mode\t')) section.create = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ') || line.startsWith('deleted file mode\t')) section.remove = true;
    }
    i++;
  }

  return sections.map((item): Edit => {
    const oldPath = item.hasPair ? (item.pairOld ?? null) : (item.renameOld ?? item.gitOld ?? '');
    const newPath = item.hasPair ? (item.pairNew ?? null) : (item.renameNew ?? item.gitNew ?? '');
    const creating = oldPath === null || item.create;
    const deleting = !creating && (newPath === null || item.remove);

    return (tree: Tree): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);

      if (creating) {
        if (newPath === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const added: string[] = [];
        let lastAdded: BodyLine | undefined;
        for (const hunk of item.hunks) {
          for (const bodyLine of hunk.body) {
            if (bodyLine.kind === '+') {
              added.push(bodyLine.text);
              lastAdded = bodyLine;
            }
          }
        }
        tree.now.set(newPath, createdLines(added, !lastAdded?.noNewline));
        return;
      }

      if (oldPath === null) throw new Fail('unsafe', '/dev/null');
      const original = tree.get(oldPath);
      if (original === null) throw new Fail('missing', oldPath);
      if (deleting) {
        tree.now.set(oldPath, null);
        return;
      }

      if (newPath === null) throw new Fail('unsafe', '/dev/null');
      const moving = oldPath !== newPath;
      if (moving && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const file = readLines(original);
      let delta = 0;
      for (const hunk of item.hunks) {
        const old: string[] = [];
        let newCount = 0;
        let lastNew: BodyLine | undefined;
        for (const bodyLine of hunk.body) {
          if (bodyLine.kind !== '+') old.push(bodyLine.text);
          if (bodyLine.kind !== '-') {
            newCount++;
            lastNew = bodyLine;
          }
        }

        let at: number;
        let tier = 0;
        if (old.length === 0) {
          at = Math.max(0, Math.min(file.lines.length, hunk.oldStart + delta));
        } else {
          const found = matchLines(file.lines, old, strict);
          if (found === null) throw new Fail('no-match', oldPath);
          tier = found.tier;
          const target = Math.max(0, Math.min(file.lines.length, hunk.oldStart - 1 + delta));
          at = found.positions[0];
          for (const position of found.positions) {
            const distance = Math.abs(position - target);
            const bestDistance = Math.abs(at - target);
            if (distance < bestDistance || (distance === bestDistance && position < at)) at = position;
          }
        }

        const atEnd = at + old.length === file.lines.length;
        const replacement = replacementLines(hunk.body, file.lines, at, tier);
        file.lines = file.lines.slice(0, at).concat(replacement, file.lines.slice(at + old.length));
        if (atEnd) file.final = !lastNew?.noNewline;
        delta += newCount - old.length;
      }

      const result = writeLines(file);
      if (moving) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, result);
        tree.moves.push({ oldPath, newPath });
      } else {
        tree.now.set(oldPath, result);
      }
    };
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
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

function v4aEdits(lines: string[], strict: boolean): Edit[] {
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


function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Set<string>();
  const changes: { path: string; row: string }[] = [];
  for (const { oldPath, newPath } of tree.moves) {
    if (moved.has(oldPath) || moved.has(newPath)) continue;
    if (tree.original(oldPath) !== null && tree.get(oldPath) === null
      && tree.original(newPath) === null && tree.get(newPath) !== null) {
      changes.push({ path: newPath, row: `R ${oldPath} -> ${newPath}` });
      moved.add(oldPath);
      moved.add(newPath);
    }
  }
  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was === now) continue;
    if (!moved.has(p)) changes.push({ path: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  changes.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const rows = changes.map((change) => change.row);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
