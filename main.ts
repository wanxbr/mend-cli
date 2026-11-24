#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ExitCode = 0 | 1 | 2;

interface FileTree {
  [path: string]: string | null;
}

interface Match {
  tier: number;
  position: number;
}

interface EditResult {
  success: boolean;
  exit: ExitCode;
  stdout: string;
  files: FileTree;
}

interface CheckOptions {
  format: 'auto' | 'unified' | 'search-replace' | 'v4a' | 'json' | 'error';
  check: boolean;
  strict: boolean;
  patchFile: string;
}

const USAGE_ERROR = 2 as ExitCode;
const EXEC_ERROR = 1 as ExitCode;

class ExecError extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

class FailedError extends Error {
  k: number;
  n: number;
  constructor(k: number, n: number) {
    super(`failed: ${k} of ${n} edits`);
    this.k = k;
    this.n = n;
  }
}

function usageError(): never {
  console.log('error: usage');
  process.exit(USAGE_ERROR);
}

function noPatchError(): never {
  console.log('error: no-patch');
  process.exit(USAGE_ERROR);
}

function formatError(): never {
  console.log('error: format');
  process.exit(USAGE_ERROR);
}

function parseError(line: number): never {
  console.log(`error: parse ${line}`);
  process.exit(USAGE_ERROR);
}

function execError(code: string, path: string): never {
  throw new ExecError(code, path);
}

function failed(k: number, n: number): never {
  throw new FailedError(k, n);
}

function ok(n: number): void {
  console.log(`ok: ${n} file${n === 1 ? '' : 's'}`);
}

function parseArgs(args: string[]): CheckOptions {
  let format: CheckOptions['format'] = 'auto';
  let check = false;
  let strict = false;
  let patchFile = '';
  let positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionalArgs.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--check') {
      check = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice(9);
      if (value === 'auto' || value === 'unified' || value === 'search-replace' || value === 'v4a' || value === 'json') {
        format = value as CheckOptions['format'];
      } else {
        usageError();
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      usageError();
    } else {
      positionalArgs.push(arg);
    }
  }

  if (positionalArgs.length > 1) {
    usageError();
  }
  patchFile = positionalArgs[0] || '-';

  return { format, check, strict, patchFile };
}

function readPatch(patchFile: string): string {
  if (patchFile === '-') {
    return readFileSync(0, 'utf8');
  } else {
    try {
      return readFileSync(patchFile, 'utf8');
    } catch {
      noPatchError();
    }
  }
}

function splitPatchLines(patch: string): string[] {
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) {
      lines[i] = lines[i].slice(0, -1);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function isSafePath(path: string): boolean {
  if (path === '' || path.startsWith('/')) return false;
  if (path.includes('\\')) return false;
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return false;
  }
  return true;
}

function detectFormat(lines: string[]): CheckOptions['format'] {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstNonBlank = i;
      break;
    }
  }

  if (firstNonBlank >= 0) {
    const trimmed = lines[firstNonBlank].trim();
    if (trimmed === '*** Begin Patch') {
      return 'v4a';
    }
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      return 'json';
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (trimmed === '<<<<<<< SEARCH') {
      return 'search-replace';
    }
    if (trimmed.startsWith('diff --git ') || (trimmed.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].trim().startsWith('+++ '))) {
      return 'unified';
    }
  }

  return 'error';
}

function main(): void {
  const args = process.argv.slice(2);
  const options = parseArgs(args);
  const patch = readPatch(options.patchFile);
  const lines = splitPatchLines(patch);

  let format: CheckOptions['format'];
  if (options.format === 'auto') {
    format = detectFormat(lines);
  } else {
    format = options.format;
  }

  if (format === 'error') {
    formatError();
  }

  const result = applyPatch(format, lines, options);
  if (result.stdout) {
    console.log(result.stdout);
  }
  if (!options.check && result.exit === 0) {
    writeFiles(result.files);
  }
  process.exit(result.exit);
}

function applyPatch(format: CheckOptions['format'], lines: string[], options: CheckOptions): EditResult {
  const files: FileTree = {};
  const originalFiles: Record<string, string> = {};
  const renames: Array<{ old: string, new: string }> = [];
  const errors: string[] = [];
  let exit = 0 as ExitCode;

  function initFiles(): void {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          walk(p);
        } else if (st.isFile()) {
          const relPath = relative('.', p).split(sep).join('/');
          const text = readFileSync(p, 'utf8');
          files[relPath] = text;
          originalFiles[relPath] = text;
        }
      }
    };
    walk('.');
  }

  initFiles();

  const edits = format === 'unified' ? parseUnifiedDiffs(lines, options.strict) :
              format === 'search-replace' ? parseSearchReplaceBlocks(lines) :
              format === 'v4a' ? parseV4ASections(lines) :
              parseJSONEdits(lines);

  let successfulEdits = 0;
  let failedEdits = 0;

  for (const edit of edits) {
    try {
      if (format === 'unified') {
        applyUnifiedEdit(edit, files, originalFiles, renames, options.strict);
        successfulEdits++;
      } else if (format === 'search-replace') {
        applySearchReplaceEdit(edit, files, options.strict);
        successfulEdits++;
      } else if (format === 'v4a') {
        applyV4AEdit(edit, files, options.strict, renames);
        successfulEdits++;
      } else if (format === 'json') {
        applyJSONEdit(edit, files);
        successfulEdits++;
      }
    } catch (e) {
      if (e instanceof ExecError) {
        errors.push(e.message);
        failedEdits++;
      } else if (e instanceof FailedError) {
        errors.push(e.message);
        failedEdits++;
      } else if (e instanceof Error) {
        errors.push(e.message);
        failedEdits++;
      }
    }
  }

  if (errors.length > 0) {
    exit = EXEC_ERROR;
    console.log(errors.join('\n'));
    console.log(`failed: ${errors.length} of ${edits.length} edits`);
  }

  const stdout = formatOutput(files, exit === 0, originalFiles, renames);
  return { success: exit === 0, exit, stdout, files };
}

function formatOutput(files: FileTree, success: boolean, originalFiles: Record<string, string> = {}, renames: Array<{ old: string, new: string }> = []): string {
  if (!success) return '';

  const changedPaths = Object.keys(files).filter(path => {
    const content = files[path];
    if (content === null) {
      return originalFiles[path] !== undefined;
    }
    return originalFiles[path] !== content;
  }).filter(path => {
    const rename = renames.find(r => r.old === path);
    return !rename;
  });
  const sortedPaths = changedPaths.sort();

  const output: string[] = [];
  const printedRenames = new Set<string>();

  for (const path of sortedPaths) {
    const content = files[path];
    if (content === null) {
      const rename = renames.find(r => r.old === path);
      if (rename) {
        const key = `${rename.old}->${rename.new}`;
        if (!printedRenames.has(key)) {
          output.push(`R ${rename.old} -> ${rename.new}`);
          printedRenames.add(key);
        }
      } else {
        output.push(`D ${path}`);
      }
    } else if (originalFiles[path] !== undefined) {
      output.push(`M ${path}`);
    } else {
      const rename = renames.find(r => r.new === path);
      if (rename) {
        const key = `${rename.old}->${rename.new}`;
        if (!printedRenames.has(key)) {
          output.push(`R ${rename.old} -> ${rename.new}`);
          printedRenames.add(key);
        }
      } else {
        output.push(`A ${path}`);
      }
    }
  }

  const fileCount = sortedPaths.length;
  output.push(`ok: ${fileCount} file${fileCount === 1 ? '' : 's'}`);

  return output.join('\n');
}

function writeFiles(files: FileTree): void {
  for (const path of Object.keys(files)) {
    const content = files[path];
    if (content === null) {
      rmSync(path, { force: true });
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
}

function stripTrailingWhitespace(line: string): string {
  return line.replace(/[\t ]+$/, '');
}

function stripLeadingWhitespace(line: string): string {
  return line.replace(/^[\t ]+/, '');
}

function stripLeadingAndTrailingWhitespace(line: string): string {
  return stripLeadingWhitespace(stripTrailingWhitespace(line));
}

function splitLines(text: string): { lines: string[], lineBreak: '\n' | '\r\n', endsWithBreak: boolean } {
  let lineBreak: '\n' | '\r\n' = '\n';
  const firstLF = text.indexOf('\n');
  if (firstLF >= 0 && text[firstLF - 1] === '\r') {
    lineBreak = '\r\n';
  }

  const lines = text.split(lineBreak);
  if (text.endsWith(lineBreak)) {
    lines.pop();
  }

  return { lines, lineBreak, endsWithBreak: text.endsWith(lineBreak) };
}

function readFileLines(path: string): { lines: string[], lineBreak: '\n' | '\r\n', endsWithBreak: boolean } | null {
  if (!existsSync(path)) return null;

  const text = readFileSync(path, 'utf8');
  return splitLines(text);
}

function readFileFromFiles(path: string, files: FileTree): { lines: string[], lineBreak: '\n' | '\r\n', endsWithBreak: boolean } | null {
  if (files[path] === undefined) return null;
  if (files[path] === null) return null;

  const text = files[path];
  return splitLines(text);
}

function writeFileLines(path: string, lines: string[], lineBreak: '\n' | '\r\n', endsWithBreak: boolean): void {
  let content = lines.join(lineBreak);
  if (endsWithBreak) {
    content += lineBreak;
  }
  writeFileSync(path, content);
}

function findBestMatch(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  offset: number
): { tier: number, position: number } | null {
  const maxTier = strict ? 0 : 2;

  for (let t = 0; t <= maxTier; t++) {
    const matches: { position: number }[] = [];

    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < oldLines.length; j++) {
        let fileLine = fileLines[i + j];
        let oldLine = oldLines[j];

        if (t === 0) {
          if (fileLine !== oldLine) {
            match = false;
            break;
          }
        } else if (t === 1) {
          if (stripTrailingWhitespace(fileLine) !== stripTrailingWhitespace(oldLine)) {
            match = false;
            break;
          }
        } else if (t === 2) {
          if (stripLeadingAndTrailingWhitespace(fileLine) !== stripLeadingAndTrailingWhitespace(oldLine)) {
            match = false;
            break;
          }
        }
      }

      if (match) {
        matches.push({ position: i });
      }
    }

    if (matches.length > 0) {
      let bestMatch = matches[0];
      let bestDistance = Math.abs(matches[0].position - offset);

      for (let i = 1; i < matches.length; i++) {
        const distance = Math.abs(matches[i].position - offset);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = matches[i];
        } else if (distance === bestDistance && matches[i].position < bestMatch.position) {
          bestMatch = matches[i];
        }
      }

      return { tier: t, position: bestMatch.position };
    }
  }

  return null;
}

function applyReindentation(
  newLines: string[],
  fileLines: string[],
  matchPosition: number,
  oldLines: string[]
): string[] {
  if (matchPosition < 0 || matchPosition >= fileLines.length) return [...newLines];

  const targetIndent = fileLines[matchPosition].match(/^[\t ]*/)?.[0] || '';
  const sourceIndent = oldLines[0].match(/^[\t ]*/)?.[0] || '';

  const result: string[] = [];

  for (const line of newLines) {
    if (line.trim() === '' || !line.startsWith(sourceIndent)) {
      result.push(line);
    } else {
      result.push(targetIndent + line.slice(sourceIndent.length));
    }
  }

  return result;
}

interface Hunk {
  body: Array<{ type: 'context' | 'old' | 'new', text: string }>;
  backslash: boolean;
  lineA: number;
  lineC: number;
}

function parseUnifiedDiffs(lines: string[], strict: boolean): Array<{ path: string, type: 'create' | 'delete' | 'move' | 'change', oldPath: string, newPath: string, hunks: Hunk[] }> {
  const edits: Array<{ path: string, type: 'create' | 'delete' | 'move' | 'change', oldPath: string, newPath: string, hunks: Hunk[] }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (!match) {
        parseError(i + 1);
      }
      const oldPath = match[1];
      const newPath = match[2];

      i++;
      let sectionOldPath = oldPath;
      let sectionNewPath = newPath;
      let sectionType: 'create' | 'delete' | 'move' | 'change' = 'change';
      const hunks: Hunk[] = [];

      while (i < lines.length) {
        const sectionLine = lines[i];

        if (sectionLine.startsWith('diff --git ')) {
          break;
        }

        if (hunks.length > 0 && sectionLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].trim().startsWith('+++ ')) {
          break;
        }

        if (sectionLine.startsWith('@@')) {
          const hunkMatch = sectionLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (!hunkMatch) {
            parseError(i + 1);
          }

          const lineA = parseInt(hunkMatch[1], 10);
          const lineB = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
          const lineC = parseInt(hunkMatch[3], 10);
          const lineD = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

          i++;
          const body: Array<{ type: 'context' | 'old' | 'new', text: string }> = [];
          let backslash = false;

          while (i < lines.length) {
            const hunkLine = lines[i];

            if (hunkLine.startsWith('diff --git ') || (hunkLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].trim().startsWith('+++ '))) {
              break;
            }

            if (hunkLine.startsWith('@@')) {
              break;
            }

            if (hunkLine.startsWith('--- ') || hunkLine.startsWith('+++ ')) {
              break;
            }

            if (hunkLine.startsWith(' ')) {
              body.push({ type: 'context', text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith('-')) {
              body.push({ type: 'old', text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith('+')) {
              body.push({ type: 'new', text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith('\\')) {
              backslash = true;
            } else if (hunkLine === '') {
              body.push({ type: 'context', text: '' });
            } else {
              break;
            }

            i++;
          }

          while (hunks.length > 0 && hunks[hunks.length - 1].body.length === 0) {
            hunks.pop();
          }

          while (body.length > 0 && body[body.length - 1].type === 'context' && body[body.length - 1].text === '') {
            body.pop();
          }

          if (body.length > 0) {
            hunks.push({ body, backslash, lineA, lineC });
          }
        } else if (sectionLine.startsWith('--- ')) {
          const match2 = sectionLine.match(/^--- (.*)$/);
          if (!match2) {
            parseError(i + 1);
          }
          const path = match2[1].replace(/^a\//, '').replace(/^b\//, '').split('\t')[0].trim();
          if (path === '/dev/null') {
            sectionType = 'create';
          }
          sectionOldPath = path;
          i++;
        } else if (sectionLine.startsWith('+++ ')) {
          const match2 = sectionLine.match(/^\+\+\+ (.*)$/);
          if (!match2) {
            parseError(i + 1);
          }
          const path = match2[1].replace(/^a\//, '').replace(/^b\//, '').split('\t')[0].trim();
          if (path === '/dev/null') {
            sectionType = 'delete';
          }
          sectionNewPath = path;
          i++;
        } else if (sectionLine.startsWith('rename from ')) {
          const match2 = sectionLine.match(/^rename from (.*)$/);
          if (!match2) {
            parseError(i + 1);
          }
          sectionOldPath = match2[1].trim();
          i++;
        } else if (sectionLine.startsWith('rename to ')) {
          const match2 = sectionLine.match(/^rename to (.*)$/);
          if (!match2) {
            parseError(i + 1);
          }
          sectionNewPath = match2[1].trim();
          i++;
        } else if (sectionLine.startsWith('new file mode')) {
          sectionType = 'create';
          i++;
        } else if (sectionLine.startsWith('deleted file mode')) {
          sectionType = 'delete';
          i++;
        } else {
          i++;
        }
      }

      if (sectionOldPath === '/dev/null' || sectionType === 'create') {
        sectionType = 'create';
        sectionOldPath = '';
      }
      if (sectionNewPath === '/dev/null' || sectionType === 'delete') {
        sectionType = 'delete';
        sectionNewPath = '';
      }
      if (sectionOldPath !== sectionNewPath && sectionType !== 'create' && sectionType !== 'delete') {
        sectionType = 'move';
      }

      edits.push({ path: sectionOldPath || sectionNewPath, type: sectionType, oldPath: sectionOldPath, newPath: sectionNewPath, hunks });
    } else if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].trim().startsWith('+++ ')) {
      const match = lines[i].match(/^--- (.*)$/);
      if (!match) {
        parseError(i + 1);
      }
      const oldPath = match[1].replace(/^a\//, '').replace(/^b\//, '').split('\t')[0].trim();

      const match2 = lines[i + 1].match(/^\+\+\+ (.*)$/);
      if (!match2) {
        parseError(i + 2);
      }
      const newPath = match2[1].replace(/^a\//, '').replace(/^b\//, '').split('\t')[0].trim();

      let sectionOldPath = oldPath;
      let sectionNewPath = newPath;
      let sectionType: 'create' | 'delete' | 'move' | 'change' = 'change';
      const hunks: Hunk[] = [];

      i += 2;

      while (i < lines.length) {
        const sectionLine = lines[i];

        if (sectionLine.startsWith('diff --git ')) {
          break;
        }

        if (sectionLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].trim().startsWith('+++ ')) {
          break;
        }

        if (sectionLine.startsWith('@@')) {
          const hunkMatch = sectionLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (!hunkMatch) {
            parseError(i + 1);
          }

          const lineA = parseInt(hunkMatch[1], 10);
          const lineB = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
          const lineC = parseInt(hunkMatch[3], 10);
          const lineD = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;

          i++;
          const body: Array<{ type: 'context' | 'old' | 'new', text: string }> = [];
          let backslash = false;

          while (i < lines.length) {
            const hunkLine = lines[i];

            if (hunkLine.startsWith('diff --git ') || (hunkLine.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].trim().startsWith('+++ '))) {
              break;
            }

            if (hunkLine.startsWith('@@')) {
              break;
            }

            if (hunkLine.startsWith('--- ') || hunkLine.startsWith('+++ ')) {
              break;
            }

            if (hunkLine.startsWith(' ')) {
              body.push({ type: 'context', text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith('-')) {
              body.push({ type: 'old', text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith('+')) {
              body.push({ type: 'new', text: hunkLine.slice(1) });
            } else if (hunkLine.startsWith('\\')) {
              backslash = true;
            } else if (hunkLine === '') {
              body.push({ type: 'context', text: '' });
            } else {
              break;
            }

            i++;
          }

          while (hunks.length > 0 && hunks[hunks.length - 1].body.length === 0) {
            hunks.pop();
          }

          while (body.length > 0 && body[body.length - 1].type === 'context' && body[body.length - 1].text === '') {
            body.pop();
          }

          if (body.length > 0) {
            hunks.push({ body, backslash, lineA, lineC });
          }
        } else if (sectionLine.startsWith('--- ')) {
          const match3 = sectionLine.match(/^--- (.*)$/);
          if (!match3) {
            parseError(i + 1);
          }
          const path = match3[1].replace(/^a\//, '').replace(/^b\//, '').split('\t')[0].trim();
          if (path === '/dev/null') {
            sectionType = 'create';
          }
          sectionOldPath = path;
          i++;
        } else if (sectionLine.startsWith('+++ ')) {
          const match3 = sectionLine.match(/^\+\+\+ (.*)$/);
          if (!match3) {
            parseError(i + 1);
          }
          const path = match3[1].replace(/^a\//, '').replace(/^b\//, '').split('\t')[0].trim();
          if (path === '/dev/null') {
            sectionType = 'delete';
          }
          sectionNewPath = path;
          i++;
        } else if (sectionLine.startsWith('rename from ')) {
          const match3 = sectionLine.match(/^rename from (.*)$/);
          if (!match3) {
            parseError(i + 1);
          }
          sectionOldPath = match3[1].trim();
          i++;
        } else if (sectionLine.startsWith('rename to ')) {
          const match3 = sectionLine.match(/^rename to (.*)$/);
          if (!match3) {
            parseError(i + 1);
          }
          sectionNewPath = match3[1].trim();
          i++;
        } else if (sectionLine.startsWith('new file mode')) {
          sectionType = 'create';
          i++;
        } else if (sectionLine.startsWith('deleted file mode')) {
          sectionType = 'delete';
          i++;
        } else {
          i++;
        }
      }

      if (sectionOldPath === '/dev/null' || sectionType === 'create') {
        sectionType = 'create';
        sectionOldPath = '';
      }
      if (sectionNewPath === '/dev/null' || sectionType === 'delete') {
        sectionType = 'delete';
        sectionNewPath = '';
      }
      if (sectionOldPath !== sectionNewPath && sectionType !== 'create' && sectionType !== 'delete') {
        sectionType = 'move';
      }

      edits.push({ path: sectionOldPath || sectionNewPath, type: sectionType, oldPath: sectionOldPath, newPath: sectionNewPath, hunks });
    } else {
      i++;
    }
  }

  return edits;
}

function applyUnifiedEdit(
  edit: { path: string, type: 'create' | 'delete' | 'move' | 'change', oldPath: string, newPath: string, hunks: Hunk[] },
  files: FileTree,
  originalFiles: Record<string, string>,
  renames: Array<{ old: string, new: string }>,
  strict: boolean
): void {
  if (!isSafePath(edit.path)) {
    execError('unsafe', edit.path);
  }

  function extractOldLines(body: Array<{ type: 'context' | 'old' | 'new', text: string }>): string[] {
    return body.filter(l => l.type === 'old' || l.type === 'context').map(l => l.text);
  }

  function extractNewLines(body: Array<{ type: 'context' | 'old' | 'new', text: string }>): string[] {
    return body.filter(l => l.type === 'new' || l.type === 'context').map(l => l.text);
  }

  function extractOnlyOldLines(body: Array<{ type: 'context' | 'old' | 'new', text: string }>): string[] {
    return body.filter(l => l.type === 'old').map(l => l.text);
  }

  function extractOnlyNewLines(body: Array<{ type: 'context' | 'old' | 'new', text: string }>): string[] {
    return body.filter(l => l.type === 'new').map(l => l.text);
  }

  function applyHunkBody(
    currentLines: string[],
    body: Array<{ type: 'context' | 'old' | 'new', text: string }>,
    matchPos: number,
    oldLinesForReindent: string[],
    newLinesForReindent: string[],
    tier: number,
    strict: boolean
  ): { resultLines: string[], newOffset: number } {
    const result: string[] = [];

    const prefixLines = currentLines.slice(0, matchPos);
    result.push(...prefixLines);

    let fileIdx = matchPos;
    let newLineIdx = 0;

    for (const line of body) {
      if (line.type === 'context') {
        if (fileIdx < currentLines.length) {
          result.push(currentLines[fileIdx]);
          fileIdx++;
        } else {
          result.push(line.text);
        }
      } else if (line.type === 'old') {
        fileIdx++;
      } else if (line.type === 'new') {
        let newLine = newLinesForReindent[newLineIdx];
        if (!strict && tier === 2) {
          const sourceIndent = oldLinesForReindent[0]?.match(/^[\t ]*/)?.[0] || '';
          const targetIndent = currentLines[matchPos]?.match(/^[\t ]*/)?.[0] || '';
          if (newLine.startsWith(sourceIndent)) {
            newLine = targetIndent + newLine.slice(sourceIndent.length);
          }
        }
        result.push(newLine);
        newLineIdx++;
      }
    }

    const remainingLines = currentLines.slice(fileIdx);
    result.push(...remainingLines);
    return { resultLines: result, newOffset: result.length - currentLines.length };
  }

  function processHunks(
    fileLines: string[],
    endsWithBreak: boolean,
    lineBreak: '\n' | '\r\n',
    hunks: Array<{ body: Array<{ type: 'context' | 'old' | 'new', text: string }>, backslash: boolean, lineA: number, lineC: number }>,
    strict: boolean,
    path: string
  ): { lines: string[], endsWithBreak: boolean } {
    let currentLines = fileLines;
    let currentEndsWithBreak = endsWithBreak;
    let offset = 0;

    for (const hunk of hunks) {
      const body = hunk.body;
      const oldLines = extractOldLines(body);
      const newLines = extractNewLines(body);
      const onlyOldLines = extractOnlyOldLines(body);
      const onlyNewLines = extractOnlyNewLines(body);

      if (oldLines.length > 0) {
        const match = findBestMatch(currentLines, oldLines, strict, hunk.lineA - 1 + offset);
        if (match === null) {
          execError('no-match', path);
        }

        const matchPos = match.position;
        const applied = applyHunkBody(currentLines, body, matchPos, onlyOldLines, onlyNewLines, match.tier, strict);
        currentLines = applied.resultLines;
        offset += applied.newOffset;
      } else {
        const insertPos = Math.min(hunk.lineC - 1 + offset, currentLines.length);
        const insertResult: string[] = [];
        for (let j = 0; j < onlyNewLines.length; j++) {
          insertResult.push(onlyNewLines[j]);
        }
        currentLines = currentLines.slice(0, insertPos).concat(insertResult, currentLines.slice(insertPos));
        offset += onlyNewLines.length;
      }

      if (hunk.backslash && (oldLines.length > 0 || onlyNewLines.length > 0)) {
        currentEndsWithBreak = false;
      }
    }

    return { lines: currentLines, endsWithBreak: currentEndsWithBreak };
  }

  switch (edit.type) {
    case 'create':
      if (files[edit.newPath] !== undefined) {
        execError('exists', edit.newPath);
      }
      const createLines: string[] = [];
      for (const hunk of edit.hunks) {
        const newLines = extractNewLines(hunk.body);
        createLines.push(...newLines);
      }
      files[edit.newPath] = createLines.join('\n') + '\n';
      break;

    case 'delete':
      if (files[edit.oldPath] === undefined) {
        execError('missing', edit.oldPath);
      }
      files[edit.oldPath] = null;
      break;

    case 'move':
      if (files[edit.oldPath] === undefined) {
        execError('missing', edit.oldPath);
      }
      if (files[edit.newPath] !== undefined) {
        execError('exists', edit.newPath);
      }

      const fileData = readFileLines(edit.oldPath);
      if (fileData === null) {
        execError('missing', edit.oldPath);
      }

      const moveResult = processHunks(fileData.lines, fileData.endsWithBreak, fileData.lineBreak, edit.hunks, strict, edit.oldPath);
      const newContent = moveResult.lines.join(fileData.lineBreak) + (moveResult.endsWithBreak ? fileData.lineBreak : '');
      files[edit.newPath] = newContent;
      files[edit.oldPath] = null;
      renames.push({ old: edit.oldPath, new: edit.newPath });
      break;

    case 'change':
      if (files[edit.path] === undefined) {
        execError('missing', edit.path);
      }

      const fileData2 = readFileLines(edit.path);
      if (fileData2 === null) {
        execError('missing', edit.path);
      }

      const changeResult = processHunks(fileData2.lines, fileData2.endsWithBreak, fileData2.lineBreak, edit.hunks, strict, edit.path);
      files[edit.path] = changeResult.lines.join(fileData2.lineBreak) + (changeResult.endsWithBreak ? fileData2.lineBreak : '');
      break;
  }
}

function parseSearchReplaceBlocks(lines: string[]): Array<{ path: string, oldLines: string[], newLines: string[], searchLine: number }> {
  const blocks: Array<{ path: string, oldLines: string[], newLines: string[], searchLine: number }> = [];

  let lastReplaceLine = -1;
  let lastPath = '';

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;

      let path = '';
      for (let j = i - 1; j > lastReplaceLine; j--) {
        const line = lines[j].trim();
        if (line !== '' && !line.startsWith('```')) {
          path = lines[j].trim();
          break;
        }
      }

      if (path === '' && blocks.length > 0) {
        path = lastPath;
      }

      if (path === '') {
        parseError(i + 1);
      }

      i++;
      const oldLines: string[] = [];
      while (i < lines.length && lines[i].trimEnd() !== '=======') {
        oldLines.push(lines[i]);
        i++;
      }

      if (i >= lines.length) {
        parseError(searchLine + 1);
      }

      i++;
      const newLines: string[] = [];
      while (i < lines.length && lines[i].trimEnd() !== '>>>>>>> REPLACE') {
        newLines.push(lines[i]);
        i++;
      }

      if (i >= lines.length) {
        parseError(searchLine + 1);
      }

      blocks.push({ path, oldLines, newLines, searchLine });
      lastPath = path;
      lastReplaceLine = i;
      i++;
    } else {
      i++;
    }
  }

  return blocks;
}

function applySearchReplaceEdit(
  edit: { path: string, oldLines: string[], newLines: string[], searchLine: number },
  files: FileTree,
  strict: boolean
): void {
  if (!isSafePath(edit.path)) {
    execError('unsafe', edit.path);
  }

  if (edit.oldLines.length === 0) {
    if (files[edit.path] !== undefined) {
      execError('exists', edit.path);
    }
    files[edit.path] = edit.newLines.join('\n') + '\n';
    return;
  }

  const fileData = readFileFromFiles(edit.path, files);
  if (fileData === null) {
    execError('missing', edit.path);
  }

  const fileLines = fileData.lines;

  const maxTier = strict ? 0 : 2;
  let matches: { tier: number, position: number }[] = [];

  for (let t = 0; t <= maxTier; t++) {
    matches = [];
    for (let i = 0; i <= fileLines.length - edit.oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < edit.oldLines.length; j++) {
        let fileLine = fileLines[i + j];
        let oldLine = edit.oldLines[j];

        if (t === 0) {
          if (fileLine !== oldLine) {
            match = false;
            break;
          }
        } else if (t === 1) {
          if (stripTrailingWhitespace(fileLine) !== stripTrailingWhitespace(oldLine)) {
            match = false;
            break;
          }
        } else if (t === 2) {
          if (stripLeadingAndTrailingWhitespace(fileLine) !== stripLeadingAndTrailingWhitespace(oldLine)) {
            match = false;
            break;
          }
        }
      }

      if (match) {
        matches.push({ tier: t, position: i });
      }
    }

    if (matches.length > 0) {
      break;
    }
  }

  if (matches.length === 0) {
    execError('no-match', edit.path);
  }

  if (matches.length > 1) {
    execError('ambiguous', edit.path);
  }

  const matchPos = matches[0].position;
  let appliedNewLines: string[];

  if (strict || matches[0].tier <= 1) {
    appliedNewLines = [...edit.newLines];
  } else {
    appliedNewLines = applyReindentation(edit.newLines, fileLines, matchPos, edit.oldLines);
  }

  const newFileLines = fileLines.slice(0, matchPos).concat(appliedNewLines, fileLines.slice(matchPos + edit.oldLines.length));
  files[edit.path] = newFileLines.join(fileData.lineBreak) + (fileData.endsWithBreak ? fileData.lineBreak : '');
}

function parseV4ASections(lines: string[]): Array<{ type: 'add' | 'delete' | 'update', path: string, moveTo?: string, chunks: Array<{ anchor: string, context: string[], old: string[], new: string[], isEndOfFile: boolean }> }> {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstNonBlank = i;
      break;
    }
  }

  if (firstNonBlank === -1 || lines[firstNonBlank].trim() !== '*** Begin Patch') {
    parseError(firstNonBlank === -1 ? 1 : firstNonBlank + 1);
  }

  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      lastNonBlank = i;
      break;
    }
  }

  if (lastNonBlank === -1 || lines[lastNonBlank].trim() !== '*** End Patch') {
    parseError(lines.length + 1);
  }

  const sections: Array<{ type: 'add' | 'delete' | 'update', path: string, moveTo?: string, chunks: Array<{ anchor: string, context: string[], old: string[], new: string[], isEndOfFile: boolean }> }> = [];

  let i = firstNonBlank + 1;
  while (i <= lastNonBlank) {
    const line = lines[i].trim();

    if (line === '') {
      i++;
      continue;
    }

    if (line === '*** End Patch') {
      break;
    }

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      if (!isSafePath(path)) {
        execError('unsafe', path);
      }

      i++;
      const fileLines: string[] = [];
      while (i <= lastNonBlank) {
        const sectionLine = lines[i];
        if (sectionLine.trim() === '' && (i + 1 > lastNonBlank || lines[i + 1].trim().startsWith('*** '))) {
          break;
        }
        if (sectionLine.startsWith('*** ')) {
          break;
        }
        if (sectionLine.startsWith('+')) {
          fileLines.push(sectionLine.slice(1));
        } else if (sectionLine === '') {
          fileLines.push('');
        } else {
          parseError(i + 1);
        }
        i++;
      }

      sections.push({ type: 'add', path, chunks: [], fileLines });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      if (!isSafePath(path)) {
        execError('unsafe', path);
      }

      sections.push({ type: 'delete', path, chunks: [] });
      i++;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      if (!isSafePath(path)) {
        execError('unsafe', path);
      }

      i++;
      let moveTo: string | undefined;
      const chunks: Array<{ anchor: string, context: string[], old: string[], new: string[], isEndOfFile: boolean }> = [];

      while (i <= lastNonBlank) {
        const rawLine = lines[i];
        const sectionLine = rawLine.trim();

        if (sectionLine === '' && !rawLine.startsWith(' ') && !rawLine.startsWith('-') && !rawLine.startsWith('+')) {
          i++;
          continue;
        }

        if (sectionLine.startsWith('*** Move to: ')) {
          moveTo = sectionLine.slice(13).trim();
          if (!isSafePath(moveTo)) {
            execError('unsafe', moveTo);
          }
          i++;
          continue;
        }

        if (sectionLine.startsWith('*** ')) {
          break;
        }

        if (sectionLine.startsWith('@@')) {
          const anchor = sectionLine.slice(2).trim();
          i++;

          const context: string[] = [];
          const oldLines: string[] = [];
          const newLines: string[] = [];

          while (i <= lastNonBlank) {
            const chunkLine = lines[i];
            const trimmed = chunkLine.trim();

            if (trimmed === '*** End of File') {
              i++;
              chunks.push({ anchor, context, old: oldLines, new: newLines, isEndOfFile: true });
              break;
            }

            if (trimmed.startsWith('*** ')) {
              break;
            }

            if (chunkLine.startsWith(' ')) {
              context.push(chunkLine.slice(1));
              oldLines.push(chunkLine.slice(1));
              newLines.push(chunkLine.slice(1));
            } else if (chunkLine.startsWith('-')) {
              oldLines.push(chunkLine.slice(1));
            } else if (chunkLine.startsWith('+')) {
              newLines.push(chunkLine.slice(1));
            } else if (chunkLine === '') {
              context.push('');
              oldLines.push('');
              newLines.push('');
            } else {
              break;
            }

            i++;
          }

          while (context.length > 0 && context[context.length - 1] === '') {
            context.pop();
            if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
            if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
          }

          if (anchor === '' && context.length === 1 && context[0] !== '') {
            anchor = context[0];
            context.shift();
            if (oldLines.length > 0) oldLines.shift();
            if (newLines.length > 0) newLines.shift();
          }

          if (chunks.length === 0 || !chunks[chunks.length - 1].isEndOfFile) {
            chunks.push({ anchor, context, old: oldLines, new: newLines, isEndOfFile: false });
          }
        } else {
          let anchor = '';
          const context: string[] = [];
          const oldLines: string[] = [];
          const newLines: string[] = [];

          while (i <= lastNonBlank) {
            const chunkLine = lines[i];
            const trimmed = chunkLine.trim();

            if (trimmed === '*** End of File') {
              i++;
              chunks.push({ anchor: '', context, old: oldLines, new: newLines, isEndOfFile: true });
              break;
            }

            if (trimmed.startsWith('*** ')) {
              break;
            }

            if (chunkLine.startsWith(' ')) {
              context.push(chunkLine.slice(1));
              oldLines.push(chunkLine.slice(1));
              newLines.push(chunkLine.slice(1));
            } else if (chunkLine.startsWith('-')) {
              oldLines.push(chunkLine.slice(1));
            } else if (chunkLine.startsWith('+')) {
              newLines.push(chunkLine.slice(1));
            } else if (chunkLine === '') {
              context.push('');
              oldLines.push('');
              newLines.push('');
            } else {
              break;
            }

            i++;
          }

          while (context.length > 0 && context[context.length - 1] === '') {
            context.pop();
            if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
            if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
          }

          if (context.length === 1 && context[0] !== '') {
            anchor = context[0];
            context.shift();
            if (oldLines.length > 0) oldLines.shift();
            if (newLines.length > 0) newLines.shift();
          }

          if (chunks.length === 0 || !chunks[chunks.length - 1].isEndOfFile) {
            chunks.push({ anchor, context, old: oldLines, new: newLines, isEndOfFile: false });
          }
        }
      }

      if (chunks.length === 0 && !moveTo) {
        parseError(i - chunks.length);
      }

      sections.push({ type: 'update', path, moveTo, chunks });
    } else {
      parseError(i + 1);
    }
  }

  return sections;
}

function applyV4AEdit(
  edit: { type: 'add' | 'delete' | 'update', path: string, moveTo?: string, chunks: Array<{ anchor: string, context: string[], old: string[], new: string[], isEndOfFile: boolean }> },
  files: FileTree,
  strict: boolean,
  renames: Array<{ old: string, new: string }>
): void {
  if (!isSafePath(edit.path)) {
    execError('unsafe', edit.path);
  }

  switch (edit.type) {
    case 'add':
      if (files[edit.path] !== undefined) {
        execError('exists', edit.path);
      }
      files[edit.path] = (edit.fileLines || []).join('\n') + '\n';
      break;

    case 'delete':
      if (files[edit.path] === undefined) {
        execError('missing', edit.path);
      }
      files[edit.path] = null;
      break;

    case 'update':
      if (files[edit.path] === undefined) {
        execError('missing', edit.path);
      }

      if (edit.moveTo) {
        if (!isSafePath(edit.moveTo)) {
          execError('unsafe', edit.moveTo);
        }
        if (files[edit.moveTo] !== undefined) {
          execError('exists', edit.moveTo);
        }
      }

      const fileData = readFileLines(edit.path);
      if (fileData === null) {
        execError('missing', edit.path);
      }

      let currentLines = fileData.lines;
      let currentEndsWithBreak = fileData.endsWithBreak;
      let cursor = 0;

      for (const chunk of edit.chunks) {
        if (chunk.anchor !== '') {
          const anchorLine = chunk.anchor;
          let found = false;

          for (let i = cursor; i < currentLines.length; i++) {
            let match = false;
            if (strict) {
              match = currentLines[i] === anchorLine;
            } else if (stripTrailingWhitespace(currentLines[i]) === stripTrailingWhitespace(anchorLine)) {
              match = true;
            } else if (stripLeadingAndTrailingWhitespace(currentLines[i]) === stripLeadingAndTrailingWhitespace(anchorLine)) {
              match = true;
            }

            if (match) {
              cursor = i + 1;
              found = true;
              break;
            }
          }

          if (!found) {
            execError('no-match', edit.path);
          }
        }

        const oldLines = chunk.old;
        const newLines = chunk.new;

        if (oldLines.length > 0) {
          const maxTier = strict ? 0 : 2;
          let matchFound = false;

          for (let t = 0; t <= maxTier; t++) {
            for (let i = cursor; i <= currentLines.length - oldLines.length; i++) {
              let match = true;
              for (let j = 0; j < oldLines.length; j++) {
                let fileLine = currentLines[i + j];
                let oldLine = oldLines[j];

                if (t === 0) {
                  if (fileLine !== oldLine) {
                    match = false;
                    break;
                  }
                } else if (t === 1) {
                  if (stripTrailingWhitespace(fileLine) !== stripTrailingWhitespace(oldLine)) {
                    match = false;
                    break;
                  }
                } else if (t === 2) {
                  if (stripLeadingAndTrailingWhitespace(fileLine) !== stripLeadingAndTrailingWhitespace(oldLine)) {
                    match = false;
                    break;
                  }
                }
              }

              if (match) {
                if (chunk.isEndOfFile && i + oldLines.length !== currentLines.length) {
                  continue;
                }

                const contextLines = chunk.context;
                const newLinesFromPatch = chunk.new;

                const contextPositionsInOld: number[] = [];
                let contextIdx = 0;
                for (let j = 0; j < chunk.old.length; j++) {
                  if (contextIdx < contextLines.length && stripTrailingWhitespace(chunk.old[j]) === stripTrailingWhitespace(contextLines[contextIdx])) {
                    contextPositionsInOld.push(j);
                    contextIdx++;
                  }
                }

                let appliedNewLines: string[] = [];

                if (strict || t <= 1) {
                  contextIdx = 0;
                  for (const newLine of newLinesFromPatch) {
                    if (contextIdx < contextLines.length && stripTrailingWhitespace(newLine) === stripTrailingWhitespace(contextLines[contextIdx])) {
                      const oldPos = contextPositionsInOld[contextIdx];
                      appliedNewLines.push(currentLines[i + oldPos]);
                      contextIdx++;
                    } else {
                      appliedNewLines.push(newLine);
                    }
                  }
                } else {
                  const firstFileLine = currentLines[i];
                  const firstOldLine = oldLines[0];
                  const F = firstFileLine.match(/^[\t ]*/)?.[0] || '';
                  const P = firstOldLine.match(/^[\t ]*/)?.[0] || '';

                  contextIdx = 0;
                  for (const newLine of newLinesFromPatch) {
                    if (contextIdx < contextLines.length && stripTrailingWhitespace(newLine) === stripTrailingWhitespace(contextLines[contextIdx])) {
                      const oldPos = contextPositionsInOld[contextIdx];
                      appliedNewLines.push(currentLines[i + oldPos]);
                      contextIdx++;
                    } else {
                      const trimmed = newLine.trim();
                      if (trimmed !== '' && !newLine.startsWith(P)) {
                        appliedNewLines.push(newLine);
                      } else {
                        const rest = newLine.slice(P.length);
                        appliedNewLines.push(F + rest);
                      }
                    }
                  }
                }

                const restLines = currentLines.slice(i + oldLines.length);
                currentLines = currentLines.slice(0, i).concat(appliedNewLines, restLines);
                cursor = i + appliedNewLines.length;
                matchFound = true;
                break;
              }
            }

            if (matchFound) break;
          }

          if (!matchFound) {
            execError('no-match', edit.path);
          }
        } else {
          if (chunk.isEndOfFile) {
            currentLines = currentLines.concat(newLines);
            cursor = currentLines.length;
          } else {
            currentLines = currentLines.slice(0, cursor).concat(newLines, currentLines.slice(cursor));
            cursor += newLines.length;
          }
        }

        if (chunk.isEndOfFile) {
          cursor = currentLines.length;
        }
      }

      if (edit.moveTo) {
        files[edit.moveTo] = currentLines.join(fileData.lineBreak) + (currentEndsWithBreak ? fileData.lineBreak : '');
        files[edit.path] = null;
        renames.push({ old: edit.path, new: edit.moveTo });
      } else {
        files[edit.path] = currentLines.join(fileData.lineBreak) + (currentEndsWithBreak ? fileData.lineBreak : '');
      }
      break;
  }
}

function parseJSONEdits(lines: string[]): Array<{ path: string, command: string, fileText?: string, oldStr?: string, newStr?: string, insertLine?: number }> {
  const patch = lines.join('\n').trim();

  if (patch.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(patch);
    } catch {
      parseError(1);
    }

    if (!Array.isArray(parsed)) {
      parseError(1);
    }

    const edits: Array<{ path: string, command: string, fileText?: string, oldStr?: string, newStr?: string, insertLine?: number }> = [];

    for (const item of parsed) {
      if (typeof item !== 'object' || item === null || !item.path || !item.command) {
        parseError(1);
      }

      if (item.command === 'create') {
        if (typeof item.file_text !== 'string') {
          parseError(1);
        }
        edits.push({ path: item.path, command: 'create', fileText: item.file_text });
      } else if (item.command === 'str_replace') {
        if (typeof item.old_str !== 'string' || item.old_str === '') {
          parseError(1);
        }
        const newStr = item.new_str ?? '';
        if (typeof newStr !== 'string') {
          parseError(1);
        }
        edits.push({ path: item.path, command: 'str_replace', oldStr: item.old_str, newStr });
      } else if (item.command === 'insert') {
        if (typeof item.insert_line !== 'number' || !Number.isInteger(item.insert_line) || item.insert_line < 0) {
          parseError(1);
        }
        const newStr = item.new_str ?? '';
        if (typeof newStr !== 'string') {
          parseError(1);
        }
        edits.push({ path: item.path, command: 'insert', newStr, insertLine: item.insert_line });
      } else {
        parseError(1);
      }
    }

    return edits;
  } else {
    const edits: Array<{ path: string, command: string, fileText?: string, oldStr?: string, newStr?: string, insertLine?: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parseError(i + 1);
      }

      if (typeof parsed !== 'object' || parsed === null || !parsed.path || !parsed.command) {
        parseError(i + 1);
      }

      if (parsed.command === 'create') {
        if (typeof parsed.file_text !== 'string') {
          parseError(i + 1);
        }
        edits.push({ path: parsed.path, command: 'create', fileText: parsed.file_text });
      } else if (parsed.command === 'str_replace') {
        if (typeof parsed.old_str !== 'string' || parsed.old_str === '') {
          parseError(i + 1);
        }
        const newStr = parsed.new_str ?? '';
        if (typeof newStr !== 'string') {
          parseError(i + 1);
        }
        edits.push({ path: parsed.path, command: 'str_replace', oldStr: parsed.old_str, newStr });
      } else if (parsed.command === 'insert') {
        if (typeof parsed.insert_line !== 'number' || !Number.isInteger(parsed.insert_line) || parsed.insert_line < 0) {
          parseError(i + 1);
        }
        const newStr = parsed.new_str ?? '';
        if (typeof newStr !== 'string') {
          parseError(i + 1);
        }
        edits.push({ path: parsed.path, command: 'insert', newStr, insertLine: parsed.insert_line });
      } else {
        parseError(i + 1);
      }
    }

    return edits;
  }
}

function applyJSONEdit(
  edit: { path: string, command: string, fileText?: string, oldStr?: string, newStr?: string, insertLine?: number },
  files: FileTree
): void {
  if (!isSafePath(edit.path)) {
    execError('unsafe', edit.path);
  }

  switch (edit.command) {
    case 'create':
      if (files[edit.path] !== undefined) {
        execError('exists', edit.path);
      }
      files[edit.path] = edit.fileText!;
      break;

    case 'str_replace':
      if (files[edit.path] === undefined) {
        execError('missing', edit.path);
      }

      const fileData = readFileLines(edit.path);
      if (fileData === null) {
        execError('missing', edit.path);
      }

      let content = fileData.lines.join(fileData.lineBreak);
      if (fileData.endsWithBreak) {
        content += fileData.lineBreak;
      }

      const oldStr = edit.oldStr!;
      const newStr = edit.newStr!;

      if (fileData.lineBreak === '\r\n') {
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const normalizedOldStr = oldStr.replace(/\r\n/g, '\n');
        const normalizedNewStr = newStr.replace(/\r\n/g, '\n');

        const index = normalizedContent.indexOf(normalizedOldStr);
        if (index === -1) {
          execError('no-match', edit.path);
        }

        const lastIndex = normalizedContent.lastIndexOf(normalizedOldStr);
        if (index !== lastIndex) {
          execError('ambiguous', edit.path);
        }

        const result = normalizedContent.slice(0, index) + normalizedNewStr + normalizedContent.slice(index + normalizedOldStr.length);
        files[edit.path] = result.replace(/\n/g, '\r\n');
      } else {
        const index = content.indexOf(oldStr);
        if (index === -1) {
          execError('no-match', edit.path);
        }

        const lastIndex = content.lastIndexOf(oldStr);
        if (index !== lastIndex) {
          execError('ambiguous', edit.path);
        }

        const result = content.slice(0, index) + newStr + content.slice(index + oldStr.length);
        files[edit.path] = result;
      }
      break;

    case 'insert':
      if (files[edit.path] === undefined) {
        execError('missing', edit.path);
      }

      const fileData2 = readFileLines(edit.path);
      if (fileData2 === null) {
        execError('missing', edit.path);
      }

      const insertLine = edit.insertLine!;
      if (insertLine < 0 || insertLine > fileData2.lines.length) {
        execError('no-match', edit.path);
      }

      const newLines = edit.newStr!.replace(/\r\n/g, '\n').split('\n');
      if (newLines.length > 0 && newLines[newLines.length - 1] === '') {
        newLines.pop();
      }
      if (newLines.length === 0) {
        // empty string
      } else {
        fileData2.lines.splice(insertLine, 0, ...newLines);
      }

      files[edit.path] = fileData2.lines.join(fileData2.lineBreak) + (fileData2.endsWithBreak ? fileData2.lineBreak : '');
      break;

    default:
      parseError(1);
  }
}

main();