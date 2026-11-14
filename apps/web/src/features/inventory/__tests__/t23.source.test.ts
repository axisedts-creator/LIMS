// C12.T-23 source/structure checks: files exist where plan row T-23 says; LD-140 (kit only, no hex/px/inline style); scanner wiring; no token in client code; spec copy verbatim. Static; no rendering.
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

const routes = ['stock', 'wastage', 'transfers', 'counts', 'counts/[count_id]', 'bench'];
const pageDirs = routes.map((p) => join(src, 'app/(staff)/inventory', p));
const pageFiles = pageDirs.flatMap((d) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((f) => statSync(f).isFile() && code(f)) : []));
// T-21 owns items/stores/suppliers; T-23 owns everything else under features/inventory that is NOT one of those T-21 files. The LD-140 sweep covers all of features/inventory (it is one lane).
const feature = walk(join(src, 'features/inventory')).filter(code);
const ui = feature.filter((f) => /\.tsx$/.test(f) || /[\\/](components|forms)[\\/]/.test(f));
const t23 = [...pageFiles, ...feature];
const all = () => feature.map(read).join('\n');

describe('files exist (plan row T-23)', () => {
  it.each([
    'app/(staff)/inventory/stock/page.tsx',
    'app/(staff)/inventory/wastage/page.tsx',
    'app/(staff)/inventory/transfers/page.tsx',
    'app/(staff)/inventory/counts/page.tsx',
    'app/(staff)/inventory/counts/[count_id]/page.tsx',
    'app/(staff)/inventory/bench/page.tsx',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it.each(['stock', 'wastage', 'transfers', 'counts', 'bench'])('app/(staff)/inventory/%s has loading.tsx and error.tsx (T-20 pattern)', (d) => {
    for (const f of ['loading.tsx', 'error.tsx']) expect(existsSync(join(src, 'app/(staff)/inventory', d, f)), `${d}/${f}`).toBe(true);
  });
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are T-23 page files to check', () => expect(pageFiles.length).toBeGreaterThanOrEqual(6));
  it.each(t23.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
    const s = strip(read(f as string));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(s).not.toMatch(/border-?[Rr]adius/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b/);
    expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/); // scanned barcodes must never be logged (04-UI-UX §2)
  });
  it.each(ui.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only', (_n, f) => {
    for (const m of read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)) expect(m[1], m[1]).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });
  it('the T-23 feature code cites LD-140 in a comment', () => expect(feature.filter((f) => /stock|transfer|count|bench|wastage|fefo/i.test(relative(src, f))).map(read).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in client component files', () => {
    const client = ui.filter((f) => /^\s*['"]use client['"]/m.test(read(f)));
    expect(client.length).toBeGreaterThan(0);
    for (const f of client) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('spec copy and widgets (04-UI-UX §3 S8–S12)', () => {
  it.each([
    'Lots are taken in the order shown: opened containers first, then earliest expiry.',
    'Write off all remaining stock of',
    'Leave uncounted lines unchanged',
    'Treat uncounted lines as zero',
    'Show system quantity',
    'Choose the analyser this bottle is loaded on. Automatic deductions for that analyser use this lot.',
    'Do not enter patient details.',
    'Logged. No consumption rule matches, so nothing was deducted.',
    'No open containers on this bench',
    'Open expiry passed',
  ])('contains "%s"', (copy) => expect(all()).toContain(copy));
  it('dispatch confirmation text follows "Dispatch? Stock leaves {from} now and shows as in transit."', () => expect(all()).toMatch(/Dispatch\? Stock leaves/));
  it('uses the kit scan primitives on the scan-first screens (S8 issue, S11 count, S12 bench)', () => {
    const s = all();
    expect(s).toMatch(/useScanCapture|BarcodeInput/);
    expect(s).toMatch(/\\x21-\\x7E/);
  });
  it('never puts a scanned value in a URL', () => expect(all()).not.toMatch(/(router\.(push|replace)|href=)[^\n]*barcode/i));
  it('quantities use DecimalField (3 decimals), counts and observations IntegerField/DecimalField; no <input type=number>', () => {
    expect(all()).toMatch(/DecimalField/);
    expect(strip(all())).not.toMatch(/type=["']number["']/);
  });
  it('the blind-count switch is gated by inventory.stock.adjust and the count POST/PUT use the contract paths', () => {
    expect(all()).toMatch(/inventory\.stock\.adjust/);
    expect(all()).toMatch(/stock-counts/);
    expect(all()).toMatch(/uncounted_policy/);
  });
  it('every state-changing call sends an Idempotency-Key and the versioned ones If-Match (contract x-idempotency / IfMatch)', () => {
    expect(all()).toMatch(/Idempotency-Key/i);
    expect(all()).toMatch(/If-Match/i);
  });
});
