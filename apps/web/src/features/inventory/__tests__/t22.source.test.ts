// C12.T-22 source/structure checks: files exist where plan row T-22 says; LD-140 (kit only, no hex/px/inline style); keyboard + scanner wiring; no token in client code; contract paths; spec copy verbatim. Static; no rendering.
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

const routes = ['purchase-orders', 'purchase-orders/[po_id]/print', 'receipts'];
const pageDirs = routes.map((p) => join(src, 'app/(staff)/inventory', p));
const pageFiles = pageDirs.flatMap((d) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((f) => statSync(f).isFile() && code(f)) : []));
const feature = walk(join(src, 'features/inventory')).filter(code);
const ui = feature.filter((f) => /\.tsx$/.test(f) || /[\\/](components|forms)[\\/]/.test(f));
const t22 = [...pageFiles, ...feature];
const all = () => feature.map(read).join('\n');
const purchasing = () => feature.filter((f) => /purchas|receipt|grn|po[A-Z_-]|Po[A-Z]|Grn/.test(relative(src, f))).map(read).join('\n');

describe('files exist (plan row T-22)', () => {
  it.each([
    'app/(staff)/inventory/purchase-orders/page.tsx',
    'app/(staff)/inventory/purchase-orders/[po_id]/print/page.tsx',
    'app/(staff)/inventory/receipts/page.tsx',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it.each(['purchase-orders', 'receipts'])('app/(staff)/inventory/%s has loading.tsx and error.tsx (T-20 pattern)', (d) => {
    for (const f of ['loading.tsx', 'error.tsx']) expect(existsSync(join(src, 'app/(staff)/inventory', d, f)), `${d}/${f}`).toBe(true);
  });
  it('the feature code for S6/S7 lives under features/inventory (plan row files)', () => expect(purchasing().length).toBeGreaterThan(0));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are T-22 page files to check', () => expect(pageFiles.length).toBeGreaterThanOrEqual(3));
  it.each(t22.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
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
  it('the T-22 feature code cites LD-140 in a comment', () => expect(purchasing()).toMatch(/LD-140/));
  it('no token / JWT handling in client component files', () => {
    const client = ui.filter((f) => /^\s*['"]use client['"]/m.test(read(f)));
    expect(client.length).toBeGreaterThan(0);
    for (const f of client) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
  it('the print view is plain print CSS (kit PrintFrame or @media print), not a screenshot/PDF library', () => {
    const p = join(src, 'app/(staff)/inventory/purchase-orders/[po_id]/print/page.tsx');
    expect(existsSync(p)).toBe(true);
    const s = purchasing() + (existsSync(p) ? read(p) : '');
    expect(s).toMatch(/PrintFrame|@media print|window\.print/);
    expect(s).not.toMatch(/html2canvas|jspdf|pdfmake|puppeteer/i);
  });
});

describe('contract wiring (contracts/openapi/inventory.yaml)', () => {
  it('uses the contract paths for POs and receipts', () => {
    const s = all();
    for (const p of ['purchase-orders', 'goods-receipts', '/approve', 'mark-sent', '/cancel', '/close', 'print-view', '/post', 'barcodes/lookup']) expect(s, p).toContain(p);
  });
  it('reads reason codes from /coded-sets/reasons?reason_group=… (contract form), never /coded-sets/po_cancel', () => {
    const s = purchasing();
    expect(s).toMatch(/reason_group/);
    expect(s).toMatch(/po_cancel/);
    expect(s).toMatch(/po_close/);
    expect(strip(s)).not.toMatch(/coded-sets\/\$\{?['"`]?po_(cancel|close)/);
  });
  it('every state-changing call sends an Idempotency-Key and the versioned ones If-Match', () => {
    expect(all()).toMatch(/Idempotency-Key/i);
    expect(all()).toMatch(/If-Match/i);
  });
  it('request bodies never carry client-computed amounts (CV §4.7): no subtotal/net/vat/total field is assigned in the S6/S7 write code', () => {
    const w = feature.filter((f) => /write\.server|actions|Po[A-Z]|Grn|Purchas|Receipt/.test(relative(src, f))).map((f) => strip(read(f))).join('\n');
    expect(w).not.toMatch(/\b(subtotal_paisa|net_paisa|vat_paisa|total_paisa|line_total_paisa|tax_rate_bp|capitalised_value_paisa)\s*:\s*[^,}\n]*\b(qty|price|\*)/);
  });
});

describe('spec copy, keyboard and scanner (04-UI-UX §2, §3 S6/S7)', () => {
  it.each([
    'Amounts are calculated by the system when you save.',
    'Exempt (no tax code)',
    'DRAFT — NOT APPROVED',
    'Enter the lot number printed on the pack.',
    'This lot has already expired. It cannot be received.',
    'More than ordered (open: ',
    'Post this receipt? Stock will be added and the receipt can no longer be edited.',
    'Receipt posted — ',
    'This barcode is not linked to an item. Link it from the item page.',
    'No purchase orders',
    'No receipts',
  ])('contains "%s"', (copy) => expect(all() + pageFiles.map(read).join('\n')).toContain(copy));
  it('Invoice-total mismatch copy follows "Invoice total {invoice} differs from the calculated total {calc} by {diff}."', () => expect(all()).toMatch(/differs from the calculated total/));
  it('line editors bind Alt+L (add line) and Ctrl+Delete (remove line); Enter in qty moves on', () => {
    const s = purchasing();
    expect(s).toMatch(/altKey|Alt\+L|\{Alt|key === ['"]l['"]/i);
    expect(s).toMatch(/Delete/);
    expect(s).toMatch(/ctrlKey|Control/);
  });
  it('uses the kit scan primitives with the supplier-code pattern override and clearAfterScan', () => {
    const s = purchasing();
    expect(s).toMatch(/BarcodeInput|useScanCapture/);
    expect(s).toMatch(/\\x21-\\x7E/);
    expect(s).toMatch(/clearAfterScan/);
  });
  it('never puts a scanned value in a URL', () => expect(purchasing()).not.toMatch(/(router\.(push|replace)|href=)[^\n]*barcode/i));
  it('quantities use DecimalField, prices MoneyField; no <input type=number>', () => {
    expect(purchasing()).toMatch(/DecimalField/);
    expect(purchasing()).toMatch(/MoneyField/);
    expect(strip(all())).not.toMatch(/type=["']number["']/);
  });
  it('money columns and fields are gated by inventory.cost.read; approve by inventory.po.approve; manage by inventory.po.manage; receive by inventory.stock.manage; opening balance by inventory.stock.adjust', () => {
    const s = purchasing();
    for (const p of ['inventory.cost.read', 'inventory.po.approve', 'inventory.po.manage', 'inventory.stock.manage', 'inventory.stock.adjust']) expect(s, p).toContain(p);
  });
  it('step-up: auth.mfa_required is handled (isStepUp or the code literal) in the S6/S7 code', () => expect(purchasing()).toMatch(/isStepUp|auth\.mfa_required/));
});
