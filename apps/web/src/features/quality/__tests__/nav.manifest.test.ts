// C9 T-01: web nav manifest. Spec: C9 04-UI-UX §1.1 (nav table), C0 04-UI-UX §3 (manifest + build-nav rules), 06-PLAN row T-01 (WEB-F nav.manifest.ts).
// Run: node --test (node strips TS types natively), cwd apps/web.
// SEAMS (the spec fixes entries, paths and permissions, not these): export `navManifest` (like analytics); entry ids `quality.<snake>`; labels
//   `quality.nav.<snake>` (message keys `quality.<screen>.<key>`, 04-UI-UX header); group `quality`; order ascending in table order; an icon per entry;
//   routeIds `staff.quality.<snake>`, of which 06-PLAN names two: `staff.quality.lj_chart` and `staff.quality.tat_alerts`.
// SPEC GAP (reported in .orchestra/notes/C9.T-01-tests.md): contracts/routes.yaml holds ONLY `staff.quality.qc_run` (parameterised, so not a nav target).
//   The 8 nav routes arrive with C0-0C (06-PLAN row 80). Until then the two tests that resolve routeIds against routes.yaml (marked ROUTES) cannot pass.
//   The tester does not edit contracts/.
// Phase-1 honesty (04-UI-UX §1): while LIMS_QUALITY_ENABLED=false the entry is hidden; that is a runtime concern of the shell (T-22+), not tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const FEATURE = join(WEB, 'src', 'features', 'quality');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const PERMS_YAML = join(WEB, '..', '..', 'contracts', 'permissions.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string }[] }).routes;

// 04-UI-UX §1.1 verbatim: entry -> path -> permission, in table order.
const EXPECTED = [
  { name: 'QC status', path: '/quality', permission: 'quality.qc_run.read' },
  { name: 'QC runs', path: '/quality/runs', permission: 'quality.qc_run.read' },
  { name: 'Levey-Jennings', path: '/quality/lj', permission: 'quality.qc_run.read' },
  { name: 'Unassigned QC', path: '/quality/observations', permission: 'quality.qc_run.read' },
  { name: 'QC set-up', path: '/quality/setup/materials', permission: 'quality.qc_run.read' },
  { name: 'Auto-verification', path: '/quality/autoverify', permission: 'quality.autoverify.read' },
  { name: 'TAT alerts', path: '/quality/tat-alerts', permission: 'quality.tat_alert.read' },
  { name: 'Quality settings', path: '/quality/settings', permission: 'quality.qc_run.read' },
] as const;

type Entry = Record<string, unknown>;
async function loadManifest() {
  const file = join(FEATURE, 'nav.manifest.ts');
  assert.ok(existsSync(file), `missing ${file}`);
  return (await import(pathToFileURL(file).href)) as { navManifest: { module: string; entries: Entry[] } };
}

test('nav.manifest: module=quality with the eight §1.1 entries, group quality, ascending order, unique ids, message-key labels, an icon each', async () => {
  const { navManifest } = await loadManifest();
  assert.equal(navManifest.module, 'quality');
  assert.equal(navManifest.entries.length, EXPECTED.length, 'exactly the eight §1.1 entries (run detail is not a nav entry)');
  const ids = navManifest.entries.map((e) => e.id as string);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  const orders = navManifest.entries.map((e) => e.order as number);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'ascending order');
  assert.equal(new Set(orders).size, orders.length, 'distinct order values');
  for (const e of navManifest.entries) {
    assert.match(String(e.id), /^quality\.[a-z0-9_]+$/);
    assert.match(String(e.label), /^quality\.nav\.[a-z0-9_]+$/, `${String(e.id)}: label is a message key, not display text`);
    assert.match(String(e.routeId), /^staff\.quality\.[a-z0-9_]+$/);
    assert.equal(e.group, 'quality');
    assert.ok(typeof e.icon === 'string' && (e.icon as string).length > 0, `${String(e.id)}: icon present`);
  }
});

test('nav.manifest: permission of every entry, in table order, equals §1.1 (the nav never offers an entry the user cannot open)', async () => {
  const { navManifest } = await loadManifest();
  assert.deepEqual(navManifest.entries.map((e) => e.permission), EXPECTED.map((x) => x.permission));
});

test('nav.manifest: every permission is a registered phase-2 quality code in contracts/permissions.yaml (no invented code)', async () => {
  const { navManifest } = await loadManifest();
  const doc = parse(readFileSync(PERMS_YAML, 'utf8')) as Record<string, unknown>;
  const flat = JSON.stringify(doc);
  for (const e of navManifest.entries) assert.ok(flat.includes(`"code":"${String(e.permission)}"`), `${String(e.permission)} registered`);
});

test('nav.manifest: the two route ids named by 06-PLAN row 80 are used verbatim (cross-module links from C8 dashboard resolve the same ids)', async () => {
  const { navManifest } = await loadManifest();
  const byRoute = new Map(navManifest.entries.map((e) => [e.routeId as string, e]));
  assert.equal(byRoute.get('staff.quality.lj_chart')?.permission, 'quality.qc_run.read');
  assert.equal(byRoute.get('staff.quality.tat_alerts')?.permission, 'quality.tat_alert.read');
  assert.equal(new Set(navManifest.entries.map((e) => e.routeId)).size, navManifest.entries.length, 'one route per entry');
});

test('nav.manifest: chords, when present, are `g <letter>` and none collides with another module (collision is a build-nav failure; see ROUTES test)', async () => {
  const { navManifest } = await loadManifest();
  for (const e of navManifest.entries) if (e.chord !== undefined) assert.match(String(e.chord), /^g [a-z]$/);
});

test('ROUTES nav.manifest: each routeId resolves in contracts/routes.yaml to a non-parameterised staff_web route with the same permission and the §1.1 path', async () => {
  const { navManifest } = await loadManifest();
  navManifest.entries.forEach((e, i) => {
    const r = routes.find((x) => x.id === e.routeId);
    assert.ok(r, `${String(e.routeId)} missing from contracts/routes.yaml (C0-0C route ids, 06-PLAN row 80)`);
    assert.equal(r.origin, 'staff_web');
    assert.equal(r.permission, e.permission, `${String(e.id)}: permission must equal the route's`);
    assert.ok(!r.path.includes('{'), `${String(e.id)}: detail pages are not nav entries`);
    assert.equal(r.path, EXPECTED[i]!.path, `${String(e.id)}: path per 04-UI-UX §1.1`);
  });
});

test('ROUTES build-nav CLI passes across ALL feature manifests and emits the quality entries (done_when of the WEB-F part)', () => {
  const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
  assert.equal(r.status, 0, `build-nav failed:\n${r.stderr}${r.stdout}`);
  const generated = readFileSync(join(WEB, 'src', 'core', 'nav', 'generated.ts'), 'utf8');
  for (const x of EXPECTED) assert.ok(generated.includes(`"${x.path}"`), `generated.ts contains path ${x.path}`);
});
