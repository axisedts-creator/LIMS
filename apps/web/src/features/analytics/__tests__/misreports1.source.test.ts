// T0D-MISREPORTS-1 static checks (tester-owned; node environment, no rendering). What these pin (done_when 1, 2, 3, 4 and the LD-353 / LD-321 / LD-342 / A39 rules):
//   - the first walk is written down (done_when 1): .orchestra/notes/T0D-MISREPORTS-1-walk.md says which ElabAssist report each new definition replaces;
//   - the catalogue (features/analytics/report-codes.ts REPORT_CODES) gets one row per x-report-definitions entry (11), equal to the contract in code, title,
//     permission and schedulable, so the schedule editor, the export names and the report-run page work for them; the 14 old rows stay as they were;
//   - ONE new route /billing/bill-of-the-day (staff_web, permission analytics.collections.read) with a page file, a routes.yaml row, the generated route tables
//     and one additive billing nav entry; the ten other reports open on the existing /analytics/reports/[reportCode] route (no route added);
//   - no new library, BFF only (no client fetch), money is integer paisa, text from the message catalogue, print stylesheet, nothing under features/admin,
//     features/platform, app/(auth), app/(platform) (rs-c2.static pins them) and no admin / platform route is added.
// NOT here: rs-c8.static (analytics byte-identity pin) - see the notes file; it must be re-recorded by a ruling after the writer edits the pinned files.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPORT_CODES } from '../report-codes';
import { BOTD, DEFS, MONEY, ROOT, SRC, def } from './misreports1.harness';

const WEB = join(SRC, '..');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? (e === '__tests__' || e === 'node_modules' ? [] : walk(p)) : [p]; }) : []);
const rel = (p: string) => relative(WEB, p).split('\\').join('/');
const code = (f: string) => /\.(ts|tsx)$/.test(f);
const MARK = /bill_of_the_day|bill-of-the-day|BillOfTheDay|MisReport|misreport|analytics\.mis\.|billing\.botd\./;
const CANDIDATES = [...walk(join(SRC, 'features', 'analytics')), ...walk(join(SRC, 'features', 'billing')), ...walk(join(SRC, 'app', '(staff)', 'billing')), ...walk(join(SRC, 'app', '(staff)', 'analytics'))];
const MINE = CANDIDATES.filter((f) => /\.(ts|tsx|css)$/.test(f) && MARK.test(read(f)));
const MINE_CODE = MINE.filter(code);
const CLIENT = MINE_CODE.filter((f) => f.endsWith('.tsx') && /^'use client'/m.test(read(f)));
const SERVER = MINE_CODE.filter((f) => /\.server\.|\/server\//.test(f.split('\\').join('/')));
const BOTD_PAGE = join(SRC, 'app', '(staff)', 'billing', 'bill-of-the-day', 'page.tsx');
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const keys = [...messagesSrc.matchAll(/'((?:analytics\.mis|billing\.botd)\.[a-z0-9_.]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => ({ key: m[1]!, text: m[2] ?? m[3]! }));
const routes = (parse(read(join(ROOT, 'contracts', 'routes.yaml'))) as { routes: { id: string; origin: string; path: string; owner?: string; permission?: string }[] }).routes;

const OLD_ROWS = [
  ['dashboard', 'analytics.dashboard.read', true], ['income', 'analytics.dashboard.read', true], ['department_income', 'analytics.dashboard.read', true], ['collections', 'analytics.collections.read', true],
  ['volume', 'analytics.dashboard.read', true], ['top_referrers', 'analytics.dashboard.read', true], ['top_centres', 'analytics.dashboard.read', true], ['referral_incentive', 'analytics.referral_report.read', true],
  ['tests_done', 'analytics.dashboard.read', true], ['tat', 'analytics.dashboard.read', true], ['pending_tests', 'analytics.dashboard.read', true], ['quality_indicators', 'analytics.dashboard.read', true],
  ['delivery', 'analytics.dashboard.read', true], ['interfaces', 'analytics.dashboard.read', false],
] as const;

describe('T0D-MISREPORTS-1 first walk (done_when 1)', () => {
  it('.orchestra/notes/T0D-MISREPORTS-1-walk.md says which ElabAssist report each new definition replaces and what is still missing', () => {
    const f = join(ROOT, '.orchestra', 'notes', 'T0D-MISREPORTS-1-walk.md');
    expect(existsSync(f), 'the writer writes the walk note first').toBe(true);
    const t = read(f);
    expect(t.length).toBeGreaterThan(800);
    for (const w of [/replaces/i, /missing/i, /Bill Of The Day/i, /Collection ?Boy/i, /Sales Representative/i, /Consultant/i, /Repeated/i, /IPD/i, /OPD/i, /TDS/i, /Two level|commission/i, /Outsource/i, /Party|Company|Client/i]) expect(t, String(w)).toMatch(w);
    for (const d of DEFS) expect(t, `the walk names the code ${d.code}`).toContain(d.code);
  });
});

describe('T0D-MISREPORTS-1 the catalogue rows (done_when 2: schedules and exports work for them)', () => {
  it('REPORT_CODES keeps its 14 old rows unchanged and in order, then holds exactly the 11 new definitions (25 rows, no duplicates)', () => {
    expect(REPORT_CODES.length).toBe(25);
    expect(new Set(REPORT_CODES.map((r) => r.code)).size).toBe(25);
    expect(REPORT_CODES.slice(0, 14).map((r) => [r.code, r.permission, r.schedulable])).toEqual(OLD_ROWS.map((r) => [...r]));
  });
  it.each(DEFS.map((d) => [d.code, d] as const))('%s: a catalogue row with the contract title, permission and schedulable flag', (c, d) => {
    const r = REPORT_CODES.find((x) => x.code === c);
    expect(r, `REPORT_CODES has no row for ${c}`).toBeTruthy();
    expect(r!.label.toLowerCase(), 'label = contract title (case free: the ElabAssist menu name wins on the page title)').toBe(d.title.toLowerCase());
    expect(r!.permission).toBe(d.permission);
    expect(r!.schedulable).toBe(d.schedulable);
  });
  it('every definition is exportable and schedulable in the contract (so every new row is) and the two money reports use the referral permission', () => {
    for (const d of DEFS) { expect(d.exportable, d.code).toBe(true); expect(d.schedulable, d.code).toBe(true); }
    for (const m of MONEY) expect(def(m).permission).toBe('analytics.referral_report.read');
  });
});

describe('T0D-MISREPORTS-1 routes and navigation (registered like T0D-ACCT-1 / T0D-FINCTRL-1)', () => {
  const r = routes.find((x) => x.path === '/billing/bill-of-the-day');
  it('/billing/bill-of-the-day has a page file and ONE routes.yaml row (staff_web, permission analytics.collections.read, id staff.billing.bill_of_the_day)', () => {
    expect(existsSync(BOTD_PAGE), 'page.tsx').toBe(true);
    expect(routes.filter((x) => x.path === '/billing/bill-of-the-day').length).toBe(1);
    expect(r).toBeTruthy();
    expect(r!.origin).toBe('staff_web');
    expect(r!.id).toBe('staff.billing.bill_of_the_day');
    expect(r!.permission).toBe(def(BOTD).permission);
    expect(r!.owner).toMatch(/^C\d+$/);
  });
  it('the page gates on the permission and reads through the analytics or billing server files (no inline fetch)', () => {
    const t = read(BOTD_PAGE);
    expect(t).toMatch(/export default (async )?function/);
    expect(t).toContain('analytics.collections.read');
    expect(t).toMatch(/features\/(analytics|billing)\//);
    expect(t).not.toMatch(/\bfetch\(/);
  });
  it('both generated route tables carry the new id (codegen was run)', () => {
    expect(read(join(SRC, 'core', 'nav', 'generated.ts'))).toContain('staff.billing.bill_of_the_day');
    expect(read(join(WEB, '..', '..', 'packages', 'shared-ts', 'src', 'routes', 'generated.ts'))).toContain('staff.billing.bill_of_the_day');
  });
  it('the billing nav manifest has one additive entry (group billing, the route permission, an unused order, a catalogue label "Bill Of The Day")', () => {
    const m = read(join(SRC, 'features', 'billing', 'nav.manifest.ts'));
    const line = m.split('\n').find((l) => l.includes("'staff.billing.bill_of_the_day'"));
    expect(line, 'nav entry').toBeTruthy();
    expect(line).toContain("permission: 'analytics.collections.read'");
    expect(line).toContain("group: 'billing'");
    const label = /label: '([^']+)'/.exec(line!)?.[1] ?? '';
    const text = new RegExp(`'${label.replace(/\./g, '\\.')}':\\s*'([^']*)'`).exec(messagesSrc)?.[1];
    expect(text, `label key ${label} in messages.ts`).toBeTruthy();
    expect(text!.toLowerCase()).toBe('bill of the day');
    const orders = [...m.matchAll(/order: ([\d.]+)/g)].map((x) => Number(x[1]));
    expect(new Set(orders).size, 'orders are unique').toBe(orders.length);
  });
  it('the existing billing entries are unchanged in id', () => {
    const m = read(join(SRC, 'features', 'billing', 'nav.manifest.ts'));
    for (const id of ['billing.invoices', 'billing.dues', 'billing.daily_cash', 'billing.credit_parties', 'billing.registers', 'billing.account_entries', 'billing.expenses', 'billing.discount_slabs']) expect(m).toContain(`id: '${id}'`);
  });
  it('no route is added under analytics (the ten reports use /analytics/reports/[reportCode]) and none under admin or platform; only /billing/bill-of-the-day is new', () => {
    expect(existsSync(join(SRC, 'app', '(staff)', 'analytics', 'reports', '[reportCode]', 'page.tsx'))).toBe(true);
    expect(routes.filter((x) => /(bill-of-the-day|mis-report|misreport|commission|tds)/i.test(x.path) && /^\/(admin|platform)/.test(x.path))).toEqual([]);
    expect(routes.filter((x) => x.origin === 'staff_web' && /bill-of-the-day/.test(x.path)).map((x) => x.path)).toEqual(['/billing/bill-of-the-day']);
  });
  it('nothing of this task is under features/admin, features/platform, app/(auth), app/(platform)', () => {
    expect(MINE.filter((f) => /features\/(admin|platform)\/|app\/\((auth|platform)\)/.test(rel(f))).map(rel)).toEqual([]);
  });
});

describe('T0D-MISREPORTS-1 no new library, light on low end PCs (done_when 4)', () => {
  const pkg = JSON.parse(read(join(WEB, 'package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const FORBIDDEN = ['react-table', '@tanstack/react-table', 'ag-grid-react', 'react-datepicker', 'moment', 'lodash', 'recharts', 'chart.js', 'xlsx', 'exceljs', 'papaparse', 'file-saver', 'jspdf', 'react-to-print', 'react-hook-form', 'formik', 'zod', 'yup', 'swr', '@tanstack/react-query', 'react-select', 'big.js', 'bignumber.js', 'decimal.js', 'currency.js', 'numeral', 'accounting'];
  it('apps/web/package.json has none of the table, print, CSV, chart, date, money or utility libraries', () => {
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => FORBIDDEN.includes(d))).toEqual([]);
  });
  it('no source of this task imports one of them', () => {
    expect(MINE_CODE.filter((f) => new RegExp(`from ['"](${FORBIDDEN.join('|')})['"/]`).test(read(f))).map(rel)).toEqual([]);
  });
  it('the CSV is built by the server export (createAnalyticsExport), never in the browser: no Blob / createObjectURL / csv string building in client code', () => {
    for (const f of CLIENT) expect(/new Blob\(|createObjectURL|text\/csv|\.join\(['"],['"]\)\s*\+\s*['"]\\n/.test(read(f)), rel(f)).toBe(false);
  });
  it('no whole result is read into the browser: every list call of this task passes a limit of at most 200 and the pager is cursor based', () => {
    for (const f of SERVER) for (const m of read(f).matchAll(/limit[:=]\s*['"`]?(\d+)/g)) expect(Number(m[1]), rel(f)).toBeLessThanOrEqual(200);
  });
});

describe('T0D-MISREPORTS-1 BFF and client rules', () => {
  it('there is a new client component or page part for the Bill of the Day screen and for the catalogue reports', () => {
    expect(MINE_CODE.length).toBeGreaterThanOrEqual(2);
  });
  it('every file that carries an API path of this task is server-only (REQ-SEC-068: the bearer JWT stays on the server) or a "use server" actions file', () => {
    for (const f of SERVER.filter((x) => /\/v1\//.test(read(x)))) expect(/import 'server-only'|import "server-only"|^'use server'|^"use server"/m.test(read(f)), rel(f)).toBe(true);
  });
  it('no client component calls fetch, XMLHttpRequest or a hard-coded URL directly, and none imports a *.server module for values', () => {
    for (const f of CLIENT) {
      expect(/\bfetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/.test(read(f)), rel(f)).toBe(false);
      for (const m of read(f).matchAll(/^import\s+(?!type\b)[^;]*from ['"][^'"]*\.server['"]/gm)) throw new Error(`${rel(f)} imports a .server module for values: ${m[0]}`);
    }
  });
  it('money is integer paisa: no parseFloat and no paisa divided or multiplied by 100 by hand (the kit MoneyText renders rupees)', () => {
    for (const f of MINE_CODE) {
      const t = read(f).replace(/\/\/.*$/gm, '');
      expect(/parseFloat\(|Number\.parseFloat|paisa[^\n]*[/*]\s*100\b|[/*]\s*100\b[^\n]*paisa/i.test(t), `${rel(f)} handles money with floats`).toBe(false);
    }
  });
  it('the export request carries an Idempotency-Key and the schedule is created by the existing editor (no second schedule writer)', () => {
    const t = MINE_CODE.map(read).join('\n') + read(join(SRC, 'features', 'analytics', 'components', 'ExportDialog.tsx'));
    expect(t).toMatch(/ExportDialog|createExportAction|createAnalyticsExport/);
    expect(MINE_CODE.map(read).join('\n')).not.toMatch(/createReportSchedule|\/v1\/analytics\/schedules'/);
  });
  it('no dangerouslySetInnerHTML, no console, no localStorage', () => {
    for (const f of MINE_CODE) expect(read(f), rel(f)).not.toMatch(/dangerouslySetInnerHTML|console\.|localStorage|sessionStorage/);
  });
});

describe('T0D-MISREPORTS-1 print (done_when 3: one page) and message catalogue (done_when 4)', () => {
  it('a print stylesheet exists for the report screens: @media print hides the controls (display: none) and keeps rows together (break-inside: avoid)', () => {
    const css = MINE.filter((f) => /\.(css|tsx)$/.test(f)).map(read).join('\n');
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/@media print[\s\S]*display:\s*none/);
    expect(css).toMatch(/break-inside:\s*avoid|page-break-inside:\s*avoid/);
  });
  it('the print button calls window.print (no print library)', () => {
    expect(MINE_CODE.map(read).join('\n')).toMatch(/window\.print\(/);
  });
  it('messages.ts holds the screen text (at least 15 keys under analytics.mis.* and billing.botd.*)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(15);
    expect(keys.some((k) => k.key.startsWith('billing.botd.'))).toBe(true);
    expect(keys.some((k) => k.key.startsWith('analytics.mis.'))).toBe(true);
  });
  it('every catalogue key a component of this task uses exists', () => {
    const used = new Set(MINE_CODE.flatMap((f) => [...read(f).matchAll(/\bt\(\s*['"]((?:analytics\.mis|billing\.botd)\.[a-z0-9_.]+)['"]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(messagesSrc, k).toContain(`'${k}'`);
  });
  it('catalogue text is plain: no exclamation mark, no HTML, no development wording (LD-353 rule 8)', () => {
    for (const k of keys) {
      expect(k.text, k.key).not.toMatch(/!|<[a-z/]|TODO|placeholder|coming soon|T0D-|\bCR-/i);
      expect(k.text.length, k.key).toBeGreaterThan(0);
    }
  });
  it('the commission and TDS wording lives only in the two money report texts (A39-3): no other key of this task says commission', () => {
    const bad = keys.filter((k) => /commission|\btds\b/i.test(`${k.key} ${k.text}`) && !/two_level_commission|two-level-commission|tds|commission/i.test(k.key));
    expect(bad.map((k) => k.key)).toEqual([]);
  });
});
