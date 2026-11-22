// mend applies the four patch formats in SPEC.md using only the Node standard library.
// Parsing finishes before file access, and edits are staged until every edit succeeds.

import { readFileSync, writeSync } from 'node:fs';
import { Exit2, patchLines, detect } from './lib/patch.ts';
import type { Edit } from './lib/patch.ts';
import { unifiedEdits } from './lib/unified.ts';
import { searchReplaceEdits } from './lib/search_replace.ts';
import { v4aEdits } from './lib/v4a.ts';
import { jsonEdits } from './lib/json.ts';
import { applyEdits } from './lib/apply.ts';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function parseArgs(args: string[]): { format: string | null; check: boolean; strict: boolean; file: string | null } | null {
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
      else return null;
    } else pos.push(a);
  }
  if (pos.length > 1) return null;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  return { format, check, strict, file };
}

function run(args: string[]): { code: number; out: string[] } {
  const options = parseArgs(args);
  if (options === null) return { code: 2, out: ['error: usage'] };
  const { format, check, strict, file } = options;
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
  return applyEdits(edits, check);
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
