// C3.T-34 — nav entries + routes + page files for SCR-13…17 (04-UI-UX §1: paths and permissions are spec-fixed; entry ids/labels are [CONV]).
// ASSUMED: ids `catalog.{price_lists,price_simulator,surcharges,tax}`, routeIds `staff.<id>`, labels `catalog.nav.<suffix>`, group `catalog`, all `catalog.price_list.read`.
// Existing routes.yaml row `staff.catalog.price_list` (/catalog/price-lists/{price_list_id}) is reused for the SCR-13 detail; the SCR-14 version route is new.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const routes = (parse(readFileSync(join(WEB, '..', '..', 'contracts', 'routes.yaml'), 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string; owner?: string }[] }).routes;

const EXPECTED = [
  { id: 'catalog.price_lists', path: '/catalog/price-lists' },
  { id: 'catalog.price_simulator', path: '/catalog/price-simulator' },
  { id: 'catalog.surcharges', path: '/catalog/surcharges' },
  { id: 'catalog.tax', path: '/catalog/tax' },
] as const;
type Entry = { id: string; label: string; routeId: string; permission: string; group: string; order: number };
const load = async () => (await import('../nav.manifest')) as { navManifest: { module: string; entries: Entry[] } };

describe('catalog nav manifest (SCR-13…17)', () => {
  it('four entries (permission catalog.price_list.read) whose routes exist in routes.yaml (owner C3, staff_web, same path + permission)', async () => {
    const { navManifest } = await load();
    for (const x of EXPECTED) {
      const e = navManifest.entries.find((n) => n.id === x.id);
      expect(e, `entry ${x.id}`).toBeTruthy();
      expect(e!.routeId).toBe(`staff.${x.id}`);
      expect(e!.label).toBe(`catalog.nav.${x.id.slice('catalog.'.length)}`);
      expect(e!.permission).toBe('catalog.price_list.read');
      expect(e!.group).toBe('catalog');
      const r = routes.find((q) => q.id === e!.routeId);
      expect(r, `${e!.routeId} in routes.yaml`).toBeTruthy();
      expect(r!.origin).toBe('staff_web');
      expect(r!.path).toBe(x.path);
      expect(r!.permission).toBe('catalog.price_list.read');
      expect(r!.owner).toBe('C3');
    }
  });

  it('orders stay unique across the whole manifest', async () => {
    const { navManifest } = await load();
    const all = navManifest.entries.map((e) => e.order);
    expect(new Set(all).size).toBe(all.length);
  });

  it('SCR-13 detail + SCR-14 version-editor routes exist (path params normalised)', () => {
    const norm = (p: string) => p.replace(/\{[a-z_]+\}/g, '{x}');
    const paths = routes.filter((r) => r.owner === 'C3' && r.origin === 'staff_web').map((r) => norm(r.path));
    expect(paths).toContain('/catalog/price-lists/{x}');
    expect(paths).toContain('/catalog/price-lists/{x}/versions/{x}');
    const v = routes.find((r) => r.owner === 'C3' && norm(r.path) === '/catalog/price-lists/{x}/versions/{x}');
    expect(v!.permission).toBe('catalog.price_list.read');
  });

  it('build-nav CLI passes across ALL feature manifests and emits the four paths', () => {
    const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
    expect(r.status, `build-nav failed:\n${r.stderr}${r.stdout}`).toBe(0);
    const generated = readFileSync(join(WEB, 'src', 'core', 'nav', 'generated.ts'), 'utf8');
    for (const x of EXPECTED) {
      expect(generated).toContain(`"${x.id}"`);
      expect(generated).toContain(`"${x.path}"`);
    }
  });
});

describe('page files (02-CV §2.4 App Router: page.tsx per route)', () => {
  const dir = join(WEB, 'src', 'app', '(staff)', 'catalog');
  for (const p of ['price-lists/page.tsx', 'price-lists/[price_list_id]/page.tsx', 'price-lists/[price_list_id]/versions/[version_id]/page.tsx', 'price-simulator/page.tsx', 'surcharges/page.tsx', 'tax/page.tsx']) {
    it(`exists: ${p}`, () => expect(existsSync(join(dir, p))).toBe(true));
  }
});
