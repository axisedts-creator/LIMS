// C3.T-35 — nav entry + routes + page files for SCR-18 / SCR-19 (04-UI-UX §1: paths are spec-fixed; entry id/label/order are [CONV]).
// ASSUMED: id `catalog.imports`, routeId `staff.catalog.imports`, label `catalog.nav.imports`, group `catalog`. Permission = the API floor of every import/export
// operation, `catalog.test.read` (x-permission in contracts/openapi/catalog.yaml #96–#107); kind-dependent permissions are enforced inside the pages/BFF.
// The detail route (`/catalog/imports/{import_id}`) is not a nav entry. Page files per 02-CV §2.4: page.tsx + loading.tsx + error.tsx.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const routes = (parse(readFileSync(join(WEB, '..', '..', 'contracts', 'routes.yaml'), 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string; owner?: string }[] }).routes;
type Entry = { id: string; label: string; routeId: string; permission: string; group: string; order: number };
const load = async () => (await import('../nav.manifest')) as { navManifest: { module: string; entries: Entry[] } };
const app = (...p: string[]) => join(WEB, 'src', 'app', '(staff)', 'catalog', ...p);

describe('catalog nav manifest (SCR-18)', () => {
  it('entry catalog.imports → /catalog/imports with the API floor permission; route in routes.yaml (owner C3, staff_web)', async () => {
    const { navManifest } = await load();
    const e = navManifest.entries.find((n) => n.id === 'catalog.imports');
    expect(e, 'entry catalog.imports').toBeTruthy();
    expect(e!.routeId).toBe('staff.catalog.imports');
    expect(e!.label).toBe('catalog.nav.imports');
    expect(e!.group).toBe('catalog');
    expect(e!.permission).toBe('catalog.test.read');
    const r = routes.find((q) => q.id === 'staff.catalog.imports');
    expect(r, 'staff.catalog.imports in routes.yaml').toBeTruthy();
    expect([r!.origin, r!.path, r!.permission, r!.owner]).toEqual(['staff_web', '/catalog/imports', 'catalog.test.read', 'C3']);
  });

  it('orders stay unique across the whole manifest', async () => {
    const all = (await load()).navManifest.entries.map((e) => e.order);
    expect(new Set(all).size).toBe(all.length);
  });

  it('detail route /catalog/imports/{import_id} exists (owner C3, staff_web, not a nav entry)', async () => {
    const r = routes.find((x) => x.owner === 'C3' && x.origin === 'staff_web' && x.path.replace(/\{[a-z_]+\}/, '{x}') === '/catalog/imports/{x}');
    expect(r, '/catalog/imports/{import_id}').toBeTruthy();
    expect(r!.permission).toBe('catalog.test.read');
    const { navManifest } = await load();
    expect(navManifest.entries.some((e) => e.routeId === r!.id)).toBe(false);
  });

  it('build-nav CLI passes across ALL feature manifests and emits the path', () => {
    const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
    expect(r.status, `build-nav failed:\n${r.stderr}${r.stdout}`).toBe(0);
    const generated = readFileSync(join(WEB, 'src', 'core', 'nav', 'generated.ts'), 'utf8');
    expect(generated).toContain('"catalog.imports"');
    expect(generated).toContain('"/catalog/imports"');
  });
});

describe('pages and proxies exist (02-CV §2.4)', () => {
  it.each([['imports'], ['imports', '[import_id]']])('app/(staff)/catalog/%s has page.tsx + loading.tsx + error.tsx (error/loading may be inherited from catalog/)', (...seg) => {
    expect(existsSync(app(...seg, 'page.tsx')), `${seg.join('/')}/page.tsx`).toBe(true);
    for (const f of ['loading.tsx', 'error.tsx']) expect(existsSync(app(...seg, f)) || existsSync(app(f)), f).toBe(true);
  });

  it.each([['import-templates', '[kind]'], ['imports', '[import_id]', 'report'], ['exports', '[export_id]', 'file']])('download proxy app/(staff)/catalog/%s/route.ts exists and exports GET only', (...seg) => {
    const f = app(...seg, 'route.ts');
    expect(existsSync(f), f).toBe(true);
    const src = readFileSync(f, 'utf8');
    expect(src).toMatch(/export\s+(async\s+function|const)\s+GET\b/);
    expect(src).not.toMatch(/export\s+(async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/);
  });
});

// REQ-SEC-085: the browser never sees a storage URL; REQ-SEC-068: the bearer JWT never reaches client code.
describe('client bundle hygiene (REQ-SEC-068)', () => {
  const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : []);
  it('no component of the import/export screens imports server-fetch / session/server / node:crypto directly (they go through server actions)', () => {
    const comps = walk(join(WEB, 'src', 'features', 'catalog', 'components')).filter((f) => /Import|Export/i.test(f));
    expect(comps.length, 'Import*/Export* components exist').toBeGreaterThan(0);
    for (const f of comps) expect(readFileSync(f, 'utf8'), f).not.toMatch(/core\/api\/server-fetch|core\/session\/server|node:crypto|LIMS_ORIGIN_API/);
  });
});
