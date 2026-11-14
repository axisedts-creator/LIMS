// C14.T18 — nav manifest `features/smartreport/nav.manifest.ts` (04-UI-UX §1, verbatim) validated by core/nav/build-nav.ts (C0 04-UI-UX §3).
// §1 entries: Smart summaries /smartreport/summaries (smartreport.summary.read); Smart report library /smartreport/library and Smart report wording
// /smartreport/wording (both smartreport.template.manage). ids/labels/group are not given by §1: ASSUMED `smartreport.<snake>` ids and `smartreport.nav.<snake>` label keys.
// CONTRACT GAP: contracts/routes.yaml has no non-parameterised staff_web route for these three paths (only staff.smartreport.summary with {summary_id}), and
// build-nav rejects any routeId that is missing or parameterised. The writer must raise a CR for the three route rows. Until it lands, this test validates the
// manifest against routes.yaml PLUS synthetic rows (path/permission from §1) for routeIds that are not in routes.yaml, so it pins everything else.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const WEB = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const FEATURE = join(WEB, 'src', 'features', 'smartreport');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const GROUPS = ['front_desk', 'laboratory', 'reporting', 'billing', 'catalog', 'instruments', 'analytics', 'quality', 'inventory', 'partners', 'engagement', 'home_collection', 'admin', 'platform'];

const SPEC = [
  { path: '/smartreport/summaries', permission: 'smartreport.summary.read', labelEnd: 'summaries' },
  { path: '/smartreport/library', permission: 'smartreport.template.manage', labelEnd: 'library' },
  { path: '/smartreport/wording', permission: 'smartreport.template.manage', labelEnd: 'wording' },
] as const;

type Entry = Record<string, unknown>;
async function manifest() {
  const file = join(FEATURE, 'nav.manifest.ts');
  expect(existsSync(file), `missing ${file}`).toBe(true);
  return ((await import(/* @vite-ignore */ pathToFileURL(file).href)) as { navManifest: { module: string; entries: Entry[] } }).navManifest;
}
const buildNav = async () => ((await import(/* @vite-ignore */ pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href)) as { buildNav: (dir: string, yaml: string) => Promise<{ errors: string[]; entries: { id: string; path: string; permission: string }[] }> }).buildNav;

/** routes.yaml text + synthetic rows for any manifest routeId the real file lacks (path/permission looked up from §1 by the entry's index). */
function withSyntheticRoutes(entries: Entry[]) {
  const base = readFileSync(ROUTES_YAML, 'utf8');
  const have = new Set(Array.from(base.matchAll(/id:\s*([A-Za-z0-9_.]+)/g)).map((m) => m[1]));
  const extra = entries.filter((e) => !have.has(String(e.routeId))).map((e) => {
    const spec = SPEC.find((s) => String(e.label).endsWith(`.${s.labelEnd}`));
    return `  - { id: ${String(e.routeId)}, origin: staff_web, path: "${spec?.path ?? '/unknown'}", owner: C14, permission: ${spec?.permission ?? 'x'} }`;
  });
  return base.trimEnd() + '\n' + extra.join('\n') + '\n';
}

describe('smartreport nav manifest', () => {
  it('module = smartreport with exactly the three §1 entries (summary detail SR-02 is not a nav entry)', async () => {
    const m = await manifest();
    expect(m.module).toBe('smartreport');
    expect(m.entries).toHaveLength(3);
  });

  it('labels are message keys smartreport.nav.{summaries,library,wording}; ids are unique smartreport.*; permission per §1; group is a known NavGroup; icon present', async () => {
    const m = await manifest();
    const ids = m.entries.map((e) => String(e.id));
    expect(new Set(ids).size).toBe(3);
    for (const s of SPEC) {
      const e = m.entries.find((x) => x.label === `smartreport.nav.${s.labelEnd}`);
      expect(e, `entry for ${s.labelEnd}`).toBeTruthy();
      expect(String(e!.id)).toMatch(/^smartreport\.[a-z_]+$/);
      expect(e!.permission).toBe(s.permission);
      expect(GROUPS).toContain(e!.group);
      expect(typeof e!.icon === 'string' && (e!.icon as string).length > 0).toBe(true);
    }
  });

  it('order is ascending in §1 order (summaries, library, wording) and chords (if any) are `g <letter>` and unique', async () => {
    const m = await manifest();
    const bySpec = SPEC.map((s) => m.entries.find((x) => x.label === `smartreport.nav.${s.labelEnd}`)!);
    const orders = bySpec.map((e) => e.order as number);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(3);
    const chords = m.entries.map((e) => e.chord).filter(Boolean) as string[];
    for (const c of chords) expect(c).toMatch(/^g [a-z]$/);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('passes build-nav together with ALL other feature manifests (no id/chord collision, permission == route permission, no parameterised route)', async () => {
    const m = await manifest();
    const { errors, entries } = await (await buildNav())(join(WEB, 'src', 'features'), withSyntheticRoutes(m.entries));
    expect(errors).toEqual([]);
    for (const s of SPEC) expect(entries.some((e) => e.path === s.path && e.permission === s.permission), s.path).toBe(true);
  });

  it('build-nav rejects a drifted manifest (permission differs from the route) — guards the check itself', async () => {
    const m = await manifest();
    const dir = mkdtempSync(join(tmpdir(), 'sr-t18-'));
    mkdirSync(join(dir, 'smartreport'));
    const drifted = { module: 'smartreport', entries: m.entries.map((e) => ({ ...e, permission: 'smartreport.bogus.perm' })) };
    writeFileSync(join(dir, 'smartreport', 'nav.manifest.ts'), `export const navManifest = ${JSON.stringify(drifted)};\n`);
    const { errors } = await (await buildNav())(dir, withSyntheticRoutes(m.entries));
    expect(errors.some((x) => /permission/.test(x))).toBe(true);
  });
});
