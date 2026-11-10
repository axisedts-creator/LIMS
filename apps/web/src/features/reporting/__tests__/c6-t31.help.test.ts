// C6-T31 help files (plan row: "help files"; 04-UI-UX §1: PageHeader requires helpKey). Mirrors BL-T23's convention.
// ASSUMED naming (dispute if wrong): help file = features/reporting/help/<suffix of PageHeader helpKey "reporting.<suffix>">.md; each has headings
// containing "Purpose", "Fields", "Shortcuts". Screens = every literal helpKey="reporting.x" found in features/reporting/components/**/*.tsx.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const comps = join(root, 'apps/web/src/features/reporting/components');
const helpDir = join(root, 'apps/web/src/features/reporting/help');
const read = (p: string) => readFileSync(p, 'utf8');
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);
const tsxIn = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsxIn(join(d, e.name)) : e.name.endsWith('.tsx') ? [join(d, e.name)] : [])) : []);

const helpKeys = [...new Set(tsxIn(comps).flatMap((f) => [...read(f).matchAll(/helpKey=["'{`]*reporting\.([a-z_]+)/g)].map((m) => m[1]!)))].sort();
const allHelp = () => mdIn(helpDir).map((n) => read(join(helpDir, n))).join('\n');

describe('C6-T31 help: every reporting screen', () => {
  it('discovers the screens (non-vacuous): worklist, outsourced, messages, settings + at least 5 more', () => {
    expect(helpKeys.length).toBeGreaterThanOrEqual(9);
    expect(helpKeys).toEqual(expect.arrayContaining(['worklist', 'outsourced', 'messages', 'settings']));
  });
  it.each(helpKeys)('help/%s.md exists with purpose, fields, shortcuts', (k) => {
    const p = join(helpDir, `${k}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = read(p);
    expect(t.length).toBeGreaterThan(300);
    expect(t).toMatch(/^#\s+\S/m);
    for (const h of ['Purpose', 'Fields', 'Shortcuts']) expect(t, `${k}.md needs a "${h}" heading`).toMatch(new RegExp(`^#{2,3}\\s+.*${h}`, 'im'));
  });
  it('no orphan help files', () => {
    expect(mdIn(helpDir).filter((n) => !helpKeys.includes(n.replace(/\.md$/, '')))).toEqual([]);
  });
});

describe('C6-T31 help documents the registered shortcuts (04-UI-UX §1.1)', () => {
  it('worklist help lists Alt+1…Alt+6, "/" and Alt+R', () => {
    const t = read(join(helpDir, 'worklist.md'));
    for (const k of ['Alt+1', 'Alt+6', 'Alt+R']) expect(t, k).toContain(k);
    expect(t).toMatch(/`\/`/);
  });
  it('the detail and narrative help list Alt+P, Alt+D, Ctrl+S, Ctrl+Enter, Alt+I', () => {
    const t = allHelp();
    for (const k of ['Alt+P', 'Alt+D', 'Ctrl+S', 'Ctrl+Enter', 'Alt+I']) expect(t, k).toContain(k);
  });
});

describe('C6-T31 help content rules', () => {
  it('uses only synthetic examples: no phone numbers, no real-looking emails', () => {
    const t = allHelp();
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toMatch(/\+?977[- ]?\d{8,10}|\b9[78]\d{8}\b/);
    expect(t).not.toMatch(/[\w.+-]+@(?!example\.(com|org)\b)[\w-]+\.\w+/);
  });
  it('delivery help states that destinations are masked and message text/links/OTPs are never shown (04-UI-UX §2.5)', () => {
    const k = helpKeys.find((x) => /deliver/.test(x));
    expect(k, 'a deliveries help key').toBeTruthy();
    expect(read(join(helpDir, `${k}.md`))).toMatch(/masked/i);
  });
  it('settings help says online payment is turned on only after online payments are live (08 A11.1)', () => {
    expect(read(join(helpDir, 'settings.md'))).toMatch(/online payments? (are|is) live/i);
  });
});
