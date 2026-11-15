// C10.T-23 source/structure checks: files under components/instrument-records/ and the page route; LD-140 (kit only, no hex / px radius / inline style); REQ-SEC-121 (no raw HTML);
// AC-08.10 / REQ-SEC-098 (barcode never logged or in a URL); REQ-SEC-068 (no token in client code); BFF actions validate ids, rebuild bodies, send Idempotency-Key / If-Match; S-16 (no create path). Static.
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

const ui = [...walk(join(src, 'features/micro/components/instrument-records')), ...walk(join(src, 'app/(staff)/micro/instrument-records'))].filter(code);
const components = ui.filter((f) => f.includes('components'));
const serverFiles = walk(join(src, 'features/micro/server')).filter(code);
const actions = serverFiles.filter((f) => /^['"]use server['"]/m.test(read(f)) && /instrument-records/.test(read(f)));
const PAGE = join(src, 'app/(staff)/micro/instrument-records/page.tsx');

describe('files exist (plan row T-23: app/(staff)/micro/instrument-records/…, components/instrument-records/*)', () => {
  it('page.tsx, loading.tsx and error.tsx exist', () => { for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(src, 'app/(staff)/micro/instrument-records', f)), f).toBe(true); });
  it('error.tsx is a client component and never prints error.message', () => {
    const f = join(src, 'app/(staff)/micro/instrument-records/error.tsx');
    const s = existsSync(f) ? read(f) : '';
    expect(s).toMatch(/^['"]use client['"]/m);
    expect(strip(s)).not.toMatch(/error\.message/);
  });
  it('components/instrument-records has the screen and dialogs (at least three .tsx)', () => expect(components.filter((f) => f.endsWith('.tsx')).length).toBeGreaterThanOrEqual(3));
  it('a "use server" file carries the calls: M19 /instrument-records (GET), M20 /assign, M21 /apply, M22 /ignore', () => {
    const t = actions.map(read).join('\n');
    for (const p of ['/v1/micro/instrument-records', '/assign', '/apply', '/ignore']) expect(t, p).toContain(p);
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
  it('no hand-made <button> / <input> / <select> / <textarea> / <dialog> / <table> (kit components only)', () => {
    expect(components.length).toBeGreaterThan(0);
    for (const f of components) expect(strip(read(f)), relative(src, f)).not.toMatch(/<(button|input|select|textarea|dialog|table)[\s>]/);
  });
  it('the components import no server-only module directly (they call server actions)', () => {
    expect(components.length).toBeGreaterThan(0);
    for (const f of components) expect(read(f), relative(src, f)).not.toMatch(/from\s+['"][^'"]*\.server['"]|from\s+['"]server-only['"]/);
  });
  it('kit pieces named in 04-UI-UX §4 are used: DataTable, FilterBar, Banner, BarcodeInput, RadioGroup, ConfirmDialog with requireReason + the coded set micro.record_ignore_reasons', () => {
    const t = ui.map(read).join('\n');
    for (const k of ['DataTable', 'FilterBar', 'Banner', 'BarcodeInput', 'RadioGroup', 'ConfirmDialog']) expect(t, k).toMatch(new RegExp(`@lims/ui/components/${k}`));
    expect(t).toMatch(/requireReason/);
    expect(t).toMatch(/micro\.record_ignore_reasons/);
  });
  it('the info banner text and its persistence: tone="info", exact §4 sentence, driven by LIMS_MICRO_SPECIMEN_LOOKUP_PORT read on the server', () => {
    const t = ui.map(read).join('\n');
    expect(t).toContain('Instrument results are matched to cultures manually until automatic matching is enabled.');
    expect(t).toMatch(/tone=["']info["']/);
    expect(existsSync(PAGE) ? read(PAGE) : '').toContain('LIMS_MICRO_SPECIMEN_LOOKUP_PORT');
    for (const f of components) expect(read(f), relative(src, f)).not.toContain('LIMS_MICRO_SPECIMEN_LOOKUP_PORT'); // env is server-side only
  });
  it('cites AC-08.4/08.5/08.6 or §4 in a comment (traceability)', () => expect(ui.map(read).join('\n')).toMatch(/AC-08\.[456]/));
});

describe('BFF actions (REQ-SEC-026/027, S-05, S-17): ids validated, body rebuilt from declared fields, Idempotency-Key / If-Match, never logged', () => {
  const t = () => actions.map((f) => strip(read(f))).join('\n');
  const around = (p: string, w = 600) => { const b = t(); const i = b.indexOf(p); return i < 0 ? '' : b.slice(Math.max(0, i - w), i + w); };
  it('an id never reaches a path unvalidated (uuid helper around every instrument-record path)', () => {
    for (const p of ['/assign', '/apply', '/ignore']) expect(around(p), p).toMatch(/uuid\(/);
  });
  it('assign and apply send Idempotency-Key and If-Match; ignore sends If-Match', () => {
    for (const p of ['/assign', '/apply']) { expect(around(p), p).toMatch(/idempotency-key/i); expect(around(p), p).toMatch(/if-match/i); }
    expect(around('/ignore')).toMatch(/if-match/i);
  });
  it('bodies are rebuilt from declared fields: assign { culture_id, isolate_seq, resolution }, apply { resolution }, ignore { reason_code, comment }; none spreads client input', () => {
    expect(around('/assign')).toContain('culture_id');
    expect(around('/assign')).toContain('isolate_seq');
    expect(around('/apply')).toContain('resolution');
    expect(around('/ignore')).toContain('reason_code');
    expect(around('/ignore')).toContain('comment');
    for (const p of ['/assign', '/apply', '/ignore']) expect(around(p), p).not.toMatch(/JSON\.stringify\(\s*(input|body|data|payload)\s*\)/);
  });
  it('resolution is checked against { use_instrument, keep_existing } and isolate_seq as an integer 1..99 before anything is sent', () => {
    const b = t();
    expect(b).toMatch(/use_instrument/);
    expect(b).toMatch(/keep_existing/);
    expect(b).toMatch(/oneOf\(|intIn\(|Number\.isInteger/);
    expect(b).toMatch(/99/);
  });
  it('the instrument-record list query is rebuilt from validated filters (match_status against the six statuses)', () => {
    const b = t();
    for (const s of ['pending_match', 'needs_mapping', 'conflict', 'late_after_final', 'applied', 'ignored']) expect(b, s).toContain(s);
  });
  it('no logging in any action or server file that touches instrument records; the barcode is never put into a path', () => {
    expect(actions.length).toBeGreaterThan(0);
    for (const f of actions) {
      const s = strip(read(f));
      expect(s).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
      expect(s).not.toMatch(/`[^`]*\/v1\/[^`]*\$\{[^}]*barcode[^}]*\}/i);
    }
  });
  it('S-16: no create path — no POST to /v1/micro/instrument-records itself', () => {
    expect(actions.length).toBeGreaterThan(0);
    expect(t()).not.toMatch(/['"`]\/v1\/micro\/instrument-records['"`]\s*,\s*\{[^}]*method:\s*['"]POST/);
  });
});
