// C11.T-25 — in-app help + user manual. Spec: 04-UI-UX header ("every page has PageHeader with a helpKey and a help file in
// apps/web/src/features/anatomic/help/ — build fails otherwise"), §3 (page shortcuts), §9 (manual pages, screenshots from synthetic data only).
// Plan row T-25: "every helpKey has help; manual pages per 04-UI-UX §9". Existing help format (T-19..T-23): help/<helpKey>.ts, default export
// { title, sections:[{heading,body}], shortcuts?:[{keys,action}], links?:[{routeId,label}] }.
// LD-140 (UI work): help is plain data, no styling in feature code -> no hex colours / pixel sizes / inline style objects in help files.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const feature = join(root, 'apps/web/src/features/anatomic');
const helpDir = join(feature, 'help');
const manualDir = join(root, 'docs/manual/anatomic');
const read = (p: string) => readFileSync(p, 'utf8');

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === '__tests__' || n === 'help') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}
// Every helpKey any anatomic screen passes to PageHeader (so a new screen without help fails here).
const helpKeys = [...new Set(walk(feature).flatMap((f) => [...read(f).matchAll(/helpKey=["']([a-z_.]+)["']/g)].map((m) => m[1]!)))].sort();
const helpFiles = readdirSync(helpDir).filter((n) => /\.tsx?$/.test(n));

type Help = { title: string; sections: { heading: string; body: string }[]; shortcuts?: { keys: string; action: string }[]; links?: { routeId: string; label: string }[] };
const load = async (k: string): Promise<Help> => (await import(/* @vite-ignore */ pathToFileURL(join(helpDir, `${k}.ts`)).href)).default;

const KNOWN_ROUTES = ['staff.anatomic.worklist', 'staff.anatomic.tracking', 'staff.anatomic.batches', 'staff.anatomic.config'];

describe('C11 T-25 in-app help: every helpKey has help', () => {
  it('discovers the T-19..T-23 screens (non-vacuous)', () => {
    expect(helpKeys).toEqual(expect.arrayContaining(['anatomic.worklist', 'anatomic.case', 'anatomic.tracking', 'anatomic.batches', 'anatomic.batch', 'anatomic.config', 'anatomic.config.template']));
  });
  it.each(helpKeys)('help/%s.ts exists with a title, sections, and plain-text content', async (k) => {
    const p = join(helpDir, `${k}.ts`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const h = await load(k);
    expect(typeof h.title).toBe('string');
    expect(h.title.trim().length).toBeGreaterThan(2);
    expect(Array.isArray(h.sections)).toBe(true);
    expect(h.sections.length).toBeGreaterThanOrEqual(2);
    for (const s of h.sections) {
      expect(s.heading.trim().length, `${k}: empty heading`).toBeGreaterThan(1);
      expect(s.body.trim().length, `${k}/${s.heading}: body too short`).toBeGreaterThan(40);
      expect(s.body, `${k}/${s.heading}: markup/HTML in plain-data help`).not.toMatch(/<[a-z][^>]*>/i);
    }
    for (const l of h.links ?? []) expect(KNOWN_ROUTES, `${k}: unknown routeId ${l.routeId}`).toContain(l.routeId);
  });
  it('no orphan help files (each maps to a helpKey)', () => {
    expect(helpFiles.map((n) => n.replace(/\.tsx?$/, '')).filter((k) => !helpKeys.includes(k))).toEqual([]);
  });
  it('page shortcuts in help match 04-UI-UX §3', async () => {
    const keysOf = async (k: string) => ((await load(k)).shortcuts ?? []).map((s) => s.keys);
    expect(await keysOf('anatomic.worklist')).toContain('Alt+F');
    expect(await keysOf('anatomic.tracking')).toContain('Alt+V');
    expect(await keysOf('anatomic.case')).toEqual(expect.arrayContaining(['Alt+O', 'Alt+G', 'Alt+B', 'Alt+T', 'Alt+I', 'Alt+R', 'Alt+A', 'Alt+L', 'Alt+S', 'Alt+U']));
    for (const k of helpKeys) for (const s of (await load(k)).shortcuts ?? []) expect(s.keys, `${k}: banned shortcut form`).toMatch(/^(Alt\+[A-Z]|Ctrl\+Enter|Esc)$/);
  });
  it('LD-140: help files carry no hex colours, pixel sizes or inline style objects', () => {
    for (const n of helpFiles) {
      const t = read(join(helpDir, n));
      expect(t, `${n}: hex colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(t, `${n}: px value`).not.toMatch(/\b\d+px\b/);
      expect(t, `${n}: inline style`).not.toMatch(/style\s*=\s*\{\{/);
    }
  });
});

// 04-UI-UX §9 — exact file list.
const PAGES = ['worklist', 'accession', 'grossing', 'blocks-slides', 'stains-ihc', 'images', 'report-signout', 'revisions-addenda', 'molecular', 'tracking', 'setup'];
const pageText = (n: string) => (existsSync(join(manualDir, `${n}.md`)) ? read(join(manualDir, `${n}.md`)) : '');

describe('C11 T-25 manual pages (docs/manual/anatomic, 04-UI-UX §9)', () => {
  it('has exactly the eleven pages listed in §9 (plus an optional README and images/)', () => {
    expect(existsSync(manualDir), `missing ${manualDir}`).toBe(true);
    const md = readdirSync(manualDir).filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, '')).filter((n) => n.toLowerCase() !== 'readme');
    expect(md.sort()).toEqual([...PAGES].sort());
  });
  describe.each(PAGES)('%s.md', (n) => {
    const p = join(manualDir, `${n}.md`);
    it('exists, non-trivial, with an H1 title and at least two sections', () => {
      expect(existsSync(p), `missing ${p}`).toBe(true);
      const t = pageText(n);
      expect(t.length).toBeGreaterThan(400);
      expect(t).toMatch(/^#\s+\S/m);
      expect((t.match(/^##\s+\S/gm) ?? []).length).toBeGreaterThanOrEqual(2);
    });
    it('has at least one screenshot (existing file under the manual) and says it is synthetic data', () => {
      const t = pageText(n);
      const imgs = [...t.matchAll(/!\[([^\]]+)\]\(([^)\s]+)\)/g)];
      expect(imgs.length, `${n}.md needs a screenshot`).toBeGreaterThanOrEqual(1);
      for (const [, alt, src] of imgs) {
        expect(alt!.trim().length, `${n}.md: empty alt text`).toBeGreaterThan(5);
        expect(src, `${n}.md: remote image`).not.toMatch(/^[a-z]+:\/\//i);
        expect(existsSync(join(dirname(p), src!)), `${n}.md: image not found ${src}`).toBe(true);
      }
      expect(t).toMatch(/synthetic/i);
    });
    it('contains no real-looking identifiers or secrets (synthetic data only)', () => {
      const t = pageText(n);
      expect(t).not.toMatch(/\b\d{10,}\b/); // long national/phone-style numbers
      expect(t).not.toMatch(/[\w.+-]+@(?!example\.(com|org|test))[\w-]+\.[a-z]{2,}/i);
      expect(t).not.toMatch(/(password|secret|api[_-]?key|token)\s*[:=]\s*\S+/i);
    });
  });
  it('covers every anatomic route and the shortcut facts from the screens', () => {
    const all = PAGES.map(pageText).join('\n');
    for (const r of ['/anatomic', '/anatomic/tracking', '/anatomic/batches', '/anatomic/config', '/anatomic/cases/']) expect(all, `manual does not mention ${r}`).toContain(r);
    for (const k of ['Alt+F', 'Alt+V', 'Alt+U', 'Alt+S']) expect(all, `manual does not mention ${k}`).toContain(k);
  });
  it('report-signout / revisions-addenda explain the reason requirement for amendments', () => {
    const t = ['report-signout', 'revisions-addenda'].map(pageText).join('\n');
    expect(t).toMatch(/amend/i);
    expect(t).toMatch(/reason/i);
    expect(t).toMatch(/addend/i);
  });
  it('no dead relative .md links between manual pages', () => {
    expect(existsSync(manualDir), `missing ${manualDir}`).toBe(true);
    for (const n of readdirSync(manualDir).filter((f) => f.endsWith('.md')))
      for (const m of read(join(manualDir, n)).matchAll(/\]\(((?!https?:|#)[^)\s#]+\.md)(?:#[^)]*)?\)/g)) expect(existsSync(join(manualDir, m[1]!)), `${n}: dead link ${m[1]}`).toBe(true);
  });
});
