// CI gate 1 `paths` (02-TRD §15): path ownership + CR-reference check; also generates .github/CODEOWNERS.
// Usage:
//   node tools/lint/check-paths.ts --branch <HEAD_REF> --files <changed-paths.txt> --body <pr-body.txt>
//   node tools/lint/check-paths.ts --codeowners-out <file>
// Exit 0 pass, 1 gate failure, 2 bad usage / unreadable input / unknown branch (fail closed).
// Rules: tools/lint/ownership.yaml (most specific pattern wins: longest literal prefix, then longest pattern).
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

type Rule = { pattern: string; owner: string; re: RegExp; key: [number, number] };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACT = [/^db\//, /^contracts\//, /^packages\//, /(^|\/)core\//]; // TRD §15 gate 1
const REFS = /^Refs:[ \t]*CR-C\d+-\d{3}(?:[ \t,]+CR-C\d+-\d{3})*[ \t,]*$/m;

class Usage extends Error {}

function toRegex(pat: string): RegExp {
  let p = pat.replace(/^\//, '');
  if (p.endsWith('/')) p += '**';
  if (/[{}<>]/.test(p)) throw new Usage(`unsupported glob syntax in ownership.yaml: ${pat}`); // CODEOWNERS cannot express it
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function specificity(pat: string): [number, number] {
  const p = pat.replace(/^\//, '');
  const k = p.search(/[*?]/);
  return [k < 0 ? p.length + 1000 : k, p.length];
}

function loadRules(): Rule[] {
  const rules: Rule[] = [];
  let cur: Partial<Rule> | null = null;
  const unq = (s: string) => s.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  for (const raw of readFileSync(ROOT + 'tools/lint/ownership.yaml', 'utf8').split(/\r?\n/)) {
    let line = raw;
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^\s*-\s/.test(line)) { cur = {}; rules.push(cur as Rule); line = line.replace(/^(\s*)-\s/, '$1  '); }
    const m = line.match(/^\s*(pattern|owner)\s*:\s*(.+)$/);
    if (m && cur) cur[m[1] as 'pattern' | 'owner'] = unq(m[2]);
  }
  for (const r of rules) {
    if (!r.pattern || !r.owner) throw new Usage('ownership.yaml: rule without pattern/owner');
    r.re = toRegex(r.pattern);
    r.key = specificity(r.pattern);
  }
  return rules;
}

const cmp = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];

// Returns owner, or null (gap / ambiguous).
function ownerOf(rules: Rule[], path: string): string | null {
  const hits = rules.filter((r) => r.re.test(path));
  if (!hits.length) return null;
  const best = hits.reduce((a, r) => (cmp(r.key, a.key) > 0 ? r : a));
  const owners = new Set(hits.filter((r) => cmp(r.key, best.key) === 0).map((r) => r.owner));
  return owners.size === 1 ? best.owner : null;
}

// `c<NN>/<topic>` -> C<N>; `c00-0[a-d]/<topic>` -> C0-0A..D. Anything else: null.
function branchOwner(branch: string): string | null {
  const m = branch.match(/^c(\d{2})(?:-0([a-d]))?\/([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)$/);
  if (!m || m[3].split('/').some((s) => s.startsWith('.'))) return null;
  const n = Number(m[1]);
  if (n === 0) return m[2] ? `C0-0${m[2].toUpperCase()}` : null;
  return m[2] ? null : `C${n}`;
}

// Normalise to repo-relative posix; null if it escapes the repo.
function normalise(p: string): string | null {
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n.startsWith('/') || n === '..' || n.startsWith('../') || /^[a-zA-Z]:/.test(n)) return null;
  return n.replace(/^\.\//, '');
}

function gate(branch: string, filesFile: string, bodyFile: string): number {
  const rules = loadRules();
  const me = branchOwner(branch);
  if (!me || !rules.some((r) => r.owner === me)) throw new Usage(`branch "${branch}" has no owning chunk (expected c<NN>/<topic> or c00-0<a-d>/<topic>)`);
  const files = readFileSync(filesFile, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '');
  const body = readFileSync(bodyFile, 'utf8').replace(/\r\n?/g, '\n');
  const errors: string[] = [];
  let contract = false;
  for (const raw of files) {
    const p = normalise(raw);
    if (p === null) { errors.push(`path outside repo: ${JSON.stringify(raw)}`); continue; }
    const owner = ownerOf(rules, p);
    if (owner === null) errors.push(`no single owner for ${p} (gap or overlap in tools/lint/ownership.yaml)`);
    else if (owner !== me) errors.push(`${p} is owned by ${owner}, not ${me}`);
    if (CONTRACT.some((re) => re.test(p))) contract = true;
  }
  if (contract && !REFS.test(body)) errors.push('contract change without CR reference (PR body needs a line "Refs: CR-C<n>-<nnn>")');
  for (const e of errors) console.error(`paths: ${e}`);
  return errors.length ? 1 : 0;
}

function codeowners(out: string): void {
  const handle = (owner: string) => `@lims/${owner.toLowerCase()}`;
  const rules = loadRules()
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => cmp(a.key, b.key) || a.i - b.i); // general first; CODEOWNERS is last-match-wins
  const lines = [
    '# GENERATED by tools/lint/check-paths.ts --codeowners-out .github/CODEOWNERS from tools/lint/ownership.yaml.',
    '# Do not edit by hand; edit ownership.yaml and regenerate.',
    ...rules.map((r) => `/${r.pattern.replace(/^\//, '')} ${handle(r.owner)}`),
  ];
  writeFileSync(out, lines.join('\n') + '\n');
}

function main(argv: string[]): number {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!['--branch', '--files', '--body', '--codeowners-out'].includes(k) || v === undefined) throw new Usage(`bad argument: ${k}`);
    args[k] = v;
  }
  if (args['--codeowners-out'] !== undefined) {
    if (Object.keys(args).length !== 1) throw new Usage('--codeowners-out takes no other flags');
    codeowners(args['--codeowners-out']);
    return 0;
  }
  if (args['--branch'] === undefined || !args['--files'] || !args['--body']) throw new Usage('need --branch, --files and --body');
  return gate(args['--branch'], args['--files'], args['--body']);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`paths: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
