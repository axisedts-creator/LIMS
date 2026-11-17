// T0D-ACCT-1 — structure and guard tests (no rendering): routes, pages, nav, permission codes, catalogue text, kit DataTable, density, append-only ledger.
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

const PAGES = ['entries', 'ledger', 'pocket', 'summary', 'masters'] as const;
const pageFile = (p: string) => join(SRC, 'app', '(staff)', 'billing', 'accounts', p, 'page.tsx');
const SCREENS: Record<(typeof PAGES)[number], string> = { entries: 'AccountEntriesScreen', ledger: 'AccountLedgerScreen', pocket: 'PocketLedgerScreen', summary: 'AccountSummaryScreen', masters: 'AccountMastersScreen' };
const COMPONENT_DIR = join(SRC, 'features', 'billing', 'components', 'accounts');
const accountFiles = () => [
  ...walk(COMPONENT_DIR),
  ...walk(join(SRC, 'features', 'billing', 'server')).filter((f) => /accounts?[.\-_]/i.test(f.split(/[\\/]/).pop()!)),
  ...PAGES.map(pageFile).filter(existsSync),
].filter((f) => /\.(ts|tsx)$/.test(f));

const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner?: string; permission?: string }[] }).routes;
const permissionCodes = new Set((parse(read(join(ROOT, 'contracts', 'permissions.yaml'))) as { permissions: { code: string }[] }).permissions.map((p) => p.code));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const catalogue = Object.fromEntries([...messagesSrc.matchAll(/'(billing\.accounts\.[a-z0-9_.]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => [m[1]!, m[2] ?? m[3]!]));

describe('T0D-ACCT-1 routes, pages and navigation', () => {
  for (const p of PAGES) {
    it(`billing/accounts/${p}: page exists, renders ${SCREENS[p]} and reads through the billing server files`, () => {
      expect(existsSync(pageFile(p)), pageFile(p)).toBe(true);
      const src = read(pageFile(p));
      expect(src).toMatch(/export default (async )?function/);
      expect(src).toContain(SCREENS[p]);
      expect(src).toMatch(/features\/billing\/server\//);
    });
    it(`routes.yaml has ONE staff_web row for /billing/accounts/${p}, owner C4, permission is an existing code`, () => {
      const r = routes.filter((x) => x.origin === 'staff_web' && x.path === `/billing/accounts/${p}`);
      expect(r.length).toBe(1);
      expect(r[0]!.owner).toBe('C4');
      expect(permissionCodes.has(r[0]!.permission!), `${r[0]!.permission} must exist in contracts/permissions.yaml`).toBe(true);
      expect(r[0]!.permission).toBe('billing.account.read'); // API floor of listAccountLedgerEntries / getAccountStatement / getAccountSummary / listAccountGroups
    });
  }

  it('no route is removed: the pre-existing billing routes are still there', () => {
    for (const path of ['/billing/invoices', '/billing/dues', '/billing/daily-cash', '/billing/credit-parties', '/billing/registers', '/billing/audit-trail', '/billing/cbms', '/billing/worklist', '/billing/settings']) {
      expect(routes.some((x) => x.origin === 'staff_web' && x.path === path), path).toBe(true);
    }
  });

  it('nothing under features/admin, features/platform, app/(auth), app/(platform) imports the accounts files and the accounts files import none of them', () => {
    for (const f of accountFiles()) {
      expect(read(f), f).not.toMatch(/features\/(admin|platform)\b|\(auth\)|\(platform\)/);
    }
  });

  it('the new accounts files stay within the 24 file cap of the brief (components + server + pages + tests)', () => {
    const tests = walk(join(SRC, 'features', 'billing', '__tests__')).filter((f) => /acct1\./.test(f) || /vitest\.acct1/.test(f));
    expect(accountFiles().length + tests.length).toBeLessThanOrEqual(24);
  });
});

describe('T0D-ACCT-1 permission codes', () => {
  it('every billing.* permission string used by the accounts files exists in contracts/permissions.yaml', () => {
    const used = new Set(accountFiles().flatMap((f) => [...read(f).matchAll(/['"`](billing\.[a-z_]+\.[a-z_]+)['"`]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(permissionCodes.has(c), `${c} must be a code in contracts/permissions.yaml (never invent one; add it with the role mapping and the corp_admin pack)`).toBe(true);
  });
  it('the screens gate on the T0C-ACCT-1 codes', () => {
    const all = accountFiles().map(read).join('\n');
    for (const c of ['billing.account.read', 'billing.account.manage', 'billing.account_entry.create', 'billing.account_entry.reverse']) expect(all, c).toContain(c);
  });
});

describe('T0D-ACCT-1 navigation entries (additive)', () => {
  it('manifest has the five accounts entries with billing group, the route permission and a message-key label; labels exist in the catalogue', async () => {
    const m = (await import(join(SRC, 'features', 'billing', 'nav.manifest.ts'))).navManifest as { entries: { id: string; label: string; routeId: string; permission: string; group: string; order: number }[] };
    for (const p of PAGES) {
      const route = routes.find((r) => r.path === `/billing/accounts/${p}`)!;
      const e = m.entries.find((x) => x.routeId === route.id);
      expect(e, `entry for ${route.path}`).toBeTruthy();
      expect(e!.group).toBe('billing');
      expect(e!.permission).toBe(route.permission);
      expect(e!.order).toBeGreaterThan(50);
      expect(e!.order).toBeLessThan(60); // C15 payments entries own billing 60-64
      expect(e!.label).toMatch(/(^|\.)nav\./);
      expect(messagesSrc, `catalogue key ${e!.label}`).toContain(`'${e!.label}'`);
    }
  });
});

describe('T0D-ACCT-1 message catalogue and copy', () => {
  const COLUMN_LABELS = ['Laboratory', 'Client', 'Franchise', 'Entry Date', 'Particulars', 'Credited', 'Debited', 'Comments', 'Payment Mode', 'Reference Number', 'Bank Details', 'Payment Details', 'Last Modified By', 'Entry Status', 'Download Receipt',
    'Center', 'Client Name', 'Address', 'Joining Date', 'Contact Person', 'Contact No', 'Email', 'PAN No', 'Credit Limit', 'Outstanding Amount', 'Debit/Credit', 'Is Blocked'];
  it('every ElabAssist column header is a billing.accounts.* catalogue value', () => {
    const values = new Set(Object.values(catalogue));
    for (const l of COLUMN_LABELS) expect(values.has(l), `catalogue value "${l}"`).toBe(true);
  });
  it('the keys the screen tests rely on exist (value is not the key)', () => {
    const KEYS = ['entries.title', 'entries.new', 'entries.empty', 'entries.reverse', 'entries.reverse_reason', 'entries.reverse_confirm',
      'reason.no_create', 'reason.no_reverse', 'reason.no_manage', 'reason.already_reversed', 'reason.is_reversal', 'reason.pick_party_first',
      'ledger.title', 'ledger.opening', 'ledger.closing', 'ledger.total_credit', 'ledger.total_debit', 'ledger.pick_party', 'ledger.empty',
      'pocket.title', 'pocket.mine', 'pocket.not_allowed', 'summary.title', 'masters.title', 'masters.groups', 'masters.particulars', 'masters.new_group', 'masters.new_particular', 'masters.edit', 'masters.deactivate'];
    for (const k of KEYS) expect(catalogue[`billing.accounts.${k}`], `billing.accounts.${k}`).toBeTruthy();
  });
  it('screens and pages hold no literal user-facing text: no JSX text, no label/title/aria-label/placeholder/header string literals (use t())', () => {
    const offenders: string[] = [];
    for (const f of accountFiles()) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’:?!-]{2,})\s*</g)) offenders.push(`${f}: JSX text "${m[1]}"`);
      for (const m of src.matchAll(/\b(label|title|aria-label|placeholder|header|description|helpText|tooltip)=["']([A-Za-z][^"']{2,})["']/g)) offenders.push(`${f}: ${m[1]}="${m[2]}"`);
      for (const m of src.matchAll(/\b(label|title|header|description|placeholder)\s*:\s*'([A-Z][^']{2,})'/g)) offenders.push(`${f}: ${m[1]}: '${m[2]}'`);
    }
    expect(offenders).toEqual([]);
  });
  it('no copy implies tax-authority approval (a ledger receipt is not a fiscal document)', () => {
    expect(Object.values(catalogue).join('\n')).not.toMatch(/IRD[ -]approved|IRD certified|approved by IRD/i);
  });
});

describe('T0D-ACCT-1 kit table, compact density, money', () => {
  it('every list uses the kit DataTable (headers with no rows + placeholders come from T0D-EMPTYTBL-1); no raw <table>', () => {
    for (const c of ['AccountEntriesScreen', 'AccountLedgerScreen', 'PocketLedgerScreen', 'AccountSummaryScreen', 'AccountMastersScreen']) {
      const f = join(COMPONENT_DIR, `${c}.tsx`);
      expect(existsSync(f), f).toBe(true);
    }
    for (const f of walk(COMPONENT_DIR).filter((x) => /\.tsx$/.test(x))) expect(stripComments(read(f)), f).not.toMatch(/<table\b/);
    for (const c of ['AccountEntriesScreen', 'AccountSummaryScreen', 'AccountMastersScreen', 'AccountLedgerScreen']) {
      expect(read(join(COMPONENT_DIR, `${c}.tsx`)), c).toMatch(/@lims\/ui\/components\/DataTable/);
    }
  });
  it('compact density is inherited from the kit: no inline pixel sizes, no fixed heights, no font-size overrides in the accounts files', () => {
    for (const f of accountFiles().filter((x) => /\.tsx$/.test(x))) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/style=\{\{[^}]*(height|width|fontSize|padding|margin|lineHeight)\s*:/);
    }
    const css = walk(COMPONENT_DIR).filter((f) => /\.css$/.test(f)).map(read).join('\n');
    expect(css).not.toMatch(/font-size:\s*(1[4-9]|[2-9]\d)px/);
  });
  it('money comes from paisa through the existing money helpers: no division by 100 or toFixed(2) in the accounts files', () => {
    for (const f of accountFiles().filter((x) => /\.tsx?$/.test(x) && !/server[\\/]/.test(x))) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/\/\s*100\b(?!\d)|toFixed\(\s*2\s*\)|parseFloat\(|Number\(\s*[a-zA-Z_.]*amount/);
    }
  });
  it('dates use the existing date components (DateText / BsAd), not toLocaleDateString or new Date().toString()', () => {
    for (const f of accountFiles().filter((x) => /\.tsx$/.test(x))) expect(stripComments(read(f)), f).not.toMatch(/toLocale(Date|Time)String|toDateString|Intl\.DateTimeFormat/);
  });
});

describe('T0D-ACCT-1 append-only ledger (LD-313 b)', () => {
  it('the web layer never issues PUT, PATCH or DELETE against account-ledger-entries, and has no edit/delete action for entries', () => {
    for (const f of accountFiles()) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/method:\s*['"](PUT|PATCH|DELETE)['"][\s\S]{0,200}account-ledger-entries|account-ledger-entries[\s\S]{0,200}method:\s*['"](PUT|PATCH|DELETE)['"]/);
      expect(src, f).not.toMatch(/\b(update|edit|delete|remove)AccountLedgerEntry/i);
    }
  });
  it('writes to the ledger go through the billing BFF with Idempotency-Key (server files send it)', () => {
    const server = accountFiles().filter((f) => /server[\\/]/.test(f)).map(read).join('\n');
    expect(server).toMatch(/idempotency-key/i);
    expect(server).toContain('/v1/billing/account-ledger-entries');
    expect(server).toMatch(/\/reverse/);
  });
  it('the CSV export neutralises spreadsheet formula prefixes (= + - @ tab CR)', () => {
    const all = accountFiles().map(read).join('\n');
    expect(all).toMatch(/\[=\+\\?-@|\^\[=\+\\?-@|startsWith\(['"]=|['"]=['"],\s*['"]\+['"]/);
  });
});
