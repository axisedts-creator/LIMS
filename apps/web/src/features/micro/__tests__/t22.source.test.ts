// C10.T-22 source/structure checks: files under components/reports/ and server/listLabCodedSet.server.ts; LD-140 (kit only, no hex / px radius / inline style); REQ-SEC-088 (no raw HTML);
// REQ-SEC-098 (no logging); REQ-SEC-068 (no token in client code); the BFF validates ids and the set name, rebuilds bodies from declared fields, strips the D-62 system codes. Static.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const src = join(web, 'src');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; }) : []);
const code = (p: string) => /\.(ts|tsx)$/.test(p);
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ui = walk(join(src, 'features/micro/components/reports')).filter(code);
const serverFiles = walk(join(src, 'features/micro/server')).filter(code);
const actions = serverFiles.filter((f) => /^['"]use server['"]/m.test(read(f)));
const BFF = join(src, 'features/micro/server/listLabCodedSet.server.ts');

describe('files exist (plan row T-22: components/reports/*, server/listLabCodedSet.server.ts)', () => {
  it('components/reports has the drawer / tab / reopen files (at least one .tsx)', () => expect(ui.filter((f) => f.endsWith('.tsx')).length).toBeGreaterThan(0));
  it('server/listLabCodedSet.server.ts exists, is server-only and exports listLabCodedSet', () => {
    expect(existsSync(BFF)).toBe(true);
    const s = existsSync(BFF) ? read(BFF) : '';
    expect(s).toMatch(/^import ['"]server-only['"]/m);
    expect(s).toMatch(/export (async )?function listLabCodedSet|export const listLabCodedSet/);
  });
  it('a "use server" file carries the report calls: M14 /report-versions (POST), M16 /report-versions/{n}, M17 /reopen', () => {
    const t = actions.map(read).join('\n');
    for (const p of ['/report-versions', '/reopen']) expect(t, p).toContain(p);
  });
});

describe('LD-140 / 10-DESIGN-SYSTEM §6', () => {
  it('there are files to check', () => expect(ui.length).toBeGreaterThan(0));
  it.each(ui.map((f) => [relative(src, f), f]))('%s: no hex colours, pixel radii, inline style objects, raw HTML, console logging', (_n, f) => {
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
  it('cites LD-140 in a comment', () => expect(ui.map(read).join('\n')).toMatch(/LD-140/));
  it('cites D-62 (reopen reasons) in a comment of the reports components or the BFF', () => expect([...ui, BFF].filter(existsSync).map(read).join('\n')).toMatch(/D-62/));
  it('no token / JWT handling in client component files', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
  it('no hand-made <button> / <input> / <select> / <textarea> / <dialog> (kit components only)', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/<(button|input|select|textarea|dialog)[\s>]/);
  });
  it('the report components import no server-only module directly (they call server actions)', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(read(f), relative(src, f)).not.toMatch(/from\s+['"][^'"]*\.server['"]|from\s+['"]server-only['"]/);
  });
  it('the drawer uses the kit Drawer and the reopen uses ConfirmDialog with requireReason (04-UI-UX §3.4)', () => {
    const t = ui.map(read).join('\n');
    expect(t).toMatch(/@lims\/ui\/components\/Drawer/);
    expect(t).toMatch(/@lims\/ui\/components\/ConfirmDialog/);
    expect(t).toMatch(/requireReason/);
    expect(t).toMatch(/codedSet:\s*['"]lab\.amendment_reasons['"]/);
  });
});

describe('BFF actions (REQ-SEC-026/027, S-05): ids validated, body rebuilt from declared fields, Idempotency-Key / If-Match where required, never logged', () => {
  const t = () => actions.map((f) => strip(read(f))).join('\n');
  const around = (p: string, w = 500) => { const b = t(); const i = b.indexOf(p); return i < 0 ? '' : b.slice(Math.max(0, i - w), i + w); };
  it('an id never reaches a path unvalidated (uuid helper around every report path)', () => {
    for (const p of ['/report-versions', '/reopen']) expect(around(p), p).toMatch(/uuid\(/);
  });
  it('M14 sends an Idempotency-Key; M17 sends If-Match', () => {
    expect(around('/report-versions')).toMatch(/idempotency-key/i);
    expect(around('/reopen')).toMatch(/if-match/i);
  });
  it('the report body is rebuilt from declared fields (pick / explicit keys), not spread from the client input', () => {
    const near = around('/report-versions');
    expect(near).toMatch(/\bpick\(|culture_summary_text/);
    expect(near).not.toMatch(/JSON\.stringify\(\s*(input|body|data|payload)\s*\)/);
  });
  it('the reopen body carries only amendment_reason_code / amendment_reason_text', () => {
    const near = around('/reopen');
    expect(near).toContain('amendment_reason_code');
    expect(near).toContain('amendment_reason_text');
    expect(near).not.toMatch(/JSON\.stringify\(\s*(input|body|data|payload)\s*\)/);
  });
  it('the version number of M16 is validated as an integer >= 1 before it reaches the path', () => expect(around('/report-versions/')).toMatch(/version\(|Number\.isInteger|intIn\(/));
  it('no logging in any action file', () => { for (const f of actions) expect(strip(read(f))).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/); });
});

describe('listLabCodedSet.server.ts (D-62, S-30)', () => {
  const s = () => (existsSync(BFF) ? strip(read(BFF)) : '');
  it('names the three system codes it removes', () => { for (const c of ['module_phase_progression', 'module_preliminary_update', 'supplementary_report']) expect(s(), c).toContain(c); });
  it('calls GET /v1/lab/coded-sets/ and checks the set name against the four lab sets', () => {
    expect(s()).toContain('/v1/lab/coded-sets/');
    for (const n of ['rejection_reasons', 'return_reasons', 'amendment_reasons', 'exception_discard_reasons']) expect(s(), n).toContain(n);
  });
  it('does not log', () => expect(s()).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/));
});
