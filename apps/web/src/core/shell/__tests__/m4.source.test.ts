// T0D-MSERIES-4 static regression (LD-266; spec/program/13-M-SERIES.md s3, pill controls 46 px). jsdom has no layout, so MSERIES-2 could not see the bug:
// kit.css `.lims-input { flex: 1 }` + `.lims-rail` (column flex) made the Find a screen field share the free height with `.lims-rail-scroll` and draw as an oval.
// Fix lives in shell.css only: `.lims-rail-search { flex: none }`. Real height is checked by tests/e2e/shell/T0D-MSERIES-4.shell.spec.ts (needs a stack).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const SHELL_CSS = join(WEB, 'src', 'core', 'shell', 'shell.css');
const KIT_CSS = join(ROOT, 'packages', 'ui', 'src', 'components', 'kit.css');
const read = (f: string) => readFileSync(f, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { sels: string[]; decls: Map<string, string>; media: string };
function parseCss(src: string): Rule[] {
  const s = strip(src);
  const out: Rule[] = [];
  const media: string[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    const close = s.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) { media.pop(); i = close + 1; continue; }
    const prelude = s.slice(i, open).trim();
    if (/^@(media|supports)/.test(prelude)) { media.push(prelude); i = open + 1; continue; }
    const end = s.indexOf('}', open);
    const decls = new Map<string, string>();
    for (const d of s.slice(open + 1, end).split(';')) { const k = d.indexOf(':'); if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim().replace(/\s+/g, ' ')); }
    if (!prelude.startsWith('@')) out.push({ sels: prelude.split(',').map((x) => x.trim().replace(/\s+/g, ' ').replace(/"/g, "'")), decls, media: media.join(' ') });
    i = end + 1;
  }
  return out;
}

const shell = parseCss(read(SHELL_CSS));
const kit = parseCss(read(KIT_CSS));
/** every declaration of `prop` on rules whose selector list contains exactly `sel` (any media), in source order */
const all = (rs: Rule[], sel: string, prop: string) => rs.filter((r) => r.sels.includes(sel)).flatMap((r) => (r.decls.has(prop) ? [{ v: r.decls.get(prop)!, media: r.media }] : []));
const isNone = (v: string) => v === 'none' || v === '0 0 auto';

describe('T0D-MSERIES-4 (LD-266): Find a screen field keeps its pill height in the column-flex sidebar', () => {
  it('shell.css .lims-rail-search carries flex: none (outside any media query) and nothing later in shell.css re-enables flex growth', () => {
    const flex = all(shell, '.lims-rail-search', 'flex');
    expect(flex.length, '.lims-rail-search must declare flex').toBeGreaterThan(0);
    expect(flex.some((d) => d.media === '' && isNone(d.v)), `flex declarations: ${JSON.stringify(flex)}`).toBe(true);
    expect(flex.at(-1)!.v, 'the last .lims-rail-search flex declaration must stay non-growing').toSatisfy(isNone);
    for (const longhand of ['flex-grow', 'flex-basis']) {
      for (const d of all(shell, '.lims-rail-search', longhand)) expect(d.v, `${longhand} must not re-enable growth`).toMatch(/^(0|auto)$/);
    }
  });

  it('the fix does not alter the field otherwise: width 100%, min-height 28 px (LD-340: was 46), radius full, accent border/fill/text, and no fixed height', () => {
    const one = (p: string) => all(shell, '.lims-rail-search', p).at(-1)?.v;
    expect(one('width')).toBe('100%');
    expect(one('min-height')).toBe('1.75rem !important'); // 28 px, the compact sidebar block of shell.css (LD-340)
    expect(one('border-radius')).toBe('var(--lims-radius-full)');
    expect(one('box-sizing')).toBe('border-box');
    expect(one('border')).toMatch(/color-mix\(in srgb, var\(--lims-accent-fg\) 60%, var\(--lims-accent\)\)/);
    expect(one('background')).toMatch(/color-mix\(in srgb, var\(--lims-accent-fg\) 10%, var\(--lims-accent\)\)/);
    expect(one('color')).toBe('var(--lims-accent-fg)');
    expect(one('height'), 'a fixed height would break compact density (40 px); min-height from kit/shell drives it').toBeUndefined();
    expect(one('max-height'), 'no max-height cap either: flex: none is the whole fix').toBeUndefined();
  });

  // T0D-DENSITY-1 (LD-310, founder 2026-11-17): the compact field is 30 px (was 40); same check against the new value.
  it('compact density resolves to 30 px: the kit density rule says 30 and shell.css has no density rule that beats it with a larger value', () => {
    expect(all(kit, "[data-density='compact'] .lims-input", 'min-height').at(-1)?.v).toBe('30px');
    for (const r of shell.filter((x) => x.sels.some((s) => /data-density/.test(s) && /lims-rail-search/.test(s)))) {
      const mh = r.decls.get('min-height');
      if (mh) expect(Number.parseFloat(mh), `density rule ${r.sels.join(',')}`).toBeLessThanOrEqual(30);
    }
  });

  it('kit.css is NOT changed: .lims-input keeps flex: 1 (other screens rely on it inside .lims-input-group) and the pill radius', () => {
    expect(all(kit, '.lims-input', 'flex').at(-1)?.v).toBe('1');
    expect(all(kit, '.lims-input', 'border-radius').at(-1)?.v).toBe('var(--lims-radius-full)');
    expect(all(kit, '.lims-input-group', 'display').at(-1)?.v).toBe('flex');
  });

  it('the sidebar layout the fix relies on is intact: .lims-rail is a column flex container, .lims-rail-scroll flex: 1 + min-height 0 + overflow-y auto, user card/brand not growing', () => {
    expect(all(shell, '.lims-rail', 'display').at(-1)?.v).toBe('flex');
    expect(all(shell, '.lims-rail', 'flex-direction').at(-1)?.v).toBe('column');
    expect(all(shell, '.lims-rail', 'min-height').at(-1)?.v).toBe('0');
    expect(all(shell, '.lims-rail-scroll', 'flex').at(-1)?.v).toBe('1');
    expect(all(shell, '.lims-rail-scroll', 'min-height').at(-1)?.v).toBe('0');
    expect(all(shell, '.lims-rail-scroll', 'overflow-y').at(-1)?.v).toBe('auto');
  });

  it('the survey note exists with the required content: every other column-flex parent holding a .lims-input/.lims-select (file + selector), notes only', () => {
    const note = join(ROOT, '.orchestra', 'notes', 'T0D-MSERIES-4.md');
    expect(existsSync(note), '.orchestra/notes/T0D-MSERIES-4.md (survey) is missing').toBe(true);
    const t = read(note);
    expect(t).toMatch(/lims-input/);
    expect(t).toMatch(/lims-select/);
    expect(t).toMatch(/apps\/web\/[^\s`]+\.(css|tsx?)/); // at least one file path
    expect(t).toMatch(/flex:\s*none|flex-direction:\s*column|column/i);
  });
});
