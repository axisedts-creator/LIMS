// T0D-SALES-1 static checks (tester-owned; node environment, no rendering). What these pin (done_when 1, 2, 4, 5 and the LD-353 / LD-321 rules):
//   - the first walk is written down (done_when 1): .orchestra/notes/T0D-SALES-1-walk.md names the ElabAssist screens and what is missing;
//   - four new staff routes under partners/sales (page files, contracts/routes.yaml rows, partners nav entries) registered the way T0D-ACCT-1 registers its routes;
//   - no new library (tree, chart, table, state), BFF only: typed calls in server-only files, writes carry an Idempotency-Key (POST) or If-Match (PATCH / deactivate / unassign), ids shape checked;
//   - client components never fetch the API themselves and import *.server modules for types only; money is integer paisa end to end (no float parsing or printing);
//   - text from the message catalogue (partners.sales.*), no exclamation marks, the permission reason names partners.sales.manage; only known permission codes appear;
//   - nothing under features/admin, features/platform, app/(auth), app/(platform) is touched by name (rs-c2.static pins them) and no admin / platform route is added.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const SRC = join(WEB, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? (e === '__tests__' || e === 'node_modules' ? [] : walk(p)) : [p]; }) : []);
const rel = (p: string) => relative(WEB, p).split('\\').join('/');
const code = (f: string) => /\.(ts|tsx)$/.test(f);
const PARTNERS = walk(join(SRC, 'features', 'partners')).filter(code);
const HOMEC = walk(join(SRC, 'features', 'homecollection')).filter(code).filter((f) => !f.includes(`${join('features', 'homecollection', 'tests')}`));
const SALES_PAGES = ['designations', 'representatives', 'clients', 'areas'].map((r) => join(SRC, 'app', '(staff)', 'partners', 'sales', r, 'page.tsx'));

/** The sales files: server / component files of features/partners that talk about the sales operations or screens, plus the homecollection files that carry the collector flags. */
const SERVER_MARK = /admin\/sales|\/phlebotomists\/\$\{/;
const salesServer = [...PARTNERS, ...HOMEC].filter((f) => /\.server\.ts$|actions\.ts$/.test(f) || /server/.test(f)).filter((f) => SERVER_MARK.test(read(f)));
const salesClient = [...PARTNERS, ...HOMEC].filter((f) => f.endsWith('.tsx') && /partners\.sales\.|Allow Collection|allow_collection|Collector settings/.test(read(f)));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const keys = [...messagesSrc.matchAll(/'(partners\.(?:sales|nav\.sales)[a-z0-9_.]*)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => ({ key: m[1]!, text: m[2] ?? m[3]! }));

describe('T0D-SALES-1 first walk (done_when 1)', () => {
  it('.orchestra/notes/T0D-SALES-1-walk.md says which ElabAssist screen each LIMS screen replaces and what is missing', () => {
    const f = join(ROOT, '.orchestra', 'notes', 'T0D-SALES-1-walk.md');
    expect(existsSync(f), 'the writer writes the walk note first').toBe(true);
    const t = read(f);
    for (const w of [/Sales Representative/i, /Sales Designation/i, /Sales Client List/i, /Services In Area/i, /Collection Boy/i, /replaces/i, /missing/i]) expect(t, String(w)).toMatch(w);
    expect(t.length).toBeGreaterThan(500);
  });
});

describe('T0D-SALES-1 routes and navigation (registered like T0D-ACCT-1)', () => {
  const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner: string; permission?: string }[] }).routes;
  const PATHS = ['/partners/sales/designations', '/partners/sales/representatives', '/partners/sales/clients', '/partners/sales/areas'];
  it.each(PATHS)('%s has a page file under app/(staff)/partners/sales and a routes.yaml row (staff_web, partners.sales.read)', (p) => {
    expect(existsSync(SALES_PAGES[PATHS.indexOf(p)]!), `page.tsx for ${p}`).toBe(true);
    const r = routes.find((x) => x.path === p);
    expect(r, `routes.yaml row for ${p}`).toBeTruthy();
    expect(r!.origin).toBe('staff_web');
    expect(r!.permission).toBe('partners.sales.read');
    expect(r!.id).toMatch(/^staff\.partners\.[a-z_]+$/);
  });
  it('the four route ids are unique and no admin or platform route was added or renamed for this task', () => {
    const ids = PATHS.map((p) => routes.find((x) => x.path === p)?.id);
    expect(new Set(ids).size).toBe(4);
    expect(routes.filter((r) => /sales/i.test(r.path) && /^\/(admin|platform)/.test(r.path))).toEqual([]);
  });
  it('the partners nav manifest gains four entries (group partners, permission partners.sales.read, distinct orders after the five existing ones, label = a catalogue key, an icon)', async () => {
    const m = read(join(SRC, 'features', 'partners', 'nav.manifest.ts'));
    for (const p of PATHS) {
      const routeId = routes.find((x) => x.path === p)?.id;
      expect(routeId, p).toBeTruthy();
      const line = m.split('\n').find((l) => l.includes(`'${routeId}'`));
      expect(line, `nav entry for ${routeId}`).toBeTruthy();
      expect(line).toMatch(/permission: 'partners\.sales\.read'/);
      expect(line).toMatch(/group: 'partners'/);
      const order = Number(/order: (\d+)/.exec(line!)?.[1]);
      expect(order).toBeGreaterThan(50);
      expect(line).toMatch(/icon: '[a-z-]+'/);
      const label = /label: '([^']+)'/.exec(line!)?.[1] ?? '';
      expect(messagesSrc, `label key ${label}`).toContain(`'${label}'`);
    }
    const orders = [...m.matchAll(/order: (\d+)/g)].map((x) => Number(x[1]));
    expect(new Set(orders).size, 'orders are unique').toBe(orders.length);
  });
  it('the five existing partners entries are unchanged (inbox, pickups, list, referrers, settings)', () => {
    const m = read(join(SRC, 'features', 'partners', 'nav.manifest.ts'));
    for (const id of ['partners.inbox', 'partners.pickups', 'partners.list', 'partners.referrers', 'partners.settings']) expect(m).toContain(`id: '${id}'`);
  });
  it('no source file of this task adds a route or file under features/admin, features/platform, app/(auth), app/(platform)', () => {
    const bad = [...salesServer, ...salesClient].filter((f) => /features\/(admin|platform)\/|app\/\((auth|platform)\)/.test(rel(f)));
    expect(bad.map(rel)).toEqual([]);
  });
});

describe('T0D-SALES-1 no new library, light on low end PCs (done_when 4)', () => {
  const pkg = JSON.parse(read(join(WEB, 'package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const FORBIDDEN = ['react-arborist', 'rc-tree', 'react-d3-tree', 'd3', 'd3-hierarchy', 'react-organizational-chart', 'reactflow', 'react-flow-renderer', '@xyflow/react', 'react-table', '@tanstack/react-table', 'ag-grid-react', 'react-datepicker', 'moment', 'lodash', 'recharts', 'chart.js', 'xlsx', 'exceljs'];
  it('apps/web/package.json has none of the tree, org-chart, grid, chart, date picker or utility libraries', () => {
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => FORBIDDEN.includes(d))).toEqual([]);
  });
  it('no sales source imports one of them', () => {
    const bad = [...salesServer, ...salesClient, ...SALES_PAGES.filter(existsSync)].filter((f) => new RegExp(`from ['"](${FORBIDDEN.join('|')})['"/]`).test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it('the manager tree is drawn from the paged tree call (limit <= 200), not by rendering an unbounded list: the call passes a limit', () => {
    const t = salesServer.map(read).join('\n');
    expect(t).toMatch(/sales\/tree/);
    expect(t).toMatch(/limit/);
  });
});

describe('T0D-SALES-1 typed calls (BFF)', () => {
  const OPS: [string, RegExp][] = [
    ['listSalesDesignations / createSalesDesignation / updateSalesDesignation', /sales\/designations/],
    ['listSalesRepresentatives / createSalesRepresentative / updateSalesRepresentative', /sales\/representatives/],
    ['deactivateSalesRepresentative', /representatives\/\$\{[^}]+\}\/deactivate|\/deactivate/],
    ['getSalesTree', /sales\/tree/],
    ['assignPartyToRepresentative / unassignPartyFromRepresentative', /sales\/assignments/],
    ['listRepresentativeClients', /\/clients/],
    ['listServiceAreas / createServiceArea / updateServiceArea / deactivateServiceArea', /sales\/service-areas/],
    ['updateCollectorFlags', /\/phlebotomists\/\$\{/],
  ];
  it.each(OPS)('%s has a typed call in a features/partners or features/homecollection server file', (_n, re) => {
    expect(salesServer.some((f) => re.test(read(f))), `no server file calls ${re}`).toBe(true);
  });
  it('every file that carries an operation path is server-only (REQ-SEC-068: the bearer JWT stays on the server) or a "use server" actions file', () => {
    expect(salesServer.length).toBeGreaterThanOrEqual(1);
    for (const f of salesServer) expect(/import 'server-only'|import "server-only"|^'use server'|^"use server"/m.test(read(f)), rel(f)).toBe(true);
  });
  it('POST writes carry an Idempotency-Key, PATCH / deactivate / unassign carry If-Match, ids are shape checked before they reach a path', () => {
    const t = salesServer.map(read).join('\n');
    expect(t).toMatch(/idempotency-key/i);
    expect(t).toMatch(/if-match/i);
    expect(t).toMatch(/uuid\(|UUID_RE|isUuid|UUID\.test/i);
  });
  it('no 501 / operation_pending branch is left for these operations (live since T0B-SALES-1)', () => {
    for (const f of [...salesServer, ...salesClient]) expect(/operation_pending/.test(read(f)), rel(f)).toBe(false);
  });
  it('permissions are the known ones: partners.sales.read / partners.sales.manage (+ homecollection.settings.manage for the collector flags); no new code is invented', () => {
    const t = [...salesServer, ...salesClient].map(read).join('\n');
    const found = new Set([...t.matchAll(/['"`]((?:partners|homecollection)\.[a-z_]+\.(?:read|manage|map|decide|assign|receive))['"`]/g)].map((m) => m[1]!));
    for (const c of found) expect(['partners.sales.read', 'partners.sales.manage', 'homecollection.settings.manage', 'homecollection.device.manage', 'partners.partner.read', 'partners.referrer.map', 'partners.partner.manage']).toContain(c);
    expect(found.has('partners.sales.manage')).toBe(true);
  });
});

describe('T0D-SALES-1 client components', () => {
  it('there are client components for the sales screens and the collector dialog', () => {
    expect(salesClient.length).toBeGreaterThanOrEqual(2);
    expect(salesClient.some((f) => /Allow Collection/.test(read(f))), 'a component carries the Allow Collection checkbox').toBe(true);
    expect(salesClient.some((f) => /Allow Pickup/.test(read(f))), 'a component carries the Allow Pickup checkbox').toBe(true);
  });
  it('no client component calls fetch, XMLHttpRequest or a hard-coded URL directly', () => {
    for (const f of salesClient) expect(/\bfetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/.test(read(f)), rel(f)).toBe(false);
  });
  it('client components import *.server modules for TYPES only', () => {
    for (const f of salesClient) for (const m of read(f).matchAll(/^import\s+(?!type\b)[^;]*from ['"][^'"]*\.server['"]/gm)) throw new Error(`${rel(f)} imports a .server module for values: ${m[0]}`);
  });
  it('the dates use native date inputs (no picker library) and the tables use the compact table class and the empty-row kit parts (headers always drawn, LD-336)', () => {
    const t = salesClient.map(read).join('\n');
    expect(t).toMatch(/type=["']date["']/);
    expect(t).toMatch(/lims-table-compact|density="compact"/);
    expect(t).toMatch(/emptyState|EmptyRow|PlaceholderRows|EmptyState/);
  });
  it('money is integer paisa: no parseFloat, toFixed or float division in the sales files; the Outstanding value is formatted by the shared money helper', () => {
    for (const f of [...salesServer, ...salesClient]) {
      const t = read(f).replace(/\/\/.*$/gm, '');
      expect(/parseFloat\(|\.toFixed\(|Number\.parseFloat|\bMath\.(round|floor|ceil|trunc)\([^)]*\/\s*100\b|\/\s*100\)?\s*\.toLocale/.test(t), `${rel(f)} handles money with floats`).toBe(false);
    }
  });
  it('uses a double submit guard (a ref or busy state) around every write', () => {
    for (const f of salesClient.filter((x) => /Action\(/.test(read(x)))) expect(/useRef|isLoading|isDisabled=\{busy|busy|pending/.test(read(f)), rel(f)).toBe(true);
  });
  it('no dangerouslySetInnerHTML', () => {
    for (const f of salesClient) expect(read(f), rel(f)).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

describe('T0D-SALES-1 message catalogue (done_when 4)', () => {
  it('messages.ts holds the screen text under partners.sales.* and the nav labels under partners.nav.sales* (at least 25 keys)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(25);
  });
  it('every partners.sales key used in a component exists in the catalogue', () => {
    const used = new Set(salesClient.flatMap((f) => [...read(f).matchAll(/\bt\(\s*['"](partners\.sales\.[a-z0-9_.]+)['"]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(messagesSrc, k).toContain(`'${k}'`);
  });
  it('catalogue text is plain: no exclamation mark, no HTML, no development wording (LD-353 rule 8)', () => {
    for (const k of keys) {
      expect(k.text, k.key).not.toMatch(/!|<[a-z/]|TODO|placeholder|coming soon|T0D-|\bCR-/i);
      expect(k.text.length, k.key).toBeGreaterThan(0);
    }
  });
  it('the blocked-by-permission reason exists and names partners.sales.manage', () => {
    const r = keys.find((k) => k.key === 'partners.sales.reason.manage');
    expect(r, 'partners.sales.reason.manage').toBeTruthy();
    expect(r!.text).toContain('partners.sales.manage');
  });
  it('rule 8: no stored text says "pincode" for areas (areas are free text district and area, LD-321)', () => {
    for (const k of keys.filter((x) => /areas?/.test(x.key))) expect(k.text, k.key).not.toMatch(/pin ?code/i);
  });
});
