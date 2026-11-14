// C11.T-19 — nav manifest (04-UI-UX §1, verbatim) + help files (04-UI-UX header: "Every page has PageHeader with a helpKey and a help file … build fails otherwise").
// Ruling C10.T-01 precedent: build-nav is run over the anatomic manifest alone (repo-wide failures on other modules' routeIds are not this task's).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WEB = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const FEATURE = join(WEB, 'src', 'features', 'anatomic');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string }[] }).routes;

const EXPECTED = [
  { id: 'anatomic.worklist', label: 'anatomic.nav.worklist', routeId: 'staff.anatomic.worklist', permission: 'anatomic.case.read', order: 60, chord: 'g p' },
  { id: 'anatomic.tracking', label: 'anatomic.nav.tracking', routeId: 'staff.anatomic.tracking', permission: 'anatomic.case.read', order: 61, chord: 'g t' },
  { id: 'anatomic.batches', label: 'anatomic.nav.batches', routeId: 'staff.anatomic.batches', permission: 'anatomic.case.read', order: 62, chord: undefined },
  { id: 'anatomic.config', label: 'anatomic.nav.config', routeId: 'staff.anatomic.config', permission: 'anatomic.config.manage', order: 63, chord: undefined },
] as const;

const loadManifest = async () => {
  const file = join(FEATURE, 'nav.manifest.ts');
  expect(existsSync(file), `missing ${file}`).toBe(true);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { navManifest: { module: string; entries: Record<string, unknown>[] } };
};
const buildNav = async () => (await import(/* @vite-ignore */ pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href)).buildNav as (dir: string, yaml: string) => Promise<{ errors: string[]; entries: { id: string; path: string }[] }>;
const scratch = (manifest: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'c11-t19-'));
  mkdirSync(join(dir, 'anatomic'));
  writeFileSync(join(dir, 'anatomic', 'nav.manifest.ts'), manifest);
  return dir;
};

describe('nav.manifest.ts', () => {
  it('module=anatomic with exactly the four §1 entries, verbatim id/label/routeId/permission/group/order/chord/phase', async () => {
    const { navManifest } = await loadManifest();
    expect(navManifest.module).toBe('anatomic');
    expect(navManifest.entries).toHaveLength(EXPECTED.length);
    for (const x of EXPECTED) {
      const e = navManifest.entries.find((n) => n.id === x.id);
      expect(e, x.id).toBeTruthy();
      expect(e).toMatchObject({ label: x.label, routeId: x.routeId, permission: x.permission, group: 'laboratory', order: x.order, phase: '2' });
      expect(e!['chord']).toBe(x.chord);
    }
  });

  it('entries are unique, ascending by order, and resolve to non-parameterised staff_web routes with the same permission', async () => {
    const { navManifest } = await loadManifest();
    const ids = navManifest.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = navManifest.entries.map((e) => e['order'] as number);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    for (const e of navManifest.entries) {
      const r = routes.find((x) => x.id === e['routeId']);
      expect(r, String(e['routeId'])).toBeTruthy();
      expect(r!.origin).toBe('staff_web');
      expect(r!.permission).toBe(e['permission']);
      expect(r!.path.includes('{'), `${String(e['id'])}: detail pages are not nav entries`).toBe(false);
    }
  });

  it('build-nav passes (done_when) over the anatomic manifest alone against the real routes.yaml, paths /anatomic …', async () => {
    const { navManifest } = await loadManifest();
    expect(navManifest).toBeTruthy();
    const { errors, entries } = await (await buildNav())(scratch(readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8')) as never, readFileSync(ROUTES_YAML, 'utf8'));
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(EXPECTED.length);
    expect(entries.find((e) => e.id === 'anatomic.worklist')!.path).toBe('/anatomic');
  });

  it('build-nav rejects a drifted manifest (guards the check itself): wrong permission and a chord clash are both reported', async () => {
    const src = readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8');
    const b = await buildNav();
    const drift = await b(scratch(src.replaceAll('anatomic.config.manage', 'anatomic.bogus.manage')), readFileSync(ROUTES_YAML, 'utf8'));
    expect(drift.errors.some((m) => /permission/.test(m)), JSON.stringify(drift.errors)).toBe(true);
    const dir = scratch(src);
    mkdirSync(join(dir, 'other'));
    writeFileSync(join(dir, 'other', 'nav.manifest.ts'), `export const navManifest = { module: 'other', entries: [ { id: 'other.x', label: 'other.nav.x', routeId: 'staff.anatomic.config', permission: 'anatomic.config.manage', group: 'laboratory', order: 90, chord: 'g p' } ] };\n`);
    const clash = await b(dir, readFileSync(ROUTES_YAML, 'utf8'));
    expect(clash.errors.some((m) => /duplicate shortcut chord "g p"/.test(m)), JSON.stringify(clash.errors)).toBe(true);
  });
});

describe('help files (helpKey -> features/anatomic/help/<key>.ts, HelpPanel shape)', () => {
  it.each(['anatomic.worklist', 'anatomic.case'])('help/%s.ts', async (key) => {
    const file = join(FEATURE, 'help', `${key}.ts`);
    expect(existsSync(file), `missing ${file}`).toBe(true);
    const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, any>;
    const h = mod['default'] ?? Object.values(mod)[0];
    expect(typeof h?.title === 'string' && h.title.trim()).toBeTruthy();
    expect(Array.isArray(h.sections) && h.sections.length > 0).toBe(true);
    for (const s of h.sections) { expect(String(s.heading).trim()).not.toBe(''); expect(String(s.body).trim()).not.toBe(''); }
    for (const s of h.shortcuts ?? []) { expect(s.keys).toBeTruthy(); expect(s.action).toBeTruthy(); }
    for (const l of h.links ?? []) { expect(routes.some((r) => r.id === l.routeId), l.routeId).toBe(true); expect(String(l.label).trim()).not.toBe(''); }
  });

  it('worklist help advertises Alt+F; case help advertises the §3 case keys; neither advertises a global key', async () => {
    const wl = (await import(/* @vite-ignore */ pathToFileURL(join(FEATURE, 'help', 'anatomic.worklist.ts')).href)).default;
    const cs = (await import(/* @vite-ignore */ pathToFileURL(join(FEATURE, 'help', 'anatomic.case.ts')).href)).default;
    const keys = (h: { shortcuts?: { keys: string }[] }) => (h.shortcuts ?? []).map((s) => s.keys);
    expect(keys(wl)).toContain('Alt+F');
    for (const k of ['Alt+O', 'Alt+G', 'Alt+S']) expect(keys(cs), k).toContain(k);
    for (const k of [...keys(wl), ...keys(cs)]) expect(['Alt+N', 'Alt+M', 'Alt+H', '?', 'Escape']).not.toContain(k);
  });
});
