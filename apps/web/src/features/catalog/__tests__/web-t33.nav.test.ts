// C3.T-33 — nav entries + wording guard for SCR-09…12 (04-UI-UX §1: paths and permissions are spec-fixed; entry ids/labels are [CONV]).
// ASSUMED: ids `catalog.{panels,comment_codes,doctors,credit_parties}`, routeIds `staff.catalog.<same>`, labels `catalog.nav.<same>`, group `catalog`.
// Doctors need `catalog.referrer.read` (CR-C3-003); credit parties `catalog.price_list.read`; panels + comment codes `catalog.test.read`.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const routes = (parse(readFileSync(join(WEB, '..', '..', 'contracts', 'routes.yaml'), 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string; owner?: string }[] }).routes;

const EXPECTED = [
  { id: 'catalog.panels', path: '/catalog/panels', permission: 'catalog.test.read' },
  { id: 'catalog.comment_codes', path: '/catalog/comment-codes', permission: 'catalog.test.read' },
  { id: 'catalog.doctors', path: '/catalog/doctors', permission: 'catalog.referrer.read' },
  { id: 'catalog.credit_parties', path: '/catalog/credit-parties', permission: 'catalog.price_list.read' },
] as const;
type Entry = { id: string; label: string; routeId: string; permission: string; group: string; order: number };
const load = async () => (await import('../nav.manifest')) as { navManifest: { module: string; entries: Entry[] } };

describe('catalog nav manifest (SCR-09…12)', () => {
  it('four entries with spec-fixed paths + permissions; routes exist in routes.yaml (owner C3, staff_web)', async () => {
    const { navManifest } = await load();
    for (const x of EXPECTED) {
      const e = navManifest.entries.find((n) => n.id === x.id);
      expect(e, `entry ${x.id}`).toBeTruthy();
      expect(e!.routeId).toBe(`staff.${x.id}`);
      expect(e!.label).toBe(`catalog.nav.${x.id.slice('catalog.'.length)}`);
      expect(e!.permission).toBe(x.permission);
      const r = routes.find((q) => q.id === e!.routeId);
      expect(r, `${e!.routeId} in routes.yaml`).toBeTruthy();
      expect(r!.origin).toBe('staff_web');
      expect(r!.path).toBe(x.path);
      expect(r!.permission).toBe(x.permission);
      expect(r!.owner).toBe('C3');
    }
  });

  it('orders stay unique across the whole manifest (T-31 entries + these four)', async () => {
    const { navManifest } = await load();
    const all = navManifest.entries.map((e) => e.order);
    expect(new Set(all).size).toBe(all.length);
  });

  it('detail/verify routes exist for panels and doctors (parameterised routes are not nav entries)', () => {
    const paths = routes.filter((r) => r.owner === 'C3' && r.origin === 'staff_web').map((r) => r.path);
    for (const p of ['/catalog/panels/{panel_id}', '/catalog/doctors/{doctor_id}', '/catalog/doctors/verify', '/catalog/credit-parties/{credit_party_id}']) {
      expect(paths.some((x) => x === p || x.replace(/\{[a-z_]+\}/, '{x}') === p.replace(/\{[a-z_]+\}/, '{x}')), p).toBe(true);
    }
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

// AC-11.5 / S-17: no field, label, export column or event in C3 contains "commission" (04 L19). CI greps C3 paths; mirror it for the web paths of this task.
describe('wording guard (AC-11.5, S-17)', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' || n === 'node_modules' ? [] : walk(p)) : [p]; });
  it('no "commission" (any case) in apps/web catalog feature or catalog app routes (tests excluded)', () => {
    const files = [...walk(join(WEB, 'src', 'features', 'catalog')), ...walk(join(WEB, 'src', 'app', '(staff)', 'catalog'))];
    expect(files.length).toBeGreaterThan(10);
    const hits = files.filter((f) => /commission/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
