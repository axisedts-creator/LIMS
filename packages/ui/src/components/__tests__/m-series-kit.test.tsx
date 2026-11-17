// @vitest-environment jsdom
// T0D-MSERIES-1 (LD-246, LD-251; spec/program/13-M-SERIES.md s2.3 and s6.3): kit shape, size and motion.
//   Button, Chip/Badge, SegmentedTabs (Tabs), TextField, Select are fully round; TextArea (multi-line) is not.
//   Card, Dialog, Drawer have radius 24 and a Card has no border and no shadow; Button 48 high, TextField / Select 46, compact is 30 (T0D-DENSITY-1 replaced the old 40).
//   Control border stays neutral.300. Motion: tokens only, 150 ms hover/press, every animation off under prefers-reduced-motion,
//   at most one looping animation, no animation or 3D dependency.
//
// How shape is measured: the real component is rendered, the real kit.css is parsed, and the cascade (specificity, then source order)
// is evaluated for the rendered element. `var(--lims-radius-x)` is resolved through tokens.json. Nothing is mocked.
//
// CONTRACT chosen here where 13 gives no class (writer: follow it, or file a dispute):
//   compact field height: an ancestor with data-density="compact" makes `.lims-input` min-height 30px.
//   T0D-DENSITY-1 (LD-310, founder decision 2026-11-17 04:49 and 05:03 NPT) REPLACES the written kit rule "dense fields stay at 40" (13 s2.3) with 30:
//   30 px still meets the 24 px minimum target of WCAG 2.2 AA (2.5.8). The rest of this file is unchanged.
//   Not tested (no kit class exists yet, MSERIES-2 owns the shell): the 46 px nav item, the 296 px sidebar.
//   "Tag" in the task brief: the kit has no Tag component; the pill chip classes (.lims-chip via Badge/StatusChip) are what is measured.
import { render } from '@testing-library/react';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Badge } from '../Badge/Badge';
import { Button } from '../Button/Button';
import { Card } from '../Card/Card';
import { Select } from '../Select/Select';
import { StatusChip } from '../StatusChip/StatusChip';
import { Tabs } from '../Tabs/Tabs';
import { TextArea } from '../TextArea/TextArea';
import { TextField } from '../TextField/TextField';

const UI = process.cwd(); // vitest root = packages/ui
const COMPONENTS = join(UI, 'src', 'components');
const ROOT = resolve(UI, '..', '..');
const tokens = JSON.parse(readFileSync(join(UI, 'tokens', 'tokens.json'), 'utf8'));

// ---------------------------------------------------------------- css reader with a small cascade
type Rule = { sels: string[]; decls: Map<string, string>; media: string; order: number };
const splitTop = (s: string, sep = ','): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
function parseCss(src: string): Rule[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const media: string[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    const close = s.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      media.pop();
      i = close + 1;
      continue;
    }
    const prelude = s.slice(i, open).trim();
    if (/^@(media|supports)/.test(prelude)) {
      media.push(prelude);
      i = open + 1;
      continue;
    }
    if (prelude.startsWith('@')) {
      let depth = 1;
      let j = open + 1;
      while (depth && j < s.length) (depth += s[j] === '{' ? 1 : s[j] === '}' ? -1 : 0), j++;
      i = j;
      continue;
    }
    const end = s.indexOf('}', open);
    const decls = new Map<string, string>();
    for (const d of s.slice(open + 1, end).split(';')) {
      const k = d.indexOf(':');
      if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim());
    }
    out.push({ sels: splitTop(prelude).map((x) => x.replace(/\s+/g, ' ')), decls, media: media.join(' '), order: out.length });
    i = end + 1;
  }
  return out;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
const files = walk(COMPONENTS);
const kitCss = readFileSync(join(COMPONENTS, 'kit.css'), 'utf8');
const rules = parseCss(kitCss);

// css that lives in component files: *.css and template strings in *.tsx that hold css (QueueBoard keeps its flash animation there)
const cssTexts = [
  kitCss,
  ...files.filter((f) => f.endsWith('.css') && !f.endsWith('kit.css')).map((f) => readFileSync(f, 'utf8')),
  ...files
    .filter((f) => /\.tsx$/.test(f) && !/\.stories\./.test(f))
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/`([^`]*(?:animation|transition|@keyframes)[^`]*)`/g)].map((m) => m[1]!)),
];
const allRules = cssTexts.flatMap((t) => parseCss(t));

const specificity = (sel: string): number => {
  const s = sel.replace(/:where\([^)]*\)/g, '');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (s.replace(/\[[^\]]*\]|[.#:][\w-]+/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + cls * 100 + tags;
};
/** effective value of `prop` on `el` from the base (no media) rules; later wins on equal specificity. */
function declOn(el: Element, prop: string): string | undefined {
  let best: { spec: number; order: number; v: string } | undefined;
  for (const r of rules) {
    if (r.media || !r.decls.has(prop)) continue;
    for (const sel of r.sels) {
      let hit = false;
      try {
        hit = el.matches(sel.replace(/:where\([^)]*\)/g, ''));
      } catch {
        hit = false;
      }
      if (!hit) continue;
      const spec = specificity(sel);
      if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, v: r.decls.get(prop)! };
    }
  }
  return best?.v;
}
const radiusPx = (v: string | undefined): number => {
  const m = /^var\(--lims-radius-(sm|md|lg|xl|full)\)$/.exec(v ?? '');
  if (!m) return v === '0' ? 0 : NaN;
  return tokens.radius[m[1]!];
};
const px = (v: string | undefined) => (v && /^(\d+(?:\.\d+)?)px$/.test(v) ? Number(v.replace('px', '')) : NaN);
const FULL = 9999;

const elOf = (ui: React.ReactElement, sel: string): Element => {
  const { container } = render(ui);
  const el = container.querySelector(sel);
  expect(el, `${sel} not rendered`).toBeTruthy();
  return el!;
};
const synthetic = (cls: string, tag = 'div') => {
  const el = document.createElement(tag);
  el.className = cls;
  document.body.append(el);
  return el;
};

// ---------------------------------------------------------------- 1. shape
describe('M series shape: fully round controls (13 s2.3: buttons, chips, segmented tabs, search and single-line fields)', () => {
  it.each(['primary', 'secondary', 'ghost', 'danger'] as const)('Button %s is fully round (md and sm)', (variant) => {
    for (const size of ['md', 'sm'] as const) {
      const b = elOf(<Button variant={variant} size={size}>Save</Button>, '.lims-btn');
      expect(radiusPx(declOn(b, 'border-radius')), `${variant}/${size}: ${declOn(b, 'border-radius')}`).toBe(FULL);
    }
  });
  it('Chip (Badge and StatusChip) is fully round', () => {
    expect(radiusPx(declOn(elOf(<Badge>3</Badge>, '.lims-chip'), 'border-radius'))).toBe(FULL);
    expect(radiusPx(declOn(elOf(<StatusChip kind="specimen" status="collected" />, '.lims-chip'), 'border-radius'))).toBe(FULL);
  });
  it('SegmentedTabs (Tabs): every tab is a pill', () => {
    const tab = elOf(<Tabs items={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B', count: 2 }]} selectedId="a" onChange={() => {}} />, '.lims-tab');
    expect(radiusPx(declOn(tab, 'border-radius')), `lims-tab radius ${declOn(tab, 'border-radius')}`).toBe(FULL);
  });
  it('TextField input and Select trigger (single-line) are fully round', () => {
    expect(radiusPx(declOn(elOf(<TextField label="Name" name="n" maxLength={20} />, 'input'), 'border-radius'))).toBe(FULL);
    const trig = elOf(<Select label="Sex" name="s" options={[{ value: 'f', label: 'F' }]} />, '.lims-select-trigger');
    expect(radiusPx(declOn(trig, 'border-radius'))).toBe(FULL);
  });
  it('TextArea (multi-line) is NOT fully round: it keeps a real radius from the ladder', () => {
    const ta = elOf(<TextArea label="Note" name="note" maxLength={200} />, 'textarea');
    const r = radiusPx(declOn(ta, 'border-radius'));
    expect(r, `textarea radius ${declOn(ta, 'border-radius')}`).toBeLessThan(FULL);
    expect(Number.isNaN(r)).toBe(false);
  });
});

describe('M series shape: radius 24 for Card, Dialog, Drawer (13 s2.3)', () => {
  it('the radius ladder token xl is 24 and the kit resolves Card, Dialog and Drawer to it', () => {
    expect(tokens.radius.xl).toBe(24);
    const card = elOf(<Card title="T">body</Card>, '.lims-card');
    expect(radiusPx(declOn(card, 'border-radius')), `card ${declOn(card, 'border-radius')}`).toBe(24);
    expect(radiusPx(declOn(synthetic('lims-dialog'), 'border-radius'))).toBe(24);
    expect(radiusPx(declOn(synthetic('lims-dialog lims-dialog-lg'), 'border-radius'))).toBe(24);
    expect(radiusPx(declOn(synthetic('lims-drawer'), 'border-radius'))).toBe(24);
  });
  it('a Card is white, has no border and no shadow, on the neutral.50 page', () => {
    const card = elOf(<Card title="T">body</Card>, '.lims-card');
    const border = declOn(card, 'border') ?? 'none';
    expect(border, 'card border').toMatch(/^(0|none)\b/);
    expect(declOn(card, 'box-shadow') ?? 'none').toBe('none');
    expect(declOn(card, 'background')).toBe('var(--lims-neutral-0)');
    expect(declOn(synthetic('lims-shell'), 'background')).toContain('var(--lims-neutral-50)');
  });
  it('elevation 2/3 only on menus, dialogs, drawers (floating); the dialog and drawer keep elevation.3', () => {
    expect(declOn(synthetic('lims-dialog'), 'box-shadow')).toBe('var(--lims-elevation-3)');
    expect(declOn(synthetic('lims-drawer'), 'box-shadow')).toBe('var(--lims-elevation-3)');
  });
});

// ---------------------------------------------------------------- 2. size
describe('M series size (13 s2.3: button 48, field 46; compact 30 since T0D-DENSITY-1, LD-310)', () => {
  it('Button (md) is 48 px high (min-height; text controls never use a fixed height, 04-UI-UX s1.4)', () => {
    const b = elOf(<Button>Save</Button>, '.lims-btn');
    expect(px(declOn(b, 'min-height')), `button min-height ${declOn(b, 'min-height')}`).toBe(48);
    expect(declOn(b, 'height')).toBeUndefined();
  });
  it('TextField input and Select trigger are 46 px high', () => {
    const i = elOf(<TextField label="Name" name="n" maxLength={20} />, 'input');
    expect(px(declOn(i, 'min-height')), `input min-height ${declOn(i, 'min-height')}`).toBe(46);
    expect(declOn(i, 'height')).toBeUndefined();
    const t = elOf(<Select label="Sex" name="s" options={[{ value: 'f', label: 'F' }]} />, '.lims-select-trigger');
    expect(px(declOn(t, 'min-height'))).toBe(46);
  });
  it('compact density is 30 (T0D-DENSITY-1, LD-310; was 40): a field inside [data-density="compact"] is 30 px high (CONTRACT, see header)', () => {
    const host = document.createElement('div');
    host.setAttribute('data-density', 'compact');
    const input = document.createElement('input');
    input.className = 'lims-input';
    host.append(input);
    document.body.append(host);
    expect(px(declOn(input, 'min-height'))).toBe(30);
  });
  it('the touch target tokens are 48 on web and Flutter (the button height is the touch target)', () => {
    expect(tokens.touchTarget).toEqual({ web: 48, flutter: 48 });
  });
});

describe('M series: the control border stays neutral.300 (13 s2.1)', () => {
  it('TextField input and Select trigger draw their border with var(--lims-neutral-300), never a lighter board colour', () => {
    const i = elOf(<TextField label="Name" name="n" maxLength={20} />, 'input');
    expect(declOn(i, 'border') ?? declOn(i, 'border-color')).toContain('var(--lims-neutral-300)');
    const t = elOf(<Select label="Sex" name="s" options={[{ value: 'f', label: 'F' }]} />, '.lims-select-trigger');
    expect(declOn(t, 'border') ?? declOn(t, 'border-color')).toContain('var(--lims-neutral-300)');
  });
});

// ---------------------------------------------------------------- 3. type in the kit
describe('M series type in the kit (13 s2.2): page title 30/600, -.02em, accent.hover', () => {
  it('the page title uses font.size.3xl (30), weight semibold, letter-spacing -0.02em and the accent.hover colour', () => {
    const t = synthetic('lims-page-title', 'h1');
    expect(declOn(t, 'font-size')).toBe('var(--lims-font-size-3xl-size)');
    expect(declOn(t, 'font-weight')).toBe('var(--lims-font-weight-semibold)');
    expect(declOn(t, 'letter-spacing')?.replace(/^-0\./, '-.')).toBe('-.02em');
    expect(declOn(t, 'color')).toBe('var(--lims-accent-hover)');
  });
  it('the kit root keeps the one sans token (no font name written in kit.css except the .num switch, if any)', () => {
    expect(declOn(synthetic('lims-root'), 'font-family')).toBe('var(--lims-font-family-sans)');
    const named = rules.flatMap((r) => (r.decls.get('font-family') ? [[r.sels.join(','), r.decls.get('font-family')!] as const] : [])).filter(([, v]) => !/^var\(--lims-font-family-(sans|mono)\)$/.test(v));
    for (const [sel, v] of named) expect(sel, `font-family "${v}" outside the tokens`).toMatch(/\.num\b/);
  });
});

// ---------------------------------------------------------------- 4. motion
describe('M series motion (13 s2.3): CSS only, tokens only, off under prefers-reduced-motion', () => {
  const reduce = allRules.filter((r) => /prefers-reduced-motion:\s*reduce/.test(r.media));
  const animated = allRules.filter((r) => !/prefers-reduced-motion/.test(r.media) && [...r.decls].some(([k, v]) => /^animation(-name)?$/.test(k) && v !== 'none'));

  it('there is at least one animation to check (the spinner), so this test cannot pass on an empty parse', () => {
    expect(animated.flatMap((r) => r.sels)).toContain('.lims-spin');
  });
  it('every rule that starts an animation has a prefers-reduced-motion: reduce rule for the same selector that turns it off', () => {
    const missing = animated.flatMap((r) => r.sels).filter((sel) => !reduce.some((q) => q.sels.includes(sel) && [...q.decls].some(([k, v]) => (k === 'animation' && v === 'none') || (k === 'animation-name' && v === 'none') || (k === 'animation-duration' && /^0(\.0+1)?m?s$/.test(v)))));
    expect(missing).toEqual([]);
  });
  it('every transition uses the motion duration tokens only (the generated CSS zeroes them under prefers-reduced-motion), never a literal time', () => {
    const bad = allRules.flatMap((r) => [...r.decls].filter(([k, v]) => /^transition(-duration)?$/.test(k) && (/\d+(\.\d+)?m?s\b/.test(v.replace(/var\([^)]*\)/g, '')) || (k === 'transition' && !/var\(--lims-motion-duration-(fast|normal)\)/.test(v)))).map(([k, v]) => `${r.sels.join(',')} { ${k}: ${v} }`));
    expect(bad).toEqual([]);
  });
  it('hover and press on a Button animate in 150 ms: .lims-btn has a transition on the fast token', () => {
    const t = declOn(elOf(<Button>Save</Button>, '.lims-btn'), 'transition');
    expect(t, '.lims-btn transition').toContain('var(--lims-motion-duration-fast)');
    expect(tokens.motion.duration.fast).toBe(150);
  });
  it('at most ONE looping animation in the kit (13 s2.3), and it is the spinner', () => {
    const loops = animated.filter((r) => [...r.decls].some(([k, v]) => /^animation$/.test(k) && /\binfinite\b/.test(v)));
    expect(loops.flatMap((r) => r.sels)).toEqual(['.lims-spin']);
  });
  it('CSS only: no JS animation call in kit components (requestAnimationFrame loops, .animate(), WebGL)', () => {
    const code = files.filter((f) => /\.tsx?$/.test(f) && !/\.stories\./.test(f) && !/BarcodeSymbol/.test(f));
    const bad = code.filter((f) => /requestAnimationFrame|\.animate\(|getContext\(\s*['"](?:webgl|experimental-webgl|webgl2)/.test(readFileSync(f, 'utf8')));
    expect(bad.map((f) => f.slice(COMPONENTS.length))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 5. no animation / 3D dependency
describe('M series: no new animation or 3D dependency (13 s2.3 "Not allowed"; LD-251 "no 3D, no animation library")', () => {
  const DENY = /^(three|@react-three\/.*|@types\/three|framer-motion|motion|motion-dom|gsap|@gsap\/.*|lottie-web|@lottiefiles\/.*|lottie-react|react-lottie.*|@rive-app\/.*|react-spring|@react-spring\/.*|animejs|anime|popmotion|@formkit\/auto-animate|react-transition-group|react-flip-toolkit|@babylonjs\/.*|babylonjs|pixi\.js|@pixi\/.*|p5|aos|wow\.js|react-three-fiber)$/;
  const pkgs = ['packages/ui', 'apps/web', 'apps/portal', 'apps/partner', 'packages/ui-flutter'].map((p) => join(ROOT, p, 'package.json')).filter(existsSync);
  it('no package.json of the web workspaces lists one', () => {
    expect(pkgs.length).toBeGreaterThan(1);
    const bad = pkgs.flatMap((f) => {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      return Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies, ...j.optionalDependencies }).filter((d) => DENY.test(d)).map((d) => `${f.slice(ROOT.length)}: ${d}`);
    });
    expect(bad).toEqual([]);
  });
  it('packages/ui dependencies are exactly the previous ones plus the Poppins font package (nothing else added)', () => {
    const j = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8'));
    expect(Object.keys(j.dependencies)).toEqual(['react-aria-components']);
    const before = ['@fontsource/noto-sans', '@fontsource/noto-sans-devanagari', '@fontsource/noto-sans-mono', '@fontsource/plus-jakarta-sans', '@testing-library/react', '@testing-library/user-event', '@types/react', '@types/react-dom', 'axe-core', 'jsdom', 'react', 'react-dom', 'typescript', 'vitest'];
    const added = Object.keys(j.devDependencies).filter((d) => !before.includes(d));
    expect(added).toEqual(['@fontsource/poppins']);
  });
  it('no source file in packages/ui/src imports one, and none uses WebGL or autoplay video', () => {
    const bad = files
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => {
        const t = readFileSync(f, 'utf8');
        const imp = [...t.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
        return imp.some((i) => DENY.test(i) || DENY.test(i.split('/').slice(0, 2).join('/'))) || /<video[^>]*\bautoPlay\b|\bnew\s+THREE\./.test(t);
      });
    expect(bad.map((f) => f.slice(COMPONENTS.length))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 6. brand assets
describe('M series brand assets (13 s3: the four Metro Labs logo files are copied into packages/ui/assets/brand)', () => {
  const src = join(ROOT, 'spec', 'program', 'design-m-series', 'logos');
  const dst = join(UI, 'assets', 'brand');
  const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  it('the source folder holds exactly the four logos (guards the premise)', () => {
    expect(readdirSync(src).sort()).toEqual(['ml-logo-landscape-white.png', 'ml-logo-landscape.png', 'ml-logo-white.png', 'ml-logo.png']);
  });
  it('packages/ui/assets/brand has the four files, byte-identical, valid PNG', () => {
    for (const n of readdirSync(src)) {
      expect(existsSync(join(dst, n)), `${n} missing in packages/ui/assets/brand`).toBe(true);
      expect(sha(join(dst, n)), `${n} differs from spec/program/design-m-series/logos`).toBe(sha(join(src, n)));
      expect(readFileSync(join(dst, n)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
  });
});
