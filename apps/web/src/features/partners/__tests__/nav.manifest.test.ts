// C13 T01: web nav manifest. Spec: C13 04-UI-UX §1 (nav table, verbatim, CR-C13-008 route ids), C0 04-UI-UX §3 (manifest + build-nav rules).
// done_when (shared with the API/worker/app parts of T01): "nav build check passes" = `src/core/nav/build-nav.ts` exits 0 across all feature manifests.
// Run: node --test (node strips TS types natively), cwd apps/web.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const FEATURE = join(WEB, 'src', 'features', 'partners');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string }[] }).routes;

// 04-UI-UX §1, verbatim.
const EXPECTED = [
  { id: 'partners.inbox', label: 'partners.nav.inbox', routeId: 'staff.partners.inbox', permission: 'partners.manifest.receive', order: 10, chord: 'g b' },
  { id: 'partners.pickups', label: 'partners.nav.pickups', routeId: 'staff.partners.pickups', permission: 'partners.pickup.manage', order: 20, chord: undefined },
  { id: 'partners.list', label: 'partners.nav.list', routeId: 'staff.partners.list', permission: 'partners.partner.read', order: 30, chord: undefined },
  { id: 'partners.referrers', label: 'partners.nav.referrers', routeId: 'staff.partners.referrers', permission: 'partners.referrer.map', order: 40, chord: undefined },
  { id: 'partners.settings', label: 'partners.nav.settings', routeId: 'staff.partners.settings', permission: 'partners.partner.manage', order: 50, chord: undefined },
] as const;

async function loadManifest() {
  const file = join(FEATURE, 'nav.manifest.ts');
  assert.ok(existsSync(file), `missing ${file}`);
  return (await import(pathToFileURL(file).href)) as { navManifest: { module: string; entries: Record<string, unknown>[] } };
}

test('nav.manifest: module=partners with the five §1 entries, verbatim ids/labels/routes/permissions/group/order', async () => {
  const { navManifest } = await loadManifest();
  assert.equal(navManifest.module, 'partners');
  assert.equal(navManifest.entries.length, EXPECTED.length, 'exactly the five §1 entries (partner/manifest detail pages are not nav entries)');
  for (const x of EXPECTED) {
    const e = navManifest.entries.find((n) => n.id === x.id);
    assert.ok(e, `entry ${x.id}`);
    assert.equal(e.label, x.label);
    assert.equal(e.routeId, x.routeId);
    assert.equal(e.permission, x.permission);
    assert.equal(e.group, 'partners');
    assert.equal(e.order, x.order);
    assert.ok(typeof e.icon === 'string' && e.icon.length > 0, `${x.id}: icon present`);
  }
});

test('nav.manifest: only partners.inbox has a chord (`g b`); no other entry has one', async () => {
  const { navManifest } = await loadManifest();
  for (const x of EXPECTED) assert.equal(navManifest.entries.find((n) => n.id === x.id)?.chord, x.chord, x.id);
});

test('nav.manifest: entries unique, ascending by order, each resolves to a non-parameterised staff_web route with the same permission', async () => {
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

test('build-nav CLI passes (done_when) across ALL feature manifests and emits the partners entries with their routes.yaml paths', () => {
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
  const dir = mkdtempSync(join(tmpdir(), 'c13-t01-'));
  mkdirSync(join(dir, 'partners'));
  writeFileSync(join(dir, 'partners', 'nav.manifest.ts'), readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8').replaceAll('partners.partner.manage', 'partners.bogus.manage'));
  const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.ok(errors.some((m: string) => /permission/.test(m)), `expected permission error, got ${JSON.stringify(errors)}`);
});

test('build-nav rejects a chord collision with another module (`g b` must stay unique)', async () => {
  const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'c13-t01-'));
  mkdirSync(join(dir, 'partners'));
  mkdirSync(join(dir, 'other'));
  writeFileSync(join(dir, 'partners', 'nav.manifest.ts'), readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8'));
  writeFileSync(join(dir, 'other', 'nav.manifest.ts'), `export const navManifest = { module: 'other', entries: [
    { id: 'other.x', label: 'other.nav.x', routeId: 'staff.partners.pickups', permission: 'partners.pickup.manage', group: 'partners', order: 1, chord: 'g b' } ] };
`);
  const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.ok(errors.some((m: string) => /duplicate shortcut chord "g b"/.test(m)), `expected chord clash, got ${JSON.stringify(errors)}`);
});

test('the real feature set has no chord/id collision with partners (`g b` is unique across every manifest)', () => {
  const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
  assert.doesNotMatch(r.stderr + r.stdout, /duplicate/);
});
