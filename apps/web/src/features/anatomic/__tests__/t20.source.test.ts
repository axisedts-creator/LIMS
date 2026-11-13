// C11.T-20 source/structure checks: files exist where plan row T-20 says; LD-140 (kit only, no hex/px/inline style); REQ-SEC-088/098; scanner + upload kit props; BarcodeSymbol from the kit (CR-C11-007). Static; no rendering.
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

const dir = (p: string) => join(src, p);
const material = walk(dir('features/anatomic/components/material')).filter(code);
const images = walk(dir('features/anatomic/components/images')).filter(code);
const tracking = walk(dir('features/anatomic/components/tracking')).filter(code);
const trackingPage = walk(dir('app/(staff)/anatomic/tracking')).filter(code);
const labelsPage = walk(dir('app/(staff)/anatomic/cases/[case_id]/labels')).filter(code);
const imageRoute = walk(dir('app/(staff)/anatomic/images')).filter(code);
const css = [...walk(dir('app/(staff)/anatomic/cases/[case_id]/labels')), ...walk(dir('features/anatomic/components/material'))].filter((f) => f.endsWith('.css'));
const ui = [...material, ...images, ...tracking];
const t20 = [...ui, ...trackingPage, ...labelsPage, ...imageRoute];

describe('files exist (plan row T-20)', () => {
  it.each([
    'app/(staff)/anatomic/tracking/page.tsx',
    'app/(staff)/anatomic/cases/[case_id]/labels/page.tsx',
    'app/(staff)/anatomic/images/[image_id]/content/route.ts',
    'features/anatomic/help/anatomic.tracking.ts', // every page has a helpKey and a help file (04-UI-UX header; build fails otherwise)
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it.each([['material', material], ['images', images], ['tracking', tracking]] as const)('features/anatomic/components/%s has components', (_n, files) => expect(files.length).toBeGreaterThan(0));
  it('the label sheet has a stylesheet (print CSS)', () => expect(css.length).toBeGreaterThan(0));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(t20.length).toBeGreaterThan(5));
  it.each(t20.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
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
  it.each(css.map((f) => [relative(src, f), f]))('%s: no hex colours and no px radii', (_n, f) => {
    const s = read(f as string).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s).not.toMatch(/border-radius:\s*[\d.]+px/);
  });
  it('feature code cites LD-140 in a comment (lead decision binding)', () => expect(t20.map(read).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in client component files (the image route is server-side and may)', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('labels page (AC-13.3, CR-C11-007)', () => {
  const s = () => labelsPage.map(read).join('\n') + '\n' + material.map(read).join('\n');
  it('uses the kit BarcodeSymbol (no hand-rolled barcode, no external barcode library)', () => {
    expect(s()).toMatch(/BarcodeSymbol/);
    expect(s()).not.toMatch(/from\s+'(jsbarcode|bwip-js|react-barcode|qrcode|barcode)[^']*'/);
  });
  it('the toolbar prints with window.print() and marks screen-only chrome data-print-hide', () => {
    expect(s()).toMatch(/window\.print\(\)/);
    expect(s()).toMatch(/data-print-hide/);
  });
  it('fetches labels by the API path with no label text in the URL (kind + ids only)', () => {
    const all = walk(dir('features/anatomic/server')).filter(code).map(read).join('\n');
    expect(all).toMatch(/\/labels/);
    expect(all).not.toMatch(/labels\?label=|labels\/\$\{(?!case)/);
  });
});

describe('tracking (04-UI-UX §2, §4.5)', () => {
  const s = () => [...tracking, ...trackingPage].map(read).join('\n');
  it('scanner: BarcodeInput with the hyphen-safe pattern, Enter + Tab submit, clear after scan, manual allowed; useScanCapture is on', () => {
    expect(s()).toMatch(/BarcodeInput/);
    expect(s()).toMatch(/\^\[A-Z0-9-\]\{1,32\}\$/);
    expect(s()).toMatch(/submitKeys[^\n]*Enter[^\n]*Tab|submitKeys[^\n]*Tab[^\n]*Enter/);
    expect(s()).toMatch(/clearAfterScan/);
    expect(s()).toMatch(/useScanCapture/);
  });
  it('registers Alt+V on staff.anatomic.tracking and never Alt+M', () => {
    expect(s()).toMatch(/staff\.anatomic\.tracking/);
    expect(s()).toMatch(/Alt\+V/);
    expect(s()).not.toMatch(/Alt\+M/);
  });
  it('uses kit Switch, Timeline and Tabs', () => {
    for (const k of ['Switch', 'Timeline', 'Tabs']) expect(s(), k).toMatch(new RegExp(`@lims/ui/components/${k}`));
  });
});

describe('images tab (04-UI-UX §4.2.5)', () => {
  const s = () => images.map(read).join('\n');
  it('FileUpload: png + jpeg only, 15 MB, multiple, at most 10 files', () => {
    expect(s()).toMatch(/FileUpload/);
    expect(s()).toMatch(/image\/png/);
    expect(s()).toMatch(/image\/jpeg/);
    expect(s()).not.toMatch(/image\/svg|image\/gif|image\/webp|application\/pdf/);
    expect(s()).toMatch(/15\s*\*\s*1024\s*\*\s*1024|15728640|15_728_640/);
    expect(s()).toMatch(/maxFiles[=:{\s]+10\b/);
    expect(s()).toMatch(/multiple/);
  });
  it('thumbnails come from the same-origin BFF route, not an API origin or a signed URL', () => {
    expect(s()).toMatch(/\/anatomic\/images\//);
    expect(s()).not.toMatch(/https?:\/\/|LIMS_ORIGIN|createObjectURL|signedUrl|signed_url/);
  });
  it('no FileReader / data: URL previews of user files on the app origin (REQ-SEC-085)', () => {
    expect(images.length).toBeGreaterThan(0);
    expect(strip(s())).not.toMatch(/FileReader|readAsDataURL|createObjectURL/);
  });
  it('captions carry the "Do not type patient names in captions." hint and maxLength 200', () => {
    expect(s()).toMatch(/Do not type patient names in captions\./);
    expect(s()).toMatch(/200/);
  });
});

describe('image route', () => {
  const s = () => imageRoute.map(read).join('\n');
  it('is server-side, validates the id as a UUID, and sets nosniff + CSP sandbox + no-store (D-67)', () => {
    expect(s()).toMatch(/uuid|UUID|isUuid/);
    expect(s()).toMatch(/nosniff/);
    expect(s()).toMatch(/default-src 'none'; sandbox/);
    expect(s()).toMatch(/no-store/);
  });
  it('allow-lists image/png and image/jpeg only (never relays an upstream content-type blindly)', () => {
    expect(s()).toMatch(/image\/png/);
    expect(s()).toMatch(/image\/jpeg/);
  });
});
