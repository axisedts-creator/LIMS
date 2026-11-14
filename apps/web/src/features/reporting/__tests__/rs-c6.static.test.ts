// RS-C6 (LD-140; 10-DESIGN-SYSTEM s3, s4, s5, s6, s8) static checks over the paths RS-C6 owns:
//   apps/web/src/features/reporting, apps/web/src/app/(staff)/reporting, apps/portal/src
// 1. no raw colour / pixel radius / inline style (same detector rules as packages/ui/scripts/__tests__/no-raw-style-literals.test.ts), including
//    CSS fallbacks such as `var(--lims-x, #fff)`; 2. the s6 "do not" list; 3. the s5 portal rules in portal.css (token radii, 44 px targets,
//    mobile first, one font stack with the Devanagari fallback, no hand-written font); 4. behaviour unchanged: data/route/action files
//    byte-identical, and the API calls, routes, links, permission codes and form field names equal rs-c6.baseline.json (recorded from HEAD
//    before the restyle by `record()` in rs-c6.surface.ts; do not re-record to make a test pass).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselineFile, DATA_FILES, files, portalRoot, read, scan, stripComments, surface } from './rs-c6.surface';

const code = files.map((f) => ({ rel: f.rel, lines: stripComments(f.text) }));
const offenders = (re: RegExp, only?: RegExp) =>
  code.filter((f) => !only || only.test(f.rel)).flatMap((f) => f.lines.flatMap((l, i) => (re.test(l) ? [`${f.rel}:${i + 1} ${l.trim().slice(0, 100)}`] : [])));

describe('scope sanity', () => {
  it('walks the web reporting feature, the staff route folder and the portal', () => {
    expect(files.filter((f) => f.rel.startsWith('web/features/reporting/components/')).length).toBeGreaterThan(12);
    expect(files.filter((f) => f.rel.startsWith('web/app/(staff)/reporting/')).length).toBeGreaterThan(10);
    expect(files.filter((f) => f.rel.startsWith('portal/src/')).length).toBeGreaterThan(20);
    expect(read('portal/src/app/portal.css').length).toBeGreaterThan(200);
  });
  it('detector self-check: finds a hex, an rgb(), a px radius and an inline style object', () => {
    const bad = ['a { color: #1d4ed8; }', 'b { background: rgb(1 2 3); }', 'c { border-radius: 6px; }', 'const x = <p style={{ margin: 0 }} />;'];
    expect(bad.map((t) => scan('x', t).length)).toEqual([1, 1, 1, 1]);
    expect(scan('x', 'a { border-radius: var(--lims-radius-md); color: var(--lims-neutral-900); }')).toEqual([]);
  });
});

describe('no raw colour, pixel radius or inline style under the RS-C6 paths (LD-140, 10-DESIGN-SYSTEM s2.3, s7.3)', () => {
  it('web reporting feature and staff reporting routes', () => {
    const hits = files.filter((f) => f.rel.startsWith('web/')).flatMap((f) => scan(f.rel, f.text));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });
  it('apps/portal (CSS included: fallbacks in var(--x, #fff) are raw colours too)', () => {
    const hits = files.filter((f) => f.rel.startsWith('portal/')).flatMap((f) => scan(f.rel, f.text));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });
});

describe('10-DESIGN-SYSTEM s6: nothing that reads as AI-generated', () => {
  it('no gradient, glass blur or glow/ad-hoc shadow', () => {
    expect(offenders(/(?:linear|radial|conic)-gradient\(|backdrop-?filter|backdropFilter|\bbox-?[sS]hadow\s*:\s*(?!var\(--lims-elevation-1\))|\bdrop-shadow\b/)).toEqual([]);
  });
  it('no emoji (one stroke icon family only)', () => {
    expect(offenders(/\p{Extended_Pictographic}/u)).toEqual([]);
  });
  it('no "Welcome back" greeting', () => {
    expect(offenders(/welcome back/i)).toEqual([]);
  });
  it('no utility rounded-* / bg-* / shadow-* classes (the radius ladder comes from the kit tokens)', () => {
    expect(offenders(/className\s*=\s*["'`{][^"'`}]*\b(?:rounded(?:-\w+)?|bg-\w+|shadow(?:-\w+)?)\b/)).toEqual([]);
  });
  it('no purple / blue-violet accent: the old portal blue fallbacks are gone', () => {
    expect(offenders(/#(?:1d4ed8|2563eb|4f46e5|6366f1|7c3aed|8b5cf6)\b/i)).toEqual([]);
  });
});

describe('10-DESIGN-SYSTEM s5 portal rules in portal.css', () => {
  const css = stripComments(read('portal/src/app/portal.css')).join('\n');
  // declarations of every rule whose selector list contains `sel` exactly (grouped selectors allowed)
  const body = (sel: string) =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(',').some((s) => s.trim() === sel)).map((m) => m[2]!).join(' ');
  const rule = body;
  it('cards use radius.lg, buttons the pill (radius.full), notices and alerts a ladder token', () => {
    expect(body('.portal-card')).toMatch(/border-radius:\s*var\(--lims-radius-lg\)/);
    expect(body('.portal-btn')).toMatch(/border-radius:\s*var\(--lims-radius-full\)/);
    expect(body('.portal-alert')).toMatch(/border-radius:\s*var\(--lims-radius-(?:sm|md|lg)\)/);
    expect(body('.portal-notice')).toMatch(/border-radius:\s*var\(--lims-radius-(?:sm|md|lg)\)/);
  });
  it('page is neutral.50, card surface is neutral.0, primary button is the accent (token vars, no fallback literal)', () => {
    expect(body('body')).toMatch(/background:\s*var\(--lims-neutral-50\)/);
    expect(body('.portal-card')).toMatch(/background:\s*var\(--lims-neutral-0\)/);
    expect(body('.portal-btn-primary')).toMatch(/background:\s*var\(--lims-accent(?:-default)?\)/);
  });
  it('touch targets stay at least 44 px (buttons, OTP cells)', () => {
    expect(rule('.portal-btn')).toMatch(/min-height:\s*44px/);
    expect(rule('.portal-btn')).toMatch(/min-width:\s*44px/);
    expect(css).toMatch(/\.lims-otp-cell[^}]*min-height:\s*44px/);
  });
  it('mobile first: no max-width media query (base rules are the phone layout)', () => {
    expect(css).not.toMatch(/@media[^{]*max-width/);
  });
  it('one font stack: the kit token (Plus Jakarta Sans with the Noto Sans Devanagari fallback); no hand-written font-family', () => {
    const fams = [...css.matchAll(/font-family\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(fams.length).toBeGreaterThan(0);
    for (const f of fams) expect(f).toMatch(/^var\(--lims-font-family-(?:sans|mono)\)$/);
    expect(readFileSync(join(portalRoot, '..', '..', 'packages', 'ui', 'tokens', 'tokens.json'), 'utf8')).toMatch(/Plus Jakarta Sans[\\", ]*Noto Sans Devanagari/);
  });
  it('layout loads the kit tokens, fonts and kit.css, then portal.css (no second token source)', () => {
    const l = read('portal/src/app/layout.tsx');
    for (const imp of ["'@lims/ui/tokens.css'", "'@lims/ui/fonts.css'", "'@lims/ui/kit.css'", "'./portal.css'"]) expect(l).toContain(imp);
  });
  it('portal and staff code import the kit through its package path only', () => {
    expect(offenders(/from\s+['"][^'"]*(?:packages\/ui|\.\.\/ui\/src)/)).toEqual([]);
  });
});

describe('behaviour unchanged: API calls, field names, validation, permissions, routes (diff of the chunk api-client usage is empty)', () => {
  const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as ReturnType<typeof surface>;
  const now = surface();
  it('baseline is not empty (guards against a vacuous pass)', () => {
    expect(Object.keys(base.data_files).length).toBe(DATA_FILES.length);
    for (const [f, h] of Object.entries(base.data_files)) expect(h, `${f} must exist in the baseline`).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(base.data_files)).not.toContain(createHash('sha256').update('MISSING').digest('hex'));
    expect(base.route_files.length).toBeGreaterThan(25);
    expect(base.portal_api_calls.length).toBeGreaterThan(8);
    expect(base.web_api_paths.length).toBeGreaterThan(20);
    expect(base.permission_codes.length).toBeGreaterThan(15);
    expect(base.field_names.length).toBeGreaterThan(20);
    expect(base.imported_server_symbols.length).toBeGreaterThan(50);
  });
  it('data, action, API-client, route-handler, middleware and nav files are untouched', () => {
    expect(now.data_files).toEqual(base.data_files);
  });
  it('same route files (no route added, removed or renamed)', () => {
    expect(now.route_files).toEqual(base.route_files);
  });
  it('same internal links and form actions', () => {
    expect(now.internal_links).toEqual(base.internal_links);
  });
  it('same portal API calls (method + path)', () => {
    expect(now.portal_api_calls).toEqual(base.portal_api_calls);
  });
  it('same web API paths', () => {
    expect(now.web_api_paths).toEqual(base.web_api_paths);
  });
  it('same server actions / API helpers imported by the screens', () => {
    expect(now.imported_server_symbols).toEqual(base.imported_server_symbols);
  });
  it('same permission codes', () => {
    expect(now.permission_codes).toEqual(base.permission_codes);
  });
  it('same form field names', () => {
    expect(now.field_names).toEqual(base.field_names);
  });
  it('portal package.json untouched (no new dependency; fonts and tokens come from @lims/ui)', () => {
    expect(now.portal_package_json).toBe(base.portal_package_json);
  });
});
