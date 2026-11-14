// T0D-12 static guards (node env): REQ-SEC-088 (no dangerouslySetInnerHTML), REQ-SEC-141 (no foreign touchpoint),
// AC-0D-8.7 (Noto Sans Devanagari bundled, no external font URL), 04-UI-UX §1.4 (min-height, not height, on text controls).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS = fileURLToPath(new URL('..', import.meta.url));
const UI = fileURLToPath(new URL('../../..', import.meta.url)); // packages/ui

const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));

const isTest = (f: string) => /\.(test|spec)\.[jt]sx?$/.test(f);
const isStory = (f: string) => /\.stories\.[jt]sx?$/.test(f);
const sources = walk(COMPONENTS).filter((f) => !isTest(f));
const prod = sources.filter((f) => !isStory(f));
const code = prod.filter((f) => /\.(tsx?|jsx?)$/.test(f));
const css = sources.filter((f) => /\.(css|scss)$/.test(f));
const read = (f: string) => readFileSync(f, 'utf8');

describe('component sources exist', () => {
  it('src/components contains implementation files', () => {
    expect(code.length).toBeGreaterThan(10);
  });
});

describe('REQ-SEC-088: kit renders text nodes only', () => {
  it('no dangerouslySetInnerHTML / innerHTML / outerHTML / insertAdjacentHTML / document.write / eval in component sources', () => {
    expect(code.length).toBeGreaterThan(0);
    const bad = code.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/.test(read(f)));
    expect(bad).toEqual([]);
  });
});

describe('REQ-SEC-141 / AC-0D-8.7: nothing leaves the origin', () => {
  const EXTERNAL = /(https?:)?\/\/(?!www\.w3\.org\/)[a-z0-9-]+(\.[a-z0-9-]+)+/i; // svg xmlns allowed
  it('no absolute http(s)/protocol-relative URLs in component code or css', () => {
    expect(code.length).toBeGreaterThan(0);
    const bad = [...code, ...css].filter((f) => EXTERNAL.test(read(f).replace(/\/\/[^\n]*$/gm, '')));
    expect(bad).toEqual([]);
  });
  it('no font CDN, @import url(), or fetch/XMLHttpRequest/sendBeacon/WebSocket in component code', () => {
    expect(code.length).toBeGreaterThan(0);
    const bad = [...code, ...css].filter((f) => /fonts\.(googleapis|gstatic)|typekit|@import\s+url|\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|new EventSource/.test(read(f)));
    expect(bad).toEqual([]);
  });
  it('every @font-face src in the package is a relative path or data: URI', () => {
    const files = [...css, ...walk(join(UI, 'assets')).filter((f) => f.endsWith('.css')), ...walk(join(UI, 'src')).filter((f) => f.endsWith('.css'))];
    for (const f of files) {
      for (const m of read(f).matchAll(/@font-face\s*{[^}]*}/g)) {
        for (const u of m[0].matchAll(/url\(\s*['"]?([^'")]+)/g)) expect(u[1], f).toMatch(/^(\.{1,2}\/|data:)/);
      }
    }
  });
});

describe('AC-0D-8.7: bundled fonts (04-UI-UX §1.4: packages/ui/assets/fonts/, woff2, OFL)', () => {
  const dir = join(UI, 'assets', 'fonts');
  const fonts = existsSync(dir) ? readdirSync(dir) : [];
  it('Noto Sans Devanagari, Noto Sans and Noto Sans Mono woff2 files are present and non-empty', () => {
    for (const re of [/devanagari/i, /^NotoSans-|NotoSans\[|noto-?sans(?!.*(mono|devanagari))/i, /mono/i]) {
      const f = fonts.find((n) => n.endsWith('.woff2') && re.test(n));
      expect(f, `no woff2 matching ${re} in assets/fonts`).toBeTruthy();
      expect(statSync(join(dir, f!)).size).toBeGreaterThan(1000);
    }
  });
  it('a licence file (OFL-1.1) ships with the fonts', () => {
    expect(fonts.some((n) => /OFL|LICENSE/i.test(n))).toBe(true);
  });
  it('font.family.sans token lists Plus Jakarta Sans then Noto Sans Devanagari', () => {
    const t = readFileSync(join(UI, 'tokens', 'tokens.json'), 'utf8');
    expect(t).toMatch(/Plus Jakarta Sans["\\]*,\s*["\\]*Noto Sans Devanagari/);
  });
});

describe('04-UI-UX §1.4: fixed heights clip Devanagari', () => {
  it('component css uses min-height, never a fixed height, on inputs/chips/rows', () => {
    const offenders = css.filter((f) => /(input|textarea|select|chip|badge|field|row)[^{}]*{[^}]*(?<![-\w])height\s*:\s*\d/i.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
