import { readFileSync, writeSync } from 'node:fs';
import { execute } from './lib/apply.ts';
import { parsePatch } from './lib/patch.ts';
import type { Edit, Format } from './lib/patch.ts';

interface CliResult {
  code: number;
  out: string[];
}

function run(arguments_: string[]): CliResult {
  let format: Format | 'auto' = 'auto';
  let check = false;
  let strict = false;
  let positional = false;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const argument of arguments_) {
    if (!positional && argument === '--') {
      positional = true;
    } else if (!positional && argument.startsWith('-') && argument !== '-') {
      const option = argument.startsWith('--format=') ? '--format' : argument;
      if (seen.has(option)) return report('usage');
      seen.add(option);
      if (option === '--check') check = true;
      else if (option === '--strict') strict = true;
      else if (option === '--format') {
        const value = argument.slice(9);
        if (!['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(value)) {
          return report('usage');
        }
        format = value as Format | 'auto';
      } else return report('usage');
    } else paths.push(argument);
  }
  if (paths.length > 1) return report('usage');
  let patch: string;
  try {
    patch = readFileSync(paths[0] === undefined || paths[0] === '-' ? 0 : paths[0], 'utf8');
  } catch {
    return report('no-patch');
  }
  let edits: Edit[];
  try {
    edits = parsePatch(patch, format);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return report(error.message);
  }
  const result = execute(edits, strict, check);
  return { out: result.output, code: result.exit };
}

function report(message: string): CliResult {
  return { code: 2, out: [`error: ${message}`] };
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
