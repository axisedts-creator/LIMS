// T0B-REVIEW-1 (C0, LD-232, audit items 2 to 4; AC-0B-3.6, AC-0B-4.3): REPORT ONLY. Static checks that the three non-blocking CRs exist and are complete,
// and that git shows no change outside them (and this test and the task notes). LD-232 RULES: no migration, policy, grant, test, code or spec change;
// a proposal may only narrow access (no GRANT, no permissive CREATE POLICY).
//   1 = reporting.provider_events UPDATE (AC-0B-4.3 append-only, lims_app UPDATE grant, policy provider_events__update__tenant)
//   2 = engagement tenant policies without is_staff_or_system (settings, number_counters, cs_* lookup tables)
//   3 = identity.mfa_factors visibility (policies mfa_factors__select__tenant / __own / __platform; C2_policies tests 63 and 72)
// Run: node --test tests/db/T0B-REVIEW-1.reports.test.mjs      (T0BR1_ROOT=<dir> points the checks at another tree)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0BR1_ROOT ? resolve(process.env.T0BR1_ROOT) : repo;
const CR_DIR = join(root, '.orchestra', 'cr');
const CR_RE = /^T0B-REVIEW-1\.[^.\s]+\.nonblocking\.md$/;
const HEADINGS = ['Intent', 'Current behaviour', 'Callers', 'Proposal', 'Tests'];

const nl = (s) => s.replace(/\r\n?/g, '\n');
const crFiles = () => (existsSync(CR_DIR) ? readdirSync(CR_DIR).filter((f) => CR_RE.test(f)).sort() : []);
const needThree = () => { const f = crFiles(); assert.equal(f.length, 3, 'expected 3 CR files, found ' + f.length); return f; };
const read = (f) => nl(readFileSync(join(CR_DIR, f), 'utf8'));

// Split a CR into { heading text -> body } on markdown heading lines (#..######), tolerating **bold** and a trailing "(...)" or ":" on the heading.
function sections(text) {
  const out = {}; let cur = null;
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+\**\s*([^\n*]+?)\s*\**\s*$/.exec(line);
    if (m) {
      const name = HEADINGS.find((h) => new RegExp(`^${h}\\b`, 'i').test(m[1]));
      if (name) { cur = name; out[cur] = out[cur] ?? ''; continue; }
    }
    if (cur) out[cur] += line + '\n';
  }
  return out;
}

// Which LD-232 item a CR covers, by what it is about (the file number n is free: the lead names them 1..3 but the test does not depend on the order).
const ITEMS = {
  provider_events: { match: (t) => /provider_events/.test(t) && /AC-0B-4\.3/.test(t), must: [/provider_events__update__tenant/, /UPDATE/, /ON CONFLICT/i] },
  engagement: { match: (t) => /number_counters/.test(t) && /engagement\.settings|settings/.test(t), must: [/is_staff_or_system/, /number_counters/, /cs_booking_cancel_reasons/, /cs_reminder_reasons/, /cs_enquiry_categories/] },
  mfa_factors: { match: (t) => /mfa_factors/.test(t), must: [/mfa_factors__select__tenant/, /mfa_factors__select__own|mfa_factors__own|__own/, /mfa_factors__select__platform|mfa_factors__platform|__platform/, /aal1/i, /\b63\b/, /\b72\b/] },
};

function git(args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return nl(r.stdout).split('\n').filter(Boolean);
}

test('exactly three CR files T0B-REVIEW-1.<n>.nonblocking.md exist in .orchestra/cr', () => {
  const f = crFiles();
  assert.equal(f.length, 3, `expected 3 CR files, found ${f.length}: ${f.join(', ') || '(none)'}`);
});

test('each CR has the five headings (Intent, Current behaviour, Callers, Proposal, Tests), each with a body', () => {
  const f = crFiles();
  assert.ok(f.length > 0, 'no CR files yet');
  for (const file of f) {
    const s = sections(read(file));
    for (const h of HEADINGS) {
      assert.ok(h in s, `${file}: missing heading "${h}"`);
      assert.ok(s[h].replace(/\s+/g, '').length >= 20, `${file}: heading "${h}" has no real body`);
    }
  }
});

test('the three CRs cover the three LD-232 items, one each (provider_events, engagement policies, mfa_factors)', () => {
  const f = crFiles();
  assert.equal(f.length, 3, 'need the three CR files first');
  const texts = f.map((x) => [x, read(x)]);
  const used = new Set();
  for (const [item, spec] of Object.entries(ITEMS)) {
    const hits = texts.filter(([, t]) => spec.match(t)).map(([x]) => x);
    assert.ok(hits.length >= 1, `no CR covers item "${item}"`);
    // the CR that is primarily about this item: the first hit not already claimed by another item
    const own = hits.find((x) => !used.has(x));
    assert.ok(own, `item "${item}" has no CR of its own (hits ${hits.join(', ')} already used)`);
    used.add(own);
    const t = texts.find(([x]) => x === own)[1];
    for (const re of spec.must) assert.match(t, re, `${own} (item ${item}) must mention ${re}`);
  }
  assert.equal(used.size, 3);
});

test('Intent quotes spec section ids (AC-/section ids) and cites LD-232', () => {
  for (const file of needThree()) {
    const t = read(file); const s = sections(t);
    assert.match(s.Intent ?? '', /\bAC-[0-9A-Z]+-\d+\.\d+\b|§\s*\d|\b\d{2}-[A-Z-]+\b.*§|\bsection\b|\b\d+\.\d+(\.\d+)?\b/i, `${file}: Intent cites no spec section id`);
    assert.match(t, /LD-232/, `${file}: must cite LD-232`);
  }
});

test('Callers lists file:line references that exist in the tree', () => {
  for (const file of needThree()) {
    const body = sections(read(file)).Callers ?? '';
    const refs = [...body.matchAll(/([A-Za-z0-9_./\\-]+\.(?:sql|ts|tsx|mjs|js|yaml|yml|md|sh)):(\d+)/g)];
    assert.ok(refs.length >= 1, `${file}: Callers has no file:line reference`);
    for (const [, p, ln] of refs) {
      const abs = join(root, p);
      assert.ok(existsSync(abs), `${file}: Callers cites ${p}:${ln} but the file does not exist`);
      const n = readFileSync(abs, 'utf8').split('\n').length;
      assert.ok(Number(ln) >= 1 && Number(ln) <= n, `${file}: Callers cites ${p}:${ln} but the file has ${n} lines`);
    }
  }
});

test('Proposal gives exact policy/grant text and only NARROWS (LD-232: no GRANT, no permissive CREATE POLICY)', () => {
  for (const file of needThree()) {
    const p = sections(read(file)).Proposal ?? '';
    assert.match(p, /\b(REVOKE|ALTER POLICY|DROP POLICY|CREATE POLICY)\b/i, `${file}: Proposal has no exact REVOKE/ALTER POLICY/DROP POLICY/CREATE POLICY text`);
    assert.doesNotMatch(p, /\bGRANT\s+(ALL|SELECT|INSERT|UPDATE|DELETE|EXECUTE|USAGE)\b/i, `${file}: Proposal must not GRANT (narrowing only)`);
    for (const m of p.matchAll(/CREATE\s+POLICY[^;]*?;/gis)) {
      assert.match(m[0], /AS\s+RESTRICTIVE/i, `${file}: a new policy must be AS RESTRICTIVE (narrowing): ${m[0].slice(0, 80)}`);
    }
  }
});

test('Tests section says what must be asserted (names a test file or an assertion subject)', () => {
  for (const file of needThree()) {
    const t = sections(read(file)).Tests ?? '';
    assert.match(t, /(db\/tests\/|tests\/|\.test\.|assert|must|expect|0 rows|42501|denied|refus)/i, `${file}: Tests section asserts nothing concrete`);
  }
});

test('git shows no change outside the three CRs, this test and the T0B-REVIEW-1 notes (committed task commits and the working tree)', () => {
  const allowed = (p) => CR_RE.test(p.replace(/^\.orchestra\/cr\//, '')) && p.startsWith('.orchestra/cr/')
    || p === 'tests/db/T0B-REVIEW-1.reports.test.mjs'
    || p.startsWith('.orchestra/notes/T0B-REVIEW-1-');
  // working tree: modified, staged and untracked (porcelain: "XY path", renames "XY old -> new")
  const dirty = git(['status', '--porcelain', '--untracked-files=all']).flatMap((l) => l.slice(3).split(' -> '));
  // commits of this task: subjects "[role] T0B-REVIEW-1 ..." (not the lead's wide commits that merely mention the id)
  const commits = git(['log', '--format=%H', '-E', '--grep=^\\[[a-z]+\\] T0B-REVIEW-1\\b']);
  const committed = commits.flatMap((h) => git(['show', '--name-only', '--format=', h]));
  const outside = [...new Set([...dirty, ...committed])].filter((p) => !allowed(p));
  assert.deepEqual(outside, [], `files changed outside the three CRs and the test: ${outside.join(', ')}`);
  // belt and braces: nothing of the guarded trees is touched at all
  const guarded = [...new Set([...dirty, ...committed])].filter((p) => /^(db|spec|services|apps|packages)\//.test(p));
  assert.deepEqual(guarded, [], `LD-232: no migration/policy/grant/test/code/spec change allowed: ${guarded.join(', ')}`);
});
