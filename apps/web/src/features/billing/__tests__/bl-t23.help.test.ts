// BL-T23 Billing help + manual — "copy scan" tests. Spec: 04-UI-UX §1 (copy rules), §11 (help = features/<m>/help/<screen>.md; manual mirrors it
// + exports.md, cash-shift.md, credit-parties.md, cbms.md); PRD US-BL-16; TRD CI job c04-copy-scan. Plan row BL-T23: "every screen; IRD behaviour explained neutrally".
// ASSUMED naming (dispute if wrong): help file = help/<suffix of the screen's PageHeader helpKey "billing.<suffix>">.md (e.g. billing.daily_cash -> help/daily_cash.md);
// each help file has headings containing "Purpose", "Fields", "Shortcuts" (§11: "purpose, fields, shortcuts").
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const comps = join(root, 'apps/web/src/features/billing/components');
const helpDir = join(root, 'apps/web/src/features/billing/help');
const manualDir = join(root, 'docs/manual/billing');
const read = (p: string) => readFileSync(p, 'utf8');
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);

// Screens = every helpKey the BL-T20 components pass to PageHeader (so a new screen without help fails here).
const helpKeys = [...new Set(readdirSync(comps).filter((n) => n.endsWith('.tsx')).flatMap((n) => [...read(join(comps, n)).matchAll(/helpKey="billing\.([a-z_]+)"/g)].map((m) => m[1]!)))].sort();
const helpOf = (k: string) => read(join(helpDir, `${k}.md`));
const manualText = () => mdIn(manualDir).map((n) => read(join(manualDir, n))).join('\n');
const BANNED = [/IRD[ -]approved/i, /IRD certified/i, /approved by IRD/i, /commission/i];
const OVERCLAIM = /IRD[ -](compliant|accredited|endorsed|verified|recogni[sz]ed|authori[sz]ed|licensed)|guarantee[sd]? (IRD|tax|compliance)|certified by IRD/i;

describe('BL-T23 help: every billing screen', () => {
  it('discovers the BL-T20 screens (non-vacuous)', () => {
    expect(helpKeys.length).toBeGreaterThanOrEqual(10);
    expect(helpKeys).toEqual(expect.arrayContaining(['invoices', 'invoice', 'dues', 'daily_cash', 'credit_parties', 'credit_party', 'registers', 'audit_trail', 'cbms', 'worklist', 'settings']));
  });
  it.each(helpKeys)('help/%s.md exists with purpose, fields, shortcuts', (k) => {
    const p = join(helpDir, `${k}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = helpOf(k);
    expect(t.length).toBeGreaterThan(300);
    expect(t).toMatch(/^#\s+\S/m); // title
    for (const h of ['Purpose', 'Fields', 'Shortcuts']) expect(t, `${k}.md needs a "${h}" heading`).toMatch(new RegExp(`^#{2,3}\\s+.*${h}`, 'im'));
  });
  it('no orphan help files (each maps to a screen)', () => {
    expect(mdIn(helpDir).filter((n) => !helpKeys.includes(n.replace(/\.md$/, '')))).toEqual([]);
  });
});

describe('BL-T23 IRD behaviour explained neutrally', () => {
  it('invoice help states immutability + cancel-with-reason + automatic credit note (04-UI-UX §11)', () => {
    for (const k of ['invoices', 'invoice']) {
      const t = helpOf(k);
      expect(t, k).toMatch(/cannot be edited or deleted/i);
      expect(t, k).toMatch(/cancel/i);
      expect(t, k).toMatch(/reason/i);
      expect(t, k).toMatch(/credit note/i);
    }
  });
  it('CBMS help + manual use the stub wording and make no connected/approved claim', () => {
    const stub = 'Not sent — CBMS connection not configured';
    expect(helpOf('cbms')).toContain(stub);
    expect(readFileSync(join(manualDir, 'cbms.md'), 'utf8')).toContain(stub);
  });
  it('at least one help and one manual page mention IRD, none overclaim', () => {
    const helps = mdIn(helpDir).map((n) => read(join(helpDir, n)));
    expect(helps.some((t) => /\bIRD\b/.test(t))).toBe(true);
    expect(/\bIRD\b/.test(manualText())).toBe(true);
    for (const t of [...helps, manualText()]) expect(t).not.toMatch(OVERCLAIM);
  });
  it('exports manual: C4-defined XML schema, explicitly not an IRD schema', () => {
    const t = read(join(manualDir, 'exports.md'));
    expect(t).toContain('urn:lims:billing:export:v1');
    expect(t).toMatch(/not an IRD/i);
  });
});

describe('BL-T23 manual pages (docs/manual/billing)', () => {
  it.each(['exports', 'cash-shift', 'credit-parties', 'cbms', 'tenant-export'])('%s.md exists and is non-trivial', (n) => {
    const p = join(manualDir, `${n}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    expect(read(p).length).toBeGreaterThan(300);
  });
  it('manual mirrors help: every billing screen route is covered', () => {
    const t = manualText();
    for (const r of ['/billing/invoices', '/billing/dues', '/billing/daily-cash', '/billing/credit-parties', '/billing/registers', '/billing/audit-trail', '/billing/cbms', '/billing/worklist', '/billing/settings'])
      expect(t, `manual does not mention ${r}`).toContain(r);
  });
});

describe('BL-T23 copy scan (TRD c04-copy-scan, PRD US-BL-16)', () => {
  it('no banned wording in help or manual (own scan, line-level)', () => {
    const files = [...mdIn(helpDir).map((n) => join(helpDir, n)), ...mdIn(manualDir).map((n) => join(manualDir, n))];
    expect(files.length).toBeGreaterThan(10); // help (>=11) + manual (>=5) must exist
    const hits = files.flatMap((f) => read(f).split(/\r?\n/).flatMap((l, i) => BANNED.filter((re) => re.test(l)).map((re) => `${f}:${i + 1}: ${re}`)));
    expect(hits).toEqual([]);
  });
  it('shipped copy-scan.mjs exits 0', () => {
    const r = spawnSync(process.execPath, [join(root, 'apps/web/src/features/billing/__tests__/copy-scan.mjs')], { cwd: root, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
