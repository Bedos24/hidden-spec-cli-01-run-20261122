// main.ts is mend, the CLI SPEC.md specifies: it applies an AI-written edit, in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls), to a tree of text files, writing every
// change or none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  moves: Array<[string, string]> = [];
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

// ---- Section 5: matching lines, and the file line model (section 3). ----

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** All 0-based positions at which O occurs in lines at this tier, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences; null when none.
 *  Tiers are tried in order, exact first: tier 0 exact lines, tier 1 trailing whitespace ignored,
 *  tier 2 leading and trailing whitespace ignored. The first tier with any occurrence wins, even
 *  when a later tier would match nearer the hunk's line number. */
function firstTier(lines: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, final: fin };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a hunk/chunk body: ctx (context), old (`-`), new (`+`). `noEol` is set when a `\` line
 *  follows it; `empty` marks a body line that was empty in the patch (a trailing one is not part of
 *  a unified hunk's body). */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
  empty: boolean;
}

const item = (kind: 'ctx' | 'old' | 'new', text: string, empty = false): BodyItem => ({ kind, text, noEol: false, empty });

/** The lines that replace a matched region: context lines are the file's own matched lines, other
 *  lines are re-indented at tier 2 (section 5). `items` is the hunk/chunk body in order. */
function applyItems(items: BodyItem[], fileLines: string[], at: number, tier: number): string[] {
  const O = items.filter((i) => i.kind !== 'new').map((i) => i.text);
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const F = O.length > 0 ? leadingWs(fileLines[at]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else if (it.kind === 'old') {
      oi += 1;
    } else if (tier === 2 && it.text.trim() !== '' && it.text.startsWith(P)) {
      out.push(F + it.text.slice(P.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/** Whether the last context or new line of the body (per `kinds`) is followed by a `\` line,
 *  i.e. the file must not end with a line break when the edit reaches the end of the file. */
function lastNoEol(items: BodyItem[], kinds: Array<'ctx' | 'new'>): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    if (kinds.includes(items[i]!.kind as 'ctx' | 'new')) return items[i]!.noEol;
  }
  return false;
}

const lastCtxOrNewNoEol = (items: BodyItem[]): boolean => lastNoEol(items, ['ctx', 'new']);
const lastNewNoEol = (items: BodyItem[]): boolean => lastNoEol(items, ['new']);

// ---- Section 6: unified diffs. ----

interface Hunk {
  A: number;
  items: BodyItem[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  headerHasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function freshSection(): Section {
  return {
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    headerHasPair: false,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDel: false,
    hunks: [],
  };
}

/** The path a `--- ` / `+++ ` header line names, or null for /dev/null. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The occurrence nearest to `target`; of two equally near, the earlier one. */
function nearestTo(occ: number[], target: number): number {
  let at = occ[0]!;
  let best = Math.abs(at - target);
  for (const o of occ) {
    const dist = Math.abs(o - target);
    if (dist < best) {
      best = dist;
      at = o;
    }
  }
  return at;
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const O = h.items.filter((i) => i.kind !== 'new').map((i) => i.text);
    if (O.length === 0) {
      const idx = Math.max(0, Math.min(h.A + d, f.lines.length));
      const atEnd = idx === f.lines.length;
      const news = h.items.filter((i) => i.kind === 'new').map((i) => i.text);
      f.lines.splice(idx, 0, ...news);
      if (atEnd) f.final = !lastNewNoEol(h.items);
      d += news.length;
    } else {
      const found = firstTier(f.lines, O, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const at = nearestTo(found.occ, h.A - 1 + d);
      const toEnd = at + O.length === f.lines.length;
      const rep = applyItems(h.items, f.lines, at, found.tier);
      f.lines.splice(at, O.length, ...rep);
      if (toEnd) f.final = !lastCtxOrNewNoEol(h.items);
      d += rep.length - O.length;
    }
  }
  return joinFile(f);
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.headerHasPair ? sec.pairOld : sec.renameFrom ?? sec.diffOld;
  const newP = sec.headerHasPair ? sec.pairNew : sec.renameTo ?? sec.diffNew;
  const isCreation = oldP === null || sec.isNew;
  const isDeletion = !isCreation && (newP === null || sec.isDel);
  const isMove = !isCreation && !isDeletion && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreation) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            noEol = it.noEol;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const p = oldP as string;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const from = oldP as string;
      const to = newP as string;
      const curText = tree.get(from);
      if (curText === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const out = applyHunks(curText, sec.hunks, strict, from);
      tree.now.set(to, out);
      tree.now.set(from, null);
      tree.moves.push([from, to]);
      return;
    }
    const p = oldP as string;
    const curText = tree.get(p);
    if (curText === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(curText, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  const pushSection = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const finishHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.empty) hunk.items.pop();
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunk !== null) {
      const nextPlus = i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
      if (line.startsWith('--- ') && nextPlus) {
        finishHunk();
      } else if (line.startsWith('diff --git ')) {
        finishHunk();
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line === '') hunk.items.push(item('ctx', '', true));
        else if (line[0] === ' ') hunk.items.push(item('ctx', line.slice(1)));
        else if (line[0] === '-') hunk.items.push(item('old', line.slice(1)));
        else if (line[0] === '+') hunk.items.push(item('new', line.slice(1)));
        else if (hunk.items.length > 0) hunk.items[hunk.items.length - 1]!.noEol = true;
        continue;
      } else {
        finishHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      pushSection();
      cur = freshSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
        if (cur === null || cur.headerHasPair || cur.hunks.length > 0) {
          pushSection();
          cur = freshSection();
        }
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(lines[i + 1]!);
        cur.headerHasPair = true;
        i += 1;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: parseInt(m[1]!, 10), items: [] };
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
    }
  }
  finishHunk();
  pushSection();
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks. ----

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = firstTier(f.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const items: BodyItem[] = [
      ...oldLines.map((t) => item('old', t)),
      ...newLines.map((t) => item('new', t)),
    ];
    const rep = applyItems(items, f.lines, found.occ[0]!, found.tier);
    f.lines.splice(found.occ[0]!, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplace; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(makeSREdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches. ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function applyV4aChunks(text: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const found = firstTier(f.lines, [ch.anchor], cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.occ[0]! + 1;
    }
    const O = ch.items.filter((i) => i.kind !== 'new').map((i) => i.text);
    if (O.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      const news = ch.items.filter((i) => i.kind === 'new').map((i) => i.text);
      f.lines.splice(at, 0, ...news);
      cursor = at + news.length;
    } else {
      const found = firstTier(f.lines, O, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let occ = found.occ;
      if (ch.eof) occ = occ.filter((o) => o + O.length === f.lines.length);
      if (occ.length === 0) throw new Fail('no-match', path);
      const at = occ[0]!;
      const rep = applyItems(ch.items, f.lines, at, found.tier);
      f.lines.splice(at, O.length, ...rep);
      cursor = at + rep.length;
    }
  }
  return joinFile(f);
}

function makeV4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const out = applyV4aChunks(cur, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    let j = i + 1;
    while (j < last && !isV4aSectionStart(lines[j]!)) j += 1;
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    const start = i + 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = start; k < end; k++) {
        const l = lines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(makeV4aAdd(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = start; k < end; k++) {
        if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push(makeV4aDelete(path));
    } else {
      let k = start;
      let moveTo: string | null = null;
      if (k < end && lines[k]!.startsWith('*** Move to: ')) {
        moveTo = lines[k]!.slice(13).trim();
        k += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (k < end) {
        const l = lines[k]!;
        const num = k + 1;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          firstChunk = false;
          k += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          k += 1;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${num}`);
        if (cur === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${num}`);
          cur = { anchor: null, eof: false, items: [] };
        }
        if (l === '') cur.items.push(item('ctx', '', true));
        else if (l[0] === ' ') cur.items.push(item('ctx', l.slice(1)));
        else if (l[0] === '-') cur.items.push(item('old', l.slice(1)));
        else if (l[0] === '+') cur.items.push(item('new', l.slice(1)));
        else throw new Exit2(`error: parse ${num}`);
        k += 1;
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

// ---- Section 10: order, atomicity, output. ----

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
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
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      consumed.add(from);
      consumed.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
