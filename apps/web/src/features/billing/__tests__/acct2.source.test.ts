// T0D-ACCT-2 — structure and guard tests (no rendering): routes, pages, nav, permission codes, catalogue text, kit DataTable, density, no delete, idempotency.
// Spec: LD-313 (accounting in the billing module), LD-310 (founder blanket authority), brief done_when (1)-(5). Synthetic data only.
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
const PAGES = { expenses: 'ExpensesScreen', 'expenses/types': 'ExpenseTypesScreen', 'cash-transfers': 'CashTransfersScreen' } as const;
const pageFile = (p: string) => join(BILLING, ...p.split('/'), 'page.tsx');
const COMPONENTS = { ExpensesScreen: 'expenses', ExpenseTypesScreen: 'expenses', CashTransfersScreen: 'transfers', DailyCollectionScreen: 'transfers' } as const;
const componentFile = (c: keyof typeof COMPONENTS) => join(SRC, 'features', 'billing', 'components', COMPONENTS[c], `${c}.tsx`);
const SERVER = join(SRC, 'features', 'billing', 'server');
const newFiles = () => [
  ...walk(join(SRC, 'features', 'billing', 'components', 'expenses')),
  ...walk(join(SRC, 'features', 'billing', 'components', 'transfers')),
  ...walk(SERVER).filter((f) => /expenses?[.\-_]/i.test(f.split(/[\\/]/).pop()!)),
  ...Object.keys(PAGES).map(pageFile).filter(existsSync),
].filter((f) => /\.(ts|tsx|css)$/.test(f));
const codeFiles = () => newFiles().filter((f) => /\.tsx?$/.test(f));

const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner?: string; permission?: string }[] }).routes;
const permissionCodes = new Set((parse(read(join(ROOT, 'contracts', 'permissions.yaml'))) as { permissions: { code: string }[] }).permissions.map((p) => p.code));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const catalogue = Object.fromEntries([...messagesSrc.matchAll(/'(billing\.[a-z0-9_.]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => [m[1]!, m[2] ?? m[3]!]));

describe('T0D-ACCT-2 routes, pages and navigation', () => {
  for (const [p, screen] of Object.entries(PAGES)) {
    it(`billing/${p}: page exists, renders ${screen} and reads through the billing server files`, () => {
      expect(existsSync(pageFile(p)), pageFile(p)).toBe(true);
      const src = read(pageFile(p));
      expect(src).toMatch(/export default (async )?function/);
      expect(src).toContain(screen);
      expect(src).toMatch(/features\/billing\/server\//);
    });
    it(`routes.yaml has ONE staff_web row for /billing/${p}, owner C4, permission billing.account.read (API floor of the list operations)`, () => {
      const r = routes.filter((x) => x.origin === 'staff_web' && x.path === `/billing/${p}`);
      expect(r.length).toBe(1);
      expect(r[0]!.owner).toBe('C4');
      expect(r[0]!.permission).toBe('billing.account.read');
      expect(permissionCodes.has(r[0]!.permission!)).toBe(true);
    });
  }

  it('the daily collection summary lives on the existing daily-cash route (no new route): the page renders DailyCollectionScreen, gated by billing.account.read', () => {
    const page = read(join(BILLING, 'daily-cash', 'page.tsx'));
    expect(page).toContain('DailyCollectionScreen');
    expect(page).toContain('billing.account.read');
    expect(page).toMatch(/getDailyCollectionSummary|daily-collection-summary/);
    expect(routes.filter((x) => x.origin === 'staff_web' && x.path === '/billing/daily-cash').length).toBe(1);
    expect(routes.filter((x) => /daily-collection|daily_collection/.test(x.path + x.id)).length).toBe(0);
  });

  it('no route is removed: the pre-existing billing routes and the five ACCT-1 routes are still there; only the three new rows are added under /billing', () => {
    const paths = ['/billing/invoices', '/billing/dues', '/billing/daily-cash', '/billing/credit-parties', '/billing/registers', '/billing/audit-trail', '/billing/cbms', '/billing/worklist', '/billing/settings',
      ...['entries', 'ledger', 'pocket', 'summary', 'masters'].map((p) => `/billing/accounts/${p}`)];
    for (const path of paths) expect(routes.some((x) => x.origin === 'staff_web' && x.path === path), path).toBe(true);
    const NEW = new Set(['/billing/expenses', '/billing/expenses/types', '/billing/cash-transfers']);
    const unknown = routes.filter((x) => x.origin === 'staff_web' && x.path.startsWith('/billing/') && !paths.includes(x.path) && !NEW.has(x.path) && /expense|transfer|collection/i.test(x.path));
    expect(unknown.map((x) => x.path)).toEqual([]);
  });

  it('nothing under features/admin, features/platform, app/(auth), app/(platform) is imported by the new files, and the brief file cap (22 in all) holds', () => {
    for (const f of codeFiles()) expect(read(f), f).not.toMatch(/features\/(admin|platform)\b|\(auth\)|\(platform\)/);
    const tests = walk(join(SRC, 'features', 'billing', '__tests__')).filter((f) => /acct2\./.test(f) || /vitest\.acct2/.test(f));
    // new files: components + server + pages + tests; routes.yaml, nav manifest, messages.ts, daily-cash page are edits to existing files and count too (+4)
    expect(newFiles().length + tests.length + 4).toBeLessThanOrEqual(22);
  });

  it('manifest gets three additive entries (billing group, billing.account.read, orders 52/54/56 inside 50-60, message-key labels in the catalogue)', async () => {
    const m = (await import(join(SRC, 'features', 'billing', 'nav.manifest.ts'))).navManifest as { entries: { id: string; label: string; routeId: string; permission: string; group: string; order: number }[] };
    for (const p of Object.keys(PAGES)) {
      const route = routes.find((r) => r.path === `/billing/${p}`)!;
      const e = m.entries.find((x) => x.routeId === route?.id);
      expect(e, `entry for /billing/${p}`).toBeTruthy();
      expect(e!.group).toBe('billing');
      expect(e!.permission).toBe('billing.account.read');
      expect(e!.order).toBeGreaterThan(50);
      expect(e!.order).toBeLessThan(60);
      expect([52, 54, 56]).toContain(e!.order); // the free slots between the ACCT-1 entries (51,53,55,57,59)
      expect(e!.label).toMatch(/(^|\.)nav\./);
      expect(messagesSrc, `catalogue key ${e!.label}`).toContain(`'${e!.label}'`);
    }
    const orders = m.entries.filter((e) => e.group === 'billing').map((e) => e.order);
    expect(new Set(orders).size, 'billing nav orders are unique').toBe(orders.length);
  });
});

describe('T0D-ACCT-2 permission codes (no new code is needed: the T0C codes already exist)', () => {
  it('every billing.* permission string used by the new files exists in contracts/permissions.yaml', () => {
    const used = new Set(codeFiles().flatMap((f) => [...read(f).matchAll(/['"`](billing\.[a-z_]+\.[a-z_]+)['"`]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(permissionCodes.has(c), `${c} must be a code in contracts/permissions.yaml`).toBe(true);
  });
  it('the screens gate on the operation permissions of the contract', () => {
    const all = codeFiles().map(read).join('\n');
    for (const c of ['billing.expense.manage', 'billing.cash_transfer.manage', 'billing.cash_transfer.decide', 'billing.account.manage', 'billing.account_entry.create']) expect(all, c).toContain(c);
  });
});

describe('T0D-ACCT-2 message catalogue and copy', () => {
  const KEYS = [
    'expenses.title', 'expenses.new', 'expenses.empty', 'expenses.cancel', 'expenses.cancel_reason', 'expenses.cancel_confirm', 'expenses.reason.no_manage', 'expenses.reason.already_cancelled',
    'expense_types.title', 'expense_types.new', 'expense_types.edit', 'expense_types.deactivate', 'expense_types.empty', 'expense_types.reason.no_manage',
    'transfers.title', 'transfers.new', 'transfers.empty', 'transfers.submit', 'transfers.accept', 'transfers.accept_confirm', 'transfers.reject', 'transfers.reject_confirm', 'transfers.cancel', 'transfers.cancel_confirm',
    'transfers.tab.all', 'transfers.tab.sent', 'transfers.tab.received', 'transfers.tab.pending',
    'transfers.reason.no_manage', 'transfers.reason.no_decide', 'transfers.reason.own_transfer', 'transfers.reason.not_receiver', 'transfers.reason.not_pending', 'transfers.reason.not_creator',
    'transfers.balance_sender', 'transfers.balance_receiver', 'transfers.balance_warning', 'transfers.same_party',
    'daily_summary.title', 'daily_summary.empty', 'daily_summary.deposit', 'daily_summary.save', 'daily_summary.total', 'daily_summary.reason.no_create', 'daily_summary.reason.no_particular', 'daily_summary.reason.search_first',
  ];
  it('the keys the screen tests rely on exist in the catalogue (value is not the key)', () => {
    for (const k of KEYS) expect(catalogue[`billing.${k}`], `billing.${k}`).toBeTruthy();
  });
  it('every ElabAssist field and button label is a catalogue value', () => {
    const values = new Set(Object.values(catalogue));
    for (const l of ['Date Time', 'Expense Type', 'Amount', 'Lab Name', 'Description', 'Status', 'Action', 'Search', 'Add New', 'Save', 'Accept', 'Reject', 'Cancel', 'All Transfers']) {
      expect(values.has(l) || Object.values(catalogue).some((v) => v.toLowerCase() === l.toLowerCase()), `catalogue value "${l}"`).toBe(true);
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
  it('the word Delete does not appear as a button or catalogue label for expenses, types or transfers (Cancel with a reason, Deactivate instead)', () => {
    const own = Object.entries(catalogue).filter(([k]) => /^billing\.(expenses|expense_types|transfers|daily_summary)\./.test(k)).map(([, v]) => v);
    expect(own.length).toBeGreaterThan(0);
    for (const v of own) expect(v, v).not.toMatch(/\bdelete\b/i);
  });
});

describe('T0D-ACCT-2 kit table, compact density, money, dates', () => {
  it('the four components exist and every list uses the kit DataTable; no raw <table>', () => {
    for (const c of Object.keys(COMPONENTS) as (keyof typeof COMPONENTS)[]) {
      expect(existsSync(componentFile(c)), componentFile(c)).toBe(true);
      expect(stripComments(read(componentFile(c))), c).not.toMatch(/<table\b/);
      expect(read(componentFile(c)), c).toMatch(/@lims\/ui\/components\/DataTable/);
    }
  });
  it('compact density is inherited from the kit: no inline pixel sizes, no font-size overrides', () => {
    for (const f of codeFiles().filter((x) => /\.tsx$/.test(x))) expect(stripComments(read(f)), f).not.toMatch(/style=\{\{[^}]*(height|width|fontSize|padding|margin|lineHeight)\s*:/);
    const css = newFiles().filter((f) => /\.css$/.test(f)).map(read).join('\n');
    expect(css).not.toMatch(/font-size:\s*(1[4-9]|[2-9]\d)px/);
  });
  it('money comes from paisa through the existing money helpers: no division by 100, toFixed(2) or parseFloat in the components', () => {
    for (const f of codeFiles().filter((x) => /\.tsx?$/.test(x) && !/server[\\/]/.test(x))) expect(stripComments(read(f)), f).not.toMatch(/\/\s*100\b(?!\d)|toFixed\(\s*2\s*\)|parseFloat\(|Number\(\s*[a-zA-Z_.]*amount/);
  });
  it('dates use the existing date components, not toLocaleDateString / Intl.DateTimeFormat', () => {
    for (const f of codeFiles().filter((x) => /\.tsx$/.test(x))) expect(stripComments(read(f)), f).not.toMatch(/toLocale(Date|Time)String|toDateString|Intl\.DateTimeFormat/);
  });
});

describe('T0D-ACCT-2 BFF: no delete, idempotency, shape-checked ids', () => {
  const server = () => codeFiles().filter((f) => /server[\\/]/.test(f));
  it('the BFF files exist and call the contract paths', () => {
    const all = server().map(read).join('\n');
    expect(server().length).toBeGreaterThan(0);
    for (const p of ['/v1/billing/expenses', '/v1/billing/expense-types', '/v1/billing/cash-transfers', '/v1/billing/daily-collection-summary', '/v1/billing/account-summary']) expect(all, p).toContain(p);
    for (const s of ['/cancel', '/accept', '/reject']) expect(all, s).toContain(s);
  });
  it('every write sends Idempotency-Key; updates of expense types send If-Match', () => {
    const all = server().map(read).join('\n');
    expect(all).toMatch(/idempotency-key/i);
    expect(all).toMatch(/if-match/i);
  });
  it('the web layer never issues DELETE, and never PUT/PATCH against expenses or cash transfers (only expense-types are PATCHed)', () => {
    for (const f of codeFiles()) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/method:\s*['"]DELETE['"]/);
      expect(src, f).not.toMatch(/method:\s*['"](PUT|PATCH)['"][\s\S]{0,200}(\/expenses\b(?!-)|cash-transfers)|(\/expenses\b(?!-)|cash-transfers)[\s\S]{0,200}method:\s*['"](PUT|PATCH)['"]/);
      expect(src, f).not.toMatch(/\b(update|edit|delete|remove)(Expense|CashTransfer)\b/);
    }
  });
  it('ids and dates are checked by shape before they leave the BFF (UUID_RE / ISO_DATE_RE)', () => {
    const all = server().map(read).join('\n');
    expect(all).toMatch(/UUID_RE/);
    expect(all).toMatch(/ISO_DATE_RE/);
  });
});
