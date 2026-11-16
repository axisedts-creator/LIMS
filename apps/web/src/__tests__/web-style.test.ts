// WEB-STYLE-1 static guard (LD-198, 2026-11-15). No build, no network. Run: .orchestra/notes/WEB-STYLE-1-verify.cmd
//   (a) root layout imports @lims/ui/tokens.css BEFORE @lims/ui/kit.css; <body> has lims-root
//   (b) next.config.mjs generates packages/ui/dist/tokens.css when missing (apps/portal precedent); nothing else removed
//   (c) every lims-* class literal under app/(auth) and features/admin/auth has a selector in kit.css or shell.css
//   (d) CSS added to shell.css (vs fixtures/shell.baseline.css) has no hex, no px, no rgb()/hsl(); card is centred, wordmark uses the accent token; no inline style
//   (e) app/(auth)/auth/page.tsx redirects to /auth/login; the 401 stub link points at an existing route; stub stays CSS-free (AC-0D-7.2)
// Planted-failure fixtures prove the scanners for (a), (c) and (e) fire on the broken form (also (b), (d)).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signInPageHtml } from '../core/shell/sign-in-page';

const web = resolve(fileURLToPath(new URL('../../', import.meta.url))); // apps/web/
const repo = resolve(web, '..', '..');
const src = join(web, 'src');
const read = (p: string): string => readFileSync(p, 'utf8');

// ---------- scanners ----------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p, out); } else out.push(p);
  }
  return out;
}

/** (a) problems with a root layout source. */
function layoutProblems(layout: string): string[] {
  const bad: string[] = [];
  const tok = layout.indexOf("'@lims/ui/tokens.css'");
  const kit = layout.indexOf("'@lims/ui/kit.css'");
  if (tok < 0) bad.push('missing import @lims/ui/tokens.css');
  if (kit < 0) bad.push('missing import @lims/ui/kit.css');
  if (tok >= 0 && kit >= 0 && tok > kit) bad.push('tokens.css imported after kit.css');
  if (tok >= 0 && !/^\s*import\s+'@lims\/ui\/tokens\.css'/m.test(layout)) bad.push('tokens.css must be a side-effect import');
  const body = layout.match(/<body\b[^>]*\bclassName=(?:"([^"]*)"|\{'([^']*)'\})/);
  const cls = (body?.[1] ?? body?.[2] ?? '').split(/\s+/);
  if (!cls.includes('lims-root')) bad.push('<body> has no lims-root class');
  return bad;
}

/** (b) problems with a next.config.mjs source: the tokens guard must exist and be keyed on dist/tokens.css. */
function tokensGuardProblems(cfg: string): string[] {
  const bad: string[] = [];
  if (!/existsSync\(/.test(cfg)) bad.push('no existsSync check');
  if (!/dist\/tokens\.css/.test(cfg)) bad.push('guard not keyed on packages/ui/dist/tokens.css');
  if (!/execFileSync\(/.test(cfg) || !/scripts\/build-tokens\.ts/.test(cfg)) bad.push('does not run scripts/build-tokens.ts');
  if (!/cwd:\s*ui\b/.test(cfg) && !/cwd:\s*[^,}]*packages\/ui/.test(cfg)) bad.push('build-tokens must run with cwd packages/ui');
  if (!/packages\/ui\//.test(cfg)) bad.push('guard does not resolve packages/ui');
  return bad;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every class named in a selector (text before a `{`); declaration bodies are not scanned. */
function selectorClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(css).matchAll(/([^{}]+)\{/g)) {
    for (const c of (m[1] ?? '').matchAll(/\.(lims-[a-z0-9]+(?:-[a-z0-9]+)*)/g)) out.add(c[1] as string);
  }
  return out;
}

/** lims-* literals in component sources. Template tails (`lims-btn-${x}`) yield the stem, which kit.css also defines. */
function classLiterals(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    if (!/\.tsx?$/.test(f)) continue;
    for (const m of read(f).matchAll(/\blims-[a-z0-9]+(?:-[a-z0-9]+)*/g)) if (!out.has(m[0])) out.set(m[0], f);
  }
  return out;
}

/** (c) classes used by the sources that no selector covers (minus the documented exceptions). */
function uncovered(used: Map<string, string>, css: string, exceptions: Record<string, string>): string[] {
  const have = selectorClasses(css);
  return [...used.keys()].filter((c) => !have.has(c) && !(c in exceptions)).sort();
}

/** (d) lines of `css` not present in `baseline`, comments removed. */
function addedCss(css: string, baseline: string): string {
  const known = new Set(stripComments(baseline).split(/\r?\n/).map((l) => l.trim()));
  return stripComments(css).split(/\r?\n/).filter((l) => l.trim() && !known.has(l.trim())).join('\n');
}
const cssViolations = (css: string): string[] => {
  const bad: string[] = [];
  if (/#[0-9a-fA-F]{3,8}\b/.test(css)) bad.push('hex colour');
  // px sizes fixed by 13-M-SERIES s3 (296 sidebar, 76 top bar, 46 pill, 20 icon, 3 px outline, 2 px offset) are exempt (ruling T0D-MSERIES-2); LD-251 bars raw colour, radius, font only.
  if (/(?<![\w.-])-?\d*\.?\d+px\b/.test(css.replace(/(?<![\w.-])(?:296|76|46|20|3|2)px\b/g, ''))) bad.push('px value');
  if (/\b(rgb|rgba|hsl|hsla)\(/.test(css)) bad.push('rgb()/hsl() colour');
  return bad;
};

/** Routes (route groups stripped) of every page.tsx/ts under an app directory. */
function routes(appDir: string): Set<string> {
  const out = new Set<string>();
  for (const f of walk(appDir)) {
    if (!/[\\/]page\.tsx?$/.test(f)) continue;
    const segs = relative(appDir, join(f, '..')).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
    out.add('/' + segs.join('/'));
  }
  return out;
}
const hrefs = (html: string): string[] => [...html.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1] as string);
const stubProblems = (html: string, known: Set<string>): string[] => {
  const bad: string[] = [];
  const links = hrefs(html);
  if (links.length === 0) bad.push('stub has no link');
  for (const h of links) if (!known.has(h)) bad.push(`stub link ${h} is not a route`);
  if (/<style\b|<link\b|<script\b|\sstyle=/i.test(html)) bad.push('stub must stay CSS/script-free (AC-0D-7.2, CSP)');
  if (!/data-testid="sign-in-prompt"/.test(html)) bad.push('stub markup changed');
  return bad;
};

// ---------- real files ----------
const layoutSrc = read(join(src, 'app', 'layout.tsx'));
const cfgSrc = read(join(web, 'next.config.mjs'));
const kitCss = read(join(repo, 'packages', 'ui', 'src', 'components', 'kit.css'));
const shellCss = read(join(src, 'core', 'shell', 'shell.css'));
const baselineCss = read(join(src, '__tests__', 'fixtures', 'shell.baseline.css'));
const authFiles = [...walk(join(src, 'app', '(auth)')), ...walk(join(src, 'features', 'admin', 'auth'))];

// Classes allowed to have no rule (each needs a reason; at most 3).
const EXCEPTIONS: Record<string, string> = {
  // md is the default button size: kit.css styles the base .lims-btn and only defines the -sm variant, so md needs no rule (packages/ui is untouched).
  'lims-btn-md': 'default size, covered by the base .lims-btn rule in kit.css',
};

describe('WEB-STYLE-1 (a) root layout: tokens reach the page', () => {
  it('imports @lims/ui/tokens.css before kit.css and the body has lims-root', () => {
    expect(layoutProblems(layoutSrc)).toEqual([]);
  });
  it('still imports fonts.css, kit.css and shell.css', () => {
    for (const i of ["'@lims/ui/fonts.css'", "'@lims/ui/kit.css'", "'@/core/shell/shell.css'"]) expect(layoutSrc).toContain(i);
  });
  it('planted failures fire', () => {
    const base = "import '@lims/ui/fonts.css';\n";
    const body = '<html><body className="lims-root">x</body></html>';
    expect(layoutProblems(`${base}import '@lims/ui/kit.css';\n${body}`)).toContain('missing import @lims/ui/tokens.css');
    expect(layoutProblems(`${base}import '@lims/ui/kit.css';\nimport '@lims/ui/tokens.css';\n${body}`)).toContain('tokens.css imported after kit.css');
    expect(layoutProblems(`${base}import '@lims/ui/tokens.css';\nimport '@lims/ui/kit.css';\n<body>x</body>`)).toContain('<body> has no lims-root class');
    expect(layoutProblems(`${base}import '@lims/ui/tokens.css';\nimport '@lims/ui/kit.css';\n${body}`)).toEqual([]);
  });
});

describe('WEB-STYLE-1 (b) next.config.mjs tokens guard', () => {
  it('generates packages/ui/dist/tokens.css when missing', () => {
    expect(tokensGuardProblems(cfgSrc)).toEqual([]);
  });
  it('keeps the existing settings (change nothing else)', () => {
    for (const k of ["transpilePackages: ['@lims/ui']", "typescript: { tsconfigPath: 'tsconfig.build.json' }", 'poweredByHeader: false', 'reactStrictMode: true']) expect(cfgSrc).toContain(k);
    expect(cfgSrc).toMatch(/export default nextConfig;/);
  });
  it('planted failure fires on the old config', () => {
    expect(tokensGuardProblems('const nextConfig = { reactStrictMode: true };\nexport default nextConfig;').length).toBeGreaterThan(0);
  });
});

describe('WEB-STYLE-1 (c) every lims-* class in the auth pages has a CSS rule', () => {
  const used = classLiterals(authFiles);
  it('scans real sources (not vacuous)', () => {
    expect(used.has('lims-auth-card')).toBe(true);
    expect(used.has('lims-wordmark')).toBe(true);
    expect(authFiles.length).toBeGreaterThan(10);
  });
  it('kit.css or shell.css has a selector for each (explicit exception list <= 3, each with a reason)', () => {
    const keys = Object.keys(EXCEPTIONS);
    expect(keys.length).toBeLessThanOrEqual(3);
    for (const k of keys) expect((EXCEPTIONS[k] ?? '').length).toBeGreaterThan(10);
    expect(uncovered(used, `${kitCss}\n${shellCss}`, EXCEPTIONS)).toEqual([]);
  });
  it('rule coverage is by selector, not by mention in a comment or a declaration', () => {
    const css = '/* .lims-ghost */ .lims-other { content: ".lims-ghost"; }';
    expect(uncovered(new Map([['lims-ghost', 'x.tsx']]), css, {})).toEqual(['lims-ghost']);
    expect(uncovered(new Map([['lims-ghost', 'x.tsx']]), '@media (min-width: 40rem) { .a .lims-ghost:hover { color: red } }', {})).toEqual([]);
  });
  it('planted failure: unstyled class in a fixture page is reported; exception list silences it', () => {
    const fx = join(src, '__tests__', 'fixtures');
    const planted = new Map([['lims-ghost-panel', join(fx, 'planted.tsx')]]);
    expect(uncovered(planted, `${kitCss}\n${shellCss}`, {})).toEqual(['lims-ghost-panel']);
    expect(uncovered(planted, `${kitCss}\n${shellCss}`, { 'lims-ghost-panel': 'fixture-only exception' })).toEqual([]);
  });
});

describe('WEB-STYLE-1 (d) the new CSS follows LD-140 and the design system', () => {
  const added = addedCss(shellCss, baselineCss);
  it('shell.css gained rules (not vacuous)', () => {
    expect(added).toContain('.lims-auth-card');
    expect(added).toContain('.lims-wordmark');
  });
  it('added lines have no hex, px, rgb()/hsl()', () => {
    expect(cssViolations(added)).toEqual([]);
  });
  it('added lines use var(--lims-*) tokens', () => {
    expect(added).toMatch(/var\(--lims-/);
  });
  it('the card is centred and the wordmark takes the accent token', () => {
    const rules = [...stripComments(shellCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: (m[1] ?? '').trim(), body: m[2] ?? '' }));
    const centring = rules.filter((r) => /\.lims-auth-(card|page)\b/.test(r.sel)).map((r) => r.body).join(';');
    expect(centring).toMatch(/margin(-inline)?:[^;]*auto|justify-content:\s*center|place-(items|content):\s*center|align-items:\s*center/);
    expect(centring).toMatch(/var\(--lims-/);
    const mark = rules.filter((r) => /\.lims-wordmark\b/.test(r.sel)).map((r) => r.body).join(';');
    expect(mark).toMatch(/color:\s*var\(--lims-accent/);
  });
  it('no inline style in the auth pages or forms (LD-140)', () => {
    const offenders = authFiles.filter((f) => /\.tsx$/.test(f) && /\bstyle=\{/.test(read(f))).map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(cssViolations('.a { color: #1a7f4b; }')).toContain('hex colour');
    expect(cssViolations('.a { padding: 16px; }')).toContain('px value');
    expect(cssViolations('.a { color: rgb(0 0 0); }')).toContain('rgb()/hsl() colour');
    expect(cssViolations('.a { padding: var(--lims-space-4); max-width: 28rem; width: 100%; }')).toEqual([]);
    expect(addedCss('.a { x: 1 }\n.b { y: 2 }', '.a { x: 1 }')).toBe('.b { y: 2 }');
  });
});

describe('WEB-STYLE-1 (e) /auth redirect and the 401 stub link', () => {
  const known = routes(join(src, 'app'));
  it('app/(auth)/auth/page.tsx redirects to /auth/login', () => {
    const p = join(src, 'app', '(auth)', 'auth', 'page.tsx');
    expect(existsSync(p)).toBe(true);
    const s = read(p);
    expect(s).toMatch(/import\s*\{[^}]*\bredirect\b[^}]*\}\s*from\s*'next\/navigation'/);
    expect(s).toMatch(/redirect\(\s*'\/auth\/login'\s*\)/);
  });
  it('/auth/login is a real route', () => {
    expect(known.has('/auth/login')).toBe(true);
  });
  it('the stub link points at an existing route and the stub stays CSS-free (AC-0D-7.2)', () => {
    for (const reason of ['expired', 'missing'] as const) {
      const html = signInPageHtml(reason);
      expect(hrefs(html)).toEqual(['/auth/login']);
      expect(stubProblems(html, known)).toEqual([]);
    }
  });
  it('planted failure: the old /auth/ link and a styled stub are reported', () => {
    const old = '<main data-testid="sign-in-prompt"><a href="/auth/">Sign in</a></main>';
    expect(stubProblems(old, new Set(['/auth/login']))).toContain('stub link /auth/ is not a route');
    expect(stubProblems('<style>a{}</style><main data-testid="sign-in-prompt"><a href="/auth/login">x</a></main>', new Set(['/auth/login']))).toContain('stub must stay CSS/script-free (AC-0D-7.2, CSP)');
    expect(stubProblems('<main data-testid="sign-in-prompt"><a href="/auth/login">x</a></main>', new Set(['/auth/login']))).toEqual([]);
  });
});
