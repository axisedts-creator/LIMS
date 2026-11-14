// C11.T-23 source/structure checks: files exist where plan row T-23 says; LD-140 (kit only, no hex/px/inline style); REQ-SEC-026/027/088; no token handling or ad-hoc fetch in client files; the web layer does not import the API's validator;
// help keys; no clashing shortcuts. Static; no rendering.
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

const components = walk(join(src, 'features/anatomic/components/config')).filter(code);
const pages = walk(join(src, 'app/(staff)/anatomic/config')).filter(code);
const ui = components;
const t23 = [...components, ...pages];
const all = () => t23.map(read).join('\n');

describe('files exist (plan row T-23)', () => {
  it.each([
    'app/(staff)/anatomic/config/page.tsx',
    'app/(staff)/anatomic/config/templates/[template_id]/page.tsx',
    'features/anatomic/help/anatomic.config.ts', // every page has a helpKey and a help file (04-UI-UX header; build fails otherwise)
    'features/anatomic/help/anatomic.config.template.ts',
  ])('%s', (f) => expect(existsSync(join(src, f)), f).toBe(true));
  it('features/anatomic/components/config has components (tabs, masters, template builder, preview)', () => expect(components.length).toBeGreaterThan(3));
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(t23.length).toBeGreaterThan(5));
  it.each(t23.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
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
  it('feature code cites LD-140 in a comment (lead decision binding)', () => expect(all()).toMatch(/LD-140/));
  it('no token / JWT handling and no ad-hoc fetch in the client component files (writes go through server actions)', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) {
      expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
      expect(strip(read(f)), relative(src, f)).not.toMatch(/\bfetch\(/);
    }
  });
});

describe('kit components (04-UI-UX §5)', () => {
  it('uses Tabs, DataTable, Drawer, ConfirmDialog, Banner, Switch, IntegerField, Select, TextArea, TextField, EmptyState', () => {
    for (const k of ['Tabs', 'DataTable', 'Drawer', 'ConfirmDialog', 'Banner', 'Switch', 'IntegerField', 'Select', 'TextArea', 'TextField', 'EmptyState']) expect(all(), k).toMatch(new RegExp(`@lims/ui/components/${k}`));
  });
  it('PageHeader carries helpKey anatomic.config and anatomic.config.template', () => {
    expect(all()).toMatch(/helpKey=["']anatomic\.config["']/);
    expect(all()).toMatch(/helpKey=["']anatomic\.config\.template["']/);
  });
  it('no hand-rolled table / drag-and-drop / rich-text library', () => {
    expect(all()).not.toMatch(/from\s+'(react-dnd[^']*|@dnd-kit\/[^']*|react-beautiful-dnd|@tanstack\/react-table|draft-js|quill|slate[^']*|@tiptap\/[^']*)'/);
  });
});

describe('boundaries', () => {
  it('the web layer does not import the API validator or any services/ code (it relies on the 422 and its own pre-checks)', () => {
    expect(t23.length).toBeGreaterThan(0);
    for (const f of t23) expect(strip(read(f)), relative(src, f)).not.toMatch(/services\/api|modules\/anatomic\/domain/);
  });
  it('the template editor page validates the id as a UUID (or the literal "new") and calls notFound() (REQ-SEC-026/027)', () => {
    const d = pages.filter((f) => f.includes('[template_id]')).map(read).join('\n');
    expect(d.length).toBeGreaterThan(0);
    expect(d).toMatch(/uuid|UUID|isUuid/);
    expect(d).toMatch(/notFound/);
    expect(d).toMatch(/['"]new['"]/);
  });
  it('the config pages gate on anatomic.config.manage', () => expect(all()).toMatch(/anatomic\.config\.manage/));
  it('template text is rendered as text: no markdown/HTML renderer is imported for labels, help text or headings', () => {
    expect(all()).not.toMatch(/from\s+'(marked|markdown-it|react-markdown|dompurify|sanitize-html)'/);
  });
  it('the config pages register no Alt+ shortcut that clashes with the global keys (Alt+M, Alt+N, Alt+H)', () => {
    expect(t23.length).toBeGreaterThan(0);
    expect(strip(all())).not.toMatch(/Alt\+[MNH]\b/);
  });
});
