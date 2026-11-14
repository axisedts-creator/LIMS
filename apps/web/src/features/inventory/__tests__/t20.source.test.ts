// C12.T-20 source/structure checks: files exist where plan row T-20 says (done_when: loading/error per page); LD-140 (kit only, no hex/px/inline style); no token in client code. Static; no rendering.
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

const A = join(src, 'app/(staff)/inventory');
const dirs = ['', 'alerts', 'settings']; // '' = /inventory (S1)
const pageFiles = dirs.flatMap((d) => ['page.tsx', 'loading.tsx', 'error.tsx'].map((f) => join(A, d, f))).filter(existsSync);
const feature = walk(join(src, 'features/inventory')).filter(code);
const ui = feature.filter((f) => /\.tsx$/.test(f) || /[\\/](components|forms)[\\/]/.test(f));
const t20 = [...pageFiles, ...feature];

describe('files exist (plan row T-20)', () => {
  it('features/inventory/nav.manifest.ts', () => expect(existsSync(join(src, 'features/inventory/nav.manifest.ts'))).toBe(true));
  it.each(dirs)('app/(staff)/inventory/%s has page.tsx, loading.tsx, error.tsx', (d) => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(A, d, f)), `${d}/${f}`).toBe(true);
  });
  it.each(dirs.filter(Boolean))('%s loading uses the kit LoadingSkeleton, error uses the kit ErrorState with onRetry and only the digest as reference', (d) => {
    expect(read(join(A, d, 'loading.tsx'))).toMatch(/@lims\/ui\/components\/LoadingSkeleton/);
    const e = read(join(A, d, 'error.tsx'));
    expect(e).toMatch(/^\s*['"]use client['"]/m);
    expect(e).toMatch(/@lims\/ui\/components\/ErrorState/);
    expect(e).toMatch(/onRetry/);
    expect(strip(e)).not.toMatch(/error\.message|error\.stack/);
  });
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
  it('the T-20 pages cite LD-140 in a comment', () => expect(pageFiles.filter((f) => /page\.tsx$/.test(f) && /alerts|settings|inventory[\\/]page/.test(f)).map(read).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in client component files', () => {
    const client = ui.filter((f) => /^\s*['"]use client['"]/m.test(read(f)));
    expect(client.length).toBeGreaterThan(0);
    for (const f of client) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('spec copy (04-UI-UX §3 S1, S18, §1)', () => {
  const all = () => feature.map(read).join('\n');
  it.each([
    'Automatic consumption is off. Stock is not deducted for tests, QC or reruns until a manager turns it on in Settings.',
    'Turn off if your lab can claim purchase VAT back (ask your auditor).',
    'Below reorder level', 'Expiring soon', 'Expired stock on hand', 'Open container past stability', 'Stock below zero', 'Waiting consumption', 'Expired lot in use', 'Stock record mismatch', 'Counts differ from lab',
  ])('contains "%s"', (copy) => expect(all()).toContain(copy));
  it('the nav manifest reuses the CR-C12-002 route ids only (no invented route id)', () => {
    const ids = [...read(join(src, 'features/inventory/nav.manifest.ts')).matchAll(/routeId:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(ids.length).toBe(15);
    for (const id of ids) expect(id).toMatch(/^staff\.inventory\.[a-z_]+$/);
  });
});
