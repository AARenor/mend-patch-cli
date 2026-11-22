export interface TextLines {
  lines: string[];
  break: string;
  final: boolean;
}

export interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noBreak?: boolean;
}

export interface Occurrences {
  positions: number[];
  tier: number;
}

export function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

export function openText(text: string): TextLines {
  const feed = text.indexOf('\n');
  const lineBreak = feed > 0 && text[feed - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(lineBreak);
  const lines = text === '' ? [] : text.split(lineBreak);
  if (final) lines.pop();
  return { lines, break: lineBreak, final };
}

export function closeText(file: TextLines): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.break) + (file.final ? file.break : '');
}

export function occurrences(
  lines: string[], old: string[], strict: boolean, start = 0, endOnly = false,
): Occurrences {
  // A short or empty remaining file cannot contain this needle; skip all tiers.
  if (old.length > lines.length - start) return { positions: [], tier: 0 };
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const needle = old.map((line) => matchKey(line, tier));
    const positions: number[] = [];
    for (let at = start; at + old.length <= lines.length; at++) {
      if (endOnly && at + old.length !== lines.length) continue;
      if (needle.every((line, offset) => matchKey(lines[at + offset], tier) === line)) positions.push(at);
    }
    if (positions.length) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}

// Only spaces are trimmed from patch paths: a tab separates a path from a timestamp.
export function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;
  return text.slice(start, end);
}

// Keep both sides of each matching tier on the same whitespace policy. The scan is
// index arithmetic rather than a trailing-space regex, which is quadratic on a long run.
function matchKey(line: string, tier: number): string {
  if (tier === 0) return line;
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (tier === 1) return line.slice(0, end);
  let start = 0;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start++;
  return line.slice(start, end);
}

export function replacement(lines: string[], at: number, body: BodyLine[], tier: number): string[] {
  const old = body.filter((line) => line.kind !== '+');
  const fileIndent = (lines[at] ?? '').match(/^[ \t]*/)?.[0] ?? '';
  const patchIndent = (old[0]?.text ?? '').match(/^[ \t]*/)?.[0] ?? '';
  const result: string[] = [];
  let consumed = 0;
  for (const line of body) {
    if (line.kind === ' ') result.push(lines[at + consumed++]);
    else if (line.kind === '-') consumed++;
    else {
      let text = line.text;
      if (tier === 2 && /[^ \t]/.test(text) && text.startsWith(patchIndent)) {
        text = fileIndent + text.slice(patchIndent.length);
      }
      result.push(text);
    }
  }
  return result;
}
