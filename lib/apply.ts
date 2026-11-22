import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Tree, Fail } from './patch.ts';
import type { Edit } from './patch.ts';

export function applyEdits(edits: Edit[], check: boolean): { code: number; out: string[] } {
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
  }
  if (!check) {
    // Delete blocking files first when a patch creates a path beneath a deleted file.
    for (const [p, now] of tree.now) {
      if (now === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const [p, now] of tree.now) {
      if (now === null || tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  changes.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const rows = changes.map((change) => change.row);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}
