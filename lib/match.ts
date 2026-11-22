import { blank } from './patch.ts';
import type { BodyLine, LineMatch } from './patch.ts';

function horizontalTrim(line: string, leading: boolean): string {
  let start = 0;
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (leading) {
    while (start < end && (line[start] === ' ' || line[start] === '\t')) start++;
  }
  return line.slice(start, end);
}

function matchingPositions(source: string[], wanted: string[], start: number, endOnly: boolean): number[] {
  const last = source.length - wanted.length;
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
  return positions;
}

export function matchLines(file: string[], old: string[], strict: boolean, start = 0, endOnly = false): LineMatch | null {
  // No tier can fit the old lines beyond the remaining search window.
  if (old.length > file.length || start > file.length - old.length) return null;
  // Keep tier priority here so every format chooses exact matches before relaxed ones.
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const source = tier === 0 ? file : file.map((line) => horizontalTrim(line, tier === 2));
    const wanted = tier === 0 ? old : old.map((line) => horizontalTrim(line, tier === 2));
    const positions = matchingPositions(source, wanted, start, endOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function indentation(line: string): string {
  let end = 0;
  while (end < line.length && (line[end] === ' ' || line[end] === '\t')) end++;
  return line.slice(0, end);
}

export function replacementLines(body: BodyLine[], file: string[], at: number, tier: number): string[] {
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
