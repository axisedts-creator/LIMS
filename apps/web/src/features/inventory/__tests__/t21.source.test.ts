// C12.T-21 source/structure checks: files exist where plan row T-21 says; LD-140 (kit only, no hex/px/inline style); REQ-SEC-088/098; scanner kit props. Static; no rendering.
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

const pages = ['items', 'items/[item_id]', 'stores', 'suppliers'].map((p) => join(src, 'app/(staff)/inventory', p));
const pageFiles = pages.flatMap((d) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((f) => statSync(f).isFile() && code(f)) : []));
const feature = walk(join(src, 'features/inventory')).filter(code);
const ui = feature.filter((f) => /\.tsx$/.test(f) || /[\\/](components|forms)[\\/]/.test(f));
const t21 = [...pageFiles, ...feature];

describe('files exist (plan row T-21)', () => {
  it.each([
    'app/(staff)/inventory/items/page.tsx',
    'app/(staff)/inventory/items/[item_id]/page.tsx',
    'app/(staff)/inventory/stores/page.tsx',
    'app/(staff)/inventory/suppliers/page.tsx',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it.each(['items', 'stores', 'suppliers'])('app/(staff)/inventory/%s has loading.tsx and error.tsx (T-20 pattern)', (d) => {
    for (const f of ['loading.tsx', 'error.tsx']) expect(existsSync(join(src, 'app/(staff)/inventory', d, f)), `${d}/${f}`).toBe(true);
  });
  it('features/inventory has components', () => expect(feature.length).toBeGreaterThan(3));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(t21.length).toBeGreaterThan(5));
  it.each(t21.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
    const s = strip(read(f as string));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(s).not.toMatch(/border-?[Rr]adius/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b/);
    expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/); // supplier contact data is personal (07 §5)
  });
  it.each(ui.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only', (_n, f) => {
    for (const m of read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)) expect(m[1], m[1]).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });
  it('feature code cites LD-140 in a comment', () => expect(t21.map(read).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in client component files', () => {
    const client = ui.filter((f) => /^\s*['"]use client['"]/m.test(read(f)));
    expect(client.length).toBeGreaterThan(0);
    for (const f of client) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('scanner add-barcode (04-UI-UX §2)', () => {
  const s = () => feature.map(read).join('\n');
  it('uses the kit BarcodeInput with the item-barcode pattern, clearAfterScan and the label "Scan or type barcode"', () => {
    expect(s()).toMatch(/BarcodeInput/);
    expect(s()).toMatch(/\\x21-\\x7E/);
    expect(s()).toMatch(/clearAfterScan/);
    expect(s()).toMatch(/Scan or type barcode/);
  });
  it('never puts a scanned value in a URL (no barcode in router.push / href template)', () => {
    expect(s()).toMatch(/BarcodeInput/); // non-vacuous
    expect(s()).not.toMatch(/(router\.(push|replace)|href=)[^\n]*barcode/i);
  });
});

describe('forms mirror spec validation (04-UI-UX §3)', () => {
  const s = () => feature.map(read).join('\n');
  it.each([
    ['item code pattern', String.raw`^[A-Z0-9][A-Z0-9_.\-]{0,31}$`],
    ['pack code pattern', String.raw`^[A-Z0-9_]{1,16}$`],
    ['store code pattern', String.raw`^[A-Z0-9][A-Z0-9_\-]{0,15}$`],
    ['HS code pattern', String.raw`^[0-9]{4,10}$`],
    ['PAN pattern', String.raw`^[A-Za-z0-9]{1,20}$`],
  ])('%s is present verbatim', (_n, re) => expect(s()).toContain(re));
  it('quantities use DecimalField, prices MoneyField (no <input type=number>)', () => {
    expect(s()).toMatch(/DecimalField/);
    expect(s()).toMatch(/MoneyField/);
    expect(strip(s())).not.toMatch(/type=["']number["']/);
  });
});
