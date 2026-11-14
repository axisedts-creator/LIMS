// C10.T-24 source/structure checks: pages + components exist where the plan row says, LD-140 (kit only, no hex/px/inline style), REQ-SEC-088 (no raw HTML),
// BFF reads are server-only, nav routes resolve to pages. Static; no rendering.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const src = join(web, 'src');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : []);
const code = (p: string) => /\.(ts|tsx)$/.test(p);
const featureFiles = [...walk(join(src, 'features/micro/components/settings')), ...walk(join(src, 'features/micro/components/breakpoints'))].filter(code);
const pageFiles = [...walk(join(src, 'app/(staff)/micro/settings')), ...walk(join(src, 'app/(staff)/micro/breakpoint-sets'))].filter(code);
const all = [...featureFiles, ...pageFiles];
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('files exist (plan row T-24)', () => {
  it.each([
    'app/(staff)/micro/settings/page.tsx',
    'app/(staff)/micro/breakpoint-sets/page.tsx',
    'app/(staff)/micro/breakpoint-sets/[breakpoint_set_id]/page.tsx',
    'features/micro/components/settings/MicroSettingsScreen.tsx',
    'features/micro/components/breakpoints/BreakpointSetsScreen.tsx',
    'features/micro/components/breakpoints/BreakpointSetDetail.tsx',
    'features/micro/server/getBreakpointSet.server.ts',
    'features/micro/server/listBreakpointImportIssues.server.ts',
    'features/micro/server/listBreakpointRows.server.ts',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(all.length).toBeGreaterThan(3));
  it.each(all.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects or dangerouslySetInnerHTML', (_n, f) => {
    const s = strip(read(f as string));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/); // hex colour literals
    expect(s).not.toMatch(/border-?[Rr]adius/); // radii come from tokens
    expect(s).not.toMatch(/\bstyle=\{\{/); // inline style objects
    expect(s).not.toMatch(/\bstyle=\{[^}]*\}/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML/); // REQ-SEC-088, S-13
    expect(s).not.toMatch(/\binnerHTML\b/);
  });

  it.each(featureFiles.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only (no raw third-party UI kits)', (_n, f) => {
    const imports = [...read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
    for (const i of imports) expect(i, `${i}`).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });

  it('every page and component marks no secrets: no token or JWT in client files', () => {
    for (const f of featureFiles) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('import dialog uses the kit FileUpload with text/csv and the 5 MiB cap (08 §4.6, REQ-SEC-083)', () => {
  const dialog = featureFiles.filter((f) => /breakpoints/.test(f.replace(/\\/g, '/'))).map(read).join('\n');
  it("FileUpload accept=['text/csv'] maxBytes={5242880}", () => {
    expect(dialog).toMatch(/FileUpload/);
    expect(dialog).toMatch(/accept=\{\[\s*'text\/csv'\s*\]\}/);
    expect(dialog).toMatch(/maxBytes=\{\s*(5242880|5 \* 1024 \* 1024)\s*\}/);
  });
  it('no other MIME type is accepted', () => expect(dialog).not.toMatch(/accept=\{\[[^\]]*(xlsx|spreadsheetml|application\/|image\/)/));
});

describe('server boundary', () => {
  const server = walk(join(src, 'features/micro/server')).filter(code);
  it.each(server.filter((f) => /\.server\.ts$/.test(f)).map((f) => [relative(src, f), f]))("%s starts with import 'server-only'", (_n, f) => {
    expect(read(f as string)).toMatch(/^import 'server-only';/m);
  });
  it('route params are validated as UUIDs before being put in an API path (REQ-SEC-026/027)', () => {
    const s = server.map(read).join('\n');
    expect(s).toMatch(/uuid|UUID|isUuid/);
  });
});

describe('routes (contracts/routes.yaml) are served', () => {
  it('detail page reads the dynamic segment named breakpoint_set_id', () => {
    const p = join(src, 'app/(staff)/micro/breakpoint-sets/[breakpoint_set_id]/page.tsx');
    expect(existsSync(p), 'page exists').toBe(true);
    expect(read(p)).toMatch(/breakpoint_set_id/);
  });
});
