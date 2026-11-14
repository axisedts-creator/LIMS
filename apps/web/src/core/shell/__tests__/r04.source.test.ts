// T0D-UI-R04 static guards over the shell sources + CSS (LD-140, 10-DESIGN-SYSTEM §3, §6, §8). No rendering.
// Shell CSS may live in apps/web/src/core/shell/*.css (root layout must import it) and/or in the kit (packages/ui/src/components/kit.css).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const SRC = join(WEB, 'src');
const ROOT = join(WEB, '..', '..');
const walk = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === '__tests__' ? [] : walk(join(dir, d.name))) : [join(dir, d.name)]));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const read = (f: string) => readFileSync(f, 'utf8');

const OWNED_DIRS = ['shell', 'nav', 'shortcuts'].map((d) => join(SRC, 'core', d));
const LAYOUTS = [join(SRC, 'app', '(staff)', 'layout.tsx'), join(SRC, 'app', 'layout.tsx')];
const owned = [...OWNED_DIRS.flatMap(walk), ...LAYOUTS].filter((f) => /\.(tsx?|css)$/.test(f) && !/generated\.ts$/.test(f));
const code = owned.filter((f) => /\.tsx?$/.test(f));
const css = owned.filter((f) => f.endsWith('.css'));
const shellCode = walk(join(SRC, 'core', 'shell')).filter((f) => /\.tsx?$/.test(f));

describe('LD-140: no colour literals, pixel radii or inline style objects outside packages/ui', () => {
  it('there is shell code to scan', () => {
    expect(code.length).toBeGreaterThan(3);
    expect(code.some((f) => /AppShell\.tsx$/.test(f))).toBe(true);
  });
  it.each(['hex colour', 'rgb()/hsl()/oklch()', 'pixel border-radius', 'inline style object/attr', 'dangerouslySetInnerHTML'])('none: %s', (kind) => {
    const re = {
      'hex colour': /#[0-9a-fA-F]{3,8}\b(?![-\w])/,
      'rgb()/hsl()/oklch()': /\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/i,
      'pixel border-radius': /border(-[a-z]+)*-radius\s*:\s*[^;}]*\d+px/i,
      'inline style object/attr': /\bstyle\s*=\s*\{|\bstyle\s*=\s*["']/,
      dangerouslySetInnerHTML: /dangerouslySetInnerHTML/,
    }[kind]!;
    const bad = owned.filter((f) => re.test(strip(read(f))));
    expect(bad, bad.join(', ')).toEqual([]);
  });
});

describe('navigation stays generated, not hard-coded (REQ-ARCH-076, AC-0D-7.5)', () => {
  it('the shell renders navEntries from the generated manifest and filters with hasPermission', () => {
    const src = strip(read(join(SRC, 'core', 'shell', 'AppShell.tsx')) + code.filter((f) => /core[\\/]nav[\\/]/.test(f)).map(read).join('\n'));
    expect(src).toMatch(/from\s+['"][^'"]*nav\/generated['"]/);
    expect(src).toMatch(/navEntries/);
    expect(src).toMatch(/hasPermission/);
  });
  it('no staff route path or nav label list is written into shell/nav code', () => {
    const routes = [...read(join(ROOT, 'contracts', 'routes.yaml')).matchAll(/origin:\s*staff_web,\s*path:\s*"?([^",\s}]+)"?/g)].map((m) => m[1]!).filter((p) => p.length > 1 && !p.includes('{'));
    expect(routes.length).toBeGreaterThan(20);
    const text = code.map((f) => strip(read(f))).join('\n');
    const hit = routes.filter((p) => new RegExp(`['"\`]${p.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}['"\`]`).test(text));
    expect(hit).toEqual([]);
  });
  it('shell/nav/shortcuts never import a feature module (search goes through the BFF, not another module\'s code)', () => {
    const bad = code.filter((f) => /from\s+['"][^'"]*(features\/|@\/features)/.test(strip(read(f))) && !/build-nav\.ts$/.test(f));
    expect(bad).toEqual([]);
  });
  it('the (staff) layout still gates direct visits (matchStaffRoute + hasPermission + PermissionDenied)', () => {
    const s = strip(read(LAYOUTS[0]!));
    for (const w of ['matchStaffRoute', 'hasPermission', 'PermissionDenied', 'AppShell']) expect(s).toContain(w);
  });
});

describe('search: existing BFF endpoints only, server-side only', () => {
  const openapi = readdirSync(join(ROOT, 'contracts', 'openapi')).filter((f) => f.endsWith('.yaml')).map((f) => read(join(ROOT, 'contracts', 'openapi', f))).join('\n');
  const literals = [...new Set(shellCode.flatMap((f) => [...strip(read(f)).matchAll(/['"`](\/v1\/[A-Za-z0-9_\-/${}.]+)['"`]/g)].map((m) => m[1]!)))];
  it('the shell calls the patient search and the specimen barcode lookup (no other lookup invented)', () => {
    expect(literals).toContain('/v1/frontdesk/patients/search');
    expect(literals).toContain('/v1/lab/specimens/lookup');
  });
  it('every /v1 path literal used by the shell exists in contracts/openapi', () => {
    for (const l of literals) {
      const p = l.replace(/\$\{[^}]*\}/g, '{x}');
      const re = new RegExp(`^  ${p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{x\\\}/g, '\\{[a-z_]+\\}')}:\\s*$`, 'm');
      expect(openapi, l).toMatch(re);
    }
  });
  it('search is a server action built on serverFetch; client files never fetch(), read cookies or hold a bearer token', () => {
    const actions = shellCode.filter((f) => /^\s*['"]use server['"]/m.test(read(f)));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.map((f) => strip(read(f))).join('\n')).toMatch(/serverFetch|server-fetch/);
    const clients = shellCode.filter((f) => /^\s*['"]use client['"]/m.test(read(f)));
    expect(clients.length).toBeGreaterThan(0);
    for (const f of clients) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/\bfetch\s*\(|document\.cookie|[Aa]uthorization|Bearer|LIMS_ORIGIN_API|localStorage|sessionStorage/);
    }
  });
});

// ---------------------------------------------------------------- CSS
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
    for (const d of s.slice(open + 1, end).split(';')) { const k = d.indexOf(':'); if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim()); }
    if (!prelude.startsWith('@')) out.push({ sels: prelude.split(',').map((x) => x.trim().replace(/\s+/g, ' ').replace(/"/g, "'")), decls, media: media.join(' ') });
    i = end + 1;
  }
  return out;
}
const kit = read(join(ROOT, 'packages', 'ui', 'src', 'components', 'kit.css'));
const rules = parseCss([kit, ...css.map(read)].join('\n'));
const px = (v?: string) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v ?? '')?.[1] ?? NaN);

describe('shell CSS (tokens only; 248 -> 72 rail, 56 top bar, accent.highlight pill)', () => {
  it('rail expanded stays 248 and top bar 56 (R03 values kept)', () => {
    expect(rules.filter((r) => r.sels.includes('.lims-shell-nav') && r.decls.has('width')).map((r) => px(r.decls.get('width'))).at(-1)).toBe(248);
    expect(rules.filter((r) => r.sels.includes('.lims-shell-top') && r.decls.has('min-height')).map((r) => px(r.decls.get('min-height'))).at(-1)).toBe(56);
  });
  it("collapsed rail ([data-collapsed='true']) is 72px wide", () => {
    const w = rules.filter((r) => !r.media && r.sels.some((s) => /data-collapsed='?true'?/.test(s)) && r.decls.has('width')).map((r) => px(r.decls.get('width')));
    expect(w, 'no [data-collapsed=true] width rule').toContain(72);
  });
  it('active item (aria-current=page): accent.highlight background, accent.default text, token radius', () => {
    const r = rules.filter((x) => !x.media && x.sels.some((s) => /aria-current='?page'?/.test(s) && /shell|rail|nav/.test(s)));
    expect(r.length, 'no [aria-current=page] rule for the rail').toBeGreaterThan(0);
    const d = (p: string) => r.map((x) => x.decls.get(p)).filter(Boolean).join(' ');
    expect(d('background') + d('background-color')).toContain('var(--lims-accent-highlight)');
    expect(d('color')).toMatch(/var\(--lims-accent\)/);
    expect(d('border-radius')).toMatch(/var\(--lims-radius-/);
  });
  it('rail items are keyboard-visible: a :focus-visible rule or the global kit focus ring', () => {
    const own = rules.some((x) => x.sels.some((s) => /:focus-visible/.test(s) && /shell|rail|nav/.test(s)));
    const global = rules.some((x) => x.sels.some((s) => /(^|\s|,)(a|button|\*):focus-visible/.test(s)) && (x.decls.get('outline') ?? '').includes('--lims-focus-ring'));
    expect(own || global).toBe(true);
  });
  it('motion: any transition/animation in shell CSS is ≤ 250 ms and reduced-motion is honoured', () => {
    const mine = css.map((f) => strip(read(f))).join('\n');
    const durations = [...mine.matchAll(/(?:transition|animation)[^;{}]*?(\d+(?:\.\d+)?)(ms|s)\b/g)].map((m) => Number(m[1]) * (m[2] === 's' ? 1000 : 1));
    for (const d of durations) expect(d).toBeLessThanOrEqual(250);
    if (durations.length > 0) expect(mine).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
  });
  it('widths/spacings use tokens: no colour keyword other than inherit/transparent/currentColor in shell CSS', () => {
    for (const f of css) expect(strip(read(f)), f).not.toMatch(/(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-[a-z]+)*-color)\s*:\s*(?:white|black|red|green|blue|gray|grey)\b/i);
  });
  it('any CSS file under core/shell is imported by the root layout', () => {
    const root = strip(read(LAYOUTS[1]!));
    for (const f of css.filter((x) => /core[\\/]shell[\\/]/.test(x))) expect(root, f).toContain(f.split(/[\\/]/).at(-1)!);
  });
});
