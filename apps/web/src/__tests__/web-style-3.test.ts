// WEB-STYLE-3 static guard (LD-205, 2026-11-15; LD-140 no hex/px/inline style; WCAG: required not by colour only). No build, no network.
// Run: .orchestra/notes/WEB-STYLE-3-verify.cmd. Layout idea only (Watermelon auth-05); nothing is copied.
// Class contract the implementation must use (names fixed here so layout.tsx, shell.css, the forms and this test agree):
//   lims-auth-panel-body = wrapper inside the panel holding the heading (lims-auth-panel-title) and the stepper (ol.lims-auth-steps)
//   lims-label-row       = flex row holding the <label> and <RequiredNote /> side by side (Required text on the label line)
//   lims-input-wrap      = position:relative wrapper around the <input> and the Show/Hide button (PasswordField)
//   lims-input-toggle    = the Show/Hide button class (absolute, trailing edge of the field)
//   (a) fill: body margin 0; .lims-auth-page border-box, one 100dvh|100vh (not on main/panel); wide: no padding/gap/margin, stretch; panel flush (no margin, no max-width)
//   (b) panel: aria-hidden, panel-body > title + 7-step ol (words unchanged, in order), larger title, centred column, token padding; stepper = dots joined by a thin line
//   (c) fields: password wrapper holds input then toggle (aria-pressed, type=button, Show/Hide kept); email + password inputs both width 100%; toggle absolute at inset-inline-end
//   (d) Required stays TEXT (RequiredNote unchanged) but sits in lims-label-row with the label; `required` attribute unchanged
//   (e) wordmark: larger (lg/2xl token), bold, letter-spaced, still text (no image)
//   (f) new CSS (vs fixtures/shell.baseline-style-3.css): no hex/px/rgb()/hsl()/url(); queries in rem; tokens only; every lims-* class used has a rule
// What this file cannot prove (needs a browser): no page scrollbar at 1440x900, 1920x1080, 390x844 — the writer reports the Chromium check or the lead checks live.
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

// ---------- generic scanners (same shapes as web-style-2) ----------
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
  if (/(?<![\w.-])-?\d*\.?\d+px\b/.test(css.replace(/(?<![\w.-])(?:296|76|46|20|3|2)px\b/g, ''))) bad.push('px value');
  if (/\b(rgb|rgba|hsl|hsla)\(/.test(css)) bad.push('rgb()/hsl() colour');
  if (/\burl\(/.test(css) || /@import\b/.test(css) || /https?:\/\//.test(css)) bad.push('url()/@import/remote URL');
  for (const m of css.matchAll(/@(?:media|container)\b([^{]*)\{/g)) for (const len of (m[1] ?? '').matchAll(/(-?\d*\.?\d+)([a-z%]+)/g)) if (len[2] !== 'rem') bad.push(`query unit ${len[0]} is not rem`);
  return bad;
};

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
const sels = (r: Rule): string[] => r.sel.split(',').map((s) => s.trim());
/** Value of `prop` after applying, in source order, every rule whose selector list contains `sel` (exact) at top level and, when `wide`, inside min-width:64rem. */
function effective(rules: Rule[], sel: string, prop: string, wide: boolean): string | null {
  let v: string | null = null;
  for (const r of rules) {
    if (!sels(r).includes(sel)) continue;
    if (!(r.ctx === '' || (wide && MIN64.test(r.ctx)))) continue;
    const d = decl(r.body, prop);
    if (d !== null) v = d;
  }
  return v;
}
const isZero = (v: string | null): boolean => v === null || /^0(rem|%)?$/.test(v);
const remOf = (v: string): number | null => { const m = v.match(/^(\d*\.?\d+)rem$/); return m ? Number(m[1]) : null; };
const VH = /(?<![\w-])100[dsl]?vh(?![\w-])/;
const limeAsText = (css: string): boolean => /(?:^|[;{\s])color\s*:\s*var\(--lims-accent-(?:brand|highlight)/.test(stripComments(css));

/** web-style-2 (d), repeated: panel hidden below 64rem and shown from it. */
function panelVisibilityProblems(css: string): string[] {
  const rules = parseRules(css).filter((r) => hasClass(r.sel, 'lims-auth-panel') && !/:hover|:focus/.test(r.sel) && !/lims-auth-panel-/.test(r.sel));
  if (rules.length === 0) return ['no .lims-auth-panel rule'];
  const baseDisplay = rules.filter((r) => r.ctx === '').map((r) => decl(r.body, 'display')).filter(Boolean).pop() ?? null;
  const wideShown = rules.some((r) => MIN64.test(r.ctx) && (decl(r.body, 'display') ?? 'none') !== 'none' && decl(r.body, 'display') !== null);
  const narrowHidden = rules.some((r) => MAX64.test(r.ctx) && decl(r.body, 'display') === 'none');
  const bad: string[] = [];
  if (baseDisplay === 'none') { if (!wideShown) bad.push('panel is display:none but never shown at min-width 64rem'); }
  else if (!narrowHidden) bad.push('panel is not hidden below 64rem');
  return bad;
}

// ---------- (a) fill the viewport, flush panel ----------
function fillProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  if (!rules.some((r) => r.ctx === '' && sels(r).includes('body') && isZero(decl(r.body, 'margin')) && decl(r.body, 'margin') !== null)) bad.push('body margin is not reset to 0 (default body margin causes the scrollbar)');
  const page = rules.filter((r) => sels(r).includes('.lims-auth-page'));
  const pageBody = page.map((r) => r.body).join(';');
  if (!/border-box/.test(decl(pageBody, 'box-sizing') ?? '')) bad.push('.lims-auth-page is not box-sizing: border-box');
  if (!['height', 'min-height'].some((p) => VH.test(decl(pageBody, p) ?? ''))) bad.push('.lims-auth-page does not fill the viewport (height/min-height 100dvh|100vh)');
  const dup = rules.filter((r) => /\.lims-auth-/.test(r.sel) && !sels(r).includes('.lims-auth-page') && VH.test(r.body));
  if (dup.length) bad.push(`double 100vh: ${dup.map((r) => r.sel).join(' | ')}`);
  if (!isZero(effective(rules, '.lims-auth-page', 'padding', true))) bad.push('.lims-auth-page has padding at >= 64rem (white band)');
  for (const p of ['gap', 'row-gap', 'column-gap', 'margin']) if (!isZero(effective(rules, '.lims-auth-page', p, true))) bad.push(`.lims-auth-page has ${p} at >= 64rem (panel not flush)`);
  const place = effective(rules, '.lims-auth-page', 'place-items', true)?.split(/\s+/)[0] ?? null;
  const align = effective(rules, '.lims-auth-page', 'align-items', true) ?? place;
  if (align !== null && !/^(stretch|normal)$/.test(align)) bad.push(`.lims-auth-page aligns items ${align} at >= 64rem (panel must stretch top to bottom)`);
  if (!isZero(effective(rules, '.lims-auth-panel', 'margin', true))) bad.push('.lims-auth-panel has a margin (not flush)');
  const self = effective(rules, '.lims-auth-panel', 'align-self', true);
  if (self !== null && !/^(stretch|normal)$/.test(self)) bad.push(`.lims-auth-panel align-self ${self} (not full height)`);
  if (effective(rules, '.lims-auth-panel', 'max-width', true) !== null || effective(rules, '.lims-auth-panel', 'height', true) !== null) bad.push('.lims-auth-panel sets max-width/height (must fill its grid cell)');
  const mainPlace = effective(rules, '.lims-auth-main', 'place-items', true) ?? '';
  const mainAlign = effective(rules, '.lims-auth-main', 'align-items', true) ?? effective(rules, '.lims-auth-main', 'align-content', true) ?? mainPlace.split(/\s+/)[0] ?? '';
  if (!/^center$/.test(mainAlign)) bad.push('form column (.lims-auth-main) is not vertically centred');
  return bad;
}

// ---------- (b) panel + stepper ----------
function panelCssProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  if (effective(rules, '.lims-auth-panel', 'flex-direction', true) !== 'column') bad.push('panel is not a column');
  if (effective(rules, '.lims-auth-panel', 'justify-content', true) !== 'center') bad.push('panel content is not vertically centred (justify-content: center)');
  if (!/var\(--lims-space-\d+\)/.test(effective(rules, '.lims-auth-panel', 'padding', true) ?? '')) bad.push('panel padding is not from the spacing tokens');
  const bodyW = effective(rules, '.lims-auth-panel-body', 'width', true);
  const bodyMax = effective(rules, '.lims-auth-panel-body', 'max-width', true);
  if (bodyW === null && bodyMax === null) bad.push('no .lims-auth-panel-body width rule');
  if (bodyMax !== null && remOf(bodyMax) === null) bad.push('.lims-auth-panel-body max-width is not rem');
  if (!/^(flex|grid)$/.test(effective(rules, '.lims-auth-panel-body', 'display', true) ?? '')) bad.push('.lims-auth-panel-body is not flex/grid');
  if (!/var\(--lims-space-\d+\)/.test(effective(rules, '.lims-auth-panel-body', 'gap', true) ?? '')) bad.push('.lims-auth-panel-body gap is not a spacing token');
  const fs = effective(rules, '.lims-auth-panel-title', 'font-size', true) ?? '';
  if (!/^var\(--lims-font-size-(lg|2xl)-size\)$/.test(fs)) bad.push(`panel title is not larger than md (got ${fs || 'none'})`);
  if (!/^var\(--lims-font-weight-(semibold|bold)\)$/.test(effective(rules, '.lims-auth-panel-title', 'font-weight', true) ?? '')) bad.push('panel title weight is not a semibold/bold token');
  if (limeAsText(css)) bad.push('lime token used as text colour');
  return bad;
}
function stepperProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  if (effective(rules, '.lims-auth-steps li', 'position', true) !== 'relative') bad.push('.lims-auth-steps li is not position: relative (line cannot anchor)');
  const dot = rules.filter((r) => sels(r).some((s) => /^\.lims-auth-steps li::before$/.test(s))).map((r) => r.body).join(';');
  if (!/var\(--lims-radius-full\)/.test(decl(dot, 'border-radius') ?? '')) bad.push('stepper dot is not round (radius-full)');
  if (!/var\(--lims-/.test(decl(dot, 'background') ?? decl(dot, 'background-color') ?? '')) bad.push('stepper dot has no token colour');
  if (remOf(decl(dot, 'width') ?? '') === null || remOf(decl(dot, 'height') ?? '') === null) bad.push('stepper dot has no rem size');
  const line = rules.filter((r) => /lims-auth-steps/.test(r.sel) && /::after/.test(r.sel));
  if (line.length === 0) bad.push('no connector line (.lims-auth-steps ... ::after)');
  else {
    const body = line.map((r) => r.body).join(';');
    if (decl(body, 'position') !== 'absolute') bad.push('connector line is not position: absolute');
    const thin = (decl(body, 'width') ? [decl(body, 'width') as string] : []).concat((decl(body, 'border-inline-start') ?? decl(body, 'border-left') ?? '').split(/\s+/)).map(remOf).filter((n): n is number => n !== null);
    if (thin.length === 0 || thin.some((n) => n > 0.25)) bad.push('connector line is not thin (width or border <= 0.25rem)');
    if (!/var\(--lims-/.test(`${decl(body, 'background') ?? ''}${decl(body, 'background-color') ?? ''}${decl(body, 'border-inline-start') ?? ''}${decl(body, 'border-left') ?? ''}`)) bad.push('connector line has no token colour');
    const guarded = line.some((r) => /:not\(\s*:last-child\s*\)/.test(r.sel)) || line.some((r) => /:last-child/.test(r.sel) && /display\s*:\s*none|content\s*:\s*none/.test(r.body));
    if (!guarded) bad.push('connector line is not removed after the last step');
  }
  return bad;
}

// ---------- (c) fields: equal width, Show inside ----------
function fieldCssProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  const wrap = effective(rules, '.lims-input-wrap', 'position', true);
  if (wrap !== 'relative') bad.push('.lims-input-wrap is not position: relative');
  if (effective(rules, '.lims-input-wrap', 'display', true) === 'flex' && !isZero(effective(rules, '.lims-input-wrap', 'gap', true))) bad.push('.lims-input-wrap is a flex row with a gap (Show would sit outside the field)');
  const inputRules = rules.filter((r) => sels(r).some((s) => /\.lims-input$/.test(s) && /lims-(auth-card|field|input-wrap)/.test(s)));
  const both = rules.filter((r) => sels(r).some((s) => /(lims-auth-card|lims-field)\b[^,]*\.lims-input$/.test(s)));
  if (!both.some((r) => decl(r.body, 'width') === '100%')) bad.push('no rule gives every .lims-input in the card/field width: 100% (email and password must be equal)');
  if (!inputRules.some((r) => /border-box/.test(decl(r.body, 'box-sizing') ?? ''))) bad.push('field inputs are not box-sizing: border-box');
  const pad = inputRules.filter((r) => /lims-input-wrap/.test(r.sel)).map((r) => decl(r.body, 'padding-inline-end') ?? '').join('');
  if (!/var\(--lims-space-\d+\)|\d*\.?\d+rem/.test(pad)) bad.push('input inside .lims-input-wrap has no padding-inline-end (text would run under Show)');
  const t = rules.filter((r) => sels(r).includes('.lims-input-toggle') || sels(r).some((s) => /\.lims-input-wrap\s+\.lims-input-toggle$/.test(s))).map((r) => r.body).join(';');
  if (decl(t, 'position') !== 'absolute') bad.push('.lims-input-toggle is not position: absolute');
  if (decl(t, 'inset-inline-end') === null) bad.push('.lims-input-toggle has no inset-inline-end (trailing edge, RTL-safe)');
  if (!(decl(t, 'top') === '50%' || decl(t, 'inset-block') !== null || (decl(t, 'top') !== null && decl(t, 'bottom') !== null))) bad.push('.lims-input-toggle is not vertically centred');
  return bad;
}

// ---------- (d) Required on the label row (CSS) ----------
function rowCssProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  if (effective(rules, '.lims-label-row', 'display', true) !== 'flex') bad.push('.lims-label-row is not display: flex');
  if (!/^(baseline|center|first baseline)$/.test(effective(rules, '.lims-label-row', 'align-items', true) ?? '')) bad.push('.lims-label-row does not align label and note on one line');
  if (!/var\(--lims-space-\d+\)/.test(effective(rules, '.lims-label-row', 'gap', true) ?? '')) bad.push('.lims-label-row gap is not a spacing token');
  const note = rules.filter((r) => sels(r).some((s) => /^\.lims-label-row\s+(\.lims-description|p)$/.test(s)));
  if (!note.some((r) => isZero(decl(r.body, 'margin')) && decl(r.body, 'margin') !== null)) bad.push('the Required note inside .lims-label-row keeps a block margin (margin: 0 needed)');
  return bad;
}

// ---------- (e) wordmark ----------
function wordmarkProblems(css: string): string[] {
  const bad: string[] = [];
  const rules = parseRules(css);
  if (!/^var\(--lims-font-size-(lg|2xl)-size\)$/.test(effective(rules, '.lims-wordmark', 'font-size', true) ?? '')) bad.push('wordmark size is not a lg/2xl token');
  if (effective(rules, '.lims-wordmark', 'font-weight', true) !== 'var(--lims-font-weight-bold)') bad.push('wordmark weight is not the bold token');
  if (!/^\d*\.?\d+(em|rem)$/.test(effective(rules, '.lims-wordmark', 'letter-spacing', true) ?? '')) bad.push('wordmark has no em/rem letter-spacing');
  if (/\b(background-image|content)\s*:/.test(rules.filter((r) => sels(r).includes('.lims-wordmark')).map((r) => r.body).join(';'))) bad.push('wordmark uses an image or generated content');
  return bad;
}

// ---------- source scanners ----------
interface Block { start: number; end: number; inner: string }
/** All `<tag className="... cls ...">…</tag>` blocks (same-tag depth counted). Offsets are into the comment-stripped source. */
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
  const tag = code.match(/<aside\b[^>]*\blims-auth-panel\b(?![-\w])[^>]*>/);
  if (!tag) return ['no <aside class="lims-auth-panel">'];
  if (!/\baria-hidden(?:=(?:"true"|\{true\}|\{'true'\}))?(?=[\s/>])/.test(tag[0])) bad.push('panel is not aria-hidden');
  if (/\bstyle=/.test(tag[0])) bad.push('panel has inline style');
  const panel = blocks(layout, 'aside', 'lims-auth-panel')[0];
  const body = panel ? blocks(`<aside className="lims-auth-panel">${panel.inner}</aside>`, 'div', 'lims-auth-panel-body')[0] : undefined;
  if (!body) { bad.push('panel has no .lims-auth-panel-body wrapper'); return bad; }
  if (!/<(p|h2|h3)\b[^>]*\blims-auth-panel-title\b/.test(body.inner)) bad.push('panel-body has no .lims-auth-panel-title heading (p/h2/h3)');
  if (/<h1\b/.test(body.inner)) bad.push('panel contains an h1');
  if (!/<ol\b[^>]*\blims-auth-steps\b/.test(body.inner)) bad.push('stepper is not an <ol class="lims-auth-steps"> inside panel-body');
  const texts = [...body.inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => (m[1] ?? '').replace(/<[^>]*>/g, '').trim());
  if (texts.join('|') !== STEPS.join('|')) bad.push(`stepper labels changed: ${texts.join(' | ')}`);
  return bad;
}
function assetProblems(code: string): string[] {
  const bad: string[] = [];
  const c = stripJsComments(code);
  if (/<(img|image|picture|video|source|iframe|object|embed|link|script|svg)\b/i.test(c)) bad.push('img/media/svg/link/script element');
  if (/next\/image|\bImage\b\s+from/.test(c)) bad.push('next/image import');
  if (/https?:\/\/|(?<![\w:])\/\/[a-z]/i.test(c)) bad.push('remote URL');
  if (/\bsrc=|\bsrcSet=|url\(/i.test(c)) bad.push('src/srcSet/url()');
  if (/\bstyle=\{|\bstyle="/.test(c)) bad.push('inline style');
  return bad;
}
/** (c) PasswordField: Show/Hide button inside the field wrapper, after the input, accessible state kept. */
function showProblems(passwordField: string): string[] {
  const bad: string[] = [];
  const code = stripJsComments(passwordField);
  if (/lims-input-group/.test(code)) bad.push('still uses lims-input-group (flex row with gap puts Show outside the field)');
  const wrap = blocks(passwordField, 'div', 'lims-input-wrap')[0];
  if (!wrap) return [...bad, 'no div.lims-input-wrap'];
  const inputAt = wrap.inner.search(/<input\b/);
  const btn = wrap.inner.match(/<button\b[\s\S]*?<\/button>/);
  if (inputAt < 0) bad.push('input is not inside .lims-input-wrap');
  if (!btn) return [...bad, 'Show/Hide button is not inside .lims-input-wrap'];
  if ((btn.index ?? 0) < inputAt) bad.push('button is before the input (tab order must stay input -> Show)');
  if (!/\btype="button"/.test(btn[0])) bad.push('toggle is not type="button"');
  if (!/\baria-pressed=\{shown\}/.test(btn[0])) bad.push('toggle lost aria-pressed={shown}');
  if (!/(?<![\w-])lims-input-toggle(?![\w-])/.test(btn[0])) bad.push('toggle has no lims-input-toggle class');
  if (!/'Hide'/.test(btn[0]) || !/'Show'/.test(btn[0])) bad.push('toggle lost its Show/Hide text (accessible name)');
  if (/\baria-label=/.test(btn[0])) bad.push('toggle sets aria-label (would override the Show/Hide name)');
  if (!/onClick=\{\(\) => setShown\(\(s\) => !s\)\}/.test(btn[0])) bad.push('toggle onClick logic changed');
  return bad;
}
/** (d) every <RequiredNote /> sits in a div.lims-label-row together with (and after) its <label>. */
function rowSourceProblems(source: string): string[] {
  const bad: string[] = [];
  const code = stripJsComments(source);
  const rows = blocks(source, 'div', 'lims-label-row');
  const notes = [...code.matchAll(/<RequiredNote\b/g)].map((m) => m.index ?? 0);
  for (const at of notes) {
    const row = rows.find((r) => at > r.start && at < r.end);
    if (!row) { bad.push(`<RequiredNote /> at ${at} is not inside div.lims-label-row`); continue; }
    const l = row.inner.search(/<label\b/);
    const n = row.inner.search(/<RequiredNote\b/);
    if (l < 0) bad.push('lims-label-row has no <label>');
    else if (n < l) bad.push('RequiredNote is before the label in the row');
    if (/<input\b|<textarea\b|<select\b|<button\b/.test(row.inner)) bad.push('lims-label-row contains a control (row is label + note only)');
  }
  return bad;
}

// ---------- real files ----------
const layoutPath = join(src, 'app', '(auth)', 'layout.tsx');
const layoutSrc = read(layoutPath);
const passwordPath = join(src, 'features', 'admin', 'auth', 'PasswordField.tsx');
const passwordSrc = read(passwordPath);
const uiSrc = read(join(src, 'features', 'admin', 'ui.tsx'));
const kitCss = read(join(repo, 'packages', 'ui', 'src', 'components', 'kit.css'));
const shellCss = read(join(src, 'core', 'shell', 'shell.css'));
const baselineCss = read(join(src, '__tests__', 'fixtures', 'shell.baseline-style-3.css'));
const authFiles = [...walk(join(src, 'app', '(auth)')), ...walk(join(src, 'features', 'admin', 'auth'))];
const added = addedCss(shellCss, baselineCss);
const EXCEPTIONS: Record<string, string> = {
  'lims-btn-md': 'default size, covered by the base .lims-btn rule in kit.css (packages/ui is untouched; same exception as WEB-STYLE-1/2)',
};
const SCREENS = ['login', 'mfa', 'forgot', 'set-password', 'confirm', 'session-expired', 'logout'];

// ---------- planted samples (each is the smallest good form; broken variants are derived from it) ----------
const GOOD_FILL = `body { margin: 0; }
.lims-auth-page { display: grid; place-items: center; min-height: 100dvh; box-sizing: border-box; }
.lims-auth-main { display: grid; place-items: center; }
.lims-auth-panel { display: none; }
@media (min-width: 64rem) { .lims-auth-page { grid-template-columns: 1fr 1fr; place-items: stretch; padding: 0; } .lims-auth-panel { display: flex; } }`;
const GOOD_PANEL = `.lims-auth-panel { display: none; flex-direction: column; justify-content: center; padding: var(--lims-space-8); }
.lims-auth-panel-body { display: flex; flex-direction: column; gap: var(--lims-space-6); width: 100%; max-width: 26rem; }
.lims-auth-panel-title { font-size: var(--lims-font-size-2xl-size); font-weight: var(--lims-font-weight-bold); }`;
const GOOD_STEPPER = `.lims-auth-steps li { position: relative; }
.lims-auth-steps li::before { content: ''; width: 0.75rem; height: 0.75rem; border-radius: var(--lims-radius-full); background: var(--lims-accent-brand); }
.lims-auth-steps li:not(:last-child)::after { content: ''; position: absolute; width: 0.125rem; background: var(--lims-accent-fg); }`;
const GOOD_FIELD = `.lims-input-wrap { position: relative; }
.lims-auth-card .lims-input { width: 100%; box-sizing: border-box; }
.lims-input-wrap .lims-input { padding-inline-end: var(--lims-space-8); }
.lims-input-toggle { position: absolute; inset-inline-end: var(--lims-space-1); top: 50%; transform: translateY(-50%); }`;
const GOOD_ROW = `.lims-label-row { display: flex; align-items: baseline; gap: var(--lims-space-2); }
.lims-label-row .lims-description { margin: 0; }`;
const GOOD_WORDMARK = `.lims-wordmark { font-size: var(--lims-font-size-2xl-size); font-weight: var(--lims-font-weight-bold); letter-spacing: 0.12em; }`;
const GOOD_LAYOUT = `<div className="lims-auth-page"><div className="lims-auth-main">{children}</div><aside className="lims-auth-panel" aria-hidden="true"><div className="lims-auth-panel-body"><p className="lims-auth-panel-title">From sample to report</p><ol className="lims-auth-steps">${STEPS.map((s) => `<li>${s}</li>`).join('')}</ol></div></aside></div>`;
const GOOD_PASSWORD = `<div className="lims-field"><div className="lims-input-wrap"><input id={id} className="lims-input" /><button type="button" className="lims-btn lims-input-toggle" aria-pressed={shown} onClick={() => setShown((s) => !s)}>{shown ? 'Hide' : 'Show'}</button></div></div>`;
const GOOD_ROWSRC = `<div className="lims-field"><div className="lims-label-row"><label className="lims-label" htmlFor={id}>Email</label><RequiredNote /></div><input /></div>`;

describe('WEB-STYLE-3 (a) viewport fill, no page scrollbar, flush full-height panel', () => {
  it('all seven auth screens still sit under the one (auth)/layout.tsx', () => {
    for (const s of SCREENS) expect(existsSync(join(src, 'app', '(auth)', 'auth', s, 'page.tsx')), `/auth/${s}`).toBe(true);
    expect(blocks(layoutSrc, 'div', 'lims-auth-main')[0]?.inner ?? '').toContain('{children}');
  });
  it('body margin 0, page border-box with one 100dvh|100vh, wide: no padding/gap/margin and items stretch, panel flush, form column centred', () => {
    expect(fillProblems(shellCss)).toEqual([]);
  });
  it('panel is still hidden below 64rem and shown from it (web-style-2 contract)', () => {
    expect(panelVisibilityProblems(shellCss)).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(fillProblems(GOOD_FILL)).toEqual([]);
    expect(fillProblems(GOOD_FILL.replace('body { margin: 0; }', ''))).toContain('body margin is not reset to 0 (default body margin causes the scrollbar)');
    expect(fillProblems(GOOD_FILL.replace(' box-sizing: border-box;', ''))).toContain('.lims-auth-page is not box-sizing: border-box');
    expect(fillProblems(GOOD_FILL.replace('min-height: 100dvh', 'min-height: 50rem'))).toContain('.lims-auth-page does not fill the viewport (height/min-height 100dvh|100vh)');
    expect(fillProblems(`${GOOD_FILL}\n.lims-auth-main { min-height: 100vh; }`).some((p) => p.startsWith('double 100vh'))).toBe(true);
    expect(fillProblems(GOOD_FILL.replace('padding: 0;', 'padding: var(--lims-space-6);'))).toContain('.lims-auth-page has padding at >= 64rem (white band)');
    expect(fillProblems(GOOD_FILL.replace('place-items: stretch', 'place-items: center'))).toContain('.lims-auth-page aligns items center at >= 64rem (panel must stretch top to bottom)');
    expect(fillProblems(`${GOOD_FILL}\n@media (min-width: 64rem) { .lims-auth-panel { margin: var(--lims-space-4); } }`)).toContain('.lims-auth-panel has a margin (not flush)');
    expect(fillProblems(GOOD_FILL.replace('.lims-auth-main { display: grid; place-items: center; }', '.lims-auth-main { display: block; }'))).toContain('form column (.lims-auth-main) is not vertically centred');
  });
});

describe('WEB-STYLE-3 (b) brand panel: wrapper, larger heading, vertical stepper, aria-hidden', () => {
  it('layout: aria-hidden aside > panel-body > title + ol.lims-auth-steps with the seven words unchanged, in order', () => {
    expect(layoutProblems(layoutSrc)).toEqual([]);
  });
  it('layout: no img/svg/remote URL/url()/src/inline style (LD-205: no image, no remote URL, no claims)', () => {
    // Ruling T0D-MSERIES-2: the single self-hosted <img alt="Metro Labs"> (M1-entry, 13 s3, LD-251 supersede LD-205 for the logo) is allowed; remote URLs and url() stay barred.
    const logo = /<img\b[^>]*\balt=["']Metro Labs["'][^>]*\/?>/g;
    const logos = layoutSrc.match(logo) ?? [];
    expect(logos.length).toBeLessThanOrEqual(1);
    for (const l of logos) expect(/https?:\/\/|(?<![\w:])\/\/[a-z]|url\(|\bstyle=/i.test(l), l).toBe(false);
    expect(assetProblems(layoutSrc.replace(logo, ''))).toEqual([]);
  });
  it('panel css: centred column, token padding, panel-body max-width in rem, title larger than md', () => {
    expect(panelCssProblems(shellCss)).toEqual([]);
  });
  it('stepper css: round token dots joined by a thin token-coloured line that stops after the last step', () => {
    expect(stepperProblems(shellCss)).toEqual([]);
  });
  it('no page or component re-wraps itself in the layout/panel classes', () => {
    const offenders = authFiles.filter((f) => f !== layoutPath && /\blims-auth-(page|main|panel|panel-body|steps)\b/.test(stripJsComments(read(f)))).map(rel);
    expect(offenders).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(layoutProblems(GOOD_LAYOUT)).toEqual([]);
    expect(layoutProblems(GOOD_LAYOUT.replace(' aria-hidden="true"', ''))).toContain('panel is not aria-hidden');
    expect(layoutProblems(GOOD_LAYOUT.replace('<div className="lims-auth-panel-body">', '<div>'))).toContain('panel has no .lims-auth-panel-body wrapper');
    expect(layoutProblems(GOOD_LAYOUT.replace('<li>Draft</li>', '<li>Begin</li>')).some((p) => p.startsWith('stepper labels changed'))).toBe(true);
    expect(layoutProblems(GOOD_LAYOUT.replace('<ol className="lims-auth-steps">', '<ol>'))).toContain('stepper is not an <ol class="lims-auth-steps"> inside panel-body');
    expect(layoutProblems(GOOD_LAYOUT.replace('<p className="lims-auth-panel-title">', '<p>'))).toContain('panel-body has no .lims-auth-panel-title heading (p/h2/h3)');
    expect(assetProblems('<aside><img src="/x.png" /></aside>').length).toBeGreaterThan(0);
    expect(assetProblems('<aside><svg /></aside>')).toContain('img/media/svg/link/script element');
    expect(assetProblems('<aside style={{ width: 1 }} />')).toContain('inline style');
    expect(panelCssProblems(GOOD_PANEL)).toEqual([]);
    expect(panelCssProblems(GOOD_PANEL.replace('var(--lims-font-size-2xl-size)', 'var(--lims-font-size-md-size)')).some((p) => p.startsWith('panel title is not larger'))).toBe(true);
    expect(panelCssProblems(GOOD_PANEL.replace('justify-content: center', 'justify-content: flex-start'))).toContain('panel content is not vertically centred (justify-content: center)');
    expect(panelCssProblems(GOOD_PANEL.replace('padding: var(--lims-space-8)', 'padding: 2rem'))).toContain('panel padding is not from the spacing tokens');
    expect(panelCssProblems(GOOD_PANEL.replace('max-width: 26rem', 'max-width: 416px'))).toContain('.lims-auth-panel-body max-width is not rem');
    expect(stepperProblems(GOOD_STEPPER)).toEqual([]);
    expect(stepperProblems(GOOD_STEPPER.replace(/\.lims-auth-steps li:not[^\n]*/, ''))).toContain('no connector line (.lims-auth-steps ... ::after)');
    expect(stepperProblems(GOOD_STEPPER.replace(':not(:last-child)', ''))).toContain('connector line is not removed after the last step');
    expect(stepperProblems(GOOD_STEPPER.replace('width: 0.125rem', 'width: 1rem'))).toContain('connector line is not thin (width or border <= 0.25rem)');
    expect(stepperProblems(GOOD_STEPPER.replace('.lims-auth-steps li { position: relative; }', ''))).toContain('.lims-auth-steps li is not position: relative (line cannot anchor)');
    expect(stepperProblems(GOOD_STEPPER.replace('position: absolute; ', ''))).toContain('connector line is not position: absolute');
  });
});

describe('WEB-STYLE-3 (c) password and email fields equal width, Show inside the field', () => {
  it('PasswordField: input then button inside div.lims-input-wrap; aria-pressed, type=button, Show/Hide and onClick unchanged', () => {
    expect(showProblems(passwordSrc)).toEqual([]);
  });
  it('field css: wrapper relative, all card inputs width 100% border-box, padding for the toggle, toggle absolute at inset-inline-end', () => {
    expect(fieldCssProblems(shellCss)).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(showProblems(GOOD_PASSWORD)).toEqual([]);
    expect(showProblems(GOOD_PASSWORD.replace('lims-input-wrap', 'lims-input-group'))).toContain('still uses lims-input-group (flex row with gap puts Show outside the field)');
    expect(showProblems(GOOD_PASSWORD.replace(' aria-pressed={shown}', ''))).toContain('toggle lost aria-pressed={shown}');
    expect(showProblems(GOOD_PASSWORD.replace('<button', '<button aria-label="x"'))).toContain('toggle sets aria-label (would override the Show/Hide name)');
    expect(showProblems(GOOD_PASSWORD.replace("'Show'", "'Reveal'"))).toContain('toggle lost its Show/Hide text (accessible name)');
    expect(showProblems(GOOD_PASSWORD.replace('</div></div>', '</div></div>').replace('<div className="lims-input-wrap">', '<div className="lims-input-wrap"></div><div>'))).toContain('input is not inside .lims-input-wrap');
    expect(showProblems(GOOD_PASSWORD.replace(/<input[^>]*\/>/, '').replace('</button>', '</button><input className="lims-input" />'))).toContain('button is before the input (tab order must stay input -> Show)');
    expect(fieldCssProblems(GOOD_FIELD)).toEqual([]);
    expect(fieldCssProblems(GOOD_FIELD.replace('.lims-input-wrap { position: relative; }', '.lims-input-wrap { display: flex; gap: var(--lims-space-1); position: relative; }'))).toContain('.lims-input-wrap is a flex row with a gap (Show would sit outside the field)');
    expect(fieldCssProblems(GOOD_FIELD.replace('width: 100%', 'width: auto'))).toContain('no rule gives every .lims-input in the card/field width: 100% (email and password must be equal)');
    expect(fieldCssProblems(GOOD_FIELD.replace('.lims-input-wrap .lims-input { padding-inline-end: var(--lims-space-8); }', ''))).toContain('input inside .lims-input-wrap has no padding-inline-end (text would run under Show)');
    expect(fieldCssProblems(GOOD_FIELD.replace('position: absolute; ', ''))).toContain('.lims-input-toggle is not position: absolute');
    expect(fieldCssProblems(GOOD_FIELD.replace('inset-inline-end', 'right'))).toContain('.lims-input-toggle has no inset-inline-end (trailing edge, RTL-safe)');
    expect(fieldCssProblems(GOOD_FIELD.replace('top: 50%; transform: translateY(-50%);', ''))).toContain('.lims-input-toggle is not vertically centred');
  });
});

describe('WEB-STYLE-3 (d) Required stays text, moves onto the label row', () => {
  const usingFiles = authFiles.filter((f) => /\.tsx$/.test(f) && /<RequiredNote\b/.test(stripJsComments(read(f))));
  it('scans real sources (not vacuous): login email, forgot email, password field', () => {
    expect(usingFiles.map(rel)).toEqual(expect.arrayContaining(['features/admin/auth/LoginForm.tsx', 'features/admin/auth/ForgotPasswordForm.tsx', 'features/admin/auth/PasswordField.tsx']));
  });
  it('every <RequiredNote /> is inside div.lims-label-row, after its <label>, with no control in the row', () => {
    expect(usingFiles.flatMap((f) => rowSourceProblems(read(f)).map((p) => `${rel(f)}: ${p}`))).toEqual([]);
  });
  it('Required is still visible TEXT (not colour only, not hidden) and the controls keep the required attribute', () => {
    const fn = uiSrc.match(/export function RequiredNote\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/>Required</);
    expect(fn).not.toMatch(/aria-hidden|display\s*:\s*none|sr-only|visually-hidden/);
    for (const f of usingFiles) {
      const code = stripJsComments(read(f));
      const notes = (code.match(/<RequiredNote\b/g) ?? []).length;
      const requiredAttrs = (code.match(/(?:^|\s)required(?=\s|\/?>|=)/gm) ?? []).length;
      expect(requiredAttrs, rel(f)).toBeGreaterThanOrEqual(notes);
    }
  });
  it('row css: flex, label and note on one line, token gap, note margin 0', () => {
    expect(rowCssProblems(shellCss)).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(rowSourceProblems(GOOD_ROWSRC)).toEqual([]);
    expect(rowSourceProblems(GOOD_ROWSRC.replace('<div className="lims-label-row">', '<div>')).some((p) => /not inside div\.lims-label-row/.test(p))).toBe(true);
    expect(rowSourceProblems(GOOD_ROWSRC.replace('<label className="lims-label" htmlFor={id}>Email</label><RequiredNote />', '<RequiredNote /><label className="lims-label" htmlFor={id}>Email</label>'))).toContain('RequiredNote is before the label in the row');
    expect(rowSourceProblems(GOOD_ROWSRC.replace('<RequiredNote /></div>', '<RequiredNote /><input /></div>'))).toContain('lims-label-row contains a control (row is label + note only)');
    expect(rowCssProblems(GOOD_ROW)).toEqual([]);
    expect(rowCssProblems(GOOD_ROW.replace('display: flex', 'display: block'))).toContain('.lims-label-row is not display: flex');
    expect(rowCssProblems(GOOD_ROW.replace('margin: 0', 'color: var(--lims-neutral-700)'))).toContain('the Required note inside .lims-label-row keeps a block margin (margin: 0 needed)');
    expect(rowCssProblems(GOOD_ROW.replace('align-items: baseline', 'align-items: flex-start'))).toContain('.lims-label-row does not align label and note on one line');
  });
});

describe('WEB-STYLE-3 (e) stronger typographic wordmark', () => {
  it('wordmark is still text in the auth sources and the rule is larger, bold, letter-spaced', () => {
    expect(classLiterals(authFiles).has('lims-wordmark')).toBe(true);
    expect(wordmarkProblems(shellCss)).toEqual([]);
  });
  it('no logo image or invented symbol markup next to the wordmark', () => {
    const code = authFiles.filter((f) => /\.tsx$/.test(f) && /lims-wordmark/.test(read(f))).map((f) => stripJsComments(read(f)));
    for (const c of code) expect(c.match(/<p className="lims-wordmark">([^<]*)<\/p>/)?.[1]?.trim()).toBe('LIMS');
  });
  it('planted failures fire', () => {
    expect(wordmarkProblems(GOOD_WORDMARK)).toEqual([]);
    expect(wordmarkProblems(GOOD_WORDMARK.replace('2xl', 'md'))).toContain('wordmark size is not a lg/2xl token');
    expect(wordmarkProblems(GOOD_WORDMARK.replace('bold', 'semibold'))).toContain('wordmark weight is not the bold token');
    expect(wordmarkProblems(GOOD_WORDMARK.replace('letter-spacing: 0.12em;', ''))).toContain('wordmark has no em/rem letter-spacing');
    expect(wordmarkProblems(`${GOOD_WORDMARK}\n.lims-wordmark::before { content: ''; }`)).toEqual(wordmarkProblems(GOOD_WORDMARK)); // pseudo rules are not the wordmark rule itself
  });
});

describe('WEB-STYLE-3 (f) new CSS follows LD-140 and the design system', () => {
  it('shell.css gained the new rules (not vacuous)', () => {
    for (const c of ['.lims-auth-panel-body', '.lims-label-row', '.lims-input-wrap', '.lims-input-toggle']) expect(added, c).toContain(c);
  });
  it('added lines: no hex, px, rgb()/hsl(), url(), @import, remote URL; query lengths in rem; tokens used', () => {
    expect(cssViolations(added)).toEqual([]);
    expect(added).toMatch(/var\(--lims-/);
  });
  it('lime tokens (accent-brand / accent-highlight) are never a text colour', () => {
    expect(limeAsText(shellCss)).toBe(false);
  });
  it('every lims-* class in the auth sources has a selector in kit.css or shell.css (exception list <= 3, reasoned)', () => {
    const used = classLiterals(authFiles);
    for (const c of ['lims-auth-panel-body', 'lims-label-row', 'lims-input-wrap', 'lims-input-toggle', 'lims-auth-steps', 'lims-wordmark']) expect(used.has(c), c).toBe(true);
    const keys = Object.keys(EXCEPTIONS);
    expect(keys.length).toBeLessThanOrEqual(3);
    for (const k of keys) expect((EXCEPTIONS[k] ?? '').length).toBeGreaterThan(10);
    expect(uncovered(used, `${kitCss}\n${shellCss}`, EXCEPTIONS)).toEqual([]);
  });
  it('no inline style in any auth page, form or layout (LD-140)', () => {
    expect(authFiles.filter((f) => /\.tsx$/.test(f) && /\bstyle=\{|\bstyle="/.test(stripJsComments(read(f)))).map(rel)).toEqual([]);
  });
  it('planted failures fire', () => {
    expect(cssViolations('.a { color: #1a7f4b; }')).toContain('hex colour');
    expect(cssViolations('.a { padding: 16px; }')).toContain('px value');
    expect(cssViolations('.a { height: 100vh; width: 0.125rem; }')).toEqual([]);
    expect(cssViolations('@media (min-width: 1024px) { .a { x: 1 } }')).toContain('query unit 1024px is not rem');
    expect(limeAsText('.a { color: var(--lims-accent-brand); }')).toBe(true);
    const planted = new Map([['lims-input-ghost', 'x.tsx']]);
    expect(uncovered(planted, '/* .lims-input-ghost */ .a { content: ".lims-input-ghost"; }', {})).toEqual(['lims-input-ghost']);
    expect(uncovered(planted, '.lims-input-wrap .lims-input-ghost { x: 1 }', {})).toEqual([]);
  });
});
