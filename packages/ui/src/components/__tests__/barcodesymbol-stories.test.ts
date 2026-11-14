// T0D-12c done_when "stories + axe" + source guards (node env). The axe scan over every story is stories-axe.test.tsx (globs *.stories.tsx, AC-0D-8.6);
// this file proves the story file exists with >=1 story, that the export contract holds, and that the sources are inert (REQ-SEC-088, REQ-SEC-141, LD-107).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = join(fileURLToPath(new URL('..', import.meta.url)), 'BarcodeSymbol');
const files = existsSync(DIR) ? readdirSync(DIR) : [];
const src = (n: string) => readFileSync(join(DIR, n), 'utf8');
const prod = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.stories\./.test(f));

describe('BarcodeSymbol files', () => {
  it('BarcodeSymbol.tsx and BarcodeSymbol.stories.tsx exist (package exports map: ./components/*/*.tsx)', () => {
    expect(files).toContain('BarcodeSymbol.tsx');
    expect(files).toContain('BarcodeSymbol.stories.tsx');
  });

  it('BarcodeSymbol.tsx exports BarcodeSymbol and code128Modules (directly or re-exported from the encoder)', () => {
    const s = src('BarcodeSymbol.tsx');
    expect(s).toMatch(/export (function|const) BarcodeSymbol\b|export \{[^}]*\bBarcodeSymbol\b[^}]*\}/);
    expect(s).toMatch(/export (function|const) code128Modules\b|export \{[^}]*\bcode128Modules\b[^}]*\}/);
  });

  it('story file is CSF3 with a default meta and >=1 named story; every story renders a valid value', () => {
    const s = src('BarcodeSymbol.stories.tsx');
    expect(s).toMatch(/export default/);
    expect(s).toMatch(/export const \w+/);
    expect(s).toMatch(/BarcodeSymbol/);
    for (const m of s.matchAll(/value\s*[:=]\s*\{?\s*['"]([^'"]*)['"]/g)) expect(m[1], 'story value must satisfy ^[A-Z0-9-]{1,32}$').toMatch(/^[A-Z0-9-]{1,32}$/);
  });
});

describe('source guards over BarcodeSymbol/** (non-story)', () => {
  it('there is production code to guard', () => {
    expect(prod.length).toBeGreaterThan(0);
  });
  it.each(prod)('%s: no HTML injection, foreignObject, eval, network, storage or logging', (f) => {
    const s = src(f);
    expect(s).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|foreignObject|\beval\s*\(|new Function\s*\(/);
    expect(s).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(s).not.toMatch(/console\s*\./); // the value is never logged
    expect(s).not.toMatch(/['"`]https?:\/\//);
  });
  it.each(prod)('%s: browser-only APIs are not used (must render in react-dom/server)', (f) => {
    const s = src(f).replace(/\/\/[^\n]*$/gm, '');
    expect(s).not.toMatch(/\b(window|document|navigator|ResizeObserver|matchMedia|requestAnimationFrame)\b|\buse(Effect|LayoutEffect|Ref)\b/);
  });
  it.each(prod)('%s: no third-party encoder / barcode library (no new dependency without a CR)', (f) => {
    expect(src(f)).not.toMatch(/from ['"](jsbarcode|bwip-js|code-128|barcode|react-barcode|@zxing[^'"]*|zxing[^'"]*)['"]/i);
  });
});
