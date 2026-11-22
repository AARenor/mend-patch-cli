import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { closeText, occurrences, openText, replacement, splitPatch } from './match.ts';
import type { Edit } from './patch.ts';

export interface Execution {
  exit: number;
  output: string[];
}

export function execute(edits: Edit[], strict: boolean, check: boolean): Execution {
  const original = new Map<string, string | null>();
  const staged = new Map<string, string | null>();
  const moves: { from: string; to: string }[] = [];
  const errors: string[] = [];
  const load = (path: string): string | null => {
    if (!staged.has(path)) {
      const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
      original.set(path, text);
      staged.set(path, text);
    }
    return staged.get(path) ?? null;
  };
  for (const edit of edits) {
    const paths = edit.destination === undefined ? [edit.path] : [edit.path, edit.destination];
    const unsafe = paths.find((path) => path === '' || path.startsWith('/') || path.includes('\\')
      || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'));
    if (unsafe !== undefined) {
      errors.push(`error: unsafe ${unsafe}`);
      continue;
    }
    const before = load(edit.path);
    if (edit.kind === 'create') {
      if (before !== null) errors.push(`error: exists ${edit.path}`);
      else staged.set(edit.path, edit.text ?? '');
      continue;
    }
    if (before === null) {
      errors.push(`error: missing ${edit.path}`);
      continue;
    }
    if (edit.destination !== undefined && load(edit.destination) !== null) {
      errors.push(`error: exists ${edit.destination}`);
      continue;
    }
    if (edit.kind === 'delete') {
      staged.set(edit.path, null);
      continue;
    }
    let after: string;
    try {
      after = changeText(before, edit, strict);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors.push(`error: ${error.message} ${edit.path}`);
      continue;
    }
    if (edit.destination !== undefined) {
      staged.set(edit.path, null);
      staged.set(edit.destination, after);
      moves.push({ from: edit.path, to: edit.destination });
    } else staged.set(edit.path, after);
  }
  if (errors.length) return { exit: 1, output: [...errors, `failed: ${errors.length} of ${edits.length} edits`] };
  const changed = new Set([...staged.keys()].filter((path) => original.get(path) !== staged.get(path)));
  const listing: { path: string; line: string }[] = [];
  for (const move of moves) {
    if (original.get(move.from) != null && staged.get(move.from) === null
      && original.get(move.to) === null && staged.get(move.to) != null
      && changed.has(move.from) && changed.has(move.to)) {
      listing.push({ path: move.to, line: `R ${move.from} -> ${move.to}` });
      changed.delete(move.from);
      changed.delete(move.to);
    }
  }
  for (const path of changed) {
    const kind = original.get(path) === null ? 'A' : staged.get(path) === null ? 'D' : 'M';
    listing.push({ path, line: `${kind} ${path}` });
  }
  listing.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (!check) {
    for (const [path, text] of staged) {
      if (text === null && original.get(path) !== null) unlinkSync(path);
    }
    for (const [path, text] of staged) {
      if (text !== null && text !== original.get(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, 'utf8');
      }
    }
  }
  const count = listing.length;
  return { exit: 0, output: [...listing.map((item) => item.line), `ok: ${count} ${count === 1 ? 'file' : 'files'}`] };
}

function changeText(before: string, edit: Edit, strict: boolean): string {
  const file = openText(before);
  if (edit.kind === 'replace') {
    const normalize = (text: string) => file.break === '\r\n' ? text.replaceAll('\r\n', '\n') : text;
    const text = normalize(before);
    const old = normalize(edit.old ?? '');
    const added = normalize(edit.text ?? '');
    const at = text.indexOf(old);
    if (at === -1) throw new Error('no-match');
    if (text.indexOf(old, at + 1) !== -1) throw new Error('ambiguous');
    const result = text.slice(0, at) + added + text.slice(at + old.length);
    return file.break === '\r\n' ? result.replaceAll('\n', '\r\n') : result;
  }
  if (edit.kind === 'insert') {
    const at = edit.insertLine ?? -1;
    if (at < 0 || at > file.lines.length) throw new Error('no-match');
    file.lines.splice(at, 0, ...splitPatch(edit.text ?? ''));
    return closeText(file);
  }
  let cursor = 0;
  let delta = 0;
  for (const chunk of edit.chunks ?? []) {
    if (chunk.anchor !== undefined) {
      const anchor = occurrences(file.lines, [chunk.anchor], strict, cursor);
      if (!anchor.positions.length) throw new Error('no-match');
      cursor = anchor.positions[0] + 1;
    }
    const old = chunk.body.filter((line) => line.kind !== '+').map((line) => line.text);
    let at: number;
    let tier = 0;
    if (old.length === 0) {
      at = edit.kind === 'unified' ? Math.max(0, Math.min(file.lines.length, chunk.line + delta))
        : chunk.eof ? file.lines.length : cursor;
    } else {
      const found = occurrences(file.lines, old, strict, edit.kind === 'v4a' ? cursor : 0, chunk.eof ?? false);
      if (!found.positions.length) throw new Error('no-match');
      if (edit.kind === 'search' && found.positions.length > 1) throw new Error('ambiguous');
      at = found.positions[0];
      tier = found.tier;
      if (edit.kind === 'unified') {
        // A may be longer than a double can hold, where every distance is Infinity and a plain compare ties.
        // Clamping it just past either end keeps the same nearest order (positions lie inside the file).
        const target = Math.min(file.lines.length + 1, Math.max(-1, chunk.line - 1 + delta));
        for (const candidate of found.positions) {
          if (Math.abs(candidate - target) < Math.abs(at - target)) at = candidate;
        }
      }
    }
    const added = replacement(file.lines, at, chunk.body, tier);
    const touchesEnd = at + old.length === file.lines.length;
    if (edit.kind === 'unified' && touchesEnd) {
      const lastOutput = chunk.body.findLast((line) => line.kind !== '-');
      file.final = !lastOutput?.noBreak;
    }
    file.lines.splice(at, old.length, ...added);
    cursor = at + added.length;
    delta += added.length - old.length;
  }
  return closeText(file);
}
