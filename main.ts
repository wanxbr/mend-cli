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

function fileLineBreak(text: string): string {
  if (text === '') return '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') return '\r\n';
  return '\n';
}

function fileLines(text: string): string[] {
  if (text === '') return [];
  const br = fileLineBreak(text);
  const lines = text.split(br);
  if (text.endsWith(br)) lines.pop();
  return lines;
}

function getLeadingWhitespace(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

function trimTrailing(line: string): string {
  return line.replace(/[ \t]*$/, '');
}

function trimLeadingTrailing(line: string): string {
  return line.replace(/^[ \t]*|[ \t]*$/g, '');
}

function findMatch(
  pattern: string[],
  fileLines: string[],
  startPos: number,
  tier: number,
  strict: boolean
): number | null {
  if (pattern.length === 0) return null;

  const tierToTry = strict ? [0] : tier === 2 ? [2, 1, 0] : tier === 1 ? [1, 0] : [0];

  for (const t of tierToTry) {
    const normalize = t === 0 ? (s: string) => s : t === 1 ? trimTrailing : trimLeadingTrailing;
    const patternNorm = pattern.map(normalize);
    
    for (let i = startPos; i <= fileLines.length - pattern.length; i++) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (normalize(fileLines[i + j]!) !== patternNorm[j]!) {
          match = false;
          break;
        }
      }
      if (match) {
        return i * 10 + t;
      }
    }
  }

  return null;
}

function findTierAndMatches(
  pattern: string[],
  fileLines: string[],
  strict: boolean
): { tier: number; positions: number[] } | null {
  if (pattern.length === 0) return null;

  const tierToTry = strict ? [0] : [0, 1, 2];

  for (const t of tierToTry) {
    const normalize = t === 0 ? (s: string) => s : t === 1 ? trimTrailing : trimLeadingTrailing;
    const patternNorm = pattern.map(normalize);
    
    const positions: number[] = [];
    for (let i = 0; i <= fileLines.length - pattern.length; i++) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (normalize(fileLines[i + j]!) !== patternNorm[j]!) {
          match = false;
          break;
        }
      }
      if (match) {
        positions.push(i);
      }
    }
    
    if (positions.length > 0) {
      return { tier: t, positions };
    }
  }

  return null;
}

function findMatchNearest(
  pattern: string[],
  fileLines: string[],
  target: number,
  strict: boolean
): number | null {
  const result = findTierAndMatches(pattern, fileLines, strict);
  if (result === null) return null;

  const { tier, positions } = result;
  let bestPos = positions[0]!;
  let bestDist = Math.abs(bestPos - target);

  for (const pos of positions) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist || (dist === bestDist && pos < bestPos)) {
      bestPos = pos;
      bestDist = dist;
    }
  }

  return bestPos * 10 + tier;
}

function findMatchAfter(
  pattern: string[],
  fileLines: string[],
  startPos: number,
  strict: boolean
): number | null {
  const result = findTierAndMatches(pattern, fileLines, strict);
  if (result === null) return null;

  const { tier, positions } = result;
  for (const pos of positions) {
    if (pos >= startPos) {
      return pos * 10 + tier;
    }
  }

  return null;
}

function extractTier(matchResult: number): number {
  return matchResult % 10;
}

function extractPos(matchResult: number): number {
  return Math.floor(matchResult / 10);
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

function parseUnifiedDiff(lines: string[], strict: boolean): { edits: Edit[], moves: Map<string, string> } {
  const edits: Edit[] = [];
  const moves = new Map<string, string>();
  let i = 0;

  while (i < lines.length) {
    const hunkStart = i;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let newFileMode = false;
    let deletedFileMode = false;

    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) {
        const m = l.match(/^diff --git a\/(.*)b\/(.*)$/);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        oldPath = m[1]!.replace(/^a\//, '').split('\t')[0]!.trim();
        newPath = m[2]!.replace(/^b\//, '').split('\t')[0]!.trim();
        i++;
        break;
      }
      if (l.startsWith('--- ')) {
        const pathStr = l.slice(4).split('\t')[0]!.trim();
        oldPath = pathStr === '/dev/null' ? null : pathStr.replace(/^a\//, '');
        i++;
        if (i >= lines.length || !lines[i]!.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        const pathStr2 = lines[i]!.slice(4).split('\t')[0]!.trim();
        newPath = pathStr2 === '/dev/null' ? null : pathStr2.replace(/^b\//, '');
        i++;
        break;
      }
      if (l.startsWith('new file mode')) {
        newFileMode = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        deletedFileMode = true;
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        oldPath = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        newPath = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('index ') || l.startsWith('old mode ') || l.startsWith('new mode ') || l.startsWith('similarity index ') || l.startsWith('dissimilarity index ') || l.startsWith('Index:')) {
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        break;
      }
      i++;
    }

    const hunks: Array<{ oldLines: string[]; newLines: string[]; oldStart: number; noFinalNewline: boolean }> = [];

    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const l = lines[i]!;
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const oldStart = parseInt(m[1]!) - 1;
      i++;

      const oldLines: string[] = [];
      const newLines: string[] = [];
      let noFinalNewline = false;

      while (i < lines.length) {
        const body = lines[i]!;
        if (body.startsWith('diff --git ') || (body.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (body.startsWith('@@')) break;
        if (body.length === 0) {
          oldLines.push('');
          newLines.push('');
          i++;
          continue;
        }
        const prefix = body[0];
        if (prefix === ' ') {
          oldLines.push(body.slice(1));
          newLines.push(body.slice(1));
          i++;
        } else if (prefix === '-') {
          oldLines.push(body.slice(1));
          i++;
        } else if (prefix === '+') {
          newLines.push(body.slice(1));
          i++;
        } else if (prefix === '\\') {
          noFinalNewline = true;
          i++;
        } else {
          break;
        }
      }

      hunks.push({ oldLines, newLines, oldStart, noFinalNewline });
    }

    if (hunks.length === 0 && !newFileMode && !deletedFileMode) {
      continue;
    }

    const path = newPath ?? oldPath;
    if (!path || !safe(path)) {
      throw new Fail('unsafe', path || '');
    }

    if (newFileMode) {
      edits.push((tree) => {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        const lines = hunks.flatMap((h) => h.newLines);
        const br = '\n';
        // Check if any hunk says no final newline; if so, don't add br
        const hasNoFinalNewline = hunks.some((h) => h.noFinalNewline);
        const text = lines.length === 0 ? '' : lines.join(br) + (hasNoFinalNewline ? '' : br);
        tree.now.set(path, text);
      });
    } else if (deletedFileMode) {
      edits.push((tree) => {
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else if (oldPath !== newPath) {
       // Track the move explicitly
       if (oldPath && newPath) {
         moves.set(oldPath, newPath);
       }
       edits.push((tree) => {
          const oldText = tree.get(oldPath!);
          if (oldText === null) throw new Fail('missing', oldPath!);
          if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);

          let currentLines = fileLines(oldText);
          const br = fileLineBreak(oldText);
          let hadFinalBreak = oldText === '' ? false : oldText.endsWith(br);
          let d = 0;

          for (const hunk of hunks) {
            if (hunk.oldLines.length === 0) {
              const insertPos = Math.min(hunk.oldStart + 1 + d, currentLines.length);
              currentLines.splice(insertPos, 0, ...hunk.newLines);
              d += hunk.newLines.length;
            } else {
              const target = hunk.oldStart - 1 + d;
              const matchResult = findMatchNearest(hunk.oldLines, currentLines, target, strict);
              if (matchResult === null) throw new Fail('no-match', oldPath!);

              const pos = extractPos(matchResult);
              const tier = extractTier(matchResult);

              const matched = currentLines.slice(pos, pos + hunk.oldLines.length);
              const normalize = tier === 0 ? (s: string) => s : tier === 1 ? trimTrailing : trimLeadingTrailing;
              
              const newLinesWithContext = hunk.newLines.map((line, idx) => {
                if (idx < hunk.oldLines.length && normalize(hunk.oldLines[idx]!) === normalize(line)) {
                  return matched[idx]!;
                }
                
                if (tier === 2 && line !== '' && line.trim() !== '') {
                  const F = getLeadingWhitespace(matched[0]!);
                  const P = getLeadingWhitespace(hunk.oldLines[0]!);
                  if (line.startsWith(P)) {
                    return F + line.slice(P.length);
                  }
                }
                
                return line;
              });

              currentLines.splice(pos, hunk.oldLines.length, ...newLinesWithContext);
              d += newLinesWithContext.length - hunk.oldLines.length;
            }
          }

          // Check if any hunk says no final newline; if so, suppress it
          const hasNoFinalNewline = hunks.some((h) => h.noFinalNewline);
          const finalText = currentLines.length === 0 ? '' : currentLines.join(br) + (hasNoFinalNewline ? '' : (hadFinalBreak ? br : ''));
          tree.now.set(newPath!, finalText);
          tree.now.set(oldPath!, null);
       });
    } else {
       edits.push((tree) => {
          const text = tree.get(path);
          if (text === null) throw new Fail('missing', path);

          let currentLines = fileLines(text);
          const br = fileLineBreak(text);
          const hadFinalBreak = text === '' ? false : text.endsWith(br);
          let d = 0;

          for (const hunk of hunks) {
            if (hunk.oldLines.length === 0) {
              const insertPos = Math.min(hunk.oldStart + 1 + d, currentLines.length);
              currentLines.splice(insertPos, 0, ...hunk.newLines);
              d += hunk.newLines.length;
            } else {
              const target = hunk.oldStart - 1 + d;
              const matchResult = findMatchNearest(hunk.oldLines, currentLines, target, strict);
              if (matchResult === null) throw new Fail('no-match', path);

              const pos = extractPos(matchResult);
              const tier = extractTier(matchResult);

              const matched = currentLines.slice(pos, pos + hunk.oldLines.length);
              const normalize = tier === 0 ? (s: string) => s : tier === 1 ? trimTrailing : trimLeadingTrailing;
              
              const newLinesWithContext = hunk.newLines.map((line, idx) => {
                if (idx < hunk.oldLines.length && normalize(hunk.oldLines[idx]!) === normalize(line)) {
                  return matched[idx]!;
                }
                
                if (tier === 2 && line !== '' && line.trim() !== '') {
                  const F = getLeadingWhitespace(matched[0]!);
                  const P = getLeadingWhitespace(hunk.oldLines[0]!);
                  if (line.startsWith(P)) {
                    return F + line.slice(P.length);
                  }
                }
                
                return line;
              });

              currentLines.splice(pos, hunk.oldLines.length, ...newLinesWithContext);
              d += newLinesWithContext.length - hunk.oldLines.length;
            }
          }

          // Check if any hunk says no final newline; if so, suppress it
          const hasNoFinalNewline = hunks.some((h) => h.noFinalNewline);
          const finalText = currentLines.length === 0 ? '' : currentLines.join(br) + (hasNoFinalNewline ? '' : (hadFinalBreak ? br : ''));
          tree.now.set(path, finalText);
        });
     }
  }

  return { edits, moves };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let currentPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }

    const line = lines[i]!.trim();
    if (line.startsWith('```')) {
      i++;
      continue;
    }

    if (line === '<<<<<<< SEARCH') {
      if (!currentPath) throw new Exit2(`error: parse ${i + 1}`);

      i++;
      const oldLines: string[] = [];
      while (i < lines.length && lines[i]!.trimEnd() !== '=======') {
        oldLines.push(lines[i]!);
        i++;
      }

      if (i >= lines.length || lines[i]!.trimEnd() !== '=======') {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      i++;

      const newLines: string[] = [];
      while (i < lines.length && lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
        newLines.push(lines[i]!);
        i++;
      }

      if (i >= lines.length || lines[i]!.trimEnd() !== '>>>>>>> REPLACE') {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      i++;

       const path = currentPath;
       edits.push((tree) => {
         if (!safe(path)) throw new Fail('unsafe', path);

         if (oldLines.length === 0) {
           if (tree.get(path) !== null) throw new Fail('exists', path);
           const br = '\n';
           tree.now.set(path, newLines.length === 0 ? '' : newLines.join(br) + br);
         } else {
           const text = tree.get(path);
           if (text === null) throw new Fail('missing', path);

           const currentFileLines = fileLines(text);
           const br = fileLineBreak(text);
           const hadFinalBreak = text === '' ? false : text.endsWith(br);

           const result = findTierAndMatches(oldLines, currentFileLines, strict);
           if (result === null) throw new Fail('no-match', path);
           if (result.positions.length > 1) throw new Fail('ambiguous', path);

           const tier = result.tier;
           const pos = result.positions[0]!;
           const matched = currentFileLines.slice(pos, pos + oldLines.length);
           const normalize = tier === 0 ? (s: string) => s : tier === 1 ? trimTrailing : trimLeadingTrailing;
           
           const newLinesWithContext = newLines.map((line, idx) => {
             if (idx < oldLines.length && normalize(oldLines[idx]!) === normalize(line)) {
               return matched[idx]!;
             }
             
             if (tier === 2 && line !== '' && line.trim() !== '') {
               const F = getLeadingWhitespace(matched[0]!);
               const P = getLeadingWhitespace(oldLines[0]!);
               if (line.startsWith(P)) {
                 return F + line.slice(P.length);
               }
             }
             
             return line;
           });

           currentFileLines.splice(pos, oldLines.length, ...newLinesWithContext);
           const finalText = currentFileLines.length === 0 ? '' : currentFileLines.join(br) + (hadFinalBreak ? br : '');
           tree.now.set(path, finalText);
         }
       });
    } else if (!line.startsWith('<<<<<<')) {
      currentPath = lines[i]!.trim();
      i++;
    } else {
      i++;
    }
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function parseV4A(lines: string[], strict: boolean): { edits: Edit[], moves: Map<string, string> } {
  const edits: Edit[] = [];
  const moves = new Map<string, string>();
  let i = 0;

  while (i < lines.length && blank(lines[i]!)) i++;
  if (i >= lines.length || lines[i]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${i + 1}`);
  }
  i++;

  while (i < lines.length && blank(lines[i]!)) i++;

  let foundEndPatch = false;
  while (i < lines.length) {
    const l = lines[i]!.trim();
    if (l === '*** End Patch') {
      foundEndPatch = true;
      i++;
      while (i < lines.length && blank(lines[i]!)) i++;
      if (i < lines.length) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }

    if (l.startsWith('*** Add File: ')) {
      const path = lines[i]!.slice(14).trim();
      if (!safe(path)) throw new Fail('unsafe', path);
      i++;

      const fileLines: string[] = [];
      while (i < lines.length) {
        const body = lines[i]!;
        if (body.trim().startsWith('***')) break;
        if (body === '') {
          fileLines.push('');
        } else if (body.startsWith('+')) {
          fileLines.push(body.slice(1));
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i++;
      }

      edits.push((tree) => {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = lines[i]!.slice(17).trim();
      if (!safe(path)) throw new Fail('unsafe', path);
      i++;

      edits.push((tree) => {
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else if (l.startsWith('*** Update File: ')) {
      const path = lines[i]!.slice(17).trim();
      if (!safe(path)) throw new Fail('unsafe', path);
      i++;

      let newPath: string | null = null;
      if (i < lines.length && lines[i]!.trim().startsWith('*** Move to: ')) {
        newPath = lines[i]!.trim().slice(13);
        if (newPath) {
          moves.set(path, newPath);
        }
        i++;
      }

      const chunks: Array<{ anchor: string | null; oldLines: string[]; newLines: string[] }> = [];
      let hasChunk = false;

      while (i < lines.length) {
        const l = lines[i]!.trim();
        if (l.startsWith('***')) {
          if (l === '*** End of File') {
            i++;
            const oldLines: string[] = [];
            const newLines: string[] = [];
            while (i < lines.length && lines[i]!.trim() !== '') {
              const body = lines[i]!;
              const prefix = body[0];
              if (prefix === ' ' || prefix === '-' || prefix === '+' || body === '') {
                if (prefix === ' ') {
                  oldLines.push(trimTrailing(body.slice(1)));
                  newLines.push(trimTrailing(body.slice(1)));
                } else if (prefix === '-') {
                  oldLines.push(body.slice(1));
                } else if (prefix === '+') {
                  newLines.push(body.slice(1));
                } else {
                  oldLines.push('');
                  newLines.push('');
                }
                i++;
              } else {
                break;
              }
            }
            chunks.push({ anchor: 'EOF', oldLines, newLines });
            hasChunk = true;
          } else {
            break;
          }
        } else if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          i++;
          const oldLines: string[] = [];
          const newLines: string[] = [];
          while (i < lines.length) {
            const body = lines[i]!;
            if (body.trim().startsWith('***')) break;
            const prefix = body[0];
            if (prefix === ' ' || prefix === '-' || prefix === '+' || body === '') {
              if (prefix === ' ') {
                oldLines.push(trimTrailing(body.slice(1)));
                newLines.push(trimTrailing(body.slice(1)));
              } else if (prefix === '-') {
                oldLines.push(body.slice(1));
              } else if (prefix === '+') {
                newLines.push(body.slice(1));
              } else {
                oldLines.push('');
                newLines.push('');
              }
              i++;
            } else {
              break;
            }
          }
          chunks.push({ anchor, oldLines, newLines });
          hasChunk = true;
        } else {
          const prefix = lines[i]![0];
          if (prefix === ' ' || prefix === '-' || prefix === '+' || lines[i] === '') {
            const oldLines: string[] = [];
            const newLines: string[] = [];
            while (i < lines.length) {
              const body = lines[i]!;
              if (body.trim().startsWith('***')) break;
              const p = body[0];
              if (p === ' ' || p === '-' || p === '+' || body === '') {
                if (p === ' ') {
                  oldLines.push(trimTrailing(body.slice(1)));
                  newLines.push(trimTrailing(body.slice(1)));
                } else if (p === '-') {
                  oldLines.push(body.slice(1));
                } else if (p === '+') {
                  newLines.push(body.slice(1));
                } else {
                  oldLines.push('');
                  newLines.push('');
                }
                i++;
              } else {
                break;
              }
            }
            chunks.push({ anchor: null, oldLines, newLines });
            hasChunk = true;
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
        }
      }

      if (!hasChunk && !newPath) throw new Exit2(`error: parse ${i}`);

      edits.push((tree) => {
        const oldFile = tree.get(path);
        if (oldFile === null) throw new Fail('missing', path);
        if (newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);

        const br = fileLineBreak(oldFile);
        let currentLines = fileLines(oldFile);
        let cursor = 0;

        for (const chunk of chunks) {
           if (chunk.anchor === 'EOF') {
             if (chunk.oldLines.length === 0) {
               currentLines.splice(currentLines.length, 0, ...chunk.newLines);
             } else {
               const result = findTierAndMatches(chunk.oldLines, currentLines, strict);
               if (result === null) throw new Fail('no-match', path);
               
               let eofPos: number | null = null;
               for (const pos of result.positions) {
                 if (pos + chunk.oldLines.length === currentLines.length) {
                   eofPos = pos;
                   break;
                 }
               }
               
               if (eofPos === null) throw new Fail('no-match', path);
               
               const tier = result.tier;
               const matched = currentLines.slice(eofPos, eofPos + chunk.oldLines.length);
               const normalize = tier === 0 ? (s: string) => s : tier === 1 ? trimTrailing : trimLeadingTrailing;
               
               const finalLines = chunk.newLines.map((line, idx) => {
                 if (idx < chunk.oldLines.length && normalize(chunk.oldLines[idx]!) === normalize(line)) {
                   return matched[idx]!;
                 }
                 
                 if (tier === 2 && line !== '' && line.trim() !== '') {
                   const F = getLeadingWhitespace(matched[0]!);
                   const P = getLeadingWhitespace(chunk.oldLines[0]!);
                   if (line.startsWith(P)) {
                     return F + line.slice(P.length);
                   }
                 }
                 
                 return line;
               });

               currentLines.splice(eofPos, chunk.oldLines.length, ...finalLines);
               cursor = eofPos + finalLines.length;
             }
           } else if (chunk.anchor) {
             const anchorResult = findTierAndMatches([chunk.anchor], currentLines, strict);
             if (anchorResult === null) throw new Fail('no-match', path);
             
             let anchorPos: number | null = null;
             for (const pos of anchorResult.positions) {
               if (pos >= cursor) {
                 anchorPos = pos;
                 break;
               }
             }
             
             if (anchorPos === null) throw new Fail('no-match', path);
             cursor = anchorPos + 1;

             if (chunk.oldLines.length === 0) {
               currentLines.splice(cursor, 0, ...chunk.newLines);
               cursor += chunk.newLines.length;
             } else {
               const matchResult = findMatchAfter(chunk.oldLines, currentLines, cursor, strict);
               if (matchResult === null) throw new Fail('no-match', path);

               const pos = extractPos(matchResult);
               const tier = extractTier(matchResult);
               const matched = currentLines.slice(pos, pos + chunk.oldLines.length);
               let finalLines = [...chunk.newLines];

               if (tier === 2) {
                 const F = getLeadingWhitespace(matched[0]!);
                 const P = getLeadingWhitespace(chunk.oldLines[0]!);
                 finalLines = finalLines.map((line) => {
                   if (line === '' || line.trim() === '') return line;
                   if (line.startsWith(P)) return F + line.slice(P.length);
                   return line;
                 });
               }

               currentLines.splice(pos, chunk.oldLines.length, ...finalLines);
               cursor = pos + finalLines.length;
             }
           } else {
             if (chunk.oldLines.length === 0) {
               currentLines.splice(cursor, 0, ...chunk.newLines);
               cursor += chunk.newLines.length;
             } else {
               const matchResult = findMatchAfter(chunk.oldLines, currentLines, cursor, strict);
               if (matchResult === null) throw new Fail('no-match', path);

               const pos = extractPos(matchResult);
               const tier = extractTier(matchResult);
               const matched = currentLines.slice(pos, pos + chunk.oldLines.length);
               let finalLines = [...chunk.newLines];

               if (tier === 2) {
                 const F = getLeadingWhitespace(matched[0]!);
                 const P = getLeadingWhitespace(chunk.oldLines[0]!);
                 finalLines = finalLines.map((line) => {
                   if (line === '' || line.trim() === '') return line;
                   if (line.startsWith(P)) return F + line.slice(P.length);
                   return line;
                 });
               }

               currentLines.splice(pos, chunk.oldLines.length, ...finalLines);
               cursor = pos + finalLines.length;
             }
           }
        }

        const finalText = currentLines.length === 0 ? '' : currentLines.join(br) + br;
        if (newPath) {
          tree.now.set(newPath, finalText);
          tree.now.set(path, null);
        } else {
          tree.now.set(path, finalText);
        }
      });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }

    while (i < lines.length && blank(lines[i]!)) i++;
  }

  if (!foundEndPatch) throw new Exit2(`error: parse ${lines.length + 1}`);

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return { edits, moves };
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
  let moves = new Map<string, string>();
  try {
    if (kind === 'json') {
      edits = jsonEdits(text, lines);
    } else if (kind === 'unified') {
      const result = parseUnifiedDiff(lines, strict);
      edits = result.edits;
      moves = result.moves;
    } else if (kind === 'search-replace') {
      edits = parseSearchReplace(lines, strict);
    } else if (kind === 'v4a') {
      const result = parseV4A(lines, strict);
      edits = result.edits;
      moves = result.moves;
    } else {
      edits = [];
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const renames = new Map<string, string>();
  
  // First pass: collect all changes and use explicit moves
  for (const [oldPath, newPath] of moves) {
    renames.set(newPath, oldPath);
  }
  
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    
    // Check if this is a destination of an explicit move
    if (renames.has(p)) {
      const oldPath = renames.get(p)!;
      rows.push(`R ${oldPath} -> ${p}`);
      renames.delete(p);
    } else if (was !== null && now === null) {
      // Check if this deleted file is a source of an explicit move (shouldn't output it)
      let isMovedFrom = false;
      for (const [oldPath, newPath] of moves) {
        if (oldPath === p) {
          isMovedFrom = true;
          break;
        }
      }
      if (!isMovedFrom) {
        rows.push(`D ${p}`);
      }
    } else {
      rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    }
    
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
