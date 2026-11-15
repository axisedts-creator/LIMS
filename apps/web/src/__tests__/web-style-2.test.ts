// WEB-STYLE-2 static guard (LD-201, 2026-11-15; LD-140 no hex/px/inline style; REQ-SEC-073 no remember-me). No build, no network.
// Run: .orchestra/notes/WEB-STYLE-2-verify.cmd. Layout idea only (Watermelon auth-05); nothing is copied.
// Class contract the implementation must use (names fixed here so layout.tsx, shell.css and this test agree):
//   lims-auth-page  = the split container (existing class, kept)   lims-auth-main = form column   lims-auth-panel = brand panel
//   (a) all seven auth screens sit under (auth)/layout.tsx; the layout renders {children} in lims-auth-main next to the panel; no page re-wraps itself
//   (b) panel: aria-hidden, plain heading + the seven pipeline words in order in one list, no digits, no img/remote URL/url()/src, no h1
//   (c) CSS added to shell.css (vs fixtures/shell.baseline-style-2.css): no hex/px/rgb()/hsl(); media/container queries in rem; panel = accent bg + accent-fg text
//   (d) panel hidden below 64rem and shown at >= 64rem; two columns at >= 64rem, one centred column below; lime tokens never used as text colour
//   (e) every lims-* class used by the auth sources has a selector rule (exception list <= 3, reasoned)
//   (f) no social buttons, remember-me, keep-signed-in or sign-up/create-account in the auth sources; no inline style
//   (g) form fields and behaviour unchanged: per-file signature of name/id/htmlFor/type/href/action/autoComplete/inputMode/maxLength/method/data-testid
// Planted-failure fixtures prove each scanner fires on the broken form.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(fileURLToPath(new URL('../../', import.meta.url))); // apps/web/
const repo = resolve(web, '..', '..');
const src = join(web, 'src');
const read = (p: string): string => readFileSync(p, 'utf8');
const rel = (p: string): string => relative(src, p).split(sep).join('/');

// ---------- scanners ----------
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p, out); } else out.push(p);
  }
  return out;
}
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJsComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function selectorClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(css).matchAll(/([^{}]+)\{/g)) {
    for (const c of (m[1] ?? '').matchAll(/\.(lims-[a-z0-9]+(?:-[a-z0-9]+)*)/g)) out.add(c[1] as string);
  }
  return out;
}
function classLiterals(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (!/\.tsx?$/.test(f)) continue;
    for (const m of stripJsComments(read(f)).matchAll(/\blims-[a-z0-9]+(?:-[a-z0-9]+)*/g)) if (!out.has(m[0])) out.set(m[0], f);
  }
  return out;
}
function uncovered(used: Map<string, string>, css: string, exceptions: Record<string, string>): string[] {
  const have = selectorClasses(css);
  return [...used.keys()].filter((c) => !have.has(c) && !(c in exceptions)).sort();
}
function addedCss(css: string, baseline: string): string {
  const known = new Set(stripComments(baseline).split(/\r?\n/).map((l) => l.trim()));
  return stripComments(css).split(/\r?\n/).filter((l) => l.trim() && !known.has(l.trim())).join('\n');
}
const cssViolations = (css: string): string[] => {
  const bad: string[] = [];
  if (/#[0-9a-fA-F]{3,8}\b/.test(css)) bad.push('hex colour');
  if (/(?<![\w-])-?\d*\.?\d+px\b/.test(css)) bad.push('px value');
  if (/\b(rgb|rgba|hsl|hsla)\(/.test(css)) bad.push('rgb()/hsl() colour');
  if (/\burl\(/.test(css) || /@import\b/.test(css) || /https?:\/\//.test(css)) bad.push('url()/@import/remote URL');
  // every media/container condition length must be rem (or % free): 64rem, never px/em/vw
  for (const m of css.matchAll(/@(?:media|container)\b([^{]*)\{/g)) {
    for (const len of (m[1] ?? '').matchAll(/(-?\d*\.?\d+)([a-z%]+)/g)) if (len[2] !== 'rem') bad.push(`query unit ${len[0]} is not rem`);
  }
  return bad;
};

/** One level of @media/@container nesting is enough for this task. `ctx` is the at-rule prelude ('' = top level). */
interface Rule { ctx: string; sel: string; body: string }
function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  const s = stripComments(css);
  let i = 0;
  const readBlock = (from: number): { body: string; end: number } => {
    let depth = 0, j = from;
    for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') { depth--; if (depth === 0) break; } }
    return { body: s.slice(from + 1, j), end: j + 1 };
  };
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const prelude = s.slice(i, open).trim();
    const { body, end } = readBlock(open);
    if (/^@(media|container|supports)\b/.test(prelude)) {
      for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ ctx: prelude, sel: (m[1] ?? '').trim(), body: m[2] ?? '' });
    } else if (!prelude.startsWith('@')) out.push({ ctx: '', sel: prelude, body });
    i = end;
  }
  return out;
}
const hasClass = (sel: string, cls: string): boolean => new RegExp(`\\.${cls}(?![\\w-])`).test(sel);
const decl = (body: string, prop: string): string | null => {
  let v: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))) v = (m[1] ?? '').trim();
  return v;
};
const MIN64 = /\(\s*min-width\s*:\s*64rem\s*\)/;
const MAX64 = /\(\s*max-width\s*:\s*(?:64rem|63\.\d+rem)\s*\)/;

/** (d) panel hidden below 64rem, visible at/above it. Returns problems. */
function panelVisibilityProblems(css: string): string[] {
  const rules = parseRules(css).filter((r) => hasClass(r.sel, 'lims-auth-panel') && !/:hover|:focus/.test(r.sel));
  if (rules.length === 0) return ['no .lims-auth-panel rule'];
  const baseDisplay = rules.filter((r) => r.ctx === '').map((r) => decl(r.body, 'display')).filter(Boolean).pop() ?? null;
  const wideShown = rules.some((r) => MIN64.test(r.ctx) && (decl(r.body, 'display') ?? 'none') !== 'none' && decl(r.body, 'display') !== null);
  const narrowHidden = rules.some((r) => MAX64.test(r.ctx) && decl(r.body, 'display') === 'none');
  const bad: string[] = [];
  if (baseDisplay === 'none') { if (!wideShown) bad.push('panel is display:none but never shown at min-width 64rem'); }
  else if (!narrowHidden) bad.push('panel is not hidden below 64rem (need display:none base + min-width 64rem, or max-width 64rem display:none)');
  return bad;
}
/** (d) one centred column below 64rem, two columns at/above. */
function columnProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const page = rules.filter((r) => hasClass(r.sel, 'lims-auth-page') || hasClass(r.sel, 'lims-auth-main'));
  const cols = (b: string): string => decl(b, 'grid-template-columns') ?? '';
  const twoTracks = (v: string): boolean => /(fr|%|rem|minmax|auto)[^;]*\s+[^;]*(fr|%|rem|minmax|auto)/.test(v) && !/^repeat\(1,/.test(v);
  const wide = page.filter((r) => MIN64.test(r.ctx));
  if (!wide.some((r) => hasClass(r.sel, 'lims-auth-page') && (twoTracks(cols(r.body)) || /display\s*:\s*flex/.test(r.body)))) bad.push('no two-column rule on .lims-auth-page at min-width 64rem');
  const baseBody = page.filter((r) => r.ctx === '' && !MAX64.test(r.ctx)).map((r) => r.body).join(';');
  if (twoTracks(cols(baseBody))) bad.push('two columns outside the >=64rem query (must collapse to one below 64rem)');
  if (!/margin(-inline)?\s*:[^;]*auto|justify-content\s*:\s*center|place-(items|content)\s*:\s*center|align-items\s*:\s*center|justify-items\s*:\s*center/.test(baseBody)) bad.push('single column is not centred below 64rem');
  return bad;
}
/** lime tokens are decoration only: never a text colour. */
const limeAsText = (css: string): boolean => /(?:^|[;{\s])color\s*:\s*var\(--lims-accent-(?:brand|highlight)/.test(stripComments(css));

/** (b) problems with the layout source. */
const STEPS = ['Draft', 'To collect', 'To receive', 'In progress', 'To authorise', 'Authorised', 'Released'];
function layoutProblems(layout: string): string[] {
  const bad: string[] = [];
  const code = stripJsComments(layout);
  for (const c of ['lims-auth-page', 'lims-auth-main', 'lims-auth-panel']) if (!new RegExp(`\\b${c}\\b`).test(code)) bad.push(`layout has no ${c}`);
  if (!/\{children\}/.test(code)) bad.push('layout does not render {children}');
  const mainAt = code.search(/lims-auth-main/), childAt = code.indexOf('{children}');
  if (mainAt >= 0 && childAt >= 0 && childAt < mainAt) bad.push('{children} is not inside lims-auth-main');
  const tag = code.match(/<(\w+)\b[^>]*\blims-auth-panel\b[^>]*>/);
  if (!tag) { bad.push('no panel element'); return bad; }
  if (!/\baria-hidden(?:=(?:"true"|\{true\}|\{'true'\}))?(?=[\s/>])/.test(tag[0])) bad.push('panel is not aria-hidden');
  if (/\bstyle=/.test(tag[0])) bad.push('panel has inline style');
  const seg = code.slice((tag.index ?? 0) + tag[0].length);
  const texts = [...seg.matchAll(/>([^<>{}]+)</g)].map((m) => (m[1] ?? '').trim()).filter(Boolean);
  let at = 0;
  for (const w of STEPS) { const k = texts.findIndex((t, i) => i >= at && t === w); if (k < 0) { bad.push(`pipeline word "${w}" missing or out of order`); break; } at = k + 1; }
  if (!/<(ol|ul)\b/.test(seg)) bad.push('pipeline words are not in a list');
  if ((seg.match(/<li\b/g) ?? []).length < STEPS.length) bad.push('fewer than 7 list items in the panel');
  if (!/<(h2|h3|p)\b/.test(seg)) bad.push('panel has no plain heading/text line');
  if (/<h1\b/.test(tag[0] + seg)) bad.push('panel contains an h1 (pages own the h1)');
  const extra = texts.filter((t) => !STEPS.includes(t));
  if (extra.some((t) => /\d|%/.test(t))) bad.push('panel text has a number/percentage (no claims or numbers)');
  return bad;
}
/** no image / remote asset anywhere in the layout source. */
function assetProblems(code: string): string[] {
  const bad: string[] = [];
  const c = stripJsComments(code);
  if (/<(img|image|picture|video|source|iframe|object|embed|link|script)\b/i.test(c)) bad.push('img/media/link/script element');
  if (/next\/image|\bImage\b\s+from/.test(c)) bad.push('next/image import');
  if (/https?:\/\/|(?<![\w:])\/\/[a-z]/i.test(c)) bad.push('remote URL');
  if (/\bsrc=|\bsrcSet=|url\(/i.test(c)) bad.push('src/srcSet/url()');
  if (/\bstyle=\{|\bstyle="/.test(c)) bad.push('inline style');
  return bad;
}
const FORBIDDEN = /remember|keep me|stay (signed|logged)|trust this (device|browser)|sign.?up|create (an |one|your )|register|\bsocial\b|google|github|microsoft|\bapple\b|oauth|facebook|linkedin|continue with|or sign in with/i;
const forbiddenHits = (files: string[]): string[] =>
  files.filter((f) => /\.tsx?$/.test(f)).flatMap((f) => [...stripJsComments(read(f)).matchAll(new RegExp(FORBIDDEN, 'gi'))].map((m) => `${rel(f)}: ${m[0]}`));

/** (g) field/behaviour signature: ordered attribute tokens per file. */
const SIG_ATTR = /\b(name|id|htmlFor|type|href|action|autoComplete|inputMode|maxLength|method|data-testid)=("[^"]*"|\{[^{}]*\})/g;
function signature(files: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of files.sort()) {
    if (!/\.tsx$/.test(f)) continue;
    out[rel(f)] = [...stripJsComments(read(f)).matchAll(SIG_ATTR)].map((m) => `${m[1]}=${m[2]}`);
  }
  return out;
}

// ---------- real files ----------
const layoutPath = join(src, 'app', '(auth)', 'layout.tsx');
const layoutSrc = read(layoutPath);
const kitCss = read(join(repo, 'packages', 'ui', 'src', 'components', 'kit.css'));
const shellCss = read(join(src, 'core', 'shell', 'shell.css'));
const baselineCss = read(join(src, '__tests__', 'fixtures', 'shell.baseline-style-2.css'));
const authFiles = [...walk(join(src, 'app', '(auth)')), ...walk(join(src, 'features', 'admin', 'auth'))];
const added = addedCss(shellCss, baselineCss);
const EXCEPTIONS: Record<string, string> = {
  // md is the default button size: kit.css styles the base .lims-btn and only defines -sm (packages/ui is untouched; same exception as WEB-STYLE-1).
  'lims-btn-md': 'default size, covered by the base .lims-btn rule in kit.css',
};
const SCREENS = ['login', 'mfa', 'forgot', 'set-password', 'confirm', 'session-expired', 'logout'];

describe('WEB-STYLE-2 (a) all seven auth screens use the one split layout', () => {
  it('each screen is a page under the (auth) route group (so (auth)/layout.tsx wraps it)', () => {
    for (const s of SCREENS) expect(existsSync(join(src, 'app', '(auth)', 'auth', s, 'page.tsx')), `/auth/${s}`).toBe(true);
  });
  it('layout has page > main (children) + panel', () => {
    expect(layoutProblems(layoutSrc).filter((p) => /no lims-auth|children|panel element/.test(p))).toEqual([]);
  });
  it('no page or component re-wraps itself in the layout/panel classes (no nested split)', () => {
    const offenders = authFiles.filter((f) => f !== layoutPath && /\blims-auth-(page|main|panel)\b/.test(stripJsComments(read(f)))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('WEB-STYLE-2 (b) brand panel content', () => {
  it('aria-hidden, plain heading, seven pipeline words in order in one list, no numbers, no h1', () => {
    expect(layoutProblems(layoutSrc)).toEqual([]);
  });
  it('layout: no img, remote URL, url(), src or inline style; auth components: no remote URL or inline style', () => {
    expect(assetProblems(layoutSrc)).toEqual([]);
    // Components may keep what they have (MfaEnrolment shows the enrolment QR via DataUriImage, REQ-SEC-088): only remote URLs and inline style are barred there.
    const offenders = authFiles.filter((f) => /\.tsx$/.test(f)).map((f) => ({ f: rel(f), p: assetProblems(read(f)).filter((x) => x === 'remote URL' || x === 'inline style') })).filter((x) => x.p.length);
    expect(offenders).toEqual([]);
  });
  it('planted failures fire', () => {
    const good = `<div className="lims-auth-page"><main className="lims-auth-main">{children}</main><aside className="lims-auth-panel" aria-hidden="true"><p>From sample to report</p><ol>${STEPS.map((s) => `<li>${s}</li>`).join('')}</ol></aside></div>`;
    expect(layoutProblems(good)).toEqual([]);
    expect(layoutProblems(good.replace(' aria-hidden="true"', ''))).toContain('panel is not aria-hidden');
    expect(layoutProblems(good.replace('<li>Draft</li>', '').replace('<ol>', '<ol><li>Released</li>'))).toContain('pipeline word "Draft" missing or out of order');
    expect(layoutProblems(good.replace('<p>From sample to report</p>', '<p>99% faster</p>'))).toContain('panel text has a number/percentage (no claims or numbers)');
    expect(layoutProblems(good.replace('<ol>', '<h1>x</h1><ol>'))).toContain('panel contains an h1 (pages own the h1)');
    expect(layoutProblems('<div className="lims-auth-page">{children}</div>')).toContain('layout has no lims-auth-panel');
    expect(assetProblems('<img src="/x.png" />').length).toBeGreaterThan(0);
    expect(assetProblems('<aside className="a">https://cdn.example.com/x</aside>')).toContain('remote URL');
    expect(assetProblems('<aside style={{ width: 1 }} />')).toContain('inline style');
    expect(assetProblems(good)).toEqual([]);
  });
});

describe('WEB-STYLE-2 (c) the new CSS follows LD-140 and the design system', () => {
  it('shell.css gained the split/panel rules (not vacuous)', () => {
    for (const c of ['.lims-auth-page', '.lims-auth-main', '.lims-auth-panel']) expect(added, c).toContain(c);
  });
  it('added lines: no hex, px, rgb()/hsl(), url(), @import, remote URL; query lengths in rem', () => {
    expect(cssViolations(added)).toEqual([]);
  });
  it('added lines use var(--lims-*) tokens', () => {
    expect(added).toMatch(/var\(--lims-/);
  });
  it('panel = accent background with accent-fg text', () => {
    const body = parseRules(shellCss).filter((r) => hasClass(r.sel, 'lims-auth-panel') && !/\s/.test(r.sel.trim())).map((r) => r.body).join(';');
    expect(decl(body, 'background') ?? decl(body, 'background-color') ?? '').toMatch(/var\(--lims-accent\)/);
    expect(decl(body, 'color') ?? '').toMatch(/var\(--lims-accent-fg\)/);
  });
  it('lime tokens (accent-brand / accent-highlight) are never a text colour', () => {
    expect(limeAsText(shellCss)).toBe(false);
  });
  it('planted failures fire', () => {
    expect(cssViolations('.a { color: #1a7f4b; }')).toContain('hex colour');
    expect(cssViolations('.a { padding: 16px; }')).toContain('px value');
    expect(cssViolations('.a { background: url(x.png); }')).toContain('url()/@import/remote URL');
    expect(cssViolations('@media (min-width: 1024px) { .a { x: 1 } }')).toContain('query unit 1024px is not rem');
    expect(cssViolations('@media (min-width: 64rem) { .a { padding: var(--lims-space-4); width: 50%; } }')).toEqual([]);
    expect(limeAsText('.a { color: var(--lims-accent-brand); }')).toBe(true);
    expect(limeAsText('.a { background: var(--lims-accent-brand); color: var(--lims-accent-fg); }')).toBe(false);
  });
});

describe('WEB-STYLE-2 (d) responsive: panel hidden and one centred column below 64rem', () => {
  it('panel is hidden below 64rem and shown from 64rem', () => {
    expect(panelVisibilityProblems(shellCss)).toEqual([]);
  });
  it('two columns from 64rem, one centred column below', () => {
    expect(columnProblems(shellCss)).toEqual([]);
  });
  it('planted failures fire', () => {
    const okPanel = '.lims-auth-panel { display: none; }\n@media (min-width: 64rem) { .lims-auth-panel { display: flex; } }';
    expect(panelVisibilityProblems(okPanel)).toEqual([]);
    expect(panelVisibilityProblems('.lims-auth-panel { display: flex; }\n@media (max-width: 64rem) { .lims-auth-panel { display: none; } }')).toEqual([]);
    expect(panelVisibilityProblems('.lims-auth-panel { display: flex; }')).not.toEqual([]);
    expect(panelVisibilityProblems('.lims-auth-panel { display: none; }')).not.toEqual([]);
    expect(panelVisibilityProblems('.lims-auth-panel { display: none; }\n@media (min-width: 48rem) { .lims-auth-panel { display: flex; } }')).not.toEqual([]);
    expect(panelVisibilityProblems('.lims-auth-main { color: red; }')).toEqual(['no .lims-auth-panel rule']);
    const okCols = '.lims-auth-page { display: grid; place-items: center; }\n@media (min-width: 64rem) { .lims-auth-page { grid-template-columns: 1fr 1fr; } }';
    expect(columnProblems(okCols)).toEqual([]);
    expect(columnProblems('.lims-auth-page { display: grid; grid-template-columns: 1fr 1fr; place-items: center; }')).toContain('two columns outside the >=64rem query (must collapse to one below 64rem)');
    expect(columnProblems('.lims-auth-page { display: grid; }\n@media (min-width: 64rem) { .lims-auth-page { grid-template-columns: 1fr 1fr; } }')).toContain('single column is not centred below 64rem');
    expect(columnProblems('.lims-auth-page { display: grid; place-items: center; }')).toContain('no two-column rule on .lims-auth-page at min-width 64rem');
  });
});

describe('WEB-STYLE-2 (e) every lims-* class in the auth sources has a CSS rule', () => {
  const used = classLiterals(authFiles);
  it('scans real sources incl. the new panel classes (not vacuous)', () => {
    for (const c of ['lims-auth-page', 'lims-auth-main', 'lims-auth-panel', 'lims-auth-card', 'lims-wordmark']) expect(used.has(c), c).toBe(true);
  });
  it('kit.css or shell.css has a selector for each (exception list <= 3, each with a reason)', () => {
    const keys = Object.keys(EXCEPTIONS);
    expect(keys.length).toBeLessThanOrEqual(3);
    for (const k of keys) expect((EXCEPTIONS[k] ?? '').length).toBeGreaterThan(10);
    expect(uncovered(used, `${kitCss}\n${shellCss}`, EXCEPTIONS)).toEqual([]);
  });
  it('planted failure: an unstyled panel class is reported; a comment or declaration mention does not count', () => {
    const planted = new Map([['lims-auth-ghost', 'x.tsx']]);
    expect(uncovered(planted, '/* .lims-auth-ghost */ .a { content: ".lims-auth-ghost"; }', {})).toEqual(['lims-auth-ghost']);
    expect(uncovered(planted, '@media (min-width: 64rem) { .lims-auth-page .lims-auth-ghost { x: 1 } }', {})).toEqual([]);
  });
});

describe('WEB-STYLE-2 (f) REQ-SEC-073 and LD-201: nothing the lead rejected', () => {
  it('no social buttons, remember-me, keep-signed-in, sign-up or create-account in the auth sources', () => {
    expect(forbiddenHits(authFiles)).toEqual([]);
  });
  it('the layout is scanned (not vacuous) and every auth page is a scanned file', () => {
    expect(authFiles).toContain(layoutPath);
    expect(authFiles.filter((f) => /[\\/]page\.tsx$/.test(f)).length).toBeGreaterThanOrEqual(8);
  });
  it('no inline style in the auth pages or forms (LD-140)', () => {
    expect(authFiles.filter((f) => /\.tsx$/.test(f) && /\bstyle=\{/.test(read(f))).map(rel)).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(FORBIDDEN.test('Remember me')).toBe(true);
    expect(FORBIDDEN.test('Keep me signed in')).toBe(true);
    expect(FORBIDDEN.test('Create one for free')).toBe(true);
    expect(FORBIDDEN.test('Continue with Google')).toBe(true);
    expect(FORBIDDEN.test('Forgot password?')).toBe(false);
    expect(FORBIDDEN.test('Sign in')).toBe(false);
  });
});

describe('WEB-STYLE-2 (g) form fields and behaviour are unchanged', () => {
  const baseline = JSON.parse(read(join(src, '__tests__', 'fixtures', 'auth-fields.baseline.json'))) as Record<string, string[]>;
  const now = signature(authFiles.filter((f) => f !== layoutPath));
  it('baseline is not vacuous', () => {
    expect(Object.keys(baseline).length).toBeGreaterThanOrEqual(10);
    expect(baseline['features/admin/auth/LoginForm.tsx']?.some((t) => /^name=/.test(t))).toBe(true);
  });
  it('per-file name/id/htmlFor/type/href/action/autoComplete/inputMode/maxLength/method/data-testid tokens match the baseline', () => {
    expect(now).toEqual(baseline);
  });
  it('planted failure: a renamed field changes the signature', () => {
    const a = [...'<input name="email" type="email" />'.matchAll(SIG_ATTR)].map((m) => m[0]);
    const b = [...'<input name="user" type="email" />'.matchAll(SIG_ATTR)].map((m) => m[0]);
    expect(a).not.toEqual(b);
  });
});
