// AN-T01 (C8): web nav manifest. Spec: C8 04-UI-UX §1 (nav table, verbatim), C0 04-UI-UX §3 (manifest + build-nav rules).
// done_when (shared with the API/worker parts of AN-T01): the manifest passes the C0 build check (`src/core/nav/build-nav.ts`).
// Run: node --test (node strips TS types natively), cwd apps/web.
// CONFLICT FOUND: 04-UI-UX §1 gives analytics.reports the chord `g m`, which instruments.messages already owns
// (apps/web/src/features/instruments/nav.manifest.ts). §1 says "on conflict the build fails and C8 picks another", so this test
// does NOT pin the reports chord: it requires a unique `g <letter>` chord that is not `g m`. `g o` (dashboard) is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const FEATURE = join(WEB, 'src', 'features', 'analytics');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string }[] }).routes;

// 04-UI-UX §1, verbatim (chord: see header for analytics.reports).
const EXPECTED = [
  { id: 'analytics.dashboard', label: 'analytics.nav.dashboard', routeId: 'staff.analytics.dashboard', permission: 'analytics.dashboard.read', order: 10, chord: 'g o' },
  { id: 'analytics.reports', label: 'analytics.nav.reports', routeId: 'staff.analytics.reports', permission: 'analytics.dashboard.read', order: 20, chord: undefined },
  { id: 'analytics.collections', label: 'analytics.nav.collections', routeId: 'staff.analytics.collections', permission: 'analytics.collections.read', order: 25, chord: null },
  { id: 'analytics.referral', label: 'analytics.nav.referral', routeId: 'staff.analytics.referral_incentive', permission: 'analytics.referral_report.read', order: 30, chord: null },
  { id: 'analytics.exports', label: 'analytics.nav.exports', routeId: 'staff.analytics.exports', permission: 'analytics.data.export', order: 40, chord: null },
  { id: 'analytics.schedules', label: 'analytics.nav.schedules', routeId: 'staff.analytics.schedules', permission: 'analytics.schedule.manage', order: 50, chord: null },
] as const;

async function loadManifest() {
  const file = join(FEATURE, 'nav.manifest.ts');
  assert.ok(existsSync(file), `missing ${file}`);
  return (await import(pathToFileURL(file).href)) as { navManifest: { module: string; entries: Record<string, unknown>[] } };
}

test('nav.manifest: module=analytics with the six §1 entries, verbatim ids/labels/routes/permissions/group/order', async () => {
  const { navManifest } = await loadManifest();
  assert.equal(navManifest.module, 'analytics');
  assert.equal(navManifest.entries.length, EXPECTED.length, 'exactly the six §1 entries (report-run detail is not a nav entry)');
  for (const x of EXPECTED) {
    const e = navManifest.entries.find((n) => n.id === x.id);
    assert.ok(e, `entry ${x.id}`);
    assert.equal(e.label, x.label);
    assert.equal(e.routeId, x.routeId);
    assert.equal(e.permission, x.permission);
    assert.equal(e.group, 'analytics');
    assert.equal(e.order, x.order);
    assert.ok(typeof e.icon === 'string' && e.icon.length > 0, `${x.id}: icon present`);
  }
});

test('nav.manifest: chords — dashboard `g o`; reports has a `g <letter>` chord other than `g m`; no other entry has a chord', async () => {
  const { navManifest } = await loadManifest();
  const chord = (id: string) => navManifest.entries.find((n) => n.id === id)?.chord;
  assert.equal(chord('analytics.dashboard'), 'g o');
  assert.match(String(chord('analytics.reports')), /^g [a-z]$/, 'reports chord');
  assert.notEqual(chord('analytics.reports'), 'g m', '`g m` is owned by instruments.messages (04-UI-UX §1 conflict rule)');
  for (const x of EXPECTED.filter((y) => y.chord === null)) assert.equal(chord(x.id), undefined, `${x.id}: no chord in §1`);
});

test('nav.manifest: entries are unique, ascending by order, and each resolves to a non-parameterised staff_web route with the same permission', async () => {
  const { navManifest } = await loadManifest();
  const ids = navManifest.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const orders = navManifest.entries.map((e) => e.order as number);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  for (const e of navManifest.entries) {
    const r = routes.find((x) => x.id === e.routeId);
    assert.ok(r, `${String(e.routeId)} in routes.yaml`);
    assert.equal(r.origin, 'staff_web');
    assert.equal(r.permission, e.permission, `${String(e.id)} permission must equal the route's`);
    assert.ok(!r.path.includes('{'), `${String(e.id)}: detail pages are not nav entries`);
  }
});

test('build-nav CLI passes (done_when) across ALL feature manifests and emits the analytics entries with their routes.yaml paths', () => {
  const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
  assert.equal(r.status, 0, `build-nav failed:\n${r.stderr}${r.stdout}`);
  const generated = readFileSync(join(WEB, 'src', 'core', 'nav', 'generated.ts'), 'utf8');
  for (const x of EXPECTED) {
    assert.ok(generated.includes(`"${x.id}"`), `generated.ts contains ${x.id}`);
    const path = routes.find((q) => q.id === x.routeId)!.path;
    assert.ok(generated.includes(`"${path}"`), `generated.ts contains path ${path}`);
  }
});

test('build-nav rejects a drifted manifest (permission differs from route) — guards the done_when check itself', async () => {
  const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'an-t01-'));
  mkdirSync(join(dir, 'analytics'));
  writeFileSync(join(dir, 'analytics', 'nav.manifest.ts'), readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8').replaceAll('analytics.data.export', 'analytics.bogus.export'));
  const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.ok(errors.some((m: string) => /permission/.test(m)), `expected permission error, got ${JSON.stringify(errors)}`);
});

test('build-nav rejects a chord collision with another module (the §1 `g m` clash is detected, not silently shipped)', async () => {
  const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'an-t01-'));
  for (const m of ['analytics', 'instruments']) mkdirSync(join(dir, m));
  writeFileSync(join(dir, 'instruments', 'nav.manifest.ts'), readFileSync(join(WEB, 'src', 'features', 'instruments', 'nav.manifest.ts'), 'utf8'));
  writeFileSync(join(dir, 'analytics', 'nav.manifest.ts'), `export const navManifest = { module: 'analytics', entries: [
    { id: 'analytics.reports', label: 'analytics.nav.reports', routeId: 'staff.analytics.reports', permission: 'analytics.dashboard.read', group: 'analytics', order: 20, chord: 'g m' } ] };
`);
  const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.ok(errors.some((m: string) => /duplicate shortcut chord "g m"/.test(m)), `expected chord clash, got ${JSON.stringify(errors)}`);
});
