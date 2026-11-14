// C10.T-20 source/structure checks: files exist where plan row T-20 says; LD-140 (kit only, no hex / px radius / inline style); REQ-SEC-088 (no raw HTML);
// REQ-SEC-098 (barcode / PHI never logged); BFF reads are server-only and validate ids; shortcuts registered under 'micro.culture'; no token in client code. Static.
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

const pageDir = join(src, 'app/(staff)/micro/cultures/[culture_id]');
const ui = [...walk(join(src, 'features/micro/components/culture')), ...walk(join(src, 'features/micro/forms'))].filter(code);
const pages = walk(pageDir).filter(code);
const serverNames = ['getCulture', 'getPatient'].map((n) => join(src, `features/micro/server/${n}.server.ts`));
const all = [...ui, ...pages, ...serverNames.filter(existsSync)];

describe('files exist (plan row T-20)', () => {
  it.each([
    'app/(staff)/micro/cultures/[culture_id]/page.tsx',
    'app/(staff)/micro/cultures/[culture_id]/loading.tsx',
    'app/(staff)/micro/cultures/[culture_id]/error.tsx',
    'features/micro/components/culture/CultureScreen.tsx',
    'features/micro/server/getCulture.server.ts',
    'features/micro/server/getPatient.server.ts',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it('features/micro/forms/ holds the dialog forms (plan row: forms/*)', () => {
    expect(walk(join(src, 'features/micro/forms')).filter(code).length).toBeGreaterThan(0);
  });
  it('a "use server" file in features/micro/server carries the culture writes (setup, plates, observations, isolates)', () => {
    const actions = walk(join(src, 'features/micro/server')).filter(code).filter((f) => /^['"]use server['"]/m.test(read(f)));
    const t = actions.map(read).join('\n');
    for (const p of ['/setup', '/plates', '/observations', '/isolates', '/identify', '/withdraw']) expect(t, p).toContain(p);
  });
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(all.length).toBeGreaterThan(5));
  it.each(all.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
    const s = strip(read(f as string));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(s).not.toMatch(/border-?[Rr]adius/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b/);
    expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/); // REQ-SEC-098: barcodes / patient data never logged
  });
  it.each(ui.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only', (_n, f) => {
    for (const m of read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)) expect(m[1], m[1]).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });
  it('feature code cites LD-140 in a comment (lead decision binding)', () => expect(all.map((f) => read(f)).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in client component or form files', () => {
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
  it('only kit-spelled primary buttons: no hand-made <button> / <input> / <select> / <textarea> / <dialog> in culture components', () => {
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/<(button|input|select|textarea|dialog)[\s>]/);
  });
});

describe('server boundary', () => {
  it.each(serverNames.map((f) => [relative(src, f), f]))("%s starts with import 'server-only'", (_n, f) => {
    expect(read(f as string)).toMatch(/^import 'server-only';/m);
  });
  it('ids reaching an API path are validated as UUIDs (REQ-SEC-026/027)', () => {
    expect(serverNames.map((f) => read(f)).join('\n')).toMatch(/uuid|UUID/);
  });
  it('getPatient reads C4 through /v1/frontdesk/patients/ and never falls through to an error (null on failure)', () => {
    const s = strip(read(serverNames[1]!));
    expect(s).toContain('/v1/frontdesk/patients/');
    expect(s).toMatch(/catch|allSettled|\.catch\(/);
    expect(s).toMatch(/null/);
  });
  it('error.tsx is a client component that never prints error.message (no internal detail leak)', () => {
    const f = join(pageDir, 'error.tsx');
    expect(existsSync(f)).toBe(true);
    const s = strip(read(f));
    expect(s).toMatch(/^['"]use client['"]/m);
    expect(s).not.toMatch(/error\.message|\.stack/);
  });
  it('the page registers its shortcuts under the id "micro.culture"', () => {
    const t = ui.map(read).join('\n');
    expect(t).toMatch(/shortcuts\.register\(\s*['"]micro\.culture['"]/);
  });
  it('the barcode (scan dialog) never goes into a URL', () => {
    const t = strip(ui.map(read).join('\n'));
    expect(t).not.toMatch(/(router\.(push|replace)|href=|fetch\()[^;\n]*barcode/i);
  });
});
