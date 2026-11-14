// C10.T-21 source/structure checks: files under components/ast/; LD-140 (kit only, no hex / px radius / inline style); REQ-SEC-088 (no raw HTML); REQ-SEC-098 (no logging);
// REQ-SEC-068 (no token in client code); AST BFF actions are server-side, rebuild the body from declared fields and validate ids. Static.
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

const ui = walk(join(src, 'features/micro/components/ast')).filter(code);
const serverFiles = walk(join(src, 'features/micro/server')).filter(code);
const actions = serverFiles.filter((f) => /^['"]use server['"]/m.test(read(f)));

describe('files exist (plan row T-21: components/ast/*)', () => {
  it('components/ast/AstGrid.tsx', () => expect(existsSync(join(src, 'features/micro/components/ast/AstGrid.tsx'))).toBe(true));
  it('at least one more file is allowed but the grid is a client component', () => {
    const f = join(src, 'features/micro/components/ast/AstGrid.tsx');
    expect(existsSync(f) && /^['"]use client['"]/m.test(read(f))).toBe(true);
  });
  it('a "use server" file carries the AST calls: interpret (preview), bulk-record, ast-panel', () => {
    const t = actions.map(read).join('\n');
    for (const p of ['/ast-results/interpret', '/ast-results/bulk-record', '/ast-panel']) expect(t, p).toContain(p);
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
  it('no token / JWT handling in client component files', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/getAccessToken|Authorization|Bearer /);
  });
  it('no hand-made <button> / <input> / <select> / <textarea> / <dialog> (kit components only)', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(strip(read(f)), relative(src, f)).not.toMatch(/<(button|input|select|textarea|dialog)[\s>]/);
  });
  it('the AST grid imports no server-only module directly (it calls server actions)', () => {
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) expect(read(f), relative(src, f)).not.toMatch(/from\s+['"][^'"]*\.server['"]|from\s+['"]server-only['"]/);
  });
});

describe('BFF actions (REQ-SEC-026/027, S-05): ids validated, body rebuilt from declared fields, Idempotency-Key where required, never logged', () => {
  const t = () => actions.map((f) => strip(read(f))).join('\n');
  it('uses the shared uuid / idempotency helpers for the AST paths (an id never reaches a path unvalidated)', () => {
    const body = t();
    const around = (p: string) => body.slice(Math.max(0, body.indexOf(p) - 400), body.indexOf(p) + 400);
    for (const p of ['/ast-results/interpret', '/ast-results/bulk-record', '/ast-panel']) expect(around(p), p).toMatch(/uuid\(/);
    expect(around('/ast-results/bulk-record')).toMatch(/idempotency-key/i);
    expect(around('/ast-panel')).toMatch(/idempotency-key/i);
    expect(around('/ast-panel')).toMatch(/if-match/i);
  });
  it('the entry list is capped (<= 60) in the action, not only in the UI', () => expect(t()).toMatch(/\b60\b/));
  it('no logging in any action file', () => { for (const f of actions) expect(strip(read(f))).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/); });
});
