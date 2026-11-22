// T0D-UIX-2 — source scan (LD-442, LD-436, LD-437, LD-438; founder 2026-11-22 09:10 NPT: "no tables design for tabular fields just floating on screen", "irregular buttons").
// The non-test .tsx under apps/web/src/features/catalog must not contain a raw <table, <dl or <button: tables are the kit DataTable, definition lists the
// kit DescriptionList, buttons the kit Button / IconButton. The look itself is set by T0D-UIX-1 / T0D-UIX-5 CSS; this task is markup only.
// ALLOW holds the named exceptions (file -> reason). Every entry must still exist AND still match (a stale entry fails), so the list cannot rot.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG = fileURLToPath(new URL('../', import.meta.url)); // apps/web/src/features/catalog/
const norm = (p: string) => p.split(sep).join('/');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : walk(p);
    return /\.tsx$/.test(n) && !/\.(test|spec|stories)\.tsx$/.test(n) ? [p] : [];
  });
}

/** Drop block and line comments so a prose "<table>" in a header comment is not a hit. Strings are kept: a literal "<table" in JSX text is still markup. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const RAW = { table: /<table[\s>/]/g, dl: /<dl[\s>/]/g, button: /<button[\s>/]/g } as const;
type Tag = keyof typeof RAW;

/** file (relative to catalog/) -> { tag -> why it may stay raw }. Keep it SHORT; the founder named none. */
// A native file input label is not a <button>; EditableGrid internals live in packages/ui, not here. So nothing under catalog needs an exception today.
const ALLOW: Record<string, Partial<Record<Tag, string>>> = {};

const files = walk(CATALOG).map((f) => ({ rel: norm(relative(CATALOG, f)), src: stripComments(readFileSync(f, 'utf8')) }));
const hits = (tag: Tag): string[] =>
  files
    .map(({ rel, src }) => ({ rel, n: (src.match(RAW[tag]) ?? []).length }))
    .filter(({ rel, n }) => n > 0 && !ALLOW[rel]?.[tag])
    .map(({ rel, n }) => `${rel} (${n})`)
    .sort();

describe('T0D-UIX-2 catalog screens use kit DataTable, DescriptionList and Button', () => {
  it('the scan works: it sees raw tags on literals and ignores comments (guards against a regex that matches nothing)', () => {
    expect('<table className="x">'.match(RAW.table)).toHaveLength(1);
    expect('<table\n  role="grid">'.match(RAW.table)).toHaveLength(1);
    expect('<dl className="x"><dt/></dl>'.match(RAW.dl)).toHaveLength(1);
    expect('<button type="button">'.match(RAW.button)).toHaveLength(1);
    expect('<DataTable columns={c} />'.match(RAW.table)).toBeNull(); // kit components are fine
    expect('<DescriptionList items={i} />'.match(RAW.dl)).toBeNull();
    expect('<Button variant="primary" />'.match(RAW.button)).toBeNull();
    expect('<IconButton label="x" />'.match(RAW.button)).toBeNull();
    expect(stripComments('// uses a <table>\nconst a = 1;\n/* <dl> */ const b = 2;')).not.toMatch(/<table|<dl/);
    expect(files.length, 'the scan found no catalog source files at all').toBeGreaterThan(20);
  });

  it('(1) no raw <table remains: every table is the kit DataTable', () => {
    const bad = hits('table');
    expect(bad, `raw <table to convert to DataTable (density regular, header kept when empty, numbers end aligned):\n${bad.join('\n')}`).toEqual([]);
  });

  it('(2) no raw <dl remains: every definition list is the kit DescriptionList', () => {
    const bad = hits('dl');
    expect(bad, `raw <dl to convert to DescriptionList:\n${bad.join('\n')}`).toEqual([]);
  });

  it('(3) no raw <button remains: every button is Button (primary, secondary, ghost) or IconButton', () => {
    const bad = hits('button');
    expect(bad, `raw <button to convert to Button or IconButton:\n${bad.join('\n')}`).toEqual([]);
  });

  it('the conversions use the kit: DataTable, DescriptionList and Button are each imported from @lims/ui by catalog source', () => {
    const uses = (name: string) => files.filter(({ src }) => new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s+['"]@lims/ui`).test(src)).map(({ rel }) => rel);
    expect(uses('DataTable'), 'no catalog file imports the kit DataTable').not.toEqual([]);
    expect(uses('DescriptionList'), 'no catalog file imports the kit DescriptionList').not.toEqual([]);
    expect(uses('Button'), 'no catalog file imports the kit Button').not.toEqual([]);
  });

  it('every allow-list entry exists and still has a raw tag (no stale entries)', () => {
    const stale: string[] = [];
    for (const [rel, tags] of Object.entries(ALLOW)) {
      const f = files.find((x) => x.rel === rel);
      if (!f) { stale.push(`${rel}: file is gone`); continue; }
      for (const tag of Object.keys(tags) as Tag[]) if (!(f.src.match(RAW[tag]) ?? []).length) stale.push(`${rel}: no raw <${tag} left`);
    }
    expect(stale).toEqual([]);
  });

  it('does not scan anything outside features/catalog (platform, (auth) and (platform) are off limits)', () => {
    expect(files.every(({ rel }) => !/^(\.\.|platform\/)/.test(rel))).toBe(true);
  });
});
