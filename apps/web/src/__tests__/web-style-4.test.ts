// WEB-STYLE-4 static guard (LD-213, founder 2026-11-15 14:56 + 15:00 NPT; LD-140 tokens/rem/% only; CSP img-src 'self' data:; 10-DESIGN-SYSTEM Metro Green).
// No build, no network. Run: .orchestra/notes/WEB-STYLE-4-verify.cmd. Layout idea only (Watermelon auth-05); nothing is copied.
// CLASS / FILE CONTRACT (names fixed here so layout, css, forms and this test agree):
//   features/admin/auth/AuthArt.tsx exports AuthArt (panel + band illustration), AuthMark (placeholder logo mark), AuthIcon({kind:'mail'|'lock'|'shield'|'arrow', className?}).
//     every <svg> there: aria-hidden="true" focusable="false" viewBox; colours only currentColor | none | var(--lims-*); NO text/title/desc/image/use/style/script/animate*; no URL; no hex; no style attr.
//     AuthArt root svg class `lims-art`; EXACTLY ONE element carries class `lims-art-accent` (the one lime highlight, CSS: stroke|fill var(--lims-accent-brand)); AuthMark svg class `lims-mark`.
//     the file must not contain the word lims-wordmark (web-style-3 greps every auth file for it); a comment says the mark is a placeholder until a real logo exists.
//   (auth)/layout.tsx: panel-body = title + <AuthArt /> + ol (web-style-3 contract kept); NEW <header className="lims-auth-band" aria-hidden="true"> holding
//     <div className="lims-lockup"><AuthMark /><p className="lims-wordmark">LIMS</p></div> and <AuthArt />; layout itself has no <svg>.
//   forms: wordmark lockup `div.lims-lockup` (AuthMark then the unchanged <p className="lims-wordmark">LIMS</p>) in LoginForm;
//     email/password inputs sit in `div.lims-input-wrap` after `<AuthIcon kind="mail|lock" className="lims-input-icon" />` (LoginForm email, ForgotPasswordForm email, PasswordField lock);
//     every submit primary <Button> ends with <AuthIcon kind="arrow" className="lims-btn-arrow" />; MfaChallengeForm + MfaEnrolment show <AuthIcon kind="shield" /> (class lims-auth-badge wrapper);
//     MfaEnrolment step 2: `div.lims-qr-card` wraps the (conditional) DataUriImage then SecretRevealOnce.
//   css: rules live in shell.css (or extra apps/web/src/**/auth*.css that is imported). Panel/band pseudo-element rules must NOT declare `display` (web-style-2/3 read every .lims-auth-panel rule).
// DISCREPANCY (reported to the lead): the 6-digit field is the kit OtpInput = SIX inputs, not one (packages/ui is out of scope), so "ONE input, name/id/maxlength unchanged" cannot be met without a behaviour change.
//   Guarded instead: OtpInput usage + kit attributes unchanged, no new local code input, and the cells are styled via .lims-otp-cell.
// Cannot be proven here (needs a browser): no page scrollbar at 1440x900, 1920x1080, 390x844; how it looks. Planted-failure fixtures prove each scanner fires.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(fileURLToPath(new URL('../../', import.meta.url))); // apps/web/
const repo = resolve(web, '..', '..');
const src = join(web, 'src');
const read = (p: string): string => readFileSync(p, 'utf8');
const rel = (p: string): string => relative(src, p).split(sep).join('/');

// ---------- generic scanners ----------
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
  for (const m of stripComments(css).matchAll(/([^{}]+)\{/g)) for (const c of (m[1] ?? '').matchAll(/\.(lims-[a-z0-9]+(?:-[a-z0-9]+)*)/g)) out.add(c[1] as string);
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
const uncovered = (used: Map<string, string>, css: string, exceptions: Record<string, string>): string[] => {
  const have = selectorClasses(css);
  return [...used.keys()].filter((c) => !have.has(c) && !(c in exceptions)).sort();
};
function addedCss(css: string, baseline: string): string {
  const known = new Set(stripComments(baseline).split(/\r?\n/).map((l) => l.trim()));
  return stripComments(css).split(/\r?\n/).filter((l) => l.trim() && !known.has(l.trim())).join('\n');
}
const cssViolations = (css: string): string[] => {
  const bad: string[] = [];
  if (/#[0-9a-fA-F]{3,8}\b/.test(css)) bad.push('hex colour');
  // px sizes fixed by 13-M-SERIES s3 (296 sidebar, 76 top bar, 46 pill, 20 icon, 3 px outline, 2 px offset) are exempt (ruling T0D-MSERIES-2); LD-251 bars raw colour, radius, font only.
  // T0D-MSERIES-5 (LD-276): the board's 3D plate, chips, rings and their @keyframes are scene geometry (perspective, translateZ, bob distance): px is exempt on those lines only; colour and radius stay token-only.
  const pxCss = css.split('\n').filter((l) => !/lims-auth-(plate|well|chip|scene|mark|rings|tagline|slab)|^\s*@keyframes\b/.test(l)).join('\n');
  if (/(?<![\w.-])-?\d*\.?\d+px\b/.test(pxCss.replace(/(?<![\w.-])(?:296|76|46|20|3|2)px\b/g, ''))) bad.push('px value');
  if (/\b(rgb|rgba|hsl|hsla)\(/.test(css)) bad.push('rgb()/hsl() colour');
  if (/\burl\(/.test(css) || /@import\b/.test(css) || /https?:\/\//.test(css)) bad.push('url()/@import/remote URL');
  if (/(?<![\w-])-?\d*\.?\d+vw\b/.test(css)) bad.push('vw unit (horizontal scroll risk)');
  for (const m of css.matchAll(/@(?:media|container)\b([^{]*)\{/g)) for (const len of (m[1] ?? '').matchAll(/(-?\d*\.?\d+)([a-z%]+)/g)) if (len[2] !== 'rem') bad.push(`query unit ${len[0]} is not rem`);
  return bad;
};

interface Rule { ctx: string; sel: string; body: string }
function readBlock(s: string, from: number): { body: string; end: number } {
  let depth = 0, j = from;
  for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') { depth--; if (depth === 0) break; } }
  return { body: s.slice(from + 1, j), end: j + 1 };
}
function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  const s = stripComments(css);
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const prelude = s.slice(i, open).trim();
    const { body, end } = readBlock(s, open);
    if (/^@(media|container|supports)\b/.test(prelude)) {
      for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ ctx: prelude, sel: (m[1] ?? '').trim(), body: m[2] ?? '' });
    } else if (!prelude.startsWith('@')) out.push({ ctx: '', sel: prelude, body });
    i = end;
  }
  return out;
}
function keyframes(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const s = stripComments(css);
  for (const m of s.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) out.set(m[1] as string, readBlock(s, (m.index ?? 0) + m[0].length - 1).body);
  return out;
}
const sels = (r: Rule): string[] => r.sel.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
const decl = (body: string, prop: string): string | null => {
  let v: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))) v = (m[1] ?? '').trim();
  return v;
};
const MIN64 = /\(\s*min-width\s*:\s*64rem\s*\)/;
const MAX64 = /\(\s*max-width\s*:\s*(?:64rem|63\.\d+rem)\s*\)/;
const RM = /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/;
/** bodies of every rule (any context except reduced-motion, unless `rm`) one of whose selectors matches `re`. */
const bodyOf = (rules: Rule[], re: RegExp, rm = false): string => rules.filter((r) => (rm || !RM.test(r.ctx)) && sels(r).some((s) => re.test(s))).map((r) => r.body).join(';');
const hasRule = (rules: Rule[], re: RegExp): boolean => rules.some((r) => !RM.test(r.ctx) && sels(r).some((s) => re.test(s)));
const remOf = (v: string | null): number | null => { const m = (v ?? '').match(/^(\d*\.?\d+)rem$/); return m ? Number(m[1]) : null; };
const tokenNum = (v: string | null): number | null => { const m = (v ?? '').match(/^var\(--lims-space-(\d+)\)$/); return m ? Number(m[1]) : null; };
const limeAsText = (css: string): boolean => /(?:^|[;{\s])(?:-webkit-text-fill-color|color)\s*:\s*var\(--lims-accent-(?:brand|highlight)/.test(stripComments(css));
const weakText = (css: string): boolean => /(?:^|[;{\s])color\s*:\s*var\(--lims-neutral-300\)/.test(stripComments(css));

// ---------- time parsing (motion) ----------
const TIME_TOKENS: Record<string, number> = { '--lims-motion-duration-fast': 150, '--lims-motion-duration-normal': 250 };
function toMs(t: string): number | null {
  const s = t.trim();
  let m = s.match(/^var\((--[\w-]+)\)$/);
  if (m) return TIME_TOKENS[m[1] as string] ?? null;
  m = s.match(/^(\d*\.?\d+)(ms|s)$/);
  if (m) return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  m = s.match(/^calc\(\s*(\d+)\s*\*\s*(\d*\.?\d+(?:ms|s))\s*\)$/);
  if (m) { const u = toMs(m[2] as string); return u === null ? null : Number(m[1]) * u; }
  return null;
}
function topLevel(value: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && sep.test(ch)) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const isTimeTok = (t: string): boolean => /^(var\(--lims-motion-duration-[a-z]+\)|\d*\.?\d+(ms|s)|calc\(.*\))$/.test(t);
interface Timing { sel: string; prop: string; durations: (number | null)[]; delays: (number | null)[]; raw: string }
const MOTION_PROPS = ['animation', 'animation-duration', 'animation-delay', 'transition', 'transition-duration', 'transition-delay'];
function timings(css: string): Timing[] {
  const out: Timing[] = [];
  for (const r of parseRules(css)) {
    if (RM.test(r.ctx)) continue;
    for (const prop of MOTION_PROPS) {
      const v = decl(r.body, prop);
      if (v === null) continue;
      const durations: (number | null)[] = [], delays: (number | null)[] = [];
      if (prop.endsWith('duration')) topLevel(v, /,/).forEach((x) => durations.push(toMs(x)));
      else if (prop.endsWith('delay')) topLevel(v, /,/).forEach((x) => delays.push(toMs(x)));
      else for (const one of topLevel(v, /,/)) {
        const times = topLevel(one, /\s/).filter(isTimeTok);
        durations.push(times[0] === undefined ? null : toMs(times[0]));
        if (times[1] !== undefined) delays.push(toMs(times[1]));
      }
      out.push({ sel: r.sel, prop, durations, delays, raw: v });
    }
  }
  return out;
}
const EASING = /var\(--lims-motion-easing\)|cubic-bezier\(\s*0?\.2\s*,\s*0\s*,\s*0\s*,\s*1\s*\)/;
function motionProblems(css: string): string[] {
  const bad: string[] = [];
  const all = timings(css);
  if (!all.some((t) => t.prop === 'animation' || t.prop === 'animation-name')) bad.push('no animation at all (entrance motion missing)');
  for (const t of all) {
    for (const d of t.durations) {
      if (d === null) bad.push(`${t.sel}: unknown/unparseable ${t.prop} "${t.raw}" (use the duration tokens or ms)`);
      else if (d > 250) bad.push(`${t.sel}: ${t.prop} ${d}ms is above the 250ms cap`);
    }
    for (const d of t.delays) if (d === null || d > 480) bad.push(`${t.sel}: ${t.prop} "${t.raw}" is unparseable or above 480ms`);
    if ((t.prop === 'animation' || t.prop === 'transition') && !EASING.test(t.raw)) bad.push(`${t.sel}: ${t.prop} does not use var(--lims-motion-easing)`);
  }
  for (const r of parseRules(css)) {
    if (RM.test(r.ctx)) continue;
    const shorthand = decl(r.body, 'animation') ?? '';
    const count = decl(r.body, 'animation-iteration-count') ?? '';
    if (/\binfinite\b/.test(`${shorthand} ${count}`)) bad.push(`${r.sel}: infinite animation`);
    const n = count.match(/^\d+$/);
    if (n && Number(n[0]) > 1) bad.push(`${r.sel}: animation plays ${n[0]} times`);
  }
  if (/\binfinite\b/.test(stripComments(css))) bad.push('the word "infinite" appears in the css');
  return bad;
}
function reducedMotionProblems(css: string): string[] {
  const rm = parseRules(css).filter((r) => RM.test(r.ctx));
  const bad: string[] = [];
  const blocks = stripComments(css).match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/g) ?? [];
  if (blocks.length !== 1) bad.push(`expected exactly one @media (prefers-reduced-motion: reduce) rule, found ${blocks.length}`);
  const zero = (v: string | null): boolean => v !== null && /^0(s|ms)?(\s*!important)?$|^0\.0*1ms(\s*!important)?$/.test(v);
  const all = rm.filter((r) => ['animation-duration', 'animation-delay', 'transition-duration', 'transition-delay'].every((p) => zero(decl(r.body, p))));
  if (all.length === 0) bad.push('no rule inside the reduced-motion query zeroes animation-duration, animation-delay, transition-duration and transition-delay');
  else {
    const set = new Set(all.flatMap(sels));
    const star = ['*', '*::before', '*::after'].every((s) => set.has(s)) || ['.lims-auth-page *', '.lims-auth-page *::before', '.lims-auth-page *::after'].every((s) => set.has(s));
    if (!star) bad.push('the reduced-motion rule must select *, *::before, *::after (or .lims-auth-page * and its ::before/::after)');
  }
  return bad;
}
function entranceProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const frames = keyframes(css);
  const nameOf = (body: string): string | null => {
    const n = decl(body, 'animation-name');
    if (n) return n.split(',')[0]?.trim() ?? null;
    const sh = decl(body, 'animation');
    const kw = new Set(['ease', 'linear', 'both', 'forwards', 'backwards', 'none', 'normal', 'reverse', 'alternate', 'running', 'paused']);
    return topLevel(sh ?? '', /\s/).find((t) => /^[a-z][\w-]*$/.test(t) && !kw.has(t) && !/^ease-/.test(t)) ?? null;
  };
  const check = (label: string, re: RegExp, needTranslate: boolean, ms: [number, number]): void => {
    const body = bodyOf(rules, re);
    const name = nameOf(body);
    if (!name) { bad.push(`${label}: no animation`); return; }
    const kf = frames.get(name);
    if (kf === undefined) { bad.push(`${label}: @keyframes ${name} not defined`); return; }
    if (!/opacity/.test(kf)) bad.push(`${label}: keyframes ${name} has no opacity fade`);
    if (needTranslate && !/translate(Y)?\(\s*(0\s*,\s*)?0\.5rem\s*\)/.test(kf)) bad.push(`${label}: keyframes ${name} has no 0.5rem rise (translateY(0.5rem))`);
    const d = timings(css).filter((t) => t.prop === 'animation' && re.test(t.sel.split(',').map((x) => x.trim()).find((x) => re.test(x)) ?? '')).flatMap((t) => t.durations)[0] ?? null;
    if (d === null || d < ms[0] || d > ms[1]) bad.push(`${label}: duration ${d}ms not in ${ms[0]}..${ms[1]}ms`);
  };
  check('form block (.lims-auth-card)', /\.lims-auth-card$/, true, [150, 250]);
  check('panel body (.lims-auth-panel-body)', /\.lims-auth-panel-body$/, true, [150, 250]);
  check('stepper items (.lims-auth-steps li)', /^\.lims-auth-steps li$/, false, [150, 250]);
  check("error alert (.lims-auth-card [role='alert'])", /\[role=['"]?alert['"]?\]$/, false, [150, 150]);
  const stepBody = bodyOf(rules, /^\.lims-auth-steps li$/);
  if (!/\b(both|backwards)\b/.test(`${decl(stepBody, 'animation') ?? ''} ${decl(stepBody, 'animation-fill-mode') ?? ''}`)) bad.push('stepper items: animation-fill-mode both|backwards missing (items would flash before their delay)');
  const delays = new Map<number, number>();
  for (const t of timings(css)) {
    for (const s of t.sel.split(',')) {
      const m = s.trim().match(/^\.lims-auth-steps li:nth-child\((\d+)\)$/);
      if (m && (t.prop === 'animation-delay' || t.prop === 'animation') && t.delays[0] != null) delays.set(Number(m[1]), t.delays[0]);
    }
  }
  const ns = [...delays.keys()].sort((a, b) => a - b);
  if (ns.length < 6) bad.push(`stepper stagger: only ${ns.length} li:nth-child() delay rules (need one per step after the first)`);
  if (ns.some((n) => n > 8)) bad.push('stepper stagger: more than 8 items');
  for (let i = 1; i < ns.length; i++) {
    const step = (delays.get(ns[i] as number) ?? 0) - (delays.get(ns[i - 1] as number) ?? 0);
    if (step < 0 || step > 60) bad.push(`stepper stagger: step between item ${ns[i - 1]} and ${ns[i]} is ${step}ms (0..60ms)`);
  }
  return bad;
}

// ---------- svg / art source ----------
const SVG_BANNED = /<(text|tspan|textPath|title|desc|image|foreignObject|use|style|script|a|animate|animateTransform|animateMotion|set|img|link)\b/i;
function svgProblems(source: string): string[] {
  const bad: string[] = [];
  const code = stripJsComments(source);
  const tags = [...code.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
  if (tags.length === 0) bad.push('no <svg> element');
  for (const t of tags) {
    if (!/\baria-hidden(?:=(?:"true"|\{true\}))?(?=[\s/>])/.test(t)) bad.push(`svg without aria-hidden: ${t.slice(0, 60)}`);
    if (!/\bfocusable="false"/.test(t)) bad.push(`svg without focusable="false": ${t.slice(0, 60)}`);
    if (!/\bviewBox="/.test(t)) bad.push(`svg without viewBox: ${t.slice(0, 60)}`);
    if (/\brole=/.test(t)) bad.push('svg with a role (decoration must be aria-hidden, not role=img)');
  }
  const banned = code.match(SVG_BANNED);
  if (banned) bad.push(`banned svg/media element <${banned[1]}> (no text, no image, no external ref, no SMIL motion)`);
  if (/https?:\/\/|(?<![\w:])\/\/[a-z]/i.test(code)) bad.push('remote URL / xmlns (not needed in JSX; CSP)');
  if (/\b(href|xlinkHref|xlink:href|src|srcSet)=/.test(code) || /\burl\(/.test(code)) bad.push('href/src/url()');
  if (/\bstyle=\{|\bstyle="/.test(code)) bad.push('inline style');
  if (/#[0-9a-fA-F]{3,8}\b/.test(code)) bad.push('hex colour');
  if (/\b(rgb|rgba|hsl|hsla)\(/.test(code)) bad.push('rgb()/hsl() colour');
  for (const m of code.matchAll(/\b(fill|stroke|stopColor|floodColor)="([^"]*)"/g)) if (!/^(currentColor|none|var\(--lims-[a-z0-9-]+\))$/.test(m[2] ?? '')) bad.push(`${m[1]}="${m[2]}" is not currentColor/none/var(--lims-*)`);
  if (/\bdangerouslySetInnerHTML\b/.test(code)) bad.push('dangerouslySetInnerHTML');
  return bad;
}

// ---------- tsx structure ----------
interface Block { start: number; end: number; inner: string }
function blocks(source: string, tag: string, cls: string): Block[] {
  const code = stripJsComments(source);
  const open = new RegExp(`<${tag}\\b[^>]*?className="[^"]*(?<![\\w-])${cls}(?![\\w-])[^"]*"[^>]*>`, 'g');
  const out: Block[] = [];
  for (const m of code.matchAll(open)) {
    const from = (m.index ?? 0) + m[0].length;
    const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g');
    re.lastIndex = from;
    let depth = 1, t: RegExpExecArray | null;
    while ((t = re.exec(code))) {
      if (t[1]) depth--; else if (!t[2]) depth++;
      if (depth === 0) { out.push({ start: m.index ?? 0, end: t.index, inner: code.slice(from, t.index) }); break; }
    }
  }
  return out;
}
const STEPS = ['Draft', 'To collect', 'To receive', 'In progress', 'To authorise', 'Authorised', 'Released'];
function layoutProblems(layout: string): string[] {
  const bad: string[] = [];
  const code = stripJsComments(layout);
  if (!/import\s*\{[^}]*\bAuthArt\b[^}]*\bAuthMark\b[^}]*\}\s*from\s*['"][^'"]*AuthArt['"]|import\s*\{[^}]*\bAuthMark\b[^}]*\bAuthArt\b[^}]*\}\s*from\s*['"][^'"]*AuthArt['"]/.test(code)) bad.push('layout does not import { AuthArt, AuthMark } from the AuthArt module');
  const panel = blocks(layout, 'aside', 'lims-auth-panel')[0];
  const panelTag = code.match(/<aside\b[^>]*\blims-auth-panel\b(?![-\w])[^>]*>/);
  if (!panel || !panelTag) return [...bad, 'no <aside class="lims-auth-panel">'];
  if (!/\baria-hidden(?:=(?:"true"|\{true\}))?(?=[\s/>])/.test(panelTag[0])) bad.push('panel is not aria-hidden');
  const body = blocks(`<aside className="lims-auth-panel">${panel.inner}</aside>`, 'div', 'lims-auth-panel-body')[0];
  if (!body) bad.push('panel has no .lims-auth-panel-body');
  else {
    if (!/<AuthArt\b/.test(body.inner)) bad.push('panel-body does not render <AuthArt />');
    const texts = [...body.inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => (m[1] ?? '').replace(/<[^>]*>/g, '').trim());
    if (texts.join('|') !== STEPS.join('|')) bad.push(`stepper labels changed: ${texts.join(' | ')}`);
  }
  const bandTag = code.match(/<header\b[^>]*\blims-auth-band\b(?![-\w])[^>]*>/);
  if (!bandTag) return [...bad, 'no <header className="lims-auth-band"> (slim band shown below 64rem)'];
  if (!/\baria-hidden(?:=(?:"true"|\{true\}))?(?=[\s/>])/.test(bandTag[0])) bad.push('band is not aria-hidden (it repeats the wordmark; decoration)');
  if (/\bstyle=/.test(bandTag[0])) bad.push('band has inline style');
  const band = blocks(layout, 'header', 'lims-auth-band')[0];
  if (band) {
    if (!/<AuthMark\b/.test(band.inner)) bad.push('band has no <AuthMark />');
    if (!/<AuthArt\b/.test(band.inner)) bad.push('band has no small <AuthArt />');
    if (!/<p className="lims-wordmark">LIMS<\/p>/.test(band.inner)) bad.push('band wordmark is not exactly <p className="lims-wordmark">LIMS</p> (web-style-3 contract)');
    if (!blocks(`<header className="lims-auth-band">${band.inner}</header>`, 'div', 'lims-lockup')[0]) bad.push('band wordmark is not inside div.lims-lockup');
  }
  if (!code.includes('{children}')) bad.push('layout lost {children}');
  return bad;
}
function layoutAssetProblems(code: string): string[] {
  const bad: string[] = [];
  const c = stripJsComments(code);
  if (/<(img|image|picture|video|source|iframe|object|embed|link|script|svg)\b/i.test(c)) bad.push('img/media/svg/link/script element in the layout (art lives in AuthArt.tsx)');
  if (/next\/image/.test(c)) bad.push('next/image');
  if (/https?:\/\/|(?<![\w:])\/\/[a-z]/i.test(c)) bad.push('remote URL');
  if (/\bsrc=|\bsrcSet=|url\(|@font-face|fonts\.g/i.test(c)) bad.push('src/srcSet/url()/external font');
  if (/\bstyle=\{|\bstyle="/.test(c)) bad.push('inline style');
  return bad;
}
function iconWrapProblems(file: string, source: string, kind: string, inputRe: RegExp): string[] {
  const bad: string[] = [];
  const wraps = blocks(source, 'div', 'lims-input-wrap').filter((w) => inputRe.test(w.inner));
  const w = wraps[0];
  if (!w) return [`${file}: no div.lims-input-wrap around the ${kind} input`];
  const icon = w.inner.search(new RegExp(`<AuthIcon\\b[^>]*kind="${kind}"[^>]*className="lims-input-icon"|<AuthIcon\\b[^>]*className="lims-input-icon"[^>]*kind="${kind}"`));
  const input = w.inner.search(/<input\b/);
  if (icon < 0) bad.push(`${file}: no <AuthIcon kind="${kind}" className="lims-input-icon" /> in the wrapper`);
  else if (input >= 0 && icon > input) bad.push(`${file}: the icon must come before the <input>`);
  return bad;
}
function arrowProblems(file: string, source: string): string[] {
  const bad: string[] = [];
  const code = stripJsComments(source);
  const subs = [...code.matchAll(/<Button\b([^>]*)>([\s\S]*?)<\/Button>/g)].filter((m) => /type="submit"/.test(m[1] ?? '') && /variant="primary"/.test(m[1] ?? ''));
  if (subs.length === 0) bad.push(`${file}: no primary submit <Button> found`);
  for (const m of subs) {
    const inner = m[2] ?? '';
    const a = inner.search(/<AuthIcon\b[^>]*kind="arrow"[^>]*className="lims-btn-arrow"|<AuthIcon\b[^>]*className="lims-btn-arrow"[^>]*kind="arrow"/);
    if (a < 0) bad.push(`${file}: submit button has no trailing <AuthIcon kind="arrow" className="lims-btn-arrow" />`);
    else if (inner.slice(0, a).replace(/<[^>]*>/g, '').trim() === '') bad.push(`${file}: arrow is not trailing (it comes before the label)`);
  }
  return bad;
}

// ---------- copy guard ----------
function copyTokens(source: string): string[] {
  const code = stripJsComments(source);
  const out: string[] = [];
  for (const m of code.matchAll(/>([^<>{}]+)</g)) {
    const t = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]/.test(t) && !/[();=]/.test(t)) out.push(t);
  }
  for (const m of code.matchAll(/\b(title|label|alt|aria-label|placeholder)="([^"]+)"/g)) out.push(`${m[1]}=${m[2]}`);
  return out.sort();
}
const copyFiles = (): string[] => [...walk(join(src, 'app', '(auth)', 'auth')), ...walk(join(src, 'features', 'admin', 'auth'))].filter((f) => /\.tsx$/.test(f) && !/AuthArt\.tsx$/.test(f)).sort();

// ---------- css contract checks ----------
function artCssProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const art = bodyOf(rules, /^\.lims-art$|^\.lims-auth-panel \.lims-art$/);
  if (!art) bad.push('no .lims-art rule');
  else {
    if (!/^(currentColor|var\(--lims-accent-fg\))$/.test(decl(art, 'stroke') ?? '') && !/currentColor/.test(decl(art, 'color') ?? '')) bad.push('.lims-art strokes are not accent-fg/currentColor');
    if (remOf(decl(art, 'width')) === null && !/%$/.test(decl(art, 'width') ?? '') && !/^min\(/.test(decl(art, 'width') ?? '') && remOf(decl(art, 'max-width')) === null) bad.push('.lims-art has no rem/% width');
  }
  if (!/var\(--lims-accent-brand\)/.test(`${decl(bodyOf(rules, /^\.lims-art-accent$|\.lims-art \.lims-art-accent$/), 'stroke') ?? ''}${decl(bodyOf(rules, /^\.lims-art-accent$|\.lims-art \.lims-art-accent$/), 'fill') ?? ''}`)) bad.push('.lims-art-accent does not use var(--lims-accent-brand) as stroke/fill (the one lime highlight)');
  if (!bodyOf(rules, /^\.lims-mark$/)) bad.push('no .lims-mark rule');
  else if (remOf(decl(bodyOf(rules, /^\.lims-mark$/), 'width')) === null) bad.push('.lims-mark has no rem width');
  return bad;
}
function panelBrandProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const panel = rules.filter((r) => sels(r).some((s) => /^\.lims-auth-panel(::before|::after)?$/.test(s)) && !RM.test(r.ctx)).map((r) => r.body).join(';');
  const bg = `${decl(panel, 'background') ?? ''} ${decl(panel, 'background-image') ?? ''}`;
  if (!/linear-gradient\(/.test(bg)) bad.push('panel has no layered linear-gradient');
  if (!(/var\(--lims-accent\)/.test(bg) && /var\(--lims-accent-hover\)/.test(bg))) bad.push('panel gradient does not run from accent to accent-hover');
  if (!/color-mix\([^)]*var\(--lims-accent-brand\)[^)]*transparent/.test(panel)) bad.push('panel has no lime glow (color-mix of accent-brand over transparent)');
  if (!/radial-gradient\(/.test(panel)) bad.push('panel has no radial glow/dot grid (radial-gradient)');
  if (!/background-size\s*:/.test(panel)) bad.push('panel has no faint dot/hairline grid (background-size on the panel or its ::before/::after)');
  if (limeAsText(css)) bad.push('lime used as a text colour');
  const pseudoDisplay = rules.filter((r) => sels(r).some((s) => /^\.lims-auth-panel(::before|::after)$/.test(s)) && decl(r.body, 'display') !== null);
  if (pseudoDisplay.length) bad.push('.lims-auth-panel::before/::after declares display (breaks the web-style-2/3 visibility scanner; use position: absolute)');
  return bad;
}
function bandCssProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css).filter((r) => sels(r).includes('.lims-auth-band'));
  if (rules.length === 0) return ['no .lims-auth-band rule'];
  const base = rules.filter((r) => r.ctx === '').map((r) => decl(r.body, 'display')).filter(Boolean).pop() ?? null;
  const wideNone = rules.some((r) => MIN64.test(r.ctx) && decl(r.body, 'display') === 'none');
  if (base === null || base === 'none') bad.push('the band is not visible below 64rem (base display must be flex/grid/block)');
  if (!wideNone) bad.push('the band is not hidden at min-width 64rem');
  const body = rules.filter((r) => r.ctx === '').map((r) => r.body).join(';');
  if (!/var\(--lims-accent(-hover)?\)|linear-gradient/.test(`${decl(body, 'background') ?? ''}${decl(body, 'background-color') ?? ''}${decl(body, 'background-image') ?? ''}`)) bad.push('band is not green (accent token background)');
  if (/\b100[dsl]?vh\b/.test(body)) bad.push('band uses vh (web-style-3: one 100dvh on the page only)');
  const art = bodyOf(parseRules(css), /^\.lims-auth-band \.lims-art$/);
  if (remOf(decl(art, 'width')) === null && remOf(decl(art, 'height')) === null && remOf(decl(art, 'max-width')) === null) bad.push('the small art in the band has no rem size (.lims-auth-band .lims-art)');
  return bad;
}
function lockupProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const l = bodyOf(rules, /^\.lims-lockup$/);
  if (decl(l, 'display') !== 'flex' && decl(l, 'display') !== 'inline-flex') bad.push('.lims-lockup is not flex');
  if (decl(l, 'align-items') !== 'center') bad.push('.lims-lockup does not centre mark and text');
  if (tokenNum(decl(l, 'gap')) === null) bad.push('.lims-lockup gap is not a spacing token');
  if (!/currentColor|var\(--lims-accent(-fg)?\)/.test(`${decl(bodyOf(rules, /^\.lims-mark$/), 'color') ?? ''}${decl(bodyOf(rules, /^\.lims-mark$/), 'fill') ?? ''}${decl(bodyOf(rules, /^\.lims-mark$/), 'stroke') ?? ''}`)) bad.push('.lims-mark colour is not accent/currentColor');
  if (!/accent-fg|neutral-0/.test(bodyOf(rules, /^\.lims-auth-band \.lims-wordmark$/))) bad.push('wordmark on the green band is not light (.lims-auth-band .lims-wordmark colour accent-fg)');
  return bad;
}
function formColumnProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const h1 = decl(bodyOf(rules, /^\.lims-auth-card h1$/), 'font-size') ?? '';
  if (!/^var\(--lims-font-size-(2xl|3xl)-size\)$/.test(h1)) bad.push(`form heading is not 2xl/3xl (got ${h1 || 'none'})`);
  const sub = bodyOf(rules, /^\.lims-auth-card h1 \+ p$|^\.lims-auth-card > p$|^\.lims-auth-subtitle$/);
  if (!/var\(--lims-neutral-(500|700)\)/.test(decl(sub, 'color') ?? '')) bad.push('no muted subtitle rule (.lims-auth-card h1 + p | > p) with neutral-500/700 colour');
  if (tokenNum(decl(bodyOf(rules, /^\.lims-auth-card$/), 'gap')) === null) bad.push('.lims-auth-card gap is not a spacing token (vertical rhythm)');
  const wide = rules.filter((r) => MIN64.test(r.ctx) && sels(r).includes('.lims-auth-main .lims-auth-card')).map((r) => r.body).join(';');
  if (!/^(0|none)(\s|$)/.test(decl(wide, 'border') ?? '') && !/^0(\s|$)/.test(decl(wide, 'border-width') ?? '')) bad.push('wide form card keeps a box border (hairlines, not boxes)');
  if (/elevation-[23]/.test(wide)) bad.push('wide form card has a heavy shadow (hairlines, not boxes)');
  return bad;
}
function controlCssProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const input = rules.filter((r) => !RM.test(r.ctx) && sels(r).some((s) => /\.lims-auth-card(?: form)? \.lims-input$/.test(s))).map((r) => r.body).join(';');
  const h = decl(input, 'min-height') ?? decl(input, 'height');
  if (h !== 'var(--lims-touch-target-web)') bad.push(`input height is not var(--lims-touch-target-web) (got ${h ?? 'none'})`);
  if (decl(input, 'border-radius') !== 'var(--lims-radius-full)') bad.push('input radius is not var(--lims-radius-full)'); // T0D-MSERIES-2 (LD-251, 13 s2.3): single-line fields are fully round
  const tr = decl(input, 'transition') ?? '';
  if (!/var\(--lims-motion-duration-fast\)|150ms/.test(tr) || !/(border-color|box-shadow|outline)/.test(tr)) bad.push('input has no 150 ms transition on border-color/box-shadow');
  const hover = bodyOf(rules, /\.lims-auth-card(?: form)? \.lims-input:hover(:not\([^)]*\))?$|\.lims-input-wrap:hover \.lims-input$/);
  if (!/^var\(--lims-(neutral-(500|700)|accent)\)$/.test(decl(hover, 'border-color') ?? '')) bad.push('input hover does not darken the border (neutral-500/700 or accent)');
  const focus = bodyOf(rules, /\.lims-input:(focus|focus-visible)(:not\([^)]*\))?$|\.lims-input-wrap:focus-within \.lims-input$/);
  if (!/var\(--lims-(accent|focus-ring)\)/.test(`${decl(focus, 'border-color') ?? ''}${decl(focus, 'outline') ?? ''}${decl(focus, 'outline-color') ?? ''}${decl(focus, 'box-shadow') ?? ''}`)) bad.push('input focus has no accent/focus-ring border, outline or ring');
  if (/outline\s*:\s*(none|0)\b/.test(focus) && !/box-shadow\s*:/.test(focus)) bad.push('focus removes the outline without a replacement ring');
  const icon = bodyOf(rules, /^\.lims-input-icon$|^\.lims-input-wrap \.lims-input-icon$/);
  if (decl(icon, 'position') !== 'absolute') bad.push('.lims-input-icon is not position: absolute');
  if (decl(icon, 'inset-inline-start') === null) bad.push('.lims-input-icon has no inset-inline-start');
  if (decl(icon, 'pointer-events') !== 'none') bad.push('.lims-input-icon must be pointer-events: none (clicks reach the input)');
  if (remOf(decl(icon, 'width')) === null || remOf(decl(icon, 'height')) === null) bad.push('.lims-input-icon has no rem size');
  if (!/var\(--lims-neutral-(500|700)\)|currentColor/.test(decl(icon, 'color') ?? '')) bad.push('.lims-input-icon colour must be neutral-500/700 (not lime, not neutral-300)');
  const pad = decl(bodyOf(rules, /^\.lims-input-wrap \.lims-input$/), 'padding-inline-start');
  if ((tokenNum(pad) ?? 0) < 8 && (remOf(pad) ?? 0) < 2) bad.push('input inside .lims-input-wrap has no padding-inline-start >= space-8 (text would run under the icon)');
  // primary button
  const btn = rules.filter((r) => !RM.test(r.ctx) && sels(r).some((s) => /^\.lims-auth-card(?: form)? \.lims-btn-primary$/.test(s))).map((r) => r.body).join(';');
  if (decl(btn, 'width') !== '100%') bad.push('primary button is not full width');
  if (decl(btn, 'border-radius') !== 'var(--lims-radius-full)') bad.push('primary button is not a pill (radius-full)');
  if (decl(btn, 'min-height') !== 'var(--lims-touch-target-web)' && decl(btn, 'height') !== 'var(--lims-touch-target-web)') bad.push('primary button height is not the touch target token');
  if (!/var\(--lims-motion-duration-fast\)|150ms/.test(decl(btn, 'transition') ?? '')) bad.push('primary button has no 150 ms transition');
  if (!/scale\(\s*0?\.98\s*\)/.test(bodyOf(rules, /\.lims-btn-primary:active(:not\([^)]*\))?$/))) bad.push('primary button has no :active scale(.98)');
  const arrow = bodyOf(rules, /^\.lims-btn-arrow$|\.lims-auth-card \.lims-btn-arrow$/);
  if (remOf(decl(arrow, 'width')) === null || remOf(decl(arrow, 'height')) === null) bad.push('.lims-btn-arrow has no rem size');
  if (!/var\(--lims-motion-duration-fast\)|150ms/.test(decl(arrow, 'transition') ?? '')) bad.push('.lims-btn-arrow has no 150 ms transition (the nudge)');
  const nudge = bodyOf(rules, /\.lims-btn-primary:hover[^,]*\.lims-btn-arrow$|\.lims-btn:hover[^,]*\.lims-btn-arrow$/);
  if (!/translateX\(\s*(var\(--lims-space-[0-9_]+\)|-?\d*\.?\d+rem)\s*\)/.test(decl(nudge, 'transform') ?? '')) bad.push('no hover nudge: .lims-btn-primary:hover .lims-btn-arrow { transform: translateX(token|rem) }');
  const dis = bodyOf(rules, /\.lims-btn-primary(\[data-disabled\]|:disabled|\[aria-busy=['"]?true['"]?\])/);
  if (!/(opacity|cursor|filter|background)/.test(dis)) bad.push('no clear disabled/busy look for the primary button ([data-disabled] | :disabled | [aria-busy])');
  // code cells (kit OtpInput)
  const cell = rules.filter((r) => !RM.test(r.ctx) && sels(r).some((s) => /\.lims-otp-cell$/.test(s))).map((r) => r.body).join(';');
  if (!/^var\(--lims-font-size-(xl|2xl|3xl)-size\)$/.test(decl(cell, 'font-size') ?? '')) bad.push('.lims-otp-cell font-size is not xl/2xl/3xl (larger code)');
  if (decl(cell, 'text-align') !== 'center') bad.push('.lims-otp-cell is not centred');
  if (!/tabular-nums/.test(decl(cell, 'font-variant-numeric') ?? '')) bad.push('.lims-otp-cell has no tabular-nums');
  if (!/^\d*\.?\d+(em|rem)$/.test(decl(cell, 'letter-spacing') ?? '')) bad.push('.lims-otp-cell has no em/rem letter-spacing');
  if ((decl(cell, 'min-height') ?? decl(cell, 'height')) !== 'var(--lims-touch-target-web)') bad.push('.lims-otp-cell height is not the touch target token');
  // QR card
  const qr = bodyOf(rules, /^\.lims-qr-card$/);
  if (!qr) bad.push('no .lims-qr-card rule');
  else {
    if (!/^(flex|grid)$/.test(decl(qr, 'display') ?? '')) bad.push('.lims-qr-card is not flex/grid');
    if (tokenNum(decl(qr, 'gap')) === null || tokenNum(decl(qr, 'padding')?.split(/\s+/)[0] ?? null) === null) bad.push('.lims-qr-card gap/padding are not spacing tokens');
    if (!/^0?\.?\d*rem\s+solid\s+var\(--lims-neutral-\d+\)$/.test(decl(qr, 'border') ?? '')) bad.push('.lims-qr-card has no hairline token border (0.0625rem solid var(--lims-neutral-N))');
    if (!/^var\(--lims-radius-(md|lg|xl)\)$/.test(decl(qr, 'border-radius') ?? '')) bad.push('.lims-qr-card has no radius token');
    if (decl(qr, 'height') !== null || decl(qr, 'min-height') !== null) bad.push('.lims-qr-card has a fixed height (must collapse cleanly when no QR image is sent)');
  }
  const qrImg = bodyOf(rules, /^\.lims-qr-card (img|svg|\.lims-data-uri-image|\[class\*=['"]?lims-[a-z-]*image[a-z-]*['"]?\])$/);
  if (!/max-width\s*:\s*100%/.test(qrImg) && !/width\s*:\s*100%/.test(qrImg)) bad.push('the QR image inside .lims-qr-card is not capped to the card width (.lims-qr-card img { max-width: 100% })');
  const alert = bodyOf(rules, /\[role=['"]?alert['"]?\]$/);
  if (!/animation/.test(alert)) bad.push("the error alert has no fade-in (.lims-auth-card [role='alert'] animation)");
  return bad;
}

// ---------- real files ----------
const layoutPath = join(src, 'app', '(auth)', 'layout.tsx');
const layoutSrc = read(layoutPath);
const artPath = join(src, 'features', 'admin', 'auth', 'AuthArt.tsx');
const artSrc = existsSync(artPath) ? read(artPath) : '';
const authDir = join(src, 'features', 'admin', 'auth');
const authFile = (n: string): string => read(join(authDir, n));
const shellCssPath = join(src, 'core', 'shell', 'shell.css');
const extraCssFiles = walk(src).filter((f) => /^auth[\w.-]*\.css$/.test(f.split(sep).pop() ?? '') && f !== shellCssPath);
const shellCss = read(shellCssPath);
const allCss = [shellCss, ...extraCssFiles.map(read)].join('\n');
const baselineCss = read(join(src, '__tests__', 'fixtures', 'shell.baseline-style-4.css'));
const added = [addedCss(shellCss, baselineCss), ...extraCssFiles.map((f) => stripComments(read(f)))].join('\n');
const kitCss = read(join(repo, 'packages', 'ui', 'src', 'components', 'kit.css'));
const authFiles = [...walk(join(src, 'app', '(auth)')), ...walk(authDir)];
const copyBaseline = JSON.parse(read(join(src, '__tests__', 'fixtures', 'auth-copy.baseline-style-4.json'))) as Record<string, string[]>;
const SCREENS = ['login', 'mfa', 'mfa/enrol', 'forgot', 'set-password', 'confirm', 'session-expired', 'logout'];
const EXCEPTIONS: Record<string, string> = {
  'lims-btn-md': 'default size, covered by the base .lims-btn rule in kit.css (packages/ui is untouched; same exception as WEB-STYLE-1/2/3)',
};

// ---------- planted samples ----------
const GOOD_SVG = `export const A = () => <svg className="lims-art" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M0 0L5 5" fill="none" stroke="currentColor" strokeWidth="1" /><circle className="lims-art-accent" cx="5" cy="5" r="1" /></svg>;`;
const GOOD_MOTION = `@keyframes lims-rise { from { opacity: 0; transform: translateY(0.5rem); } to { opacity: 1; transform: none; } }
@keyframes lims-fade { from { opacity: 0; } to { opacity: 1; } }
.lims-auth-card { animation: lims-rise var(--lims-motion-duration-normal) var(--lims-motion-easing) both; }
.lims-auth-panel-body { animation: lims-rise var(--lims-motion-duration-normal) var(--lims-motion-easing) both; }
.lims-auth-steps li { animation: lims-rise var(--lims-motion-duration-normal) var(--lims-motion-easing) both; }
.lims-auth-steps li:nth-child(2) { animation-delay: 60ms; }
.lims-auth-steps li:nth-child(3) { animation-delay: 120ms; }
.lims-auth-steps li:nth-child(4) { animation-delay: 180ms; }
.lims-auth-steps li:nth-child(5) { animation-delay: 240ms; }
.lims-auth-steps li:nth-child(6) { animation-delay: 300ms; }
.lims-auth-steps li:nth-child(7) { animation-delay: 360ms; }
.lims-auth-card [role='alert'] { animation: lims-fade var(--lims-motion-duration-fast) var(--lims-motion-easing); }
.lims-auth-card .lims-input { transition: border-color var(--lims-motion-duration-fast) var(--lims-motion-easing); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0s; animation-delay: 0s; transition-duration: 0s; transition-delay: 0s; } }`;
const GOOD_LAYOUT = `import { AuthArt, AuthMark } from '@/features/admin/auth/AuthArt';
export default function L({ children }) { return (<div className="lims-auth-page"><header className="lims-auth-band" aria-hidden="true"><div className="lims-lockup"><AuthMark /><p className="lims-wordmark">LIMS</p></div><AuthArt /></header><div className="lims-auth-main">{children}</div><aside className="lims-auth-panel" aria-hidden="true"><div className="lims-auth-panel-body"><p className="lims-auth-panel-title">From sample to report</p><AuthArt /><ol className="lims-auth-steps">${STEPS.map((s) => `<li>${s}</li>`).join('')}</ol></div></aside></div>); }`;
const GOOD_BAND = `.lims-auth-band { display: flex; background: var(--lims-accent); }\n.lims-auth-band .lims-art { width: 5rem; }\n@media (min-width: 64rem) { .lims-auth-band { display: none; } }`;

describe('WEB-STYLE-4 (a) inline SVG art, mark and icons (AuthArt.tsx)', () => {
  // T0D-MSERIES-5 (LD-276): the AuthArt line art and the placeholder AuthMark are removed (board M1-entry.png); AuthIcon (form icons) stays.
  it('AuthArt.tsx still exports AuthIcon; AuthArt and AuthMark are no longer used by the layout or any form', () => {
    expect(existsSync(artPath), 'features/admin/auth/AuthArt.tsx').toBe(true);
    expect(artSrc).toMatch(/export (function|const) AuthIcon\b/);
    for (const k of ['mail', 'lock', 'shield', 'arrow']) expect(artSrc, `icon kind ${k}`).toContain(`'${k}'`);
    const users = [layoutPath, ...authFiles.filter((f) => /\.tsx$/.test(f) && f !== artPath)].filter((f) => /<AuthArt\b|<AuthMark\b/.test(stripJsComments(read(f)))).map(rel);
    expect(users).toEqual([]);
  });
  it('every svg is aria-hidden + focusable=false + viewBox; no text/title/image/use/style/SMIL, no URL, no hex, no inline style, colours from currentColor|none|var(--lims-*)', () => {
    expect(svgProblems(artSrc)).toEqual([]);
  });
  // T0D-MSERIES-5 SUPERSEDED (real files only): "exactly one lime highlight / lims-art / lims-mark placeholder" and the art css rules described the removed line art.
  it('the line-art classes are gone from the auth sources', () => {
    expect(authFiles.filter((f) => /\.tsx$/.test(f) && /\blims-(art|art-accent|mark|lockup|wordmark)\b/.test(stripJsComments(read(f)))).map(rel)).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(svgProblems(GOOD_SVG)).toEqual([]);
    expect(svgProblems(GOOD_SVG.replace(' aria-hidden="true"', '')).some((p) => p.startsWith('svg without aria-hidden'))).toBe(true);
    expect(svgProblems(GOOD_SVG.replace(' focusable="false"', '')).some((p) => p.startsWith('svg without focusable'))).toBe(true);
    expect(svgProblems(GOOD_SVG.replace('<path', '<text>x</text><path')).some((p) => p.startsWith('banned svg'))).toBe(true);
    expect(svgProblems(GOOD_SVG.replace('<path', '<animate /><path')).some((p) => p.startsWith('banned svg'))).toBe(true);
    expect(svgProblems(GOOD_SVG.replace('stroke="currentColor"', 'stroke="#9DBE2E"'))).toContain('hex colour');
    expect(svgProblems(GOOD_SVG.replace('stroke="currentColor"', 'stroke="red"')).some((p) => p.includes('is not currentColor'))).toBe(true);
    expect(svgProblems(GOOD_SVG.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))).toContain('remote URL / xmlns (not needed in JSX; CSP)');
    expect(svgProblems(GOOD_SVG.replace('<path', '<image href="x.png" /><path'))).toContain('href/src/url()');
    expect(svgProblems(GOOD_SVG.replace('<svg ', '<svg style={{ width: 1 }} '))).toContain('inline style');
    expect(artCssProblems('.lims-art { stroke: currentColor; width: 20rem; }\n.lims-art-accent { stroke: var(--lims-accent-brand); }\n.lims-mark { width: 2rem; }')).toEqual([]);
    expect(artCssProblems('.lims-art { stroke: currentColor; width: 20rem; }\n.lims-art-accent { stroke: currentColor; }\n.lims-mark { width: 2rem; }')).toContain('.lims-art-accent does not use var(--lims-accent-brand) as stroke/fill (the one lime highlight)');
  });
});

describe('WEB-STYLE-4 (b) layout: brand panel with art, slim band below 64rem, nothing remote', () => {
  it('all eight auth screens still sit under the one (auth)/layout.tsx', () => {
    for (const s of SCREENS) expect(existsSync(join(src, 'app', '(auth)', 'auth', ...s.split('/'), 'page.tsx')), `/auth/${s}`).toBe(true);
  });
  // T0D-MSERIES-5 SUPERSEDED (real files only): panel with <AuthArt /> + seven words and the slim band were replaced by the board hero (m5.entry.test.tsx).
  it('layout: keeps {children} and the Metro Labs logo <img>; no remote URL, no inline style (CSP img-src self data:); every other image is decoration', () => {
    const code = stripJsComments(layoutSrc);
    expect(code).toContain('{children}');
    expect(/<img\b[^>]*alt=["']Metro Labs["']/.test(code), 'Metro Labs logo <img> in the auth layout').toBe(true);
    expect(layoutAssetProblems(code).filter((p) => p === 'remote URL' || p === 'inline style')).toEqual([]);
    for (const m of code.matchAll(/<img\b[^>]*>/g)) expect(/alt=["']Metro Labs["']|alt=""|alt=\{""\}/.test(m[0]), m[0]).toBe(true);
  });
  it('no remote URL, @import, url() or external font anywhere in the auth css or auth sources', () => {
    expect(/https?:\/\/|@import|@font-face|\burl\(/.test(stripComments(allCss))).toBe(false);
    for (const f of authFiles.filter((x) => /\.tsx$/.test(x))) {
      const c = stripJsComments(read(f));
      expect(/https?:\/\//.test(c), `${rel(f)} remote URL`).toBe(false);
      expect(/<img\b|next\/image|dangerouslySetInnerHTML/.test(c.replace(/<img\b[^>]*alt=["'](Metro Labs)?["'][^>]*\/?>/g, '')), `${rel(f)} img (other than the Metro Labs logo) / next/image / dangerouslySetInnerHTML`).toBe(false);
    }
  });
  // T0D-MSERIES-5 SUPERSEDED (real css only): slim band, forest gradient + glow + dot grid, and the stepper last-step rule are gone with the old panel.
  it('lime is never a text colour in the auth css', () => {
    expect(limeAsText(allCss)).toBe(false);
  });
  it('planted failures fire', () => {
    expect(layoutProblems(GOOD_LAYOUT)).toEqual([]);
    expect(layoutProblems(GOOD_LAYOUT.replace('<header className="lims-auth-band" aria-hidden="true">', '<header className="lims-auth-band">'))).toContain('band is not aria-hidden (it repeats the wordmark; decoration)');
    expect(layoutProblems(GOOD_LAYOUT.replace('<AuthArt /><ol', '<ol'))).toContain('panel-body does not render <AuthArt />');
    expect(layoutProblems(GOOD_LAYOUT.replace('<li>Draft</li>', '<li>Begin</li>')).some((p) => p.startsWith('stepper labels changed'))).toBe(true);
    expect(layoutProblems(GOOD_LAYOUT.replace('<header className="lims-auth-band" aria-hidden="true">', '<div aria-hidden="true">').replace('</header>', '</div>'))).toContain('no <header className="lims-auth-band"> (slim band shown below 64rem)');
    expect(layoutProblems(GOOD_LAYOUT.replace('<p className="lims-wordmark">LIMS</p>', '<span>LIMS</span>'))).toContain('band wordmark is not exactly <p className="lims-wordmark">LIMS</p> (web-style-3 contract)');
    expect(layoutAssetProblems(`${GOOD_LAYOUT}<svg />`)).toContain('img/media/svg/link/script element in the layout (art lives in AuthArt.tsx)');
    expect(layoutAssetProblems(`${GOOD_LAYOUT}<img src="/a.png" />`).length).toBeGreaterThan(0);
    expect(layoutAssetProblems(`${GOOD_LAYOUT}<a href="https://x.test" />`)).toContain('remote URL');
    expect(bandCssProblems(GOOD_BAND)).toEqual([]);
    expect(bandCssProblems(GOOD_BAND.replace('display: flex;', 'display: none;'))).toContain('the band is not visible below 64rem (base display must be flex/grid/block)');
    expect(bandCssProblems(GOOD_BAND.replace('display: none; }', 'display: flex; }'))).toContain('the band is not hidden at min-width 64rem');
    expect(bandCssProblems(GOOD_BAND.replace('width: 5rem', 'width: 80px'))).toContain('the small art in the band has no rem size (.lims-auth-band .lims-art)');
    const goodPanel = `.lims-auth-panel { background: radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--lims-accent-brand) 18%, transparent), transparent 60%), linear-gradient(160deg, var(--lims-accent), var(--lims-accent-hover)); }\n.lims-auth-panel::before { content: ''; position: absolute; background-image: radial-gradient(var(--lims-accent-fg) 0.0625rem, transparent 0.0625rem); background-size: 1.5rem 1.5rem; }`;
    expect(panelBrandProblems(goodPanel)).toEqual([]);
    expect(panelBrandProblems(goodPanel.replace('var(--lims-accent-hover)', 'var(--lims-accent)'))).toContain('panel gradient does not run from accent to accent-hover');
    expect(panelBrandProblems(goodPanel.replace('transparent), transparent 60%)', 'red), transparent 60%)'))).toContain('panel has no lime glow (color-mix of accent-brand over transparent)');
    expect(panelBrandProblems(goodPanel.replace('background-size: 1.5rem 1.5rem;', 'display: block;'))).toContain('.lims-auth-panel::before/::after declares display (breaks the web-style-2/3 visibility scanner; use position: absolute)');
    expect(panelBrandProblems(`${goodPanel}\n.lims-x { color: var(--lims-accent-brand); }`)).toContain('lime used as a text colour');
  });
});

describe('WEB-STYLE-4 (c) wordmark lockup (placeholder mark + text) and form column', () => {
  it('LoginForm: UPDATED by T0D-MSERIES-2 (LD-251): the placeholder mark + LIMS wordmark are gone from the card (the real Metro Labs logo sits in the auth layout)', () => {
    const f = authFile('LoginForm.tsx');
    expect(f).not.toMatch(/<AuthMark\b/);
    expect(f).not.toMatch(/className="lims-wordmark"/);
  });
  // T0D-MSERIES-5 SUPERSEDED (real css only): lockup css is gone; the form column follows the board (card removed, 16 px fields): m5.entry.test.tsx 'css contract'.
  it('form column css: muted subtitle (neutral-500/700) under the heading', () => {
    expect(formColumnProblems(allCss).filter((p) => /muted subtitle/.test(p))).toEqual([]);
  });
  it('planted failures fire', () => {
    const good = `.lims-lockup { display: flex; align-items: center; gap: var(--lims-space-2); }\n.lims-mark { width: 2rem; color: var(--lims-accent); }\n.lims-auth-band .lims-wordmark { color: var(--lims-accent-fg); }`;
    expect(lockupProblems(good)).toEqual([]);
    expect(lockupProblems(good.replace('align-items: center', 'align-items: flex-start'))).toContain('.lims-lockup does not centre mark and text');
    expect(lockupProblems(good.replace('var(--lims-accent-fg)', 'var(--lims-accent)'))).toContain('wordmark on the green band is not light (.lims-auth-band .lims-wordmark colour accent-fg)');
    const col = `.lims-auth-card { gap: var(--lims-space-4); }\n.lims-auth-card h1 { font-size: var(--lims-font-size-2xl-size); }\n.lims-auth-card h1 + p { color: var(--lims-neutral-500); }\n@media (min-width: 64rem) { .lims-auth-main .lims-auth-card { border: 0; } }`;
    expect(formColumnProblems(col)).toEqual([]);
    expect(formColumnProblems(col.replace('2xl', 'md')).some((p) => p.startsWith('form heading is not 2xl/3xl'))).toBe(true);
    expect(formColumnProblems(col.replace('neutral-500', 'neutral-300'))).toContain('no muted subtitle rule (.lims-auth-card h1 + p | > p) with neutral-500/700 colour');
    expect(formColumnProblems(col.replace('border: 0', 'border: 0.0625rem solid var(--lims-neutral-200)'))).toContain('wide form card keeps a box border (hairlines, not boxes)');
  });
});

describe('WEB-STYLE-4 (d) controls: icons, 44px inputs, pill button with arrow, code cells, error fade', () => {
  it('login email, forgot email and the password field sit in div.lims-input-wrap; a leading AuthIcon is optional (the M1 board fields carry none), but if present it comes before the input', () => {
    const optionalIcon = (p: string) => !/no <AuthIcon/.test(p);
    expect([
      ...iconWrapProblems('LoginForm', authFile('LoginForm.tsx'), 'mail', /name="email"/),
      ...iconWrapProblems('ForgotPasswordForm', authFile('ForgotPasswordForm.tsx'), 'mail', /name="email"/),
      ...iconWrapProblems('PasswordField', authFile('PasswordField.tsx'), 'lock', /<input\b/),
    ].filter(optionalIcon)).toEqual([]);
  });
  it('the Show/Hide control stays inside the field wrapper, after the input, with its state and text (web-style-3 contract repeated)', () => {
    const w = blocks(authFile('PasswordField.tsx'), 'div', 'lims-input-wrap')[0]?.inner ?? '';
    const btn = w.match(/<button\b[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(w.search(/<input\b/)).toBeGreaterThanOrEqual(0);
    expect(w.indexOf(btn)).toBeGreaterThan(w.search(/<input\b/));
    expect(btn).toMatch(/type="button"/);
    expect(btn).toMatch(/aria-pressed=\{shown\}/);
    expect(btn).toMatch(/'Hide'/);
    expect(btn).toMatch(/'Show'/);
  });
  it('primary submit buttons: the trailing arrow is optional (the board "Continue" has none); if present it is trailing', () => {
    expect(['LoginForm.tsx', 'ForgotPasswordForm.tsx', 'SetPasswordForm.tsx', 'MfaChallengeForm.tsx', 'MfaEnrolment.tsx'].flatMap((f) => arrowProblems(f, authFile(f))).filter((p) => !/has no trailing/.test(p))).toEqual([]);
  });
  it('pending state is the existing one: submit buttons keep isLoading={pending} (kit Button gives spinner + aria-busy); no new pending logic', () => {
    for (const f of ['LoginForm.tsx', 'ForgotPasswordForm.tsx', 'SetPasswordForm.tsx', 'MfaChallengeForm.tsx', 'MfaEnrolment.tsx']) expect(stripJsComments(authFile(f)), f).toMatch(/<Button type="submit" variant="primary" isLoading=\{pending\}>/);
  });
  it('MFA screens: the code field is still the kit OtpInput (same props, no local code input) and the kit still sets numeric + one-time-code; a shield icon marks the screen', () => {
    for (const f of ['MfaChallengeForm.tsx', 'MfaEnrolment.tsx']) {
      const c = stripJsComments(authFile(f));
      expect(c, f).toMatch(/<OtpInput label="Authentication code" length=\{6\} value=\{code\} onChange=\{setCode\}/);
      expect(/<input\b/.test(c), `${f} has a local <input>`).toBe(f === 'MfaEnrolment.tsx'); // only the device-name input
      expect(c, f).toMatch(/<AuthIcon\b[^>]*kind="shield"/);
    }
    const otp = read(join(repo, 'packages', 'ui', 'src', 'components', 'OtpInput', 'OtpInput.tsx'));
    expect(otp).toMatch(/inputMode="numeric"/);
    expect(otp).toMatch(/autoComplete=\{i === 0 \? 'one-time-code' : 'off'\}/);
    expect(authFiles.filter((f) => /\.tsx$/.test(f) && /autoComplete="one-time-code"/.test(read(f))).map(rel)).toEqual([]);
  });
  it('MfaEnrolment: ONE div.lims-qr-card holds the conditional QR (DataUriImage, alt unchanged) then the "Can\'t scan? Enter this key" block', () => {
    const src2 = authFile('MfaEnrolment.tsx');
    const cards = blocks(src2, 'div', 'lims-qr-card');
    expect(cards.length).toBe(1);
    const inner = cards[0]?.inner ?? '';
    expect(inner).toMatch(/enrol\.qr_svg_base64 \?/);
    expect(inner).toMatch(/<DataUriImage\b[^>]*alt="QR code for your authenticator app"/);
    expect(inner).toContain(`label="Can't scan? Enter this key"`);
    expect(inner.search(/<DataUriImage\b/)).toBeLessThan(inner.search(/<SecretRevealOnce\b/));
  });
  // T0D-MSERIES-5 SUPERSEDED (real css only): 44px / radius-md inputs and the arrow-nudge button became the board's 16 px (radius-lg) fields, 3 px focus ring and
  // full-round Continue pill (m5.entry.test.tsx 'css contract'). The remaining pieces of the old rule set that still hold are checked here.
  it('controls css: disabled look, code cells and QR card keep their rules', () => {
    const keep = (p: string) => /disabled|otp|code cell|qr/i.test(p);
    expect(controlCssProblems(allCss).filter(keep)).toEqual([]);
  });
  it('planted failures fire', () => {
    const btnSrc = (inner: string): string => `<Button type="submit" variant="primary" isLoading={pending}>${inner}</Button>`;
    expect(arrowProblems('f', btnSrc('Log in <AuthIcon kind="arrow" className="lims-btn-arrow" />'))).toEqual([]);
    expect(arrowProblems('f', btnSrc('Log in'))).toContain('f: submit button has no trailing <AuthIcon kind="arrow" className="lims-btn-arrow" />');
    expect(arrowProblems('f', btnSrc('<AuthIcon kind="arrow" className="lims-btn-arrow" /> Log in'))).toContain('f: arrow is not trailing (it comes before the label)');
    const wrap = (inner: string): string => `<div className="lims-input-wrap">${inner}</div>`;
    expect(iconWrapProblems('f', wrap('<AuthIcon kind="mail" className="lims-input-icon" /><input name="email" />'), 'mail', /name="email"/)).toEqual([]);
    expect(iconWrapProblems('f', wrap('<input name="email" /><AuthIcon kind="mail" className="lims-input-icon" />'), 'mail', /name="email"/)).toContain('f: the icon must come before the <input>');
    expect(iconWrapProblems('f', wrap('<input name="email" />'), 'mail', /name="email"/)).toContain('f: no <AuthIcon kind="mail" className="lims-input-icon" /> in the wrapper');
    expect(iconWrapProblems('f', '<input name="email" />', 'mail', /name="email"/)).toContain('f: no div.lims-input-wrap around the mail input');
  });
});

describe('WEB-STYLE-4 (e) motion: spec-bound (150/250 ms cap, once, reduced-motion)', () => {
  // T0D-MSERIES-5 SUPERSEDED (real css only): the board's hero loops forever (plate sway, well wave, chip bob, pulse ring) and the stepper entrance is gone;
  // the hero's reduced-motion rules are asserted in m5.entry.test.tsx. What stays here: nothing but the hero loops, none above 250 ms outside the hero, transitions short.
  it('no transition above 250 ms; no infinite animation outside the hero (plate, wells, chips, mark ring)', () => {
    const rules = parseRules(allCss);
    const loops = rules.filter((r) => /infinite/.test(r.body) && !/lims-auth-(plate|well|chip|mark)/.test(r.sel)).map((r) => r.sel);
    expect(loops).toEqual([]);
    expect(motionProblems(allCss).filter((p) => /transition/.test(p) && /cap|unknown/.test(p))).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(motionProblems(GOOD_MOTION)).toEqual([]);
    expect(entranceProblems(GOOD_MOTION)).toEqual([]);
    expect(reducedMotionProblems(GOOD_MOTION)).toEqual([]);
    expect(motionProblems(`${GOOD_MOTION}\n.lims-x { animation: lims-fade 300ms var(--lims-motion-easing); }`).some((p) => p.includes('300ms is above the 250ms cap'))).toBe(true);
    expect(motionProblems(`${GOOD_MOTION}\n.lims-x { transition: opacity 0.4s var(--lims-motion-easing); }`).some((p) => p.includes('400ms is above the 250ms cap'))).toBe(true);
    expect(motionProblems(`${GOOD_MOTION}\n.lims-x { animation: lims-fade 150ms var(--lims-motion-easing) infinite; }`).some((p) => p.includes('infinite animation'))).toBe(true);
    expect(motionProblems(`${GOOD_MOTION}\n.lims-x { animation-iteration-count: 3; }`).some((p) => p.includes('plays 3 times'))).toBe(true);
    expect(motionProblems(`${GOOD_MOTION}\n.lims-x { transition: opacity 150ms ease-in; }`).some((p) => p.includes('does not use var(--lims-motion-easing)'))).toBe(true);
    expect(motionProblems(`${GOOD_MOTION}\n.lims-x { transition: opacity var(--lims-mystery) var(--lims-motion-easing); }`).some((p) => p.includes('unknown/unparseable transition'))).toBe(true);
    expect(motionProblems('.lims-x { color: var(--lims-accent); }')).toContain('no animation at all (entrance motion missing)');
    expect(reducedMotionProblems(GOOD_MOTION.replace(/@media \(prefers-reduced-motion: reduce\)[^\n]*/, ''))[0]).toMatch(/exactly one/);
    expect(reducedMotionProblems(GOOD_MOTION.replace('animation-delay: 0s; ', ''))).toContain('no rule inside the reduced-motion query zeroes animation-duration, animation-delay, transition-duration and transition-delay');
    expect(reducedMotionProblems(GOOD_MOTION.replace('*, *::before, *::after {', '.lims-auth-card {'))).toContain('the reduced-motion rule must select *, *::before, *::after (or .lims-auth-page * and its ::before/::after)');
    expect(reducedMotionProblems(`${GOOD_MOTION}\n@media (prefers-reduced-motion: reduce) { .a { animation: none; } }`)[0]).toMatch(/exactly one/);
    expect(entranceProblems(GOOD_MOTION.replace('translateY(0.5rem)', 'translateY(2rem)')).some((p) => p.includes('no 0.5rem rise'))).toBe(true);
    expect(entranceProblems(GOOD_MOTION.replace('animation-delay: 360ms', 'animation-delay: 600ms')).some((p) => p.startsWith('stepper stagger: step between'))).toBe(true);
    expect(entranceProblems(GOOD_MOTION.replace(/\.lims-auth-steps li:nth-child\(\d\) \{[^}]*\}\n/g, '')).some((p) => p.startsWith('stepper stagger: only'))).toBe(true);
    expect(entranceProblems(GOOD_MOTION.replace('var(--lims-motion-duration-fast) var(--lims-motion-easing); }\n.lims-auth-card .lims-input', 'var(--lims-motion-duration-normal) var(--lims-motion-easing); }\n.lims-auth-card .lims-input')).some((p) => p.includes('error alert') && p.includes('not in 150..150ms'))).toBe(true);
    expect(entranceProblems(GOOD_MOTION.replace('lims-rise var(--lims-motion-duration-normal) var(--lims-motion-easing) both; }\n.lims-auth-panel-body', 'none; }\n.lims-auth-panel-body')).some((p) => p.startsWith('form block'))).toBe(true);
  });
});

describe('WEB-STYLE-4 (f) hygiene: LD-140, contrast, class coverage, no copy/behaviour change', () => {
  it('shell.css gained the new rules (not vacuous)', () => {
    for (const c of ['.lims-qr-card', '.lims-otp-cell']) expect(added, c).toContain(c);
  });
  it('new/changed css lines: no hex, px, rgb()/hsl(), url(), @import, remote URL, vw; query lengths in rem; tokens used', () => {
    expect(cssViolations(added)).toEqual([]);
    expect(added).toMatch(/var\(--lims-/);
  });
  it('AA: lime and neutral-300 are never a text colour; placeholder text is not neutral-300', () => {
    expect(limeAsText(allCss)).toBe(false);
    expect(weakText(added)).toBe(false);
  });
  it('every lims-* class in the auth sources has a selector in kit.css or the auth css (exception list <= 3, reasoned)', () => {
    const used = classLiterals(authFiles);
    for (const c of ['lims-qr-card']) expect(used.has(c), c).toBe(true);
    const keys = Object.keys(EXCEPTIONS);
    expect(keys.length).toBeLessThanOrEqual(3);
    for (const k of keys) expect((EXCEPTIONS[k] ?? '').length).toBeGreaterThan(10);
    expect(uncovered(used, `${kitCss}\n${allCss}`, EXCEPTIONS)).toEqual([]);
  });
  it('no inline style attribute in any auth page, form, layout or art (LD-140)', () => {
    expect(authFiles.filter((f) => /\.tsx$/.test(f) && /\bstyle=\{|\bstyle="/.test(stripJsComments(read(f)))).map(rel)).toEqual([]);
  });
  it('any extra auth css file is imported by a source file under src', () => {
    for (const f of extraCssFiles) {
      const name = f.split(sep).pop() as string;
      const importers = walk(src).filter((p) => /\.tsx?$/.test(p) && new RegExp(`import\\s+['"][^'"]*${name.replace('.', '\\.')}['"]`).test(read(p)));
      expect(importers.length, `${name} is not imported`).toBeGreaterThan(0);
    }
  });
  it('no copy, field, label or button text changed: JSX text and title/label/alt props equal the baseline for every auth page and form; the layout only adds', () => {
    // T0D-MSERIES-5 (LD-276): the ONLY copy changes are the sign-in screen's (board M1-entry.png): "Email" -> "Work email", "Log in" (heading and button) -> "Welcome back" / "Continue",
    // plus the new pill and sentence. Every other file equals the baseline; new hero files may exist (their text is asserted by m5.entry.test.tsx).
    const LOGIN = 'features/admin/auth/LoginForm.tsx';
    const removed = new Set(['Email', 'Log in']);
    const added2 = new Set(['Work email', 'Staff sign-in', 'Welcome back', 'Sign in with your work email. A one-time code confirms it is you.', 'Continue']);
    for (const f of copyFiles()) {
      const now = copyTokens(read(f));
      if (rel(f) === LOGIN) {
        const base = new Set((copyBaseline[LOGIN] ?? []).filter((t) => !removed.has(t)));
        expect([...new Set(now)].sort(), LOGIN).toEqual([...new Set([...base, ...added2])].sort());
      } else if (rel(f) in copyBaseline) expect(now, rel(f)).toEqual(copyBaseline[rel(f)]);
    }
    for (const k of Object.keys(copyBaseline).filter((x) => x !== 'app/(auth)/layout.tsx')) expect(copyFiles().map(rel), `${k} was deleted`).toContain(k);
    // the layout: the stepper words are gone (the baseline listed them); nothing of the old panel copy survives
    const nowLayout = copyTokens(layoutSrc);
    for (const t of copyBaseline['app/(auth)/layout.tsx'] ?? []) expect(nowLayout, `layout still has the old panel text "${t}"`).not.toContain(t);
  });
  it('planted failures fire', () => {
    expect(cssViolations('.a { width: 100vw; }')).toContain('vw unit (horizontal scroll risk)');
    expect(cssViolations('.a { background: url(x.png); }')).toContain('url()/@import/remote URL');
    expect(weakText('.a { color: var(--lims-neutral-300); }')).toBe(true);
    expect(weakText('.a { border-color: var(--lims-neutral-300); }')).toBe(false);
    expect(copyTokens('<p>Hello there</p><Button label="Go" />')).toEqual(['Hello there', 'label=Go']);
    expect(copyTokens('<p>Hello there!</p>')).not.toEqual(copyTokens('<p>Hello there</p>'));
    expect(copyTokens('<svg aria-hidden="true"><path d="M0 0" /></svg>')).toEqual([]);
    const planted = new Map([['lims-art-ghost', 'x.tsx']]);
    expect(uncovered(planted, '/* .lims-art-ghost */ .a { x: 1 }', {})).toEqual(['lims-art-ghost']);
    expect(uncovered(planted, '.lims-art .lims-art-ghost { x: 1 }', {})).toEqual([]);
  });
});
