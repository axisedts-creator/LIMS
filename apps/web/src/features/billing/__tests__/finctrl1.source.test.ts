// T0D-FINCTRL-1 — structure and guard tests (no rendering): routes, pages, nav, permission codes, catalogue text, kit DataTable, density, no delete, idempotency,
// hold / release and fiscal year wiring, discount form wiring, file cap. Spec: LD-321, LD-310 (founder blanket authority), LD-353 rules, brief done_when (1)-(8).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const SRC = join(WEB, 'src');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const BILLING = join(SRC, 'app', '(staff)', 'billing');
const PAGES = { 'discounts/reasons': 'DiscountReasonsScreen', 'discounts/slabs': 'DiscountSlabsScreen', 'discounts/limits': 'DiscountLimitsScreen', 'discounts/authorities': 'DiscountAuthoritiesScreen' } as const;
const pageFile = (p: string) => join(BILLING, ...p.split('/'), 'page.tsx');
const componentFile = (c: string) => join(SRC, 'features', 'billing', 'components', 'discounts', `${c}.tsx`);
const SERVER = join(SRC, 'features', 'billing', 'server');
const serverFiles = () => walk(SERVER).filter((f) => /discount/i.test(f.split(/[\\/]/).pop()!) && /\.ts$/.test(f));
const newFiles = () => [
  ...walk(join(SRC, 'features', 'billing', 'components', 'discounts')),
  ...serverFiles(),
  ...Object.keys(PAGES).map(pageFile).filter(existsSync),
].filter((f) => /\.(ts|tsx|css)$/.test(f));
const codeFiles = () => newFiles().filter((f) => /\.tsx?$/.test(f));
const componentFiles = () => codeFiles().filter((f) => /\.tsx$/.test(f) && !f.includes(`${join('app', '(staff)')}`));

const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner?: string; permission?: string }[] }).routes;
const permissionCodes = new Set((parse(read(join(ROOT, 'contracts', 'permissions.yaml'))) as { permissions: { code: string }[] }).permissions.map((p) => p.code));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const catalogue = Object.fromEntries([...messagesSrc.matchAll(/'(billing\.[a-z0-9_.]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => [m[1]!, m[2] ?? m[3]!]));

describe('T0D-FINCTRL-1 routes, pages and navigation', () => {
  for (const [p, screen] of Object.entries(PAGES)) {
    it(`billing/${p}: page exists, renders ${screen}, reads through the billing server files`, () => {
      expect(existsSync(pageFile(p)), pageFile(p)).toBe(true);
      const src = read(pageFile(p));
      expect(src).toMatch(/export default (async )?function/);
      expect(src).toContain(screen);
      expect(src).toMatch(/features\/billing\/server\//);
      expect(src, 'the page gates on the view permission').toContain('billing.discount_policy.read');
      expect(existsSync(componentFile(screen)), componentFile(screen)).toBe(true);
    });
    it(`routes.yaml has ONE staff_web row for /billing/${p}, owner C4, permission billing.discount_policy.read`, () => {
      const r = routes.filter((x) => x.origin === 'staff_web' && x.path === `/billing/${p}`);
      expect(r.length).toBe(1);
      expect(r[0]!.owner).toBe('C4');
      expect(r[0]!.permission).toBe('billing.discount_policy.read');
      expect(permissionCodes.has('billing.discount_policy.read')).toBe(true);
    });
  }

  it('no route is added, renamed or removed under admin or platform; only the four /billing/discounts rows are new', () => {
    const NEW = new Set(Object.keys(PAGES).map((p) => `/billing/${p}`));
    // ruling: scope to the billing area; /frontdesk/discount-approvals (C4) pre-exists on main
    const discountRoutes = routes.filter((x) => x.origin === 'staff_web' && x.path.startsWith('/billing/') && /discount/i.test(x.path));
    expect(discountRoutes.map((x) => x.path).sort()).toEqual([...NEW].sort());
    expect(routes.some((x) => x.origin === 'staff_web' && x.path === '/frontdesk/discount-approvals')).toBe(true);
  });

  it('the existing billing routes (including the accounting ones) are all still there', () => {
    const paths = ['/billing/invoices', '/billing/dues', '/billing/daily-cash', '/billing/credit-parties', '/billing/registers', '/billing/audit-trail', '/billing/cbms', '/billing/worklist', '/billing/settings',
      ...['entries', 'ledger', 'pocket', 'summary', 'masters'].map((p) => `/billing/accounts/${p}`), '/billing/expenses', '/billing/expenses/types', '/billing/cash-transfers'];
    for (const path of paths) expect(routes.some((x) => x.origin === 'staff_web' && x.path === path), path).toBe(true);
  });

  it('nothing under features/admin, features/platform, app/(auth), app/(platform) is imported by the new files; the file cap (28 in all) holds', () => {
    for (const f of codeFiles()) expect(read(f), f).not.toMatch(/features\/(admin|platform)\b|\(auth\)|\(platform\)/);
    const tests = walk(join(SRC, 'features', 'billing', '__tests__')).filter((f) => /finctrl1\./.test(f) || /vitest\.finctrl1/.test(f));
    // edits to existing files count too: routes.yaml, nav manifest, messages.ts, entries screen, daily collection screen, daily-cash page, entries page, DiscountDialog,
    // frontdesk actions + read.server, nav-complete test = 11
    expect(newFiles().length + tests.length + 11).toBeLessThanOrEqual(28);
  });

  it('manifest gets four additive billing entries (permission billing.discount_policy.read, orders strictly between 50 and 60, unique, message-key labels)', async () => {
    const m = (await import(join(SRC, 'features', 'billing', 'nav.manifest.ts'))).navManifest as { entries: { id: string; label: string; routeId: string; permission: string; group: string; order: number }[] };
    for (const p of Object.keys(PAGES)) {
      const route = routes.find((r) => r.path === `/billing/${p}`)!;
      const e = m.entries.find((x) => x.routeId === route?.id);
      expect(e, `entry for /billing/${p}`).toBeTruthy();
      expect(e!.group).toBe('billing');
      expect(e!.permission).toBe('billing.discount_policy.read');
      expect(e!.order).toBeGreaterThan(50);
      expect(e!.order).toBeLessThan(60);
      expect(e!.label).toMatch(/(^|\.)nav\./);
      expect(messagesSrc, `catalogue key ${e!.label}`).toContain(`'${e!.label}'`);
    }
    const orders = m.entries.filter((e) => e.group === 'billing').map((e) => e.order);
    expect(new Set(orders).size, 'billing nav orders are unique').toBe(orders.length);
  });
});

describe('T0D-FINCTRL-1 permission codes (no new code: the T0C codes exist)', () => {
  it('every billing.* permission string used by the new files exists in contracts/permissions.yaml', () => {
    const used = new Set(codeFiles().flatMap((f) => [...read(f).matchAll(/['"`](billing\.[a-z_]+\.[a-z_]+)['"`]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(permissionCodes.has(c), `${c} must be a code in contracts/permissions.yaml`).toBe(true);
  });
  it('the screens gate on the operation permissions of the contract', () => {
    const all = codeFiles().map(read).join('\n');
    for (const c of ['billing.discount_policy.read', 'billing.discount_policy.manage']) expect(all, c).toContain(c);
  });
  it('Hold and Release gate on billing.account.manage (the contract x-permission of holdLedgerEntry / releaseLedgerEntry)', () => {
    const entries = read(join(SRC, 'features', 'billing', 'components', 'accounts', 'AccountEntriesScreen.tsx')) + read(join(SRC, 'features', 'billing', 'components', 'accounts', 'accountsShared.tsx'));
    expect(entries).toMatch(/PERM\.manage|billing\.account\.manage/);
    expect(entries).toMatch(/hold/i);
    expect(entries).toMatch(/release/i);
  });
});

describe('T0D-FINCTRL-1 message catalogue and copy', () => {
  const KEYS = [
    'discounts.reasons.title', 'discounts.reasons.new', 'discounts.reasons.empty', 'discounts.slabs.title', 'discounts.slabs.new', 'discounts.slabs.empty', 'discounts.slabs.open_ended',
    'discounts.limits.title', 'discounts.limits.new', 'discounts.limits.empty', 'discounts.authorities.title', 'discounts.authorities.new', 'discounts.authorities.empty',
    'discounts.edit', 'discounts.deactivate', 'discounts.deactivate_confirm', 'discounts.save', 'discounts.active.yes', 'discounts.active.no', 'discounts.reason.no_manage',
    'discounts.form.own_limit', 'discounts.form.authority', 'discounts.form.no_limit', 'discounts.form.approval_needed', 'discounts.form.approval_not_needed',
    'accounts.status.held', 'accounts.entries.hold', 'accounts.entries.release', 'accounts.entries.hold_reason', 'accounts.entries.hold_confirm', 'accounts.entries.release_confirm', 'accounts.entries.held_total',
    'accounts.reason.no_hold', 'accounts.reason.not_submitted', 'accounts.reason.held_first', 'accounts.filter.fiscal_year',
    'daily_summary.previous_outstanding', 'daily_summary.deposited', 'daily_summary.carried_forward',
  ];
  it('the keys the screen tests rely on exist in the catalogue (value is not the key)', () => {
    for (const k of KEYS) expect(catalogue[`billing.${k}`], `billing.${k}`).toBeTruthy();
  });
  it('every ElabAssist column and field label is a catalogue value', () => {
    const values = Object.values(catalogue).map((v) => v.toLowerCase());
    for (const l of ['Code', 'Name', 'Active', 'Party Type', 'Party', 'From Amount', 'To Amount', 'Discount Percent', 'Effective From', 'Effective To', 'User', 'Max Percent', 'Max Amount Per Bill', 'Action', 'Search', 'Add New', 'Save', 'Cancel']) {
      expect(values.includes(l.toLowerCase()), `catalogue value "${l}"`).toBe(true);
    }
  });
  it('new files hold no literal user-facing text: no JSX text, no label/title/aria-label/placeholder/header string literals (use t())', () => {
    const offenders: string[] = [];
    for (const f of codeFiles()) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’:?!-]{2,})\s*</g)) offenders.push(`${f}: JSX text "${m[1]}"`);
      for (const m of src.matchAll(/\b(label|title|aria-label|placeholder|header|description|helpText|tooltip)=["']([A-Za-z][^"']{2,})["']/g)) offenders.push(`${f}: ${m[1]}="${m[2]}"`);
      for (const m of src.matchAll(/\b(label|title|header|description|placeholder)\s*:\s*'([A-Z][^']{2,})'/g)) offenders.push(`${f}: ${m[1]}: '${m[2]}'`);
    }
    expect(offenders).toEqual([]);
  });
  it('no Delete / Remove label exists for the discount masters (Deactivate instead); no exclamation marks in the new copy', () => {
    const own = Object.entries(catalogue).filter(([k]) => /^billing\.discounts\./.test(k)).map(([, v]) => v);
    expect(own.length).toBeGreaterThan(0);
    for (const v of own) { expect(v, v).not.toMatch(/\b(delete|remove)\b/i); expect(v, v).not.toContain('!'); }
  });
});

describe('T0D-FINCTRL-1 kit table, compact density, percent, money, dates', () => {
  it('the four screens exist and every list uses the kit DataTable; no raw <table>', () => {
    for (const c of Object.values(PAGES)) {
      expect(existsSync(componentFile(c)), componentFile(c)).toBe(true);
      expect(stripComments(read(componentFile(c))), c).not.toMatch(/<table\b/);
      expect(read(componentFile(c)), c).toMatch(/@lims\/ui\/components\/DataTable/);
      expect(read(componentFile(c)), c).toMatch(/density="compact"/);
    }
  });
  it('compact density is inherited from the kit: no inline pixel sizes, no font-size overrides', () => {
    for (const f of codeFiles().filter((x) => /\.tsx$/.test(x))) expect(stripComments(read(f)), f).not.toMatch(/style=\{\{[^}]*(height|width|fontSize|padding|margin|lineHeight)\s*:/);
    const css = newFiles().filter((f) => /\.css$/.test(f)).map(read).join('\n');
    expect(css).not.toMatch(/font-size:\s*(1[4-9]|[2-9]\d)px/);
  });
  it('money goes through paisa string helpers: no float parsing and no toFixed(2) in the components; no paisa divided by 100', () => {
    for (const f of codeFiles().filter((x) => !/server[\\/]/.test(x))) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/toFixed\(\s*2\s*\)|parseFloat\(|Number\(\s*[a-zA-Z_.]*amount/);
      expect(src, f).not.toMatch(/paisa[^\n]*\/\s*100\b(?!\d)|\/\s*100\b(?!\d)[^\n]*paisa/i);
    }
  });
  it('dates use the existing date components, not toLocaleDateString / Intl.DateTimeFormat', () => {
    for (const f of componentFiles()) expect(stripComments(read(f)), f).not.toMatch(/toLocale(Date|Time)String|toDateString|Intl\.DateTimeFormat/);
  });
  it('no new heavy library: the new files import only react, next, @lims/ui, @/ paths and relative files', () => {
    for (const f of codeFiles()) for (const m of read(f).matchAll(/from\s+['"]([^'"]+)['"]/g)) expect(m[1], `${f}: ${m[1]}`).toMatch(/^(react|next\/|@lims\/ui\/|@\/|\.\.?\/|server-only|@lims\/)/);
  });
  it('lists are paged: the pages pass a limit to the list operations (no unbounded read)', () => {
    const all = [...Object.keys(PAGES).map(pageFile), ...serverFiles()].filter(existsSync).map(read).join('\n');
    expect(all).toMatch(/limit/i);
  });
});

describe('T0D-FINCTRL-1 BFF: paths, idempotency, If-Match, no delete, shape-checked ids, field errors', () => {
  const all = () => serverFiles().map((f) => stripComments(read(f))).join('\n');
  it('the BFF files exist and call the contract paths', () => {
    expect(serverFiles().length).toBeGreaterThan(0);
    for (const p of ['/v1/billing/discount-reasons', '/v1/billing/discount-slabs', '/v1/billing/discount-limits', '/v1/billing/discount-authorities']) expect(all(), p).toContain(p);
    for (const s of ['/deactivate']) expect(all(), s).toContain(s);
  });
  it('hold, release and my discount policy are called through the billing / frontdesk server files', () => {
    const files = [...walk(SERVER), ...walk(join(SRC, 'features', 'frontdesk', 'server'))].filter((f) => /\.ts$/.test(f)).map((f) => stripComments(read(f))).join('\n');
    expect(files).toMatch(/\/hold\b/);
    expect(files).toMatch(/\/release\b/);
    expect(files).toContain('/v1/billing/discount-policy/me');
  });
  it('every create / hold / release sends Idempotency-Key; updates and deactivations send If-Match', () => {
    expect(all()).toMatch(/idempotency-key/i);
    expect(all()).toMatch(/if-match/i);
  });
  it('the web layer never issues DELETE; limits are the only PUT; slabs and reasons are the only PATCH', () => {
    for (const f of codeFiles()) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/method:\s*['"]DELETE['"]/);
      expect(src, f).not.toMatch(/\b(delete|remove)(DiscountReason|DiscountSlab|DiscountLimit|DiscountAuthority)\b/);
    }
    expect(all()).not.toMatch(/method:\s*['"]PATCH['"][\s\S]{0,200}discount-(limits|authorities)|discount-(limits|authorities)[^\n]{0,200}method:\s*['"]PATCH['"]/);
  });
  it('ids and dates are checked by shape before they leave the BFF (UUID_RE / ISO_DATE_RE)', () => {
    expect(all()).toMatch(/UUID_RE/);
    expect(all()).toMatch(/ISO_DATE_RE/);
  });
  it('the server actions hand the field errors of a 400 (path + message) back to the screen, not only the code', () => {
    const actions = walk(SERVER).filter((f) => /discount.*actions|actions.*discount/i.test(f.split(/[\\/]/).pop()!)).map(read).join('\n');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions).toMatch(/errors/);
    expect(actions).toMatch(/path/);
    expect(actions).toMatch(/message/);
  });
});

describe('T0D-FINCTRL-1 hold / release, fiscal year, daily collection and discount form wiring', () => {
  it('the BFF exposes list reads that pass fiscal_year_label and status=held to listAccountLedgerEntries (API query names)', () => {
    const files = walk(SERVER).concat(walk(join(SRC, 'app', '(staff)', 'billing', 'accounts', 'entries'))).filter((f) => /\.tsx?$/.test(f)).map(read).join('\n');
    expect(files).toContain('fiscal_year_label');
    expect(files).toMatch(/['"]held['"]/);
  });
  it('the entries screen shows the held total and the daily collection screen the three cash figures', () => {
    const entries = read(join(SRC, 'features', 'billing', 'components', 'accounts', 'AccountEntriesScreen.tsx'));
    expect(entries).toContain('held_total');
    expect(entries).toContain('fiscal_year');
    const daily = read(join(SRC, 'features', 'billing', 'components', 'transfers', 'DailyCollectionScreen.tsx'));
    for (const k of ['previous_outstanding', 'deposited', 'carried_forward']) expect(daily, k).toContain(k);
    expect(daily).toMatch(/sessions/);
  });
  it('the daily-cash page hands the cash sessions of getDailyCash to the daily collection screen', () => {
    const page = read(join(BILLING, 'daily-cash', 'page.tsx'));
    expect(page).toMatch(/sessions/);
  });
  it('the discount form reads getMyDiscountPolicy and keeps its existing payload keys (scope, reason_code, kind, percent_bp, amount_paisa)', () => {
    const dialog = read(join(SRC, 'features', 'frontdesk', 'components', 'DiscountDialog.tsx'));
    expect(dialog).toMatch(/DiscountPolicy/);
    for (const k of ['reason_code', 'percent_bp', 'amount_paisa', 'scope']) expect(dialog, k).toContain(k);
    expect(dialog).toMatch(/billing\.discounts\.form\./);
  });
});
