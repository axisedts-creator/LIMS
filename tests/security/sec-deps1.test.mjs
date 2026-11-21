// SEC-DEPS-1 (audit 9.1, LD-239): dependency advisories ajv, yaml, dev tools, prism-cli chain, CI audit steps.
// Run: node --test tests/security/sec-deps1.test.mjs
// No network and no install: pnpm-lock.yaml, pnpm-workspace.yaml, package.json files and .github/workflows/pr.yml are read as text.
// Contracts the brief fixes:
//  1. every ajv resolution >= 8.18.0 (GHSA-2g4f-4pwh-qvx6); every yaml resolution is at or above the fixed release of its
//     major: 2.x >= 2.8.3 (GHSA-48c2-rrv3-qjmp), 1.x >= 1.10.3 (assumption: 1.10.3 is the 1.x backport of the same fix; the
//     brief's ">= 2.8.3" cannot apply to the 1.x line, which no parent here can move to 2.x).
//  2. dev-tool advisories of LD-239 (vitest 3.x <3.2.6, tinypool <2.1.2, lodash <4.18.1, @faker-js/faker <10.5.0, uuid 8.3.2,
//     @stoplight/prism-cli): each is gone from the lockfile OR has `.orchestra/cr/SEC-DEPS-1.<n>.nonblocking.md` naming the package.
//  3. the lockfile is in step with every package.json and with pnpm-workspace.yaml overrides (static stand-in for
//     `pnpm install --frozen-lockfile`, which the verify gate of the writer runs for real).
//  4. every pnpm override has its own comment naming a GHSA id (LD-239 "with a comment naming the advisory").
//  5. pr.yml: a blocking `pnpm audit --prod --audit-level=high` step and a non-blocking (continue-on-error) `pnpm audit
//     --audit-level=high` step, both after a `pnpm install --frozen-lockfile` step of the same job. `pnpm audit fix` is never used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

// ---------- helpers ----------
const cmp = (a, b) => {
  const pa = a.split(/[-+]/)[0].split('.').map(Number);
  const pb = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
// pnpm 12 writes two YAML documents: the pnpm self-install env lock first, the project lock last.
const lock = read('pnpm-lock.yaml').split(/^---$/m).pop();
const section = (name, next) => {
  const s = lock.indexOf(`\n${name}:\n`);
  assert.notEqual(s, -1, `pnpm-lock.yaml has no ${name}: section`);
  const e = next ? lock.indexOf(`\n${next}:\n`, s + 1) : lock.length;
  return lock.slice(s, e === -1 ? lock.length : e);
};
const packagesSec = section('packages', 'snapshots');
const snapshotsSec = section('snapshots');
// package -> sorted unique versions, from the `packages:` keys (`  name@ver:` or `  'name@ver':`)
const locked = new Map();
for (const m of packagesSec.matchAll(/^ {2}'?((?:@[^/\s']+\/)?[^@'\s/]+)@([^'\s:(]+)'?:/gm)) {
  locked.set(m[1], [...new Set([...(locked.get(m[1]) ?? []), m[2]])].sort(cmp));
}
const vers = (name) => locked.get(name) ?? [];

// ---------- 1. ajv and yaml ----------
test('lockfile parser sees the packages it must judge (guards against a silently empty parse)', () => {
  assert.ok(vers('ajv').length >= 1, 'no ajv in pnpm-lock.yaml packages: section');
  assert.ok(vers('yaml').length >= 1, 'no yaml in pnpm-lock.yaml packages: section');
  assert.ok(locked.size > 200, `parsed only ${locked.size} packages`);
});

test('ajv: every resolution >= 8.18.0 (GHSA-2g4f-4pwh-qvx6)', () => {
  const bad = vers('ajv').filter((v) => cmp(v, '8.18.0') < 0);
  assert.deepEqual(bad, [], `vulnerable ajv still locked: ${bad}`);
  assert.deepEqual(vers('ajv').filter((v) => !v.startsWith('8.')), [], 'an ajv outside 8.x is locked');
});

test('yaml: every resolution at or above the fixed release of its major (2.x >= 2.8.3, 1.x >= 1.10.3) (GHSA-48c2-rrv3-qjmp)', () => {
  const min = { 1: '1.10.3', 2: '2.8.3' };
  const bad = vers('yaml').filter((v) => !min[v.split('.')[0]] || cmp(v, min[v.split('.')[0]]) < 0);
  assert.deepEqual(bad, [], `vulnerable yaml still locked: ${bad}`);
});

test('snapshots: no dependency line pins ajv or yaml below the fixed release', () => {
  const bad = [];
  for (const m of snapshotsSec.matchAll(/^ {6}(ajv|yaml): '?(\d[^'\s(]*)/gm)) {
    const min = m[1] === 'ajv' ? '8.18.0' : m[2].startsWith('1.') ? '1.10.3' : '2.8.3';
    if (cmp(m[2], min) < 0) bad.push(`${m[1]}@${m[2]}`);
  }
  assert.deepEqual([...new Set(bad)], [], `snapshots still resolve vulnerable versions: ${[...new Set(bad)]}`);
});

// ---------- 2. dev-tool advisories: cleared or each has a CR ----------
const crDir = join(root, '.orchestra', 'cr');
const crs = existsSync(crDir)
  ? readdirSync(crDir).filter((f) => /^SEC-DEPS-1\.\d+\.nonblocking\.md$/.test(f)).map((f) => ({ f, text: readFileSync(join(crDir, f), 'utf8') }))
  : [];
const hasCr = (name, v) => crs.some((c) => c.text.includes(name) && c.text.includes(v));
const FLAGGED = [
  { name: 'vitest', bad: (v) => v.startsWith('3.') && cmp(v, '3.2.6') < 0, adv: 'GHSA-5xrq-8626-4rwp' },
  { name: 'tinypool', bad: (v) => cmp(v, '2.1.2') < 0, adv: 'tinypool <2.1.2' },
  { name: 'lodash', bad: (v) => v.startsWith('4.') && cmp(v, '4.18.1') < 0, adv: 'GHSA-r5fr-rjxr-66jc' },
  { name: '@faker-js/faker', bad: (v) => cmp(v, '10.5.0') < 0, adv: 'GHSA-qxc2-j82w-r537' },
  { name: 'uuid', bad: (v) => v === '8.3.2', adv: 'uuid 8.3.2' },
];
for (const f of FLAGGED) {
  test(`${f.name}: no flagged version in the lockfile, or a SEC-DEPS-1.<n>.nonblocking.md CR names ${f.name} and that version (${f.adv})`, () => {
    const open = vers(f.name).filter(f.bad).filter((v) => !hasCr(f.name, v));
    assert.deepEqual(open, [], `${f.name} ${open} locked with no CR; clear it or write .orchestra/cr/SEC-DEPS-1.<n>.nonblocking.md naming "${f.name}" and the version`);
  });
}

test('@stoplight/prism-cli: removed from the lockfile, or a SEC-DEPS-1.<n>.nonblocking.md CR names it', () => {
  const inLock = vers('@stoplight/prism-cli').length > 0;
  assert.ok(!inLock || crs.some((c) => c.text.includes('@stoplight/prism-cli')),
    'prism-cli chain still locked and no SEC-DEPS-1.<n>.nonblocking.md CR names @stoplight/prism-cli');
});

test('a SEC-DEPS-1 CR, when present, carries the CR template fields (title line and a non-empty body)', () => {
  for (const c of crs) assert.match(c.text, /^#\s+\S/m, `${c.f} has no heading`), assert.ok(c.text.trim().length > 200, `${c.f} is a stub`);
});

// ---------- 3. lockfile in step with manifests (static stand-in for --frozen-lockfile) ----------
const importers = (() => {
  const sec = lock.slice(lock.indexOf('\nimporters:\n'), lock.indexOf('\npackages:\n'));
  const out = new Map();
  let dir = null, kind = null, dep = null;
  for (const line of sec.split('\n')) {
    let m;
    if ((m = /^ {2}(\S.*):$/.exec(line))) { dir = m[1].replace(/^'|'$/g, ''); out.set(dir, new Map()); kind = dep = null; }
    else if ((m = /^ {4}(dependencies|devDependencies|optionalDependencies):$/.exec(line))) kind = m[1];
    else if (kind && (m = /^ {6}(.+):$/.exec(line))) dep = m[1].replace(/^'|'$/g, '');
    else if (kind && dep && (m = /^ {8}specifier: (.+)$/.exec(line))) out.get(dir).set(`${kind}:${dep}`, m[1].replace(/^'|'$/g, ''));
  }
  return out;
})();

test('importers: every lock importer has a package.json whose dependency specifiers equal the lock (frozen-lockfile proxy)', () => {
  assert.ok(importers.size >= 5, `parsed ${importers.size} importers`);
  const diffs = [];
  for (const [dir, deps] of importers) {
    const pj = JSON.parse(read(join(dir, 'package.json')));
    const want = new Map();
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const [n, s] of Object.entries(pj[k] ?? {})) want.set(`${k}:${n}`, s);
    for (const [k, s] of want) if (deps.get(k) !== s) diffs.push(`${dir} ${k}: package.json ${s} vs lock ${deps.get(k) ?? '(missing)'}`);
    for (const k of deps.keys()) if (!want.has(k)) diffs.push(`${dir} ${k}: in lock, not in package.json`);
  }
  assert.deepEqual(diffs, [], `pnpm-lock.yaml is out of step with the manifests (frozen install would fail):\n${diffs.join('\n')}`);
});

const wsLines = read('pnpm-workspace.yaml').split('\n');
const ovStart = wsLines.findIndex((l) => /^overrides:\s*$/.test(l));
const overrideEntries = [];
if (ovStart !== -1) {
  for (let i = ovStart + 1; i < wsLines.length && (/^\s+\S/.test(wsLines[i]) || wsLines[i].trim() === ''); i++) {
    const m = /^ {2}('?)([^:]+?)\1:\s*(\S.*?)\s*(#.*)?$/.exec(wsLines[i]);
    if (m && !wsLines[i].trim().startsWith('#')) overrideEntries.push({ line: i, key: m[2], val: m[3].replace(/^'|'$/g, ''), inline: m[4] ?? '' });
  }
}

test('overrides: pnpm-workspace.yaml overrides equal the lockfile overrides block', () => {
  const sec = /\noverrides:\n((?: {2}\S.*\n)+)/.exec(lock);
  const lockOv = new Map();
  for (const l of (sec?.[1] ?? '').split('\n')) { const m = /^ {2}'?([^:']+?)'?: (.+)$/.exec(l); if (m) lockOv.set(m[1], m[2].replace(/^'|'$/g, '')); }
  const wsOv = new Map(overrideEntries.map((o) => [o.key, o.val]));
  assert.deepEqual([...wsOv].sort(), [...lockOv].sort(), 'overrides differ between pnpm-workspace.yaml and pnpm-lock.yaml');
});

test('overrides: each override has its own comment naming a GHSA advisory (LD-239)', () => {
  assert.ok(overrideEntries.length >= 1, 'no overrides parsed from pnpm-workspace.yaml');
  const bad = [];
  for (const o of overrideEntries) {
    let i = o.line - 1;
    while (i >= 0 && (wsLines[i].trim() === '' || /^overrides:\s*$/.test(wsLines[i]))) i--;
    const above = [];
    while (i >= 0 && wsLines[i].trim().startsWith('#')) above.unshift(wsLines[i--]);
    if (!/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.test(`${above.join('\n')}\n${o.inline}`)) bad.push(o.key);
  }
  assert.deepEqual(bad, [], `overrides without an advisory comment: ${bad}`);
});

// ---------- 4. never `pnpm audit fix` ----------
test('no script, workflow or doc step runs `pnpm audit --fix` / `pnpm audit fix` (LD-239: never audit fix)', () => {
  const files = ['package.json', ...readdirSync(join(root, '.github', 'workflows')).map((f) => `.github/workflows/${f}`)];
  const hits = files.filter((f) => /pnpm audit\s+(--fix|fix)\b/.test(read(f)));
  assert.deepEqual(hits, []);
});

// ---------- 5. pr.yml audit steps ----------
// steps are `      - ` items at 6-space indent; a step ends at the next step or at the next job id (2-space indent).
const pr = read('.github/workflows/pr.yml');
const steps = (() => {
  const out = [];
  let job = null, cur = null;
  for (const line of pr.split('\n')) {
    let m;
    if ((m = /^ {2}([\w-]+):\s*$/.exec(line))) { job = m[1]; cur = null; }
    else if (/^ {6}- /.test(line)) { cur = { job, lines: [line] }; out.push(cur); }
    else if (cur && (/^ {8}\S/.test(line) || line.trim() === '' || /^ {9,}/.test(line))) cur.lines.push(line);
    else if (/^\S|^ {2}\S|^ {4}\S/.test(line)) cur = null;
  }
  return out.map((s) => ({ job: s.job, text: s.lines.join('\n') }));
})();
const auditFlags = (text) => [...text.matchAll(/^[^#\n]*\bpnpm audit\b([^\n]*)/gm)].map((m) => m[1]);
const levelHigh = (a) => /--audit-level[= ]high\b/.test(a);
const blocking = steps.filter((s) => auditFlags(s.text).some((a) => /--prod\b/.test(a) && levelHigh(a)));
const full = steps.filter((s) => auditFlags(s.text).some((a) => !/--prod\b/.test(a) && !/--dev\b/.test(a) && levelHigh(a)));

test('pr.yml: one blocking step runs `pnpm audit --prod --audit-level=high` (no continue-on-error, no `|| true`)', () => {
  assert.ok(steps.length > 20, `parsed ${steps.length} steps from pr.yml`);
  assert.ok(blocking.length >= 1, 'no pr.yml step runs pnpm audit --prod --audit-level=high');
  for (const s of blocking) {
    assert.doesNotMatch(s.text, /continue-on-error:\s*true/, `blocking audit step in job ${s.job} has continue-on-error`);
    assert.doesNotMatch(s.text, /\|\|\s*(true|:)/, `blocking audit step in job ${s.job} swallows its exit code`);
  }
});

test('pr.yml: one non-blocking step runs `pnpm audit --audit-level=high` (full tree) with continue-on-error: true', () => {
  assert.ok(full.length >= 1, 'no pr.yml step runs pnpm audit --audit-level=high without --prod');
  assert.ok(full.some((s) => /^\s+continue-on-error:\s*true\s*$/m.test(s.text)), 'the full-tree audit step has no `continue-on-error: true`');
});

test('pr.yml: both audit steps follow a `pnpm install --frozen-lockfile` step of the same job', () => {
  for (const a of [...blocking, ...full]) {
    const idx = steps.indexOf(a);
    const earlier = steps.slice(0, idx).filter((s) => s.job === a.job && /pnpm install --frozen-lockfile/.test(s.text));
    assert.ok(earlier.length >= 1, `audit step in job ${a.job} has no earlier frozen-lockfile install in that job`);
  }
});
