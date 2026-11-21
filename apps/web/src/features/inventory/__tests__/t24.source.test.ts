// C12.T-24 source/structure checks: files exist where plan row T-24 says; LD-140 (kit only, no hex/px/inline style); contract paths; spec copy verbatim; no client-side CSV/token handling. Static; no rendering.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const src = join(web, 'src');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : []);
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (p: string) => /\.(ts|tsx)$/.test(p);

const routeDirs = ['rules', 'unresolved', 'reports', 'reports/[report_code]/export'];
const pageFiles = routeDirs.flatMap((r) => { const d = join(src, 'app/(staff)/inventory', r); return existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((f) => statSync(f).isFile() && code(f)) : []; });
const feature = walk(join(src, 'features/inventory')).filter(code);
const ui = feature.filter((f) => /\.tsx$/.test(f) || /[\\/](components|forms)[\\/]/.test(f));
const t24 = [...pageFiles, ...feature];
const all = () => feature.map(read).join('\n');
const mine = () => feature.filter((f) => /rule|unresolved|report|fact|waiting/i.test(relative(src, f))).map(read).join('\n');

describe('files exist (plan row T-24)', () => {
  it.each([
    'app/(staff)/inventory/rules/page.tsx',
    'app/(staff)/inventory/unresolved/page.tsx',
    'app/(staff)/inventory/reports/page.tsx',
    'app/(staff)/inventory/reports/[report_code]/export/route.ts',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it.each(['rules', 'unresolved', 'reports'])('app/(staff)/inventory/%s has loading.tsx and error.tsx (T-20 pattern)', (d) => {
    for (const f of ['loading.tsx', 'error.tsx']) expect(existsSync(join(src, 'app/(staff)/inventory', d, f)), `${d}/${f}`).toBe(true);
  });
  it('the feature code for S13/S15/S17 lives under features/inventory (plan row files)', () => expect(mine().length).toBeGreaterThan(0));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are T-24 page files to check', () => expect(pageFiles.length).toBeGreaterThanOrEqual(4));
  it.each(t24.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
    const s = strip(read(f as string));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(s).not.toMatch(/border-?[Rr]adius/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b/);
    expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
  });
  it.each(ui.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only', (_n, f) => {
    for (const m of read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)) expect(m[1], m[1]).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });
  it('the T-24 feature code cites LD-140 in a comment', () => expect(mine()).toMatch(/LD-140/));
  it('no token / JWT handling in client component files', () => {
    const client = ui.filter((f) => /^\s*['"]use client['"]/m.test(read(f)));
    expect(client.length).toBeGreaterThan(0);
    for (const f of client) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
  it('charts use the kit (BarChart from @lims/ui), no third-party chart library', () => {
    expect(mine()).toMatch(/BarChart/);
    expect(strip(all())).not.toMatch(/from\s+'(chart\.js|recharts|d3[\w-]*|victory|apexcharts|echarts)'/);
  });
});

describe('contract wiring (contracts/openapi/inventory.yaml)', () => {
  it('uses the contract paths for rules, preview, facts and reports', () => {
    const s = all();
    for (const p of ['consumption-rules', '/supersede', '/deactivate', 'consumption-rules/preview', 'consumption-facts', '/resolve', '/dismiss', 'reports/', 'export.csv']) expect(s, p).toContain(p);
  });
  it('rule kinds, report codes and fact reason group are the contract literals', () => {
    const s = all();
    for (const k of ['per_test', 'per_analyte', 'per_rerun', 'per_qc', 'per_calibration', 'per_day']) expect(s, k).toContain(k);
    for (const k of ['daily_consumption', 'analyser_consumption', 'cost_per_test', 'wastage', 'expiry', 'stock_valuation', 'consumption_reconciliation']) expect(s, k).toContain(k);
    expect(s).toContain('fact_dismiss');
    expect(s).toMatch(/reason_group/);
  });
  it('state-changing calls send an Idempotency-Key', () => expect(mine() + all()).toMatch(/Idempotency-Key/i));
  it('the S17 screen takes its column list from the API (ColumnMeta / is_cost), not a hard-coded cost schema', () => expect(mine()).toMatch(/is_cost/));
  it('reconciliation visibility is read from the C2 /identity/me centre_scope (fails closed), not guessed from permissions', () => {
    const s = mine();
    expect(s).toMatch(/identity\/me/);
    expect(s).toMatch(/centre_scope/);
  });
  it('the export route handler never builds CSV itself and uses redirect:"error" for the upstream call', () => {
    const f = join(src, 'app/(staff)/inventory/reports/[report_code]/export/route.ts');
    expect(existsSync(f)).toBe(true);
    const s = existsSync(f) ? strip(read(f)) : '';
    expect(s).toMatch(/redirect:\s*['"]error['"]/);
    expect(s).toMatch(/server-only/);
    expect(s).not.toMatch(/neutraliseFormula|\.join\(['"],['"]\)|Papa|csv-stringify/); // the API writes + neutralises the CSV (08 A13 P-9); no module-local copy here
  });
  it('no client-side CSV/Blob generation anywhere in the feature (export is a server download)', () => expect(strip(all())).not.toMatch(/new Blob\(|URL\.createObjectURL|text\/csv;charset=utf-8,/));
});

describe('spec copy (04-UI-UX §3 S13, S15, S17) — verbatim', () => {
  it.each([
    'Deducted once for each test on an order when its first result is verified.',
    'Deducted once for each verified result of this analyte.',
    'Deducted when the analyser reports a rerun. Not every analyser reports reruns.',
    'Deducted for each QC result received from the analyser. If you leave the analyte empty, this is deducted once for every analyte in every QC run.',
    'Deducted when someone logs a calibration on the Bench page, or when the analyser reports a calibration (supported analysers only).',
    'Deducted once per day for each day the analyser sent any results.',
    'The old rule stops now. Earlier deductions are not changed.',
    'Every QC result on this analyser',
    'Any analyser',
    'No consumption rules. Automatic deduction does nothing until you add rules.',
    'These deductions could not be posted because no store is linked to the analyser and no default store is set.',
    'No store found',
    'Nothing waiting',
    'CPT excludes wastage, expiry and count differences. See the Wastage report.',
    'No data for this period',
    'Daily consumption', 'Analyser-wise', 'Cost per test', 'Valuation', 'Reconciliation',
    'Post to store', 'Export CSV',
  ])('contains "%s"', (copy) => expect(all() + pageFiles.map(read).join('\n')).toContain(copy));
  it('permissions are gated by name: master.manage (write), cost.read (CPT + money), report.export (export)', () => {
    const s = mine();
    for (const p of ['inventory.master.manage', 'inventory.cost.read', 'inventory.report.export']) expect(s, p).toContain(p);
  });
  it('help: S13 and S17 link to the consumption-model topic (inventory.help.consumption_model)', () => expect(mine()).toMatch(/consumption_model|consumption-model/));
});
