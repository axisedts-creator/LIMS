// T0D-UNSLOP-1 (D) — one trail (LD-344 evidence: "Catalog / Doctors" under "Administration / Doctor Management" above an h1 "Doctors").
// Rule: the top bar (ShellFrame) carries the trail. A PageHeader keeps an in-page `breadcrumbs` only where its parent differs, i.e. a detail page
// whose list parent is NOT in the top bar: 3 or more crumbs (section / list / this page). A trail of 1 or 2 crumbs only repeats the section and the title.
// Static walk over every page and component that is not pinned (features/admin, features/platform, app/(auth), app/(platform): rs-c2 / platform tests).
// The scan counts top-level `label:` keys inside each `breadcrumbs={[ ... ]}` literal (bracket matched); a dynamic expression (variable) is not judged.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', '..'); // apps/web/src
const PINNED = /[\\/](features[\\/](admin|platform)[\\/]|app[\\/]\((auth|platform)\)[\\/])/;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '__tests__' || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(n) && !PINNED.test(p)) out.push(p);
  }
  return out;
}

/** Every `breadcrumbs={[...]}` literal in the source with its number of crumbs. */
export function trails(src: string): { at: number; crumbs: number }[] {
  const res: { at: number; crumbs: number }[] = [];
  for (const m of src.matchAll(/breadcrumbs=\{\s*\[/g)) {
    let depth = 1; let i = m.index! + m[0].length; const start = i;
    while (i < src.length && depth > 0) { const c = src[i++]; if (c === '[') depth++; else if (c === ']') depth--; }
    res.push({ at: src.slice(0, m.index).split('\n').length, crumbs: (src.slice(start, i - 1).match(/\blabel\s*:/g) ?? []).length });
  }
  return res;
}

describe('the in-page breadcrumb scanner sees the rule', () => {
  it('counts crumbs of a literal', () => {
    expect(trails("<P breadcrumbs={[{ label: 'Catalog', href: '/c' }, { label: 'Doctors' }]} />")).toEqual([{ at: 1, crumbs: 2 }]);
    expect(trails("<P breadcrumbs={[{ label: 'A' }, { label: 'B', href: '/b' }, { label: 'C' }]} />")).toEqual([{ at: 1, crumbs: 3 }]);
  });
});

describe('one trail on top: no in-page breadcrumb that only repeats the section and the title', () => {
  const offenders: string[] = [];
  for (const f of walk(SRC)) {
    for (const tr of trails(readFileSync(f, 'utf8'))) if (tr.crumbs <= 2) offenders.push(`${relative(SRC, f).replace(/\\/g, '/')}:${tr.at} (${tr.crumbs} crumbs)`);
  }
  it('no PageHeader breadcrumbs of 1 or 2 crumbs outside the pinned admin / platform / auth pages', () => {
    expect(offenders, `drop the breadcrumbs prop (the top bar already shows the trail); keep only trails of 3+ crumbs:\n${offenders.join('\n')}`).toEqual([]);
  });
  it('the 3-crumb detail trails stay (their list parent is not in the top bar)', () => {
    const kept = walk(SRC).flatMap((f) => trails(readFileSync(f, 'utf8')).filter((x) => x.crumbs >= 3));
    expect(kept.length).toBeGreaterThanOrEqual(10);
  });
});
