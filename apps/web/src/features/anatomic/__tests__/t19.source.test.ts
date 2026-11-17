// C11.T-19 source/structure checks: files exist where plan row T-19 says; LD-140 (kit only, no hex/px/inline style); REQ-SEC-088 (no raw HTML);
// REQ-SEC-098 (label never logged/in URL); BFF reads are server-only; scanner + gross-upload kit props. Static; no rendering.
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
const norm = (p: string) => p.replace(/\\/g, '/');

const ui = [...walk(join(src, 'features/anatomic/components')), ...walk(join(src, 'features/anatomic/forms'))].filter(code);
const pages = walk(join(src, 'app/(staff)/anatomic')).filter(code).filter((f) => !/\/(tracking|batches|config)\//.test(norm(f)) && !/\/labels\//.test(norm(f)));
const server = walk(join(src, 'features/anatomic/server')).filter(code);
const all = [...ui, ...pages, ...server];

describe('files exist (plan row T-19)', () => {
  it.each([
    'app/(staff)/anatomic/page.tsx',
    'app/(staff)/anatomic/loading.tsx',
    'app/(staff)/anatomic/error.tsx',
    'app/(staff)/anatomic/cases/[case_id]/page.tsx',
    'features/anatomic/nav.manifest.ts',
    'features/anatomic/components/WorklistScreen.tsx',
    'features/anatomic/components/CaseWorkspace.tsx',
    'features/anatomic/help/anatomic.worklist.ts',
    'features/anatomic/help/anatomic.case.ts',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it('features/anatomic/server and forms are non-empty', () => {
    expect(server.length).toBeGreaterThan(0);
    expect(walk(join(src, 'features/anatomic/forms')).filter(code).length).toBeGreaterThan(0);
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
    expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/); // REQ-SEC-098: labels/PHI never logged
  });
  it.each(ui.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only', (_n, f) => {
    for (const m of read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)) expect(m[1], m[1]).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });
  it('feature code cites LD-140 in a comment (lead decision binding)', () => expect(all.map(read).join('\n')).toMatch(/LD-140/));
  it('no token / JWT handling in client component files', () => {
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
});

describe('server boundary', () => {
  it.each(server.filter((f) => /\.server\.ts$/.test(f)).map((f) => [relative(src, f), f]))("%s starts with import 'server-only'", (_n, f) => {
    expect(read(f as string)).toMatch(/^import 'server-only';/m);
  });
  it('route ids are validated as UUIDs before reaching an API path (REQ-SEC-026/027)', () => {
    expect(server.map(read).join('\n')).toMatch(/uuid|UUID|isUuid/);
  });
  it('lookup sends the label in the POST body, never in the URL (REQ-SEC-098)', () => {
    const s = server.map(read).join('\n');
    expect(s).toMatch(/\/v1\/anatomic\/cases\/lookup/);
    expect(s).not.toMatch(/lookup\?|lookup\/\$\{/);
  });
  it('error.tsx is a client component; loading.tsx and the pages are not', () => {
    expect(read(join(src, 'app/(staff)/anatomic/error.tsx'))).toMatch(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/);
    expect(strip(read(join(src, 'app/(staff)/anatomic/error.tsx'))).replace(/\s+/g, ' ')).not.toMatch(/error\.(message|stack)\b/);
    for (const f of ['page.tsx', 'loading.tsx', 'cases/[case_id]/page.tsx']) expect(read(join(src, 'app/(staff)/anatomic', f)), f).not.toMatch(/^\s*['"]use client['"]/m);
  });
});

describe('kit usage that tests cannot see in the DOM', () => {
  const wl = existsSync(join(src, 'features/anatomic/components/WorklistScreen.tsx')) ? read(join(src, 'features/anatomic/components/WorklistScreen.tsx')) : '';
  const uiAll = ui.map(read).join('\n');
  it('lookup is a kit BarcodeInput: name "label", pattern /^[A-Z0-9-]{1,32}$/, submitKeys Enter+Tab, clearAfterScan, allowManual (04-UI-UX §2)', () => {
    expect(wl).toMatch(/BarcodeInput/);
    expect(wl).toMatch(/name=["']label["']/);
    expect(wl).toMatch(/\/\^\[A-Z0-9-\]\{1,32\}\$\//);
    expect(wl).toMatch(/submitKeys=\{\[\s*'Enter'\s*,\s*'Tab'\s*\]\}/);
    expect(wl).not.toMatch(/clearAfterScan=\{false\}|allowManual=\{false\}/);
  });
  it('worklist is built from kit Tabs, FilterBar, DataTable, StatusChip(kind="generic"), EmptyState', () => {
    for (const c of ['Tabs', 'FilterBar', 'DataTable', 'StatusChip', 'EmptyState']) expect(wl, c).toMatch(new RegExp(`\\b${c}\\b`));
    expect(wl).toMatch(/kind=["']generic["']/);
  });
  it('gross images: kit FileUpload accept png+jpeg only, 15 MB cap, multiple, maxFiles 10 (04-UI-UX §4.2.2)', () => {
    expect(uiAll).toMatch(/FileUpload/);
    expect(uiAll).toMatch(/image\/png/);
    expect(uiAll).toMatch(/image\/jpeg/);
    expect(uiAll).toMatch(/maxBytes=\{\s*(15728640|15 \* 1024 \* 1024)\s*\}/);
    expect(uiAll).toMatch(/maxFiles=\{\s*10\s*\}/);
    expect(uiAll).not.toMatch(/accept=\{\[[^\]]*(image\/(gif|webp|svg)|application\/)/);
  });
  it('narrative fields are plain kit TextArea with showCount; gross text maxLength 20000', () => {
    expect(uiAll).toMatch(/TextArea/);
    expect(uiAll).toMatch(/showCount/);
    expect(uiAll).toMatch(/20000|20_000/);
  });
  it('shortcuts are registered through core/shortcuts/registry with page ids staff.anatomic.worklist / staff.anatomic.case', () => {
    expect(uiAll).toMatch(/@\/core\/shortcuts\/registry/);
    expect(uiAll).toMatch(/staff\.anatomic\.worklist/);
    expect(uiAll).toMatch(/staff\.anatomic\.case/);
  });
  it('shortcuts are inactive during IME composition (§3)', () => expect(uiAll).toMatch(/isComposing|compositionstart/));
  it('PageHeader carries helpKey anatomic.worklist and anatomic.case', () => {
    expect(uiAll).toMatch(/helpKey=["']anatomic\.worklist["']/);
    expect(uiAll).toMatch(/helpKey=["']anatomic\.case["']/);
  });
});

describe('routes (contracts/routes.yaml) are served', () => {
  it('case page reads the dynamic segment named case_id', () => {
    const p = join(src, 'app/(staff)/anatomic/cases/[case_id]/page.tsx');
    expect(existsSync(p)).toBe(true);
    expect(read(p)).toMatch(/case_id/);
  });
});
