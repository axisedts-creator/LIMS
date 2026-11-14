// C10 T-01: web nav manifest. Spec: C10 04-UI-UX §1 (nav table, verbatim), C0 04-UI-UX §3 (manifest + build-nav rules), routes per CR-C10-006.
// done_when: nav build passes (`src/core/nav/build-nav.ts`) with the micro manifest. Run: node --test (node strips TS types natively), cwd apps/web.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const FEATURE = join(WEB, 'src', 'features', 'micro');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string }[] }).routes;

// 04-UI-UX §1, verbatim.
const EXPECTED = [
  { id: 'micro.worklist', label: 'micro.nav.worklist', routeId: 'staff.micro.worklist', permission: 'micro.culture.read', order: 60, icon: 'flask', chord: 'g u' },
  { id: 'micro.instrument_records', label: 'micro.nav.instrument_records', routeId: 'staff.micro.instrument_records', permission: 'micro.culture.read', order: 61, icon: 'inbox', chord: undefined },
  { id: 'micro.settings', label: 'micro.nav.settings', routeId: 'staff.micro.settings', permission: 'micro.config.manage', order: 62, icon: 'settings', chord: undefined },
  { id: 'micro.breakpoint_sets', label: 'micro.nav.breakpoint_sets', routeId: 'staff.micro.breakpoint_sets', permission: 'micro.breakpoint.manage', order: 63, icon: 'table', chord: undefined },
] as const;

async function loadManifest() {
  const file = join(FEATURE, 'nav.manifest.ts');
  assert.ok(existsSync(file), `missing ${file}`);
  return (await import(pathToFileURL(file).href)) as { navManifest: { module: string; entries: Record<string, unknown>[] } };
}

test('nav.manifest: module=micro with the four §1 entries, verbatim ids/labels/routes/permissions/group/order/icon/chord/phase', async () => {
  const { navManifest } = await loadManifest();
  assert.equal(navManifest.module, 'micro');
  assert.equal(navManifest.entries.length, EXPECTED.length, 'exactly the four §1 entries (the culture detail page is not a nav entry)');
  for (const x of EXPECTED) {
    const e = navManifest.entries.find((n) => n.id === x.id);
    assert.ok(e, `entry ${x.id}`);
    assert.equal(e.label, x.label);
    assert.equal(e.routeId, x.routeId);
    assert.equal(e.permission, x.permission);
    assert.equal(e.group, 'laboratory');
    assert.equal(e.order, x.order);
    assert.equal(e.icon, x.icon);
    assert.equal(e.chord, x.chord);
    assert.equal(e.phase, '2');
  }
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

// Ruling C10.T-01: scoped to micro/nav.manifest.ts only; repo-wide build-nav failures on platform.*/smartreport.* routeIds are C0/C2/C14-owned.
test('build-nav passes (done_when) over the micro manifest alone against the real routes.yaml, with the EXPECTED entries and paths', async () => {
  const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'c10-t01-'));
  mkdirSync(join(dir, 'micro'));
  writeFileSync(join(dir, 'micro', 'nav.manifest.ts'), readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8'));
  const { errors, entries } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.deepEqual(errors, []);
  assert.equal(entries.length, EXPECTED.length);
  for (const x of EXPECTED) {
    const e = entries.find((n: { id: string }) => n.id === x.id);
    assert.ok(e, `entry ${x.id}`);
    assert.equal(e.path, routes.find((q) => q.id === x.routeId)!.path);
  }
});

test('build-nav rejects a drifted manifest (permission differs from route) — guards the done_when check itself', async () => {
  const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'c10-t01-'));
  mkdirSync(join(dir, 'micro'));
  writeFileSync(join(dir, 'micro', 'nav.manifest.ts'), readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8').replaceAll('micro.config.manage', 'micro.bogus.manage'));
  const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.ok(errors.some((m: string) => /permission/.test(m)), `expected permission error, got ${JSON.stringify(errors)}`);
});

test('build-nav rejects a chord collision: `g u` of micro.worklist may not be shared with another manifest', async () => {
  const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'c10-t01-'));
  mkdirSync(join(dir, 'micro'));
  mkdirSync(join(dir, 'other'));
  writeFileSync(join(dir, 'micro', 'nav.manifest.ts'), readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8'));
  writeFileSync(join(dir, 'other', 'nav.manifest.ts'), `export const navManifest = { module: 'other', entries: [
    { id: 'other.x', label: 'other.nav.x', routeId: 'staff.micro.settings', permission: 'micro.config.manage', group: 'laboratory', order: 90, chord: 'g u' } ] };
`);
  const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.ok(errors.some((m: string) => /duplicate shortcut chord "g u"/.test(m)), `expected chord clash, got ${JSON.stringify(errors)}`);
});
