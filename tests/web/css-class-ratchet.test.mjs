// WEB-CSS-RATCHET-1 (LD-241, 2026-11-15; C0 10-DESIGN-SYSTEM "no unstyled markup").
// Ratchet: every lims- class used in a className in apps/web, apps/portal, apps/partner and packages/ui
// must be defined in a stylesheet / CSS module / inline <style> of the same app or of packages/ui.
// Known violations live in css-class-baseline.json. The test fails when a NEW undefined class appears
// and when a baselined class has since been defined (so the baseline only shrinks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS, scan, ratchet, usedClasses, definedClasses } from './css-class-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/web/css-class-baseline.json'), 'utf8'));

/** Build a throwaway mini repo: { 'apps/web/src/a.tsx': '...', ... } */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-ratchet-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const failures = (res) => Object.values(res).flatMap((r) => [...r.added, ...r.stale]);

// ---------- scanner unit tests ----------
test('usedClasses reads className in string, braces, ternary, template, helper-call and object forms', () => {
  const src = `
    <a className="lims-a lims-b" />
    <a className='lims-c' />
    <a className={'lims-d'} />
    <a className={ok ? "lims-e" : 'lims-f'} />
    <a className={\`lims-g \${x ? 'lims-h' : ''}\`} />
    <a className={clsx('lims-i', { 'lims-j': on })} />
    const p = { className: "lims-k" };`;
  assert.deepEqual([...usedClasses(src)].sort(), 'abcdefghijk'.split('').map((c) => `lims-${c}`));
});

test('usedClasses ignores lims- text outside className, dynamic prefixes and non-lims names', () => {
  const src = `
    <a data-x="lims-not-a-class" id="lims-anchor" aria-labelledby="lims-label" />
    <a className={\`lims-state-\${s}\`} />
    <a className="btn other-lims-x" />
    const t = "lims-plain-string";`;
  assert.deepEqual([...usedClasses(src)], []);
});

test('definedClasses reads selectors, ignores comments, keyframes and custom properties', () => {
  const css = `/* .lims-commented { } */
    .lims-a, .lims-b:hover > .lims-c { color: red }
    @keyframes lims-spin { to { opacity: 0 } }
    .x { color: var(--lims-color); }
    .lims-d__el--mod::after { content: ""; }`;
  assert.deepEqual([...definedClasses(css)].sort(), ['lims-a', 'lims-b', 'lims-c', 'lims-d__el--mod']);
});

// ---------- fixture: scope rules ----------
test('scan: same-app css, css module, packages/ui css and inline <style> define; other app css and __tests__ do not', () => {
  const root = fixture({
    'apps/web/src/page.tsx': `<div className="lims-own lims-mod lims-shared lims-inline lims-other-app lims-test-only lims-nowhere" />`,
    'apps/web/src/own.css': '.lims-own { color: red }',
    'apps/web/src/m.module.css': '.lims-mod { color: red }',
    'apps/web/src/inline.tsx': 'export const S = () => <style href="x">{`.lims-inline { color: red }`}</style>;',
    'apps/web/src/__tests__/t.css': '.lims-test-only { color: red }',
    'apps/web/src/__tests__/t.test.tsx': '<a className="lims-in-test" />',
    'apps/portal/src/p.css': '.lims-other-app { color: red }',
    'packages/ui/src/kit.css': '.lims-shared { color: red }',
    'packages/ui/src/Button.tsx': '<b className="lims-shared lims-ui-missing" />',
  });
  const r = scan(root);
  assert.deepEqual(r['apps/web'].violations, ['lims-nowhere', 'lims-other-app', 'lims-test-only']);
  assert.deepEqual(r['packages/ui'].violations, ['lims-ui-missing']);
  assert.deepEqual(r['apps/portal'].violations, []);
  assert.deepEqual(r['apps/partner'].violations, []); // app dir absent: no crash
});

test('scan: packages/ui classes are not defined by an app stylesheet', () => {
  const root = fixture({
    'packages/ui/src/B.tsx': '<b className="lims-only-in-app-css" />',
    'apps/web/src/a.css': '.lims-only-in-app-css { color: red }',
  });
  assert.deepEqual(scan(root)['packages/ui'].violations, ['lims-only-in-app-css']);
});

// ---------- fixture: the ratchet itself ----------
test('ratchet FAILS on a new undefined class (not in baseline)', () => {
  const root = fixture({
    'apps/web/src/a.tsx': '<a className="lims-old lims-brand-new" />',
  });
  const res = ratchet(scan(root), { 'apps/web': ['lims-old'] });
  assert.deepEqual(res['apps/web'].added, ['lims-brand-new']);
  assert.deepEqual(res['apps/web'].stale, []);
  assert.notEqual(failures(res).length, 0);
});

test('ratchet FAILS on a stale baseline entry (class now defined or no longer used)', () => {
  const root = fixture({
    'apps/web/src/a.tsx': '<a className="lims-old lims-fixed" />',
    'apps/web/src/a.css': '.lims-fixed { color: red }',
  });
  const res = ratchet(scan(root), { 'apps/web': ['lims-old', 'lims-fixed', 'lims-deleted'] });
  assert.deepEqual(res['apps/web'].added, []);
  assert.deepEqual(res['apps/web'].stale, ['lims-deleted', 'lims-fixed']);
  assert.notEqual(failures(res).length, 0);
});

test('ratchet passes when baseline equals the violations exactly', () => {
  const root = fixture({ 'apps/web/src/a.tsx': '<a className="lims-old" />' });
  assert.equal(failures(ratchet(scan(root), { 'apps/web': ['lims-old'] })).length, 0);
});

test('ratchet: a baseline entry is per app (web baseline does not excuse the same class in partner)', () => {
  const root = fixture({
    'apps/web/src/a.tsx': '<a className="lims-x" />',
    'apps/partner/src/a.tsx': '<a className="lims-x" />',
  });
  const res = ratchet(scan(root), { 'apps/web': ['lims-x'] });
  assert.deepEqual(res['apps/partner'].added, ['lims-x']);
});

// ---------- the real repo ----------
test('baseline file is well formed: exactly the four apps, sorted, unique, plain lims- names', () => {
  assert.equal(BASELINE.decision, 'LD-241');
  assert.deepEqual(Object.keys(BASELINE.apps).sort(), [...APPS].sort());
  for (const [app, list] of Object.entries(BASELINE.apps)) {
    assert.deepEqual(list, [...new Set(list)].sort(), `${app}: baseline must be sorted and unique`);
    for (const c of list) assert.match(c, /^lims-[a-z0-9_-]*[a-z0-9_]$/, `${app}: bad entry ${c}`);
  }
});

test('baseline records the seven lims-platform-* classes of the platform shell layout', () => {
  const seven = ['denied', 'header', 'label', 'main', 'nav', 'shell', 'user'].map((s) => `lims-platform-${s}`);
  for (const c of seven) assert.ok(BASELINE.apps['apps/web'].includes(c), `apps/web baseline missing ${c}`);
});

test('real repo: scanner is not vacuous (sees the platform layout classes and shared kit classes)', () => {
  const r = scan(ROOT);
  assert.ok(r['apps/web'].files['lims-platform-shell']?.some((f) => f === 'apps/web/src/app/(platform)/layout.tsx'));
  assert.ok(r['apps/web'].used.length > 50);
  assert.ok(r['packages/ui'].used.length > 50);
  for (const app of APPS) assert.ok(Array.isArray(r[app].violations));
});

test('real repo: no new undefined lims- class and no stale baseline entry (counts per app in diagnostics)', (t) => {
  const r = scan(ROOT);
  for (const app of APPS) t.diagnostic(`${app}: ${r[app].violations.length} undefined of ${r[app].used.length} used (baseline ${BASELINE.apps[app].length})`);
  const res = ratchet(r, BASELINE.apps);
  const lines = [];
  for (const [app, x] of Object.entries(res)) {
    for (const c of x.added) lines.push(`NEW undefined in ${app}: ${c} (used in ${r[app].files[c].join(', ')}). Define it in a stylesheet; do not baseline it.`);
    for (const c of x.stale) lines.push(`STALE baseline in ${app}: ${c} is now defined or unused. Remove it from tests/web/css-class-baseline.json.`);
  }
  assert.deepEqual(lines, []);
});
