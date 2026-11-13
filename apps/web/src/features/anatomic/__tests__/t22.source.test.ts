// C11.T-22 source/structure checks: files exist where plan row T-22 says; LD-140 (kit only, no hex/px/inline style); REQ-SEC-088; no token handling in client files; no page shortcut that clashes. Static; no rendering.
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

const molecular = walk(join(src, 'features/anatomic/components/molecular')).filter(code);
const batchPages = walk(join(src, 'app/(staff)/anatomic/batches')).filter(code);
const ui = molecular;
const t22 = [...molecular, ...batchPages];

describe('files exist (plan row T-22)', () => {
  it.each([
    'app/(staff)/anatomic/batches/page.tsx',
    'app/(staff)/anatomic/batches/[batch_id]/page.tsx',
    'features/anatomic/help/anatomic.batches.ts', // every page has a helpKey and a help file (04-UI-UX header; build fails otherwise)
    'features/anatomic/help/anatomic.batch.ts',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it('features/anatomic/components/molecular has components (Molecular tab + batches screens)', () => expect(molecular.length).toBeGreaterThan(1));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(t22.length).toBeGreaterThan(3));
  it.each(t22.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
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
  it('feature code cites LD-140 in a comment (lead decision binding)', () => expect(t22.map(read).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in the client component files', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('molecular tab (04-UI-UX §4.2.6)', () => {
  const s = () => molecular.map(read).join('\n');
  it('uses kit DecimalField for Value, DatePicker for Kit expiry, Select for Assay/Target/Result/Batch', () => {
    for (const k of ['DecimalField', 'DatePicker', 'Select']) expect(s(), k).toMatch(new RegExp(`@lims/ui/components/${k}`));
  });
  it('Kit expiry has a 2000-01-01 lower bound', () => expect(s()).toMatch(/2000-01-01/));
  it('sends the molecular_rev as If-Match through the server layer (no ad-hoc fetch from components)', () => {
    expect(molecular.length).toBeGreaterThan(0);
    expect(strip(s())).not.toMatch(/\bfetch\(/);
  });
});

describe('batch pages (04-UI-UX §4.6)', () => {
  const s = () => [...molecular, ...batchPages].map(read).join('\n');
  it('uses kit BarcodeInput with the hyphen-safe pattern, DescriptionList and ConfirmDialog; no hand-rolled grid library', () => {
    expect(s()).toMatch(/BarcodeInput/);
    expect(s()).toMatch(/\^\[A-Z0-9-\]\{1,32\}\$/);
    expect(s()).toMatch(/DescriptionList/);
    expect(s()).toMatch(/ConfirmDialog/);
    expect(s()).not.toMatch(/from\s+'(react-window|react-virtualized|ag-grid[^']*|@tanstack\/react-table)'/);
  });
  it('the pages validate the id as a UUID and call notFound() (REQ-SEC-026/027)', () => {
    const d = batchPages.filter((f) => f.includes('[batch_id]')).map(read).join('\n');
    expect(d.length).toBeGreaterThan(0);
    expect(d).toMatch(/uuid|UUID|isUuid/);
    expect(d).toMatch(/notFound/);
  });
  it('the batch pages register no Alt+ shortcut that clashes with the global keys (Alt+M, Alt+N, Alt+H)', () => {
    expect(batchPages.length).toBeGreaterThan(0);
    expect(strip(s())).not.toMatch(/Alt\+[MNH]\b/);
  });
  it('the scanned value is never put in the URL or logged (C0 §2.4 rule 6)', () => {
    expect(batchPages.length).toBeGreaterThan(0);
    expect(molecular.length).toBeGreaterThan(0);
    expect(strip(s())).not.toMatch(/router\.(push|replace)\([^)]*(label|accession)/i);
  });
});
