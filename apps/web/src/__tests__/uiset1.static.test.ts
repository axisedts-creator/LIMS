// T0D-UISETTINGS-1 static checks (LD-353 template 4 SETTINGS). Source and notes only; the rendered contract is in features/*/__tests__/uiset1.*.test.tsx.
// Pinned: every settings screen of the done_when list builds on the kit SettingsForm (imported from '@lims/ui/components/SettingsForm' somewhere in its settings folder);
// the screens table of the task notes lists every route (done_when: "FIRST write notes/ ... -screens.md with one row per screen you touch"); the files other tasks or the rs-c2.static pin are untouched.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/
const root = join(web, '..', '..');
const src = (...p: string[]) => join(web, 'src', ...p);
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? (n === '__tests__' ? [] : walk(f)) : /\.tsx?$/.test(n) ? [f] : []; });
const KIT = /from\s+['"]@lims\/ui\/components\/SettingsForm['"]/;

// route -> the folder(s) that draw the form
const SCREENS: [string, string[]][] = [
  ['/frontdesk/settings', ['features/frontdesk/settings']],
  ['/engagement/settings', ['features/engagement/settings']],
  ['/homecollection/settings', ['features/homecollection/components/SettingsForm.tsx']],
  ['/instruments/settings', ['features/instruments/components/InstrumentSettingsForm.tsx']],
  ['/inventory/settings', ['features/inventory/components/SettingsForm.tsx']],
  ['/lab/settings', ['features/lab/components/settings']],
  ['/micro/settings', ['features/micro/components/settings']],
  ['/partners/settings', ['features/partners/components/PartnerSettings.tsx']],
  ['/payments/settings', ['features/payments/components/SettingsView.tsx']],
  ['/quality/settings', ['features/quality/settings']],
  ['/anatomic/config', ['features/anatomic/components/config']],
];

describe('T0D-UISETTINGS-1 static', () => {
  it.each(SCREENS)('%s is built on the kit SettingsForm', (_route, where) => {
    const files = where.flatMap((w) => { const p = src(w); return statSync(p).isDirectory() ? walk(p) : [p]; });
    expect(files.some((f) => KIT.test(readFileSync(f, 'utf8'))), `none of ${where.join(', ')} imports @lims/ui/components/SettingsForm`).toBe(true);
  });

  it('no settings screen draws its own width or column layout (inline style width / maxWidth / gridTemplateColumns)', () => {
    const files = SCREENS.flatMap(([, where]) => where.flatMap((w) => { const p = src(w); return statSync(p).isDirectory() ? walk(p) : [p]; }));
    const bad = files.filter((f) => /style=\{\{[^}]*\b(width|maxWidth|gridTemplateColumns)\b/.test(readFileSync(f, 'utf8')));
    expect(bad.map((f) => f.replace(web, '')), 'layout comes from the kit SettingsForm CSS').toEqual([]);
  });

  it('the screens notes exist and list every route (one row per screen touched)', () => {
    const f = join(root, '.orchestra', 'notes', 'T0D-UISETTINGS-1-screens.md');
    expect(existsSync(f), 'notes/T0D-UISETTINGS-1-screens.md').toBe(true);
    const md = readFileSync(f, 'utf8');
    for (const [route] of SCREENS) expect(md, `row for ${route}`).toContain(route);
    expect(md, 'the screens left to another task (billing and reporting settings: T0D-PRINTCFG-1) are named').toMatch(/PRINTCFG-1/);
  });

  it('pinned and foreign files get no SettingsForm edit: admin, platform and auth pages, billing and reporting settings forms', () => {
    const untouched = ['features/billing/components/BillingSettingsForm.tsx', 'features/reporting/components/ReportingSettingsForm.tsx'];
    for (const f of untouched) expect(KIT.test(readFileSync(src(f), 'utf8')), `${f} belongs to T0D-PRINTCFG-1`).toBe(false);
    for (const dir of ['features/admin', 'features/platform']) expect(walk(src(dir)).filter((f) => KIT.test(readFileSync(f, 'utf8'))), `${dir} is pinned by rs-c2.static`).toEqual([]);
  });
});
