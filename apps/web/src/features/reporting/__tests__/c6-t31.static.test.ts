// C6-T31 static guards (node env). Spec: 04-UI-UX §1 (every page has loading.tsx / error.tsx; PHI never in storage; kit-only components),
// §2 (routes), 02-CV §1.3 (no dangerouslySetInnerHTML in feature code), contracts/routes.yaml (staff.reporting.*), plan row C6-T31 (nav manifest).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNav } from '../../../core/nav/build-nav.ts';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const repo = join(web, '..', '..');
const app = join(web, 'src', 'app', '(staff)', 'reporting');
const feat = join(web, 'src', 'features', 'reporting');
const routesYaml = readFileSync(join(repo, 'contracts', 'routes.yaml'), 'utf8');

// 04-UI-UX §2.1–§2.8 + #31 (delivery detail page). Templates/deliveries LISTS have no routes.yaml row (billing precedent, CR-C4-013): pages must self-guard (see pages test).
const PAGES = [
  '', 'reports/[report_id]', 'outsourced', 'narratives/[narrative_id]', 'deliveries', 'deliveries/[delivery_id]',
  'templates', 'templates/[template_id]', 'messages', 'settings',
];
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return n === '__tests__' || n === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const pageFile = (p: string) => join(app, ...p.split('/').filter(Boolean), 'page.tsx');
/** nearest loading/error file from the page dir up to (and including) the reporting segment */
const nearest = (p: string, name: string) => {
  let d = dirname(pageFile(p));
  for (;;) {
    const f = join(d, name);
    if (existsSync(f)) return f;
    if (d === app || d === dirname(d)) return undefined;
    d = dirname(d);
  }
};

describe('C6-T31 routes (04-UI-UX §2)', () => {
  it.each(PAGES)('reporting/%s/page.tsx exists', (p) => {
    expect(existsSync(pageFile(p))).toBe(true);
  });

  it.each(PAGES)('page "%s" has a loading.tsx and an error.tsx (own or inherited from a reporting segment)', (p) => {
    expect(nearest(p, 'loading.tsx'), 'loading.tsx').toBeTruthy();
    const err = nearest(p, 'error.tsx');
    expect(err, 'error.tsx').toBeTruthy();
    const src = readFileSync(err!, 'utf8');
    expect(src).toMatch(/^['"]use client['"]/m);
    expect(src).not.toMatch(/error\.message|error\.stack/); // never print the raw message/stack (PHI/internal detail)
    expect(src).toMatch(/digest/);
  });

  it('every reporting page is a server component and reads only through features/reporting/server (02-CONVENTIONS §2.4)', () => {
    for (const p of PAGES) {
      const f = pageFile(p);
      if (!existsSync(f)) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, p).not.toMatch(/^['"]use client['"]/m);
      expect(src, p).not.toMatch(/\bfetch\(/);
    }
  });

  it('no page puts a patient name or registration no. in the tab title (04-UI-UX §1 PHI rule)', () => {
    for (const f of walk(app).filter((x) => /page\.tsx$/.test(x))) {
      const src = readFileSync(f, 'utf8');
      if (/generateMetadata|export const metadata/.test(src)) expect(src, f).not.toMatch(/patient_display_name|registration_no/);
    }
  });
});

describe('C6-T31 code hygiene (02-CV §1.3, 04-UI-UX §1)', () => {
  const files = () => [...walk(feat), ...walk(app)].filter((f) => /\.(tsx?|mjs)$/.test(f));
  it('feature code exists to scan (non-vacuous)', () => {
    expect(files().length).toBeGreaterThan(10);
  });
  it('no localStorage/sessionStorage/document.cookie (PHI never in browser storage)', () => {
    for (const f of files()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
  it('no dangerouslySetInnerHTML: signed narrative HTML is rendered through the kit SafeHtml/RichTextEditor only', () => {
    for (const f of files()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML/);
  });
  it('client components never touch the access token or call fetch (writes go through server actions)', () => {
    const clients = files().filter((x) => /^['"]use client['"]/m.test(readFileSync(x, 'utf8')));
    expect(clients.length).toBeGreaterThan(0);
    for (const f of clients) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/getAccessToken|LIMS_ORIGIN_API|authorization/i);
      expect(src, f).not.toMatch(/\bfetch\(/);
    }
  });
  it('the scanned barcode is never put into a URL (04-UI-UX §1.2, C0 §2.4 rule 6)', () => {
    for (const f of files()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/[?&]barcode=/);
  });
  it('server actions file exists and is a "use server" module', () => {
    const f = join(feat, 'server', 'actions.ts');
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/^['"]use server['"]/m);
  });
});

describe('C6-T31 nav.manifest.ts (plan row: "nav manifest")', () => {
  const load = async () => (await import('../nav.manifest.ts')).navManifest;
  const PARAMETERLESS = ['staff.reporting.worklist', 'staff.reporting.outsourced', 'staff.reporting.messages', 'staff.reporting.settings'];
  const permOf = (id: string) => new RegExp(`id:\\s*${id.replace(/\./g, '\\.')},[^}]*permission:\\s*([a-z_.]+)`).exec(routesYaml)?.[1];

  it('module reporting; one entry per parameterless staff_web route; permission equals the route\'s', async () => {
    const m = await load();
    expect(m.module).toBe('reporting');
    expect(m.entries.map((e) => e.routeId).sort()).toEqual([...PARAMETERLESS].sort());
    for (const e of m.entries) {
      expect(e.id).toMatch(/^reporting\.[a-z0-9_]+$/);
      expect(e.label).toMatch(/^nav\.reporting\.[a-z0-9_]+$/);
      expect(e.group).toBe('reporting');
      expect(e.permission).toBe(permOf(e.routeId));
    }
  });

  it('build-nav accepts it (routeId in routes.yaml, staff_web, same permission, unique ids)', async () => {
    const m = await load();
    const { errors, entries } = await buildNav(join(web, 'src', 'features'), routesYaml);
    expect(errors.filter((e) => /reporting/.test(e))).toEqual([]);
    expect(entries.filter((e) => e.module === 'reporting').length).toBe(m.entries.length);
  });

  it('does not import from another feature folder (REQ-ARCH-076)', () => {
    const src = readFileSync(join(feat, 'nav.manifest.ts'), 'utf8');
    expect(/from\s+['"][^'"]*\/features\/(?!reporting\b)[a-z_]+\//.test(src)).toBe(false);
  });
});
