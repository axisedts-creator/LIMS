// HC-T18 — nav manifest apps/web/src/features/homecollection/nav.manifest.ts (04-UI-UX §1 verbatim; routes.yaml CR-C17-009; C0 build-nav rules).
// done_when ("nav"): the manifest passes the C0 build check across ALL feature manifests (ids, chords `g h` / `g t` unique, routeId + permission equal routes.yaml).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { buildNav } from '../../../core/nav/build-nav.ts';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const FEATURES = join(WEB, 'src', 'features');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string }[] }).routes;

// 04-UI-UX §1, verbatim.
const EXPECTED = [
  { id: 'homecollection.dispatch', label: 'homecollection.nav.dispatch', routeId: 'staff.homecollection.dispatch', permission: 'homecollection.visit.read', order: 10, chord: 'g h' },
  { id: 'homecollection.handovers', label: 'homecollection.nav.handovers', routeId: 'staff.homecollection.handovers', permission: 'homecollection.handover.receive', order: 20, chord: 'g t' },
  { id: 'homecollection.devices', label: 'homecollection.nav.devices', routeId: 'staff.homecollection.devices', permission: 'homecollection.device.manage', order: 30, chord: undefined },
  { id: 'homecollection.settings', label: 'homecollection.nav.settings', routeId: 'staff.homecollection.settings', permission: 'homecollection.settings.manage', order: 40, chord: undefined },
] as const;

async function loadManifest() {
  const file = join(FEATURES, 'homecollection', 'nav.manifest.ts');
  expect(existsSync(file), `missing ${file}`).toBe(true);
  return (await import(pathToFileURL(file).href)) as { navManifest: { module: string; entries: Record<string, unknown>[] } };
}

describe('nav.manifest (04-UI-UX §1)', () => {
  it('module=homecollection with the four §1 entries, verbatim ids / label keys / routes / permissions / group / order / phase', async () => {
    const { navManifest } = await loadManifest();
    expect(navManifest.module).toBe('homecollection');
    expect(navManifest.entries).toHaveLength(EXPECTED.length);
    for (const x of EXPECTED) {
      const e = navManifest.entries.find((n) => n.id === x.id);
      expect(e, `entry ${x.id}`).toBeTruthy();
      expect(e!.label).toBe(x.label);
      expect(e!.routeId).toBe(x.routeId);
      expect(e!.permission).toBe(x.permission);
      expect(e!.group).toBe('home_collection');
      expect(e!.order).toBe(x.order);
      expect(e!.phase).toBe('3');
      expect(typeof e!.icon === 'string' && (e!.icon as string).length > 0, `${x.id}: icon present`).toBe(true);
    }
  });

  it('chords: dispatch `g h`, handovers `g t` (`g o` is C8\'s — review #19); devices and settings have none', async () => {
    const { navManifest } = await loadManifest();
    for (const x of EXPECTED) expect(navManifest.entries.find((n) => n.id === x.id)?.chord, x.id).toBe(x.chord);
  });

  it('every entry resolves to a non-parameterised staff_web route with the same permission (routes.yaml CR-C17-009)', async () => {
    const { navManifest } = await loadManifest();
    for (const e of navManifest.entries) {
      const r = routes.find((x) => x.id === e.routeId);
      expect(r, `${String(e.routeId)} in routes.yaml`).toBeTruthy();
      expect(r!.origin).toBe('staff_web');
      expect(r!.permission).toBe(e.permission);
      expect(r!.path.includes('{')).toBe(false);
    }
    expect(routes.find((x) => x.id === 'staff.homecollection.dispatch')?.path).toBe('/homecollection/dispatch');
  });

  it('the C0 build check passes across ALL feature manifests (no duplicate id / chord, no drift) and emits the dispatch entry with its path', async () => {
    const { errors, entries } = await buildNav(FEATURES, readFileSync(ROUTES_YAML, 'utf8'));
    expect(errors).toEqual([]);
    const d = entries.find((e) => e.id === 'homecollection.dispatch');
    expect(d?.path).toBe('/homecollection/dispatch');
    expect(entries.filter((e) => e.group === 'home_collection').map((e) => e.id)).toEqual(EXPECTED.map((x) => x.id));
  });

  it('nav visibility is permission-driven: a dispatcher-only user sees only "Home visits" (entry permission is the one the page checks)', async () => {
    const { navManifest } = await loadManifest();
    const perms = new Set(['homecollection.visit.read', 'homecollection.visit.assign']);
    expect(navManifest.entries.filter((e) => perms.has(e.permission as string)).map((e) => e.id)).toEqual(['homecollection.dispatch']);
  });
});
