// C11.T-21 source/structure checks: files under components/report/* (plan row T-21); LD-140 (kit only, no hex/px/inline style); REQ-SEC-088 (no HTML sinks); §8 error copy present for every report/sign-out code; shortcuts Alt+S / Alt+U / Alt+R; no token handling in client files. Static; no rendering.
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
const dir = (p: string) => join(src, p);

const report = walk(dir('features/anatomic/components/report')).filter(code);
const tsx = report.filter((f) => f.endsWith('.tsx'));
const feature = walk(dir('features/anatomic')).filter(code);
const all = () => [...report, dir('features/anatomic/components/common.tsx')].filter(existsSync).map(read).join('\n').replace(/\\(['"])/g, '$1');

describe('files exist (plan row T-21)', () => {
  it('features/anatomic/components/report/* has components (not just a barrel)', () => {
    expect(tsx.length).toBeGreaterThanOrEqual(3);
  });
  it('the Report tab is wired into CaseWorkspace (placeholder gone)', () => {
    const s = read(dir('features/anatomic/components/CaseWorkspace.tsx'));
    expect(s).toMatch(/components\/report|\.\/report\//);
    expect(s).not.toContain('This section is not available in this version of the workspace.');
  });
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(report.length).toBeGreaterThan(2));
  it.each(report.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
    const s = strip(read(f as string));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(s).not.toMatch(/border-?[Rr]adius/);
    expect(s).not.toMatch(/\bstyle=\{/);
    expect(s).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/);
    expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
  });
  it.each(tsx.map((f) => [relative(src, f), f]))('%s: UI imports come from @lims/ui only', (_n, f) => {
    for (const m of read(f as string).matchAll(/^import[^;]*?from\s+'([^']+)'/gm)) expect(m[1], m[1]).toMatch(/^(@lims\/ui(\/.*)?|react|react-dom|next\/navigation|next\/link|\.{1,2}\/.*|@\/.*)$/);
  });
  it('report feature code cites LD-140 in a comment (lead decision binding)', () => expect(report.map(read).join('\n')).toMatch(/LD-140/));
  it('the synoptic form is composed from kit fields (no new component, 04-UI-UX §5)', () => {
    const s = report.map(read).join('\n');
    for (const k of ['TextField', 'TextArea', 'IntegerField', 'DecimalField', 'Switch', 'Select', 'Checkbox', 'DatePicker']) expect(s, k).toMatch(new RegExp(`@lims/ui/components/${k}`));
  });
  it('uses the kit ErrorSummary through Form, ConfirmDialog, Drawer, Dialog, DataTable', () => {
    const s = report.map(read).join('\n');
    for (const k of ['Form', 'ConfirmDialog', 'Drawer', 'Dialog', 'DataTable']) expect(s, k).toMatch(new RegExp(`@lims/ui/components/${k}`));
    expect(s).toMatch(/errorSummary/);
  });
});

describe('security', () => {
  it('no token / JWT handling in client component files', () => {
    expect(tsx.length).toBeGreaterThan(0);
    for (const f of tsx) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer |localStorage|sessionStorage/);
  });
  it('no report text, accession number or diagnosis code is logged or put in a URL', () => {
    expect(report.length).toBeGreaterThan(0);
    const s = strip(report.map(read).join('\n'));
    expect(s).not.toMatch(/router\.(push|replace)\([^)]*(gross_text|impression|microscopy|accession|diagnos)/i);
    expect(s).not.toMatch(/searchParams\.set\([^)]*(gross|impression|microscopy|accession)/i);
  });
  it('writes go through server actions / the BFF only: report files do not fetch() the API origin', () => {
    expect(report.length).toBeGreaterThan(0);
    const s = strip(report.map(read).join('\n'));
    expect(s).not.toMatch(/LIMS_ORIGIN|process\.env/);
    expect(s).not.toMatch(/\bfetch\(\s*['"`]https?:/);
  });
  it('server actions for the report calls use the contract paths (R1-R10 + K13/K14 + lab amendment reasons)', () => {
    const s = feature.filter((f) => /server[\\/]/.test(f)).map(read).join('\n');
    for (const p of ['/report-draft', '/sign-out', '/changes', '/changes/discard', '/versions', '/addenda', '/sign', '/synoptic-templates', '/lab/coded-sets/amendment_reasons']) expect(s, p).toContain(p);
  });
  it('report server actions exist and send Idempotency-Key + If-Match (behaviour of each call is covered by the component tests)', () => {
    const s = feature.filter((f) => /server[\\/]/.test(f)).map(read).join('\n');
    expect(s).toContain('/report-draft');
    expect(s).toMatch(/idempotency-key/i);
    expect(s).toMatch(/if-match/i);
  });
});

describe('error mapping per 04-UI-UX §8 (done_when)', () => {
  it.each([
    'Complete the highlighted fields before signing out.',
    'This template version is not published.',
    'The lab result is approved and locked. Use Amend.',
    'A newer version was already sent to the lab. Reload the case.',
    "The lab did not accept this result for this test. Check the test's setup.",
    "The lab result can't accept a new version now (it may be cancelled).",
    'An amendment needs a reason.',
    'This case is signed out. Use Revise/Amend or add an addendum.',
  ])('copy present: %s', (copy) => { expect(report.length).toBeGreaterThan(0); expect(all()).toContain(copy); });
  it('maps the codes (not only the copy)', () => {
    for (const c of ['anatomic.report_incomplete', 'anatomic.template_not_published', 'lab.result_locked', 'lab.module_result_stale', 'lab.module_result_invalid', 'lab.result_invalid_transition', 'lab.amendment_reason_required', 'anatomic.order_item_inactive']) expect(all(), c).toContain(c);
  });
  it('the incomplete summary maps JSON Pointers (/impression_text, /synoptic/{i}/values/{key}, /image_ids/{k}) to fields', () => {
    const s = report.map(read).join('\n');
    expect(s).toMatch(/impression_text/);
    expect(s).toMatch(/synoptic/);
    expect(s).toMatch(/image_ids/);
    expect(s).toMatch(/split\(\s*['"]\/['"]\s*\)|\/\^\\\/|RegExp|match\(/);
  });
});

describe('shortcuts (04-UI-UX §3)', () => {
  it('Alt+S (save draft) and Alt+U (sign out dialog) are registered on staff.anatomic.case; Alt+R already opens the tab; no Alt+N/M/H', () => {
    const s = [...report, dir('features/anatomic/components/CaseWorkspace.tsx')].map(read).join('\n');
    expect(s).toMatch(/Alt\+S/);
    expect(s).toMatch(/Alt\+U/);
    expect(s).toMatch(/Alt\+R/);
    expect(strip(report.map(read).join('\n'))).not.toMatch(/Alt\+[NMH]\b/);
  });
});
