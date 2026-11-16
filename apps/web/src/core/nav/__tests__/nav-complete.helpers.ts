// T0D-NAV-COMPLETE-1 shared test helpers (tester-owned). LD-250: every nav table of the chunk specs gets a manifest entry,
// but ONLY when its page exists under apps/web/src/app/(staff); a missing page is listed in a non-blocking CR and never stubbed.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

export const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
export const ROOT = join(WEB, '..', '..');
export const FEATURES = join(WEB, 'src', 'features');
export const ROUTES_YAML = readFileSync(join(ROOT, 'contracts', 'routes.yaml'), 'utf8');

export interface RouteRow { id: string; origin: string; path: string; permission?: string; owner?: string }
export const routes = (parse(ROUTES_YAML) as { routes: RouteRow[] }).routes;

export interface Entry { id: string; label: string; routeId: string; permission: string; group: string; order: number; chord?: string; phase?: string }

/** One row of a chunk-spec navigation table, copied into the test (the test is the second copy of the spec). */
export interface SpecRow {
  name: string;          // English entry name (spec table, or the founder board for C4 where the spec only names the screen)
  path: string;          // non-parameterised spec path
  permission: string;
  group: string;
  order?: number;        // fixed by the spec table (C15, C16); otherwise [CONV]: see orderRange / the C4 and C5 notes
  orderRange?: readonly [number, number]; // exclusive bounds
  id?: string;           // spec-fixed id (C15, C16)
  routeId?: string;      // spec-fixed route id (C15, C16)
  phase?: string;
}

/** Page file of a staff path: apps/web/src/app/(staff)<path>/page.tsx */
export const pageExists = (path: string) => existsSync(join(WEB, 'src', 'app', '(staff)', ...path.split('/').filter(Boolean), 'page.tsx'));

export const loadManifest = async (module: string) => {
  const file = join(FEATURES, module, 'nav.manifest.ts');
  expect(existsSync(file), `${file} must exist`).toBe(true);
  const m = (await import(pathToFileURL(file).href)) as { navManifest: { module: string; entries: Entry[] } };
  return m.navManifest;
};

const crDir = join(ROOT, '.orchestra', 'cr');
export const nonBlockingCrText = () =>
  existsSync(crDir)
    ? readdirSync(crDir)
        .filter((f) => /^T0D-NAV-COMPLETE-1\.\d+\.nonblocking\.md$/.test(f))
        .map((f) => readFileSync(join(crDir, f), 'utf8'))
        .join('\n')
    : '';

const routeByPath = (path: string) => routes.filter((r) => r.origin === 'staff_web' && r.path === path);

/**
 * Registers the standard per-feature checks. `exact` = the manifest holds exactly the spec rows whose page exists
 * (catalog adds one row to an existing manifest, so it passes exact:false and has its own test file).
 */
export function specSuite(opts: { module: string; owner: string; section: string; rows: readonly SpecRow[]; exact?: boolean }) {
  const { module, owner, section, rows, exact = true } = opts;
  const present = rows.filter((r) => pageExists(r.path));
  const missing = rows.filter((r) => !pageExists(r.path));

  describe(`${module} nav manifest vs ${section}`, () => {
    it('manifest exists, module name = directory, entry ids are <module>.<snake> and unique', async () => {
      const m = await loadManifest(module);
      expect(m.module).toBe(module);
      const ids = m.entries.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(new RegExp(`^${module}\\.[a-z0-9_]+$`));
    });

    for (const row of present) {
      it(`${row.name} (${row.path}): entry has the spec permission, group and order; route is staff_web with the same permission and owner ${owner}`, async () => {
        const m = await loadManifest(module);
        const rts = routeByPath(row.path);
        expect(rts.length, `routes.yaml needs ONE non-parameterised staff_web row for ${row.path}`).toBe(1);
        const route = rts[0]!;
        expect(route.permission).toBe(row.permission);
        expect(route.owner).toBe(owner);
        if (row.routeId) expect(route.id).toBe(row.routeId);
        const e = m.entries.find((x) => x.routeId === route.id);
        expect(e, `manifest entry for ${route.id}`).toBeTruthy();
        expect(e!.permission).toBe(row.permission);
        expect(e!.group).toBe(row.group);
        if (row.order !== undefined) expect(e!.order).toBe(row.order);
        if (row.orderRange) {
          expect(e!.order).toBeGreaterThan(row.orderRange[0]);
          expect(e!.order).toBeLessThan(row.orderRange[1]);
        }
        if (row.id) expect(e!.id).toBe(row.id);
        if (row.phase) expect(e!.phase).toBe(row.phase);
        expect(e!.label, 'label is a message key').toMatch(/(^|\.)nav\./);
      });
    }

    if (exact) {
      it('the manifest holds exactly the spec rows whose page exists (no extras, no stubs for missing pages)', async () => {
        const m = await loadManifest(module);
        const paths = m.entries.map((e) => routes.find((r) => r.id === e.routeId)?.path).sort();
        expect(paths).toEqual(present.map((r) => r.path).sort());
      });
      it('entries are in the spec order and orders are unique inside the manifest', async () => {
        const m = await loadManifest(module);
        const orders = m.entries.map((e) => e.order);
        expect(new Set(orders).size).toBe(orders.length);
        const bySpec = [...m.entries].sort((a, b) => a.order - b.order).map((e) => routes.find((r) => r.id === e.routeId)?.path);
        expect(bySpec).toEqual(present.map((r) => r.path)); // `present` is listed in spec-table order
      });
    }

    for (const row of missing) {
      it(`${row.name} (${row.path}): page does not exist -> NO entry (never stubbed) and a non-blocking CR names the path`, async () => {
        const m = await loadManifest(module);
        const stray = m.entries.filter((e) => routes.find((r) => r.id === e.routeId)?.path === row.path);
        expect(stray, 'entry for a page that does not exist').toEqual([]);
        const cr = nonBlockingCrText();
        expect(cr, '.orchestra/cr/T0D-NAV-COMPLETE-1.<n>.nonblocking.md must exist').not.toBe('');
        expect(cr).toContain(row.path);
        expect(cr).toContain(section.split(' ')[0]!); // chunk id of the spec section, e.g. C4
      });
    }
  });
}
