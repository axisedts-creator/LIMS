// C3.T-31 — nav manifest for SCR-01…05 (04-UI-UX §1 table; C0 04-UI-UX §3 build-nav rules).
// done_when: the manifest passes the C0 build check (`src/core/nav/build-nav.ts`) — which needs the five routes in contracts/routes.yaml (writer adds; CR-C3-006 era).
// ASSUMED names (spec fixes only paths + permissions): entry ids `catalog.{home,departments,specimens,methods,units}`, routeIds `staff.catalog.<same>`,
// labels `catalog.nav.<same>`, group `catalog`. SCR-01 route permission is `catalog.test.read` (routes.yaml carries ONE permission; the page itself also
// admits `catalog.price_list.read`, see the component tests). Later tasks (T-32+) append entries, so this file checks "at least these five".
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string; owner?: string }[] }).routes;

const EXPECTED = [
  { id: 'catalog.home', routeId: 'staff.catalog.home', path: '/catalog' },
  { id: 'catalog.departments', routeId: 'staff.catalog.departments', path: '/catalog/departments' },
  { id: 'catalog.specimens', routeId: 'staff.catalog.specimens', path: '/catalog/specimens' },
  { id: 'catalog.methods', routeId: 'staff.catalog.methods', path: '/catalog/methods' },
  { id: 'catalog.units', routeId: 'staff.catalog.units', path: '/catalog/units' },
] as const;

type Entry = { id: string; label: string; routeId: string; permission: string; group: string; order: number; chord?: string };
const load = async () => (await import('../nav.manifest')) as { navManifest: { module: string; entries: Entry[] } };

describe('catalog nav manifest (SCR-01…05)', () => {
  it('module=catalog with the five entries: label key, route, permission catalog.test.read, group catalog', async () => {
    const { navManifest } = await load();
    expect(navManifest.module).toBe('catalog');
    for (const x of EXPECTED) {
      const e = navManifest.entries.find((n) => n.id === x.id);
      expect(e, `entry ${x.id}`).toBeTruthy();
      expect(e!.routeId).toBe(x.routeId);
      expect(e!.label).toBe(`catalog.nav.${x.id.slice('catalog.'.length)}`);
      expect(e!.permission).toBe('catalog.test.read');
      expect(e!.group).toBe('catalog');
    }
  });

  it('home first, then departments, specimens, methods, units — unique ascending order', async () => {
    const { navManifest } = await load();
    const orders = EXPECTED.map((x) => navManifest.entries.find((n) => n.id === x.id)!.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    const all = navManifest.entries.map((e) => e.order);
    expect(new Set(all).size).toBe(all.length);
  });

  it('every entry resolves to a non-parameterised staff_web route in routes.yaml with the same permission; the five paths are the 04-UI-UX §1 paths', async () => {
    const { navManifest } = await load();
    for (const e of navManifest.entries) {
      const r = routes.find((x) => x.id === e.routeId);
      expect(r, `${e.routeId} in routes.yaml`).toBeTruthy();
      expect(r!.origin).toBe('staff_web');
      expect(r!.permission).toBe(e.permission);
      expect(r!.path.includes('{')).toBe(false);
    }
    for (const x of EXPECTED) {
      const r = routes.find((q) => q.id === x.routeId);
      expect(r?.path).toBe(x.path);
      expect(r?.owner).toBe('C3');
    }
  });

  it('chords, when present, are `g <letter>` and unique within the manifest', async () => {
    const { navManifest } = await load();
    const chords = navManifest.entries.map((e) => e.chord).filter((c): c is string => !!c);
    for (const c of chords) expect(c).toMatch(/^g [a-z]$/);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('build-nav CLI passes across ALL feature manifests (done_when) and emits the five catalog paths', () => {
    const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
    expect(r.status, `build-nav failed:\n${r.stderr}${r.stdout}`).toBe(0);
    const generated = readFileSync(join(WEB, 'src', 'core', 'nav', 'generated.ts'), 'utf8');
    for (const x of EXPECTED) {
      expect(generated).toContain(`"${x.id}"`);
      expect(generated).toContain(`"${x.path}"`);
    }
  });

  it('build-nav rejects a drifted catalog manifest (permission differs from route) — guards the done_when check itself', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
    const dir = mkdtempSync(join(tmpdir(), 'c3-t31-'));
    mkdirSync(join(dir, 'catalog'));
    writeFileSync(join(dir, 'catalog', 'nav.manifest.ts'), readFileSync(join(WEB, 'src', 'features', 'catalog', 'nav.manifest.ts'), 'utf8').replaceAll('catalog.test.read', 'catalog.bogus.read'));
    const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
    expect(errors.some((m: string) => /permission/.test(m)), JSON.stringify(errors)).toBe(true);
  });
});
