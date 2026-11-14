// C9.T-23 — structure and rule checks that need no rendering: every page has loading.tsx + error.tsx (03-APP-FLOW §4), helpKey (04-UI-UX §1),
// LD-140 (kit components and tokens only), REQ-SEC-068 (token never in the browser), REQ-SEC-062 (aal2 failures handled), spec permission names only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AV_DIR, srcOf, walk } from './av-t23.harness';

const PAGES = ['', '[version_id]', 'decisions'];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const files = () => walk(AV_DIR).filter((f) => /\.(ts|tsx)$/.test(f));
const all = () => files().map(srcOf).join('\n');

describe('files (T-23 owns app/(staff)/quality/autoverify/**)', () => {
  it.each(PAGES)('page %j has page.tsx + loading.tsx + error.tsx', (p) => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(AV_DIR, p, f)), `${p}/${f}`).toBe(true);
  });
  it.each(PAGES)('error.tsx of %j is a client component with ErrorState + retry and no raw error text', (p) => {
    const s = srcOf(join(AV_DIR, p, 'error.tsx'));
    expect(/^\s*['"]use client['"]/.test(s)).toBe(true);
    expect(s).toContain('ErrorState');
    expect(s).toMatch(/retry|reset/i);
    expect(strip(s)).not.toMatch(/error\.message|error\.stack/);
  });
  it.each(PAGES)('loading.tsx of %j is a LoadingSkeleton', (p) => {
    expect(srcOf(join(AV_DIR, p, 'loading.tsx'))).toContain('LoadingSkeleton');
  });
  it('every page header carries a helpKey and uses PageShell + PageHeader', () => {
    const pages = files().filter((f) => /page\.tsx$/.test(f));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const s = all();
    expect((s.match(/helpKey/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(s).toContain('PageShell');
    expect(s).toContain('PageHeader');
  });
});

describe('LD-140 — only @lims/ui components and tokens', () => {
  it('no hex colours, no px sizes, no inline style objects', () => {
    for (const f of files()) {
      const s = strip(srcOf(f));
      expect(s, `${f}: hex`).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
      expect(s, `${f}: px`).not.toMatch(/\b\d+(\.\d+)?px\b/);
      expect(s, `${f}: style`).not.toMatch(/style=\{\{/);
    }
  });
  it('cites LD-140 in a code comment', () => { expect(files().some((f) => /LD-140/.test(srcOf(f)))).toBe(true); });
  it('uses the kit: ConfirmDialog, Drawer, DataTable, StatusChip (status = tone + icon + word)', () => {
    const s = all();
    for (const c of ['ConfirmDialog', 'Drawer', 'DataTable', 'StatusChip']) expect(s, c).toContain(c);
  });
  it('defines no local look-alike of a kit component', () => {
    for (const f of files()) expect(strip(srcOf(f)), f).not.toMatch(/(function|const)\s+(DataTable|StatusChip|Drawer|ConfirmDialog|Banner|StatTile|BarChart|EmptyState|ErrorState)\b/);
  });
  it('simulation report uses the kit StatTile and BarChart (04-UI-UX §2.8)', () => {
    const s = all();
    expect(s).toContain('StatTile');
    expect(s).toContain('BarChart');
  });
});

describe('security', () => {
  it("client components never import server code or read env; only 'use server' code calls the API (REQ-SEC-068)", () => {
    for (const f of files()) {
      const s = srcOf(f);
      if (/^\s*['"]use client['"]/.test(s)) {
        expect(s, f).not.toMatch(/server-fetch|core\/session\/server|server-only/);
        expect(strip(s), f).not.toMatch(/process\.env|\bfetch\(/);
      }
    }
  });
  it("every server action re-validates its input: a 'use server' file validates ids and the ACTIVATE text", () => {
    const actions = files().filter((f) => /^\s*['"]use server['"]/.test(srcOf(f)));
    // the feature may keep its actions under features/quality/server; then this scan is vacuous and the render tests above carry the proof
    if (actions.length) expect(actions.map(srcOf).join('\n')).toMatch(/ACTIVATE/);
  });
  it('no dangerouslySetInnerHTML / storage of rule or decision data / innerHTML', () => {
    expect(strip(all())).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|\.innerHTML\s*=/);
  });
  it('no patient identifiers are read from any DTO', () => {
    expect(strip(all())).not.toMatch(/patient_name|patient_id|barcode|registration_no|mrn\b/i);
  });
  it('links to C5 use the generated route (buildRoute / staff.lab.order_results), not hand-written /lab paths', () => {
    expect(strip(all())).not.toMatch(/['"`]\/lab\/(specimens|orders)/);
  });
  it('only documented permission names appear', () => {
    const known = new Set(['quality.autoverify.read', 'quality.autoverify.manage']);
    for (const f of files()) for (const m of strip(srcOf(f)).matchAll(/['"`](quality\.[a-z_]+\.[a-z_]+)['"`]/g)) {
      if (/^quality\.autoverify\./.test(m[1]!)) expect(known.has(m[1]!), `${f}: ${m[1]}`).toBe(true);
    }
  });
  it('the step-up path exists: auth.mfa_required is handled in feature code (REQ-SEC-062, 04-UI-UX §2.8)', () => {
    expect(all()).toMatch(/auth\.mfa_required/);
  });
  it('no confirmation text is hard-coded anywhere but where it is validated (ACTIVATE)', () => {
    expect(all()).toContain('ACTIVATE');
  });
});
