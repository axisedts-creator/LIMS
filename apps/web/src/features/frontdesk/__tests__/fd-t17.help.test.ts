// FD-T17 Frontdesk help + manual — "copy scan" tests. Spec: 04-UI-UX §11 (help = features/<m>/help/<screen>.md: purpose, fields, shortcuts;
// manual under docs/manual/frontdesk mirrors it), §3.5 (registration shortcuts), §5-§7 (patient/worklist/approvals); plan row FD-T17
// "every screen has help; copy scan passes"; TRD CI job c04-copy-scan. Mirrors BL-T23 (billing) conventions.
// ASSUMED naming (dispute if wrong): help file = help/<suffix of the screen's PageHeader helpKey "frontdesk.<suffix>">.md
// (frontdesk.discount_approvals -> help/discount_approvals.md); each help file has headings containing "Purpose", "Fields", "Shortcuts".
// ASSUMED: no /frontdesk/settings page exists yet (FD-T15 shipped handlers only), so help/settings.md is optional, not required.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHORTCUT_GROUPS } from '../forms/shortcuts.ts';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const comps = join(root, 'apps/web/src/features/frontdesk/components');
const helpDir = join(root, 'apps/web/src/features/frontdesk/help');
const manualDir = join(root, 'docs/manual/frontdesk');
const read = (p: string) => readFileSync(p, 'utf8');
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);

// Screens = every helpKey the C4 frontdesk components pass to PageHeader (a new screen without help fails here).
const helpKeys = [...new Set(readdirSync(comps).filter((n) => n.endsWith('.tsx')).flatMap((n) => [...read(join(comps, n)).matchAll(/helpKey="frontdesk\.([a-z_]+)"/g)].map((m) => m[1]!)))].sort();
const helpOf = (k: string) => read(join(helpDir, `${k}.md`));
const manualText = () => mdIn(manualDir).map((n) => read(join(manualDir, n))).join('\n');
const BANNED = [/IRD[ -]approved/i, /IRD certified/i, /approved by IRD/i, /commission/i];
const OVERCLAIM = /IRD[ -](compliant|accredited|endorsed|verified|recogni[sz]ed|authori[sz]ed|licensed)|guarantee[sd]? (IRD|tax|compliance)|certified by IRD/i;

describe('FD-T17 help: every frontdesk screen', () => {
  it('discovers the FD-T13/14 screens (non-vacuous)', () => {
    expect(helpKeys).toEqual(expect.arrayContaining(['registration', 'order', 'patient', 'worklist', 'discount_approvals']));
  });
  it.each(helpKeys)('help/%s.md exists with purpose, fields, shortcuts', (k) => {
    const p = join(helpDir, `${k}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = helpOf(k);
    expect(t.length).toBeGreaterThan(300);
    expect(t).toMatch(/^#\s+\S/m);
    for (const h of ['Purpose', 'Fields', 'Shortcuts']) expect(t, `${k}.md needs a "${h}" heading`).toMatch(new RegExp(`^#{2,3}\\s+.*${h}`, 'im'));
  });
  it('no orphan help files (each maps to a screen; settings allowed ahead of its page)', () => {
    expect(mdIn(helpDir).filter((n) => ![...helpKeys, 'settings'].includes(n.replace(/\.md$/, '')))).toEqual([]);
  });
});

describe('FD-T17 help content matches the screens (04-UI-UX §3.5, §5-§7)', () => {
  it('registration help lists every registration shortcut key', () => {
    const t = helpOf('registration');
    for (const g of SHORTCUT_GROUPS) for (const s of g.shortcuts) expect(t, `registration.md missing shortcut ${s.keys}`).toContain(s.keys);
  });
  it('worklist help covers tabs, possible duplicates and row keys', () => {
    const t = helpOf('worklist');
    for (const w of [/recollection/i, /possible duplicates/i, /pre-registered/i, /\bEnter\b/, /\bR\b/]) expect(t).toMatch(w);
  });
  it('discount approvals help covers A/R keys, reject note and MFA', () => {
    const t = helpOf('discount_approvals');
    for (const w of [/\bA\b/, /\bR\b/, /note/i, /MFA/]) expect(t).toMatch(w);
  });
  it('patient help covers consent, visits and anonymise with retention', () => {
    const t = helpOf('patient');
    for (const w of [/consent/i, /visits?/i, /anonymi[sz]e/i, /retention/i]) expect(t).toMatch(w);
  });
  it('order help covers cancel and changing items', () => {
    const t = helpOf('order');
    for (const w of [/cancel/i, /items?/i]) expect(t).toMatch(w);
  });
  it('no help or manual overclaims on IRD / approval', () => {
    for (const t of [...mdIn(helpDir).map((n) => read(join(helpDir, n))), manualText()]) expect(t).not.toMatch(OVERCLAIM);
  });
});

describe('FD-T17 manual pages (docs/manual/frontdesk)', () => {
  it('manual exists and is non-trivial', () => {
    const names = mdIn(manualDir);
    expect(names.length).toBeGreaterThanOrEqual(1);
    for (const n of names) expect(read(join(manualDir, n)).length, n).toBeGreaterThan(300);
  });
  it('manual mirrors help: every frontdesk screen route is covered', () => {
    const t = manualText();
    for (const r of ['/frontdesk/registrations/new', '/frontdesk/orders/', '/frontdesk/patients/', '/frontdesk/worklist', '/frontdesk/discount-approvals'])
      expect(t, `manual does not mention ${r}`).toContain(r);
  });
  it('manual states the registration shortcuts', () => {
    const t = manualText();
    for (const k of ['F2', 'F4', 'F6', 'Ctrl+Enter']) expect(t, `manual missing ${k}`).toContain(k);
  });
});

describe('FD-T17 copy scan (TRD c04-copy-scan)', () => {
  it('no banned wording in frontdesk help or manual (own scan, line-level)', () => {
    const files = [...mdIn(helpDir).map((n) => join(helpDir, n)), ...mdIn(manualDir).map((n) => join(manualDir, n))];
    expect(files.length).toBeGreaterThan(5); // help (>=5) + manual (>=1) must exist
    const hits = files.flatMap((f) => read(f).split(/\r?\n/).flatMap((l, i) => BANNED.filter((re) => re.test(l)).map((re) => `${f}:${i + 1}: ${re}`)));
    expect(hits).toEqual([]);
  });
  it('shipped copy-scan.mjs exits 0', () => {
    const r = spawnSync(process.execPath, [join(root, 'apps/web/src/features/billing/__tests__/copy-scan.mjs')], { cwd: root, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
