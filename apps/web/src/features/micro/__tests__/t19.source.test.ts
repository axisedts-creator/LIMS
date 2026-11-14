// C10.T-19 source/structure checks: files exist where plan row T-19 says; LD-140 (kit only, no hex / px radius / inline style); REQ-SEC-088 (no raw HTML);
// REQ-SEC-098 (barcode never logged / in a URL); BFF reads are server-only; scan bar kit props. Static; no rendering.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const src = join(web, 'src');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : []);
const code = (p: string) => /\.(ts|tsx)$/.test(p);
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ui = walk(join(src, 'features/micro/components/worklist')).filter(code);
const pages = walk(join(src, 'app/(staff)/micro/worklist')).filter(code);
const serverNames = ['listCultures', 'lookupSpecimenByBarcode', 'getSpecimen', 'listCentres'].map((n) => join(src, `features/micro/server/${n}.server.ts`));
const all = [...ui, ...pages, ...serverNames.filter(existsSync)];

describe('files exist (plan row T-19)', () => {
  it.each([
    'app/(staff)/micro/worklist/page.tsx',
    'app/(staff)/micro/worklist/loading.tsx',
    'app/(staff)/micro/worklist/error.tsx',
    'features/micro/components/worklist/WorklistScreen.tsx',
    'features/micro/server/listCultures.server.ts',
    'features/micro/server/lookupSpecimenByBarcode.server.ts',
    'features/micro/server/getSpecimen.server.ts',
    'features/micro/server/listCentres.server.ts',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(all.length).toBeGreaterThan(5));
  it.each(all.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
    const s = strip(read(f as string));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(s).not.toMatch(/border-?[Rr]adius/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b/);
    expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/); // REQ-SEC-098: barcodes/PHI never logged
  });
  it.each(ui.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only', (_n, f) => {
    for (const m of read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)) expect(m[1], m[1]).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });
  it('feature code cites LD-140 in a comment (lead decision binding)', () => expect(all.map((f) => read(f)).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in client component files', () => {
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('server boundary', () => {
  it.each(serverNames.map((f) => [relative(src, f), f]))("%s starts with import 'server-only'", (_n, f) => {
    expect(read(f as string)).toMatch(/^import 'server-only';/m);
  });
  it('ids reaching an API path are validated as UUIDs (REQ-SEC-026/027)', () => {
    expect(serverNames.map((f) => read(f)).join('\n')).toMatch(/uuid|UUID/);
  });
  it('scan: the barcode travels in the POST body of /v1/lab/specimens/lookup, never in a URL (REQ-SEC-098)', () => {
    const s = read(serverNames[1]!);
    expect(s).toMatch(/\/v1\/lab\/specimens\/lookup/);
    expect(s).not.toMatch(/lookup\?|lookup\/\$\{|barcode=/);
  });
  it('centres: C2 listCentres is called with is_active=true', () => expect(read(serverNames[3]!)).toMatch(/\/v1\/identity\/centres\?is_active=true/));
  it('error.tsx is a client component and never prints error.message / stack; loading.tsx and page.tsx are server components', () => {
    const dir = join(src, 'app/(staff)/micro/worklist');
    expect(read(join(dir, 'error.tsx'))).toMatch(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/);
    expect(strip(read(join(dir, 'error.tsx'))).replace(/\s+/g, ' ')).not.toMatch(/error\.(message|stack)\b/);
    for (const f of ['page.tsx', 'loading.tsx']) expect(read(join(dir, f)), f).not.toMatch(/^\s*['"]use client['"]/m);
  });
});

describe('kit usage that tests cannot see in the DOM (04-UI-UX §2, §11 component list)', () => {
  const wl = existsSync(join(src, 'features/micro/components/worklist/WorklistScreen.tsx')) ? read(join(src, 'features/micro/components/worklist/WorklistScreen.tsx')) : '';
  const uiAll = ui.map((f) => read(f)).join('\n');
  it('scan bar is a kit BarcodeInput labelled "Scan specimen barcode", autoFocus, default C5 pattern, allowManual/clearAfterScan kept', () => {
    expect(wl).toMatch(/BarcodeInput/);
    expect(wl).toMatch(/Scan specimen barcode/);
    expect(wl).not.toMatch(/autoFocus=\{false\}|clearAfterScan=\{false\}|allowManual=\{false\}/);
    expect(wl).not.toMatch(/pattern=\{\/\^\[A-Z0-9-\]/); // C5 barcode charset is /^[A-Z0-9]{1,20}$/ (the kit default); hyphens are not part of it
  });
  it('worklist is built from kit PageHeader, Tabs, FilterBar, DataTable, StatusChip(kind="generic"), Badge, EmptyState, Banner, Dialog', () => {
    for (const c of ['PageHeader', 'Tabs', 'FilterBar', 'DataTable', 'StatusChip', 'Badge', 'EmptyState', 'Banner', 'Dialog']) expect(uiAll, c).toMatch(new RegExp(`\\b${c}\\b`));
    expect(uiAll).toMatch(/kind=["']generic["']/);
    expect(uiAll).toMatch(/tone=["']info["']/);
  });
  it('DataTable is compact and captioned "Microbiology cultures"', () => {
    expect(uiAll).toMatch(/Microbiology cultures/);
    expect(uiAll).toMatch(/compact/);
  });
  it('shortcuts go through core/shortcuts/registry (Alt+B) and PageHeader carries helpKey micro.worklist', () => {
    expect(uiAll).toMatch(/@\/core\/shortcuts\/registry/);
    expect(uiAll).toMatch(/Alt\+B/);
    expect(uiAll).toMatch(/helpKey=["']micro\.worklist["']/);
  });
  it('the "no culture" message is one constant used for both unknown barcode and no culture (no oracle)', () => {
    const found = [...all.map((f) => read(f)).join('\n').matchAll(/No microbiology culture for this specimen/g)];
    expect(found).toHaveLength(1);
  });
});
