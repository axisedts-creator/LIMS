// T0D-UIX-4 (LD-442, LD-436, LD-437, LD-438): tester-owned markup grep. Display only.
// Done when (5): no raw <table, <dl or <button remains in the non-test .tsx of the 16 feature folders below (catalog and lab belong to T0D-UIX-2 / T0D-UIX-3).
// The kit parts are DataTable, DescriptionList, Button and IconButton (@lims/ui). Comments are stripped before the grep, so a word in a comment never counts.
// Allowed exceptions are named in EXCEPTIONS with a reason; each one is a ceiling (max raw tags) and goes stale when the file no longer has the tag.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const FEATURES = join(import.meta.dirname, '..', '..', 'features');
const FOLDERS = ['frontdesk', 'billing', 'payments', 'reporting', 'smartreport', 'instruments', 'micro', 'anatomic', 'inventory', 'quality', 'partners', 'engagement', 'homecollection', 'offline', 'analytics', 'admin'] as const;
const TAGS = ['table', 'dl', 'button'] as const;
type Tag = (typeof TAGS)[number];

interface Exception { file: string; tag: Tag; max: number; reason: string }
export const EXCEPTIONS: Exception[] = [
  { file: 'micro/components/ast/AstGrid.tsx', tag: 'table', max: 1, reason: 'EditableGrid internals: role=grid with its own arrow key and cell focus handling (AST results entry)' },
  { file: 'anatomic/components/molecular/MolecularTab.tsx', tag: 'table', max: 1, reason: 'EditableGrid internals: role=grid result entry grid with aria-readonly' },
  { file: 'admin/Grid.tsx', tag: 'table', max: 1, reason: 'server pages pass ready cells across the server boundary, which the react-aria DataTable cannot take; it already draws the kit DataTable classes and header (rows open on one click, AD-6/AD-7)' },
  { file: 'admin/ui.tsx', tag: 'button', max: 2, reason: 'form primitives: the picker (combobox trigger styled as lims-input, not an action) and the WAI-ARIA role=tab buttons of the admin tab strip' },
  { file: 'admin/auth/PasswordField.tsx', tag: 'button', max: 1, reason: 'sign-in page field, pinned by LD-442 (sign-in pages) and the task rule that nothing under (auth) changes' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') out.push(...walk(f)); }
    else if (name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(name)) out.push(f);
  }
  return out.sort();
}

/** Drops /* *\/ blocks and // line comments (not the // of a URL in a string or after a colon). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
const rel = (f: string) => relative(FEATURES, f).replace(/\\/g, '/');
const count = (src: string, tag: Tag) => (src.match(new RegExp(`<${tag}(?![\\w-])`, 'g')) ?? []).length;

const FILES = FOLDERS.flatMap((d) => (existsSync(join(FEATURES, d)) ? walk(join(FEATURES, d)) : []));
const SRC = new Map(FILES.map((f) => [rel(f), stripComments(readFileSync(f, 'utf8'))]));
const allowed = (file: string, tag: Tag) => EXCEPTIONS.find((e) => e.file === file && e.tag === tag)?.max ?? 0;

describe('T0D-UIX-4 markup: raw table, dl and button become kit parts (LD-442)', () => {
  it('scans all 16 feature folders and the files of the fixture exist', () => {
    // features/offline holds no code yet (nothing to convert), so only 15 of the 16 folders exist.
    expect(FOLDERS.filter((d) => existsSync(join(FEATURES, d))).length).toBeGreaterThanOrEqual(15);
    expect(FILES.length).toBeGreaterThan(100);
    for (const e of EXCEPTIONS) expect(SRC.has(e.file), `exception file ${e.file} does not exist`).toBe(true);
  });

  for (const tag of TAGS) {
    it(`no raw <${tag} in the non-test .tsx of the 16 folders (beyond the named exceptions)`, () => {
      const bad = [...SRC].flatMap(([file, src]) => {
        const n = count(src, tag);
        return n > allowed(file, tag) ? [`${file}: ${n} raw <${tag}` + (allowed(file, tag) ? ` (allowed ${allowed(file, tag)})` : '')] : [];
      });
      expect(bad, `raw <${tag} left (use ${tag === 'table' ? 'DataTable' : tag === 'dl' ? 'DescriptionList' : 'Button or IconButton'} from @lims/ui):\n${bad.join('\n')}`).toEqual([]);
    });
  }

  it('every exception is still needed (stale entries are deleted) and carries a reason', () => {
    for (const e of EXCEPTIONS) {
      expect(e.reason.length, `${e.file}: reason`).toBeGreaterThan(20);
      expect(count(SRC.get(e.file) ?? '', e.tag), `stale exception ${e.file} <${e.tag}`).toBeGreaterThan(0);
    }
  });

  it('exceptions stay out of the folders that other tasks own and out of platform', () => {
    for (const e of EXCEPTIONS) expect(e.file).toMatch(new RegExp(`^(${FOLDERS.join('|')})/`));
    expect(FILES.map(rel).filter((f) => f.startsWith('platform/') || f.startsWith('catalog/') || f.startsWith('lab/'))).toEqual([]);
  });

  // Done when (6): on the front desk patient and order detail screens the fields are a DescriptionList and the lines a DataTable.
  it.each(['frontdesk/components/PatientView.tsx', 'frontdesk/components/OrderView.tsx'])('%s draws its label and value fields with DescriptionList and its rows with DataTable', (file) => {
    const src = SRC.get(file) ?? '';
    const has = (re: RegExp) => re.test(src); // boolean, so a failure never dumps the whole source
    expect(has(/from '@lims\/ui\/components\/DescriptionList[^']*'/), `${file} imports DescriptionList`).toBe(true);
    expect(has(/<DescriptionList\b/), `${file} renders DescriptionList`).toBe(true);
    expect(has(/from '@lims\/ui\/components\/DataTable[^']*'/), `${file} imports DataTable`).toBe(true);
    expect(has(/<DataTable\b/), `${file} renders DataTable`).toBe(true);
  });

  it('the order view shows its order lines in a DataTable (not a raw table)', () => {
    const src = SRC.get('frontdesk/components/OrderView.tsx') ?? '';
    expect(count(src, 'table')).toBe(0);
    expect((src.match(/<DataTable\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
