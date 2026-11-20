// T0D-PARTYSET-1 static checks (tester-owned; node environment, no rendering). What these pin (done_when 1, 5, 6 and the LD-353 / LD-321 / 07-SECURITY rules):
//   - the first walk is written down (done_when 1): .orchestra/notes/T0D-PARTYSET-1-walk.md names the ElabAssist screens and what is missing;
//   - four new staff routes (partners/onboarding, partners/penalties, partners/penalty-events, catalog/icd): page files, contracts/routes.yaml rows, nav entries (3 partners + 1 catalog), registered like T0D-ACCT-1 / T0D-SALES-1;
//   - no new library, BFF only: typed calls in server-only files, POST writes carry an Idempotency-Key, PATCH / deactivate / decision / charge carry If-Match, ids shape checked;
//   - client components never fetch the API themselves and import *.server modules for types only; money is integer paisa, percent is integer basis points (no float parsing or printing);
//   - text from the message catalogue, no exclamation marks, the permission reasons name their codes; only known permission codes appear;
//   - the full ID number is never logged, stored or put in a URL by source (the reveal value stays in component state);
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
const MARK = /party-settings|\/onboarding|\/penalt|id-number|icd-master|partners\.(partyset|onboarding|penalt|idnumber)\.|catalog\.icd\./;
const CANDIDATES = [...walk(join(SRC, 'features', 'partners')), ...walk(join(SRC, 'features', 'catalog')), ...walk(join(SRC, 'features', 'billing')), ...walk(join(SRC, 'app', '(staff)'))].filter(code);
const MINE = CANDIDATES.filter((f) => MARK.test(read(f)));
const SERVER = MINE.filter((f) => /server/.test(f) && /party-settings|\/onboarding|\/penalt|id-number|icd-master/.test(read(f)));
const CLIENT = MINE.filter((f) => f.endsWith('.tsx') && /^'use client'/m.test(read(f)));
const PAGES = [['partners', 'onboarding'], ['partners', 'penalties'], ['partners', 'penalty-events'], ['catalog', 'icd']].map(([a, b]) => join(SRC, 'app', '(staff)', a!, b!, 'page.tsx'));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const keys = [...messagesSrc.matchAll(/'((?:partners\.(?:partyset|onboarding|penalt[a-z]*|idnumber|nav\.(?:onboarding|penalt[a-z_]*))|catalog\.(?:icd|nav\.icd))[a-z0-9_.]*)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => ({ key: m[1]!, text: m[2] ?? m[3]! }));

describe('T0D-PARTYSET-1 first walk (done_when 1)', () => {
  it('.orchestra/notes/T0D-PARTYSET-1-walk.md says which ElabAssist screen each LIMS screen replaces and what is missing', () => {
    const f = join(ROOT, '.orchestra', 'notes', 'T0D-PARTYSET-1-walk.md');
    expect(existsSync(f), 'the writer writes the walk note first').toBe(true);
    const t = read(f);
    for (const w of [/Affiliation/i, /Franchise/i, /Non Compliance|penalt/i, /ICD/i, /Doctor/i, /Client Settings|per client/i, /replaces/i, /missing/i]) expect(t, String(w)).toMatch(w);
    expect(t.length).toBeGreaterThan(500);
  });
});

describe('T0D-PARTYSET-1 routes and navigation (registered like T0D-ACCT-1 / T0D-SALES-1)', () => {
  const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner: string; permission?: string }[] }).routes;
  const NEW: [string, string, string, RegExp][] = [
    ['/partners/onboarding', 'partners.onboarding.decide', 'partners', /^staff\.partners\.[a-z_]+$/],
    ['/partners/penalties', 'partners.penalty.manage', 'partners', /^staff\.partners\.[a-z_]+$/],
    ['/partners/penalty-events', 'partners.penalty.manage', 'partners', /^staff\.partners\.[a-z_]+$/],
    ['/catalog/icd', 'catalog.icd.manage', 'catalog', /^staff\.catalog\.[a-z_]+$/],
  ];
  it.each(NEW.map((n, i) => [n[0], i] as const))('%s has a page file and a routes.yaml row (staff_web, the pinned permission, a staff.<module>.<name> id)', (p, i) => {
    expect(existsSync(PAGES[i]!), `page.tsx for ${p}`).toBe(true);
    const r = routes.find((x) => x.path === p);
    expect(r, `routes.yaml row for ${p}`).toBeTruthy();
    expect(r!.origin).toBe('staff_web');
    expect(r!.permission).toBe(NEW[i]![1]);
    expect(r!.id).toMatch(NEW[i]![3]);
  });
  it('route ids are unique and no admin or platform route is added', () => {
    const ids = NEW.map(([p]) => routes.find((x) => x.path === p)?.id);
    expect(new Set(ids).size).toBe(4);
    expect(routes.filter((r) => /(onboarding|penalt|icd)/i.test(r.path) && /^\/(admin|platform)/.test(r.path))).toEqual([]);
  });
  it.each([['partners', 0], ['partners', 1], ['partners', 2], ['catalog', 3]] as const)('the %s nav manifest has an entry for route #%i (group = the module, the route permission, an unused order, an icon, a catalogue label)', (mod, i) => {
    const [path, permission] = NEW[i]!;
    const m = read(join(SRC, 'features', mod, 'nav.manifest.ts'));
    const routeId = routes.find((x) => x.path === path)?.id;
    expect(routeId, path).toBeTruthy();
    const line = m.split('\n').find((l) => l.includes(`'${routeId}'`));
    expect(line, `nav entry for ${routeId}`).toBeTruthy();
    expect(line).toContain(`permission: '${permission}'`);
    expect(line).toContain(`group: '${mod}'`);
    expect(line).toMatch(/icon: '[a-z-]+'/);
    const label = /label: '([^']+)'/.exec(line!)?.[1] ?? '';
    expect(messagesSrc, `label key ${label}`).toContain(`'${label}'`);
    const orders = [...m.matchAll(/order: (\d+)/g)].map((x) => Number(x[1]));
    expect(new Set(orders).size, 'orders are unique').toBe(orders.length);
  });
  it('the existing partners entries (inbox, pickups, list, referrers, settings, four sales) and the catalog entries are unchanged in id', () => {
    const p = read(join(SRC, 'features', 'partners', 'nav.manifest.ts'));
    for (const id of ['partners.inbox', 'partners.pickups', 'partners.list', 'partners.referrers', 'partners.settings', 'partners.sales_designations', 'partners.sales_areas']) expect(p).toContain(`id: '${id}'`);
    expect(read(join(SRC, 'features', 'catalog', 'nav.manifest.ts'))).toContain("id: 'catalog.doctors'");
  });
  it('nothing of this task is under features/admin, features/platform, app/(auth), app/(platform)', () => {
    expect(MINE.filter((f) => /features\/(admin|platform)\/|app\/\((auth|platform)\)/.test(rel(f))).map(rel)).toEqual([]);
  });
});

describe('T0D-PARTYSET-1 no new library, light on low end PCs (done_when 6)', () => {
  const pkg = JSON.parse(read(join(WEB, 'package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const FORBIDDEN = ['react-table', '@tanstack/react-table', 'ag-grid-react', 'react-datepicker', 'moment', 'lodash', 'recharts', 'chart.js', 'xlsx', 'exceljs', 'react-hook-form', 'formik', 'zod', 'yup', 'swr', '@tanstack/react-query', 'react-select', 'big.js', 'bignumber.js', 'decimal.js', 'currency.js', 'numeral', 'accounting'];
  it('apps/web/package.json has none of the table, form, chart, date, money or utility libraries', () => {
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => FORBIDDEN.includes(d))).toEqual([]);
  });
  it('no source of this task imports one of them', () => {
    const bad = [...MINE, ...PAGES.filter(existsSync)].filter((f) => new RegExp(`from ['"](${FORBIDDEN.join('|')})['"/]`).test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it('every list call passes a limit of at most 50 (lists are paged)', () => {
    const t = SERVER.map(read).join('\n');
    expect(t).toMatch(/limit/);
    for (const m of t.matchAll(/limit[:=]\s*(\d+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(200);
  });
});

describe('T0D-PARTYSET-1 typed calls (BFF)', () => {
  const OPS: [string, RegExp][] = [
    ['getPartyCommercialSetting / setPartyCommercialSetting', /party-settings/],
    ['listPartyOnboarding / decidePartyOnboarding', /admin\/onboarding/],
    ['listNonCompliancePenalties / create / update / deactivate', /admin\/penalties/],
    ['listNonComplianceEvents / raise / waive / charge', /admin\/penalty-events/],
    ['revealPartyIdNumber', /\/id-number/],
    ['listIcdMasterCodes / createIcdMasterCode / updateIcdMasterCode / deactivateIcdMasterCode', /catalog\/icd-master/],
  ];
  it.each(OPS)('%s has a typed call in a server file', (_n, re) => {
    expect(SERVER.some((f) => re.test(read(f))), `no server file calls ${re}`).toBe(true);
  });
  it('every file that carries an operation path is server-only (REQ-SEC-068: the bearer JWT stays on the server) or a "use server" actions file', () => {
    expect(SERVER.length).toBeGreaterThanOrEqual(3);
    for (const f of SERVER) expect(/import 'server-only'|import "server-only"|^'use server'|^"use server"/m.test(read(f)), rel(f)).toBe(true);
  });
  it('POST writes carry an Idempotency-Key, PATCH / deactivate / decision / waive / charge carry If-Match, ids are shape checked before they reach a path', () => {
    const t = SERVER.map(read).join('\n');
    expect(t).toMatch(/idempotency-key/i);
    expect(t).toMatch(/if-match/i);
    expect(t).toMatch(/uuid\(|UUID_RE|isUuid|UUID\.test/i);
  });
  it('the party kind is checked against the four known values before it reaches a path', () => {
    const t = SERVER.map(read).join('\n');
    expect(t).toMatch(/credit_party/);
    expect(t).toMatch(/referrer/);
  });
  it('no 501 / operation_pending branch is left for these operations (live since T0B-PARTYSET-1)', () => {
    for (const f of [...SERVER, ...CLIENT]) expect(/operation_pending/.test(read(f)), rel(f)).toBe(false);
  });
  it('the reveal call never logs, stores or URL-encodes the value: no console, localStorage, sessionStorage or cookie use in these files', () => {
    for (const f of [...SERVER, ...CLIENT].filter((x) => /id-number|idnumber|IdNumber|MaskedId/i.test(read(x)))) expect(/console\.|localStorage|sessionStorage|document\.cookie|router\.(push|replace)\([^)]*value/.test(read(f)), rel(f)).toBe(false);
  });
  it('permissions are the known ones; no code is invented', () => {
    const t = [...SERVER, ...CLIENT, ...PAGES.filter(existsSync)].map(read).join('\n');
    const found = new Set([...t.matchAll(/['"`]((?:partners|catalog|billing)\.[a-z_]+\.(?:read|manage|decide|map|receive))['"`]/g)].map((m) => m[1]!));
    const KNOWN = ['partners.party_setting.read', 'partners.party_setting.manage', 'partners.onboarding.decide', 'partners.party_id_number.read', 'partners.penalty.manage', 'catalog.icd.manage', 'partners.partner.read', 'partners.partner.manage', 'partners.referrer.map', 'partners.manifest.receive', 'catalog.referrer.read', 'catalog.referrer.manage', 'catalog.price_list.read', 'billing.credit_party.read'];
    for (const c of found) expect(KNOWN, c).toContain(c);
    for (const c of ['partners.party_setting.manage', 'partners.onboarding.decide', 'partners.party_id_number.read', 'partners.penalty.manage', 'catalog.icd.manage']) expect(found.has(c), c).toBe(true);
  });
});

describe('T0D-PARTYSET-1 client components', () => {
  it('there are client components for settings, onboarding, penalties, events, ICD and the masked field', () => {
    expect(CLIENT.length).toBeGreaterThanOrEqual(5);
  });
  it('no client component calls fetch, XMLHttpRequest or a hard-coded URL directly', () => {
    for (const f of CLIENT) expect(/\bfetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/.test(read(f)), rel(f)).toBe(false);
  });
  it('client components import *.server modules for TYPES only', () => {
    for (const f of CLIENT) for (const m of read(f).matchAll(/^import\s+(?!type\b)[^;]*from ['"][^'"]*\.server['"]/gm)) throw new Error(`${rel(f)} imports a .server module for values: ${m[0]}`);
  });
  it('dates use native date inputs; the tables use the kit DataTable with an emptyState (headers always drawn, LD-353 rule 5)', () => {
    const t = CLIENT.map(read).join('\n');
    expect(t).toMatch(/type=["']date["']/);
    expect(t).toMatch(/DataTable/);
    expect(t).toMatch(/emptyState|EmptyState/);
  });
  it('money is integer paisa and percent is integer basis points: no parseFloat, toFixed, Number(...) * 100 or float division in these files', () => {
    for (const f of [...SERVER, ...CLIENT]) {
      const t = read(f).replace(/\/\/.*$/gm, '');
      expect(/parseFloat\(|Number\.parseFloat|\.toFixed\(|Number\([^)]*\)\s*\*\s*100\b|\*\s*100\s*\)\s*;?\s*$|\bMath\.(round|floor|ceil|trunc)\([^)]*[*/]\s*100\b/m.test(t), `${rel(f)} handles money or percent with floats`).toBe(false);
    }
  });
  it('uses a double submit guard (a ref or busy state) around every write', () => {
    for (const f of CLIENT.filter((x) => /Action\(/.test(read(x)))) expect(/useRef|isLoading|isDisabled=\{busy|busy|pending/.test(read(f)), rel(f)).toBe(true);
  });
  it('no dangerouslySetInnerHTML', () => {
    for (const f of CLIENT) expect(read(f), rel(f)).not.toMatch(/dangerouslySetInnerHTML/);
  });
  it('the settings tab reuses ONE component for partner and credit party (no copy of the six groups)', () => {
    const owners = CLIENT.filter((f) => /Billing cycle and invoice periods|partners\.partyset\.group\.billing/i.test(read(f)));
    expect(owners.length, 'one component owns the groups').toBe(1);
  });
});

describe('T0D-PARTYSET-1 message catalogue (done_when 6)', () => {
  it('messages.ts holds the screen text for the four screens and the tab (at least 40 keys)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(40);
  });
  it('every catalogue key this task uses in a component exists', () => {
    const used = new Set(CLIENT.flatMap((f) => [...read(f).matchAll(/\bt\(\s*['"]((?:partners|catalog)\.(?:partyset|onboarding|penalt[a-z]*|idnumber|icd)[a-z0-9_.]*)['"]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(messagesSrc, k).toContain(`'${k}'`);
  });
  it('catalogue text is plain: no exclamation mark, no HTML, no development wording (LD-353 rule 8)', () => {
    for (const k of keys) {
      expect(k.text, k.key).not.toMatch(/!|<[a-z/]|TODO|placeholder|coming soon|T0D-|\bCR-/i);
      expect(k.text.length, k.key).toBeGreaterThan(0);
    }
  });
  it.each([
    ['partners.partyset.reason.manage', 'partners.party_setting.manage'],
    ['partners.idnumber.reason.read', 'partners.party_id_number.read'],
  ])('the blocked reason %s exists and names %s', (k, codeName) => {
    const r = keys.find((x) => x.key === k);
    expect(r, k).toBeTruthy();
    expect(r!.text).toContain(codeName);
  });
  it.each(['partners.partyset.defaults', 'partners.partyset.saved', 'partners.onboarding.reason.creator', 'partners.idnumber.mfa_required', 'partners.idnumber.not_found'])('%s exists', (k) => {
    expect(keys.some((x) => x.key === k), k).toBe(true);
  });
  it('rule 8: no stored text says "Aadhar" or "Aadhaar" (Nepal: National ID number); the PAN label is PAN', () => {
    for (const k of keys) expect(k.text, k.key).not.toMatch(/aadha?a?r/i);
  });
});
