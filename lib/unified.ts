import { Exit2, Fail, safe, readLines, writeLines, createdLines } from './patch.ts';
import type { BodyLine, Edit, Tree } from './patch.ts';
import { matchLines, replacementLines } from './match.ts';

type Hunk = { oldStart: number; body: BodyLine[] };

function applyHunks(original: string, hunks: Hunk[], strict: boolean, path: string): string {
  const file = readLines(original);
  let delta = 0;
  for (const hunk of hunks) {
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
      if (found === null) throw new Fail('no-match', path);
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
  return writeLines(file);
}

export function unifiedEdits(lines: string[], strict: boolean): Edit[] {
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

      const result = applyHunks(original, item.hunks, strict, oldPath);
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
