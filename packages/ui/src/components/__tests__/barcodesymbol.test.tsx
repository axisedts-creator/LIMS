// @vitest-environment jsdom
// T0D-12c / LD-107 (CR-C11-007, CR-C5-T10-001): BarcodeSymbol (Code 128 SVG) + code128Modules.
// AC-0D-8.6 (axe, no critical/serious) ; 07-SECURITY: a wrong barcode on a specimen label is a misidentification risk -> never render a guess,
// never echo the value in an error, never log it.
// INDEPENDENT DECODER: written below from the ISO/IEC 15417 symbol-character table (widths of bar,space,bar,space,bar,space; stop = 7 elements, 13 modules).
// It reads ONLY the rendered SVG geometry (rect / path in module units, black fill), never the encoder's internals.
// ASSUMED (spec gives behaviour, not markup): bars are <rect x width> or <path d="M x y h w v h h -w z"> (M m L l H h V v Z z) with fill black
//   (attr or inline style, or inherited from <g>/<svg>; an element with no fill is black per SVG), a white background <rect> covers the whole viewBox,
//   no transform attributes, integer module coordinates, viewBox="0 0 W H" with W = code128Modules(value) (default quiet zone 10 modules).
//   svg width attr is "<modules*moduleWidthMm>mm"; heightMm (showText=false) -> svg height attr "<heightMm>mm".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BarcodeSymbol, code128Modules } from '../BarcodeSymbol/BarcodeSymbol';
import { seriousViolations } from './helpers';

// ---- ISO/IEC 15417 table: value -> element widths (bar,space,bar,space,bar,space), values 0..105 ----
const T =
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232';
const PATTERNS = T.split(/\s+/);
const STOP = '2331112';
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const BY_PATTERN = new Map(PATTERNS.map((p, i) => [p, i]));

// ---- SVG -> module bits ----
const BLACK = /^(#000|#000000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i;
const WHITE = /^(#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i;

function fillOf(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const st = e.getAttribute('style')?.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1];
    const v = (st ?? e.getAttribute('fill'))?.trim();
    if (v) return v;
    if (e.tagName.toLowerCase() === 'svg') break;
  }
  return 'black'; // SVG default fill
}

/** minimal path reader: M m L l H h V v Z z, absolute/relative; one [minX,maxX] per sub-path */
function pathSpans(d: string): [number, number][] {
  const toks = d.match(/[MmLlHhVvZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const spans: [number, number][] = [];
  let x = 0, y = 0, cmd = '', xs: number[] = [];
  const flush = () => { if (xs.length) spans.push([Math.min(...xs), Math.max(...xs)]); xs = []; };
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t; i++;
      if (cmd === 'Z' || cmd === 'z') { flush(); }
      continue;
    }
    const n = (k: number) => parseFloat(toks[i + k]);
    switch (cmd) {
      case 'M': flush(); x = n(0); y = n(1); xs.push(x); i += 2; cmd = 'L'; break;
      case 'm': flush(); x += n(0); y += n(1); xs.push(x); i += 2; cmd = 'l'; break;
      case 'L': x = n(0); y = n(1); xs.push(x); i += 2; break;
      case 'l': x += n(0); y += n(1); xs.push(x); i += 2; break;
      case 'H': x = n(0); xs.push(x); i += 1; break;
      case 'h': x += n(0); xs.push(x); i += 1; break;
      case 'V': y = n(0); i += 1; break;
      case 'v': y += n(0); i += 1; break;
      default: throw new Error(`unsupported path command near "${t}" in ${d}`);
    }
  }
  flush();
  void y;
  return spans;
}

function parse(markup: string): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  const svg = host.querySelector('svg');
  if (!svg) throw new Error('no <svg> in markup');
  return svg as SVGSVGElement;
}
const viewBoxOf = (svg: Element) => (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);

function geometry(svg: Element) {
  const [vx, vy, W, H] = viewBoxOf(svg);
  const black: [number, number][] = [];
  let whiteBackground = false;
  for (const el of svg.querySelectorAll('rect,path')) {
    expect(el.getAttribute('transform'), 'transform attributes are not allowed on geometry').toBeNull();
    const f = fillOf(el);
    expect(BLACK.test(f) || WHITE.test(f), `fill "${f}" must be literal black or white (theme-independent)`).toBe(true);
    const spans: [number, number][] =
      el.tagName.toLowerCase() === 'rect'
        ? [[Number(el.getAttribute('x') ?? 0), Number(el.getAttribute('x') ?? 0) + Number(el.getAttribute('width'))]]
        : pathSpans(el.getAttribute('d') ?? '');
    if (WHITE.test(f)) {
      if (el.tagName.toLowerCase() === 'rect' && spans[0][0] <= vx && spans[0][1] >= vx + W) whiteBackground = true;
      continue;
    }
    for (const s of spans) {
      expect(Number.isInteger(s[0]) && Number.isInteger(s[1]) && s[1] > s[0], `bar [${s}] must be integer module coordinates`).toBe(true);
      black.push(s);
    }
  }
  const bits: number[] = [];
  for (let i = 0; i < W; i++) bits.push(black.some(([a, b]) => a <= vx + i + 0.5 && vx + i + 0.5 <= b) ? 1 : 0);
  return { W, H, vx, vy, bits, whiteBackground };
}

const runs = (bits: number[]) => {
  const out: number[] = [];
  let prev = -1;
  for (const b of bits) { if (b === prev) out[out.length - 1]++; else { out.push(1); prev = b; } }
  return out;
};

/** decode symbol values (start..checksum) from the bars between the quiet zones; asserts structure on the way */
function decode(svg: Element, q = 10) {
  const { W, bits, whiteBackground } = geometry(svg);
  expect(whiteBackground, 'a white background rect must cover the whole viewBox (scanners need contrast whatever the theme)').toBe(true);
  expect(bits.slice(0, q), 'left quiet zone').toEqual(Array(q).fill(0));
  expect(bits.slice(W - q), 'right quiet zone').toEqual(Array(q).fill(0));
  const body = bits.slice(q, W - q);
  expect(body[0]).toBe(1);
  expect(body[body.length - 1]).toBe(1);
  expect((body.length - 13) % 11, 'body = 11*symbols + 13 (stop)').toBe(0);
  const stop = runs(body.slice(-13)).join('');
  expect(stop, 'stop pattern').toBe(STOP);
  const vals: number[] = [];
  for (let i = 0; i < body.length - 13; i += 11) {
    const r = runs(body.slice(i, i + 11));
    expect(body[i], `symbol at ${i} starts with a bar`).toBe(1);
    const v = BY_PATTERN.get(r.join(''));
    expect(v, `unknown symbol pattern ${r.join('')} at module ${i}`).not.toBeUndefined();
    vals.push(v!);
  }
  return vals;
}

/** values -> text, verifying checksum, start in {B,C}, code sets B/C only */
function interpret(vals: number[]) {
  const [start, ...rest] = vals;
  expect([START_B, START_C], 'start symbol must be Start B or Start C (never Start A)').toContain(start);
  const check = rest.pop()!;
  expect(check, 'checksum symbol is a data value 0..102').toBeLessThan(103);
  const sum = start + rest.reduce((s, v, i) => s + v * (i + 1), 0);
  expect(check, 'checksum = (start + sum(value*position)) mod 103').toBe(sum % 103);
  let set: 'B' | 'C' = start === START_B ? 'B' : 'C';
  let text = '';
  for (const v of rest) {
    if (v === CODE_C && set === 'B') { set = 'C'; continue; }
    if (v === CODE_B && set === 'C') { set = 'B'; continue; }
    if (set === 'C') { expect(v, 'code set C data value').toBeLessThan(100); text += String(v).padStart(2, '0'); continue; }
    expect(v, 'code set B data value (no FNC/shift/Code A)').toBeLessThanOrEqual(95);
    text += String.fromCharCode(v + 32);
  }
  return { text, start, check, symbols: vals, set };
}

/** minimal symbol count (start + data + code switches) over sets B/C: BFS, independent of the encoder */
function minSymbols(s: string): number {
  const n = s.length;
  const isD = (i: number) => i + 1 < n && /\d\d/.test(s.slice(i, i + 2));
  const key = (i: number, c: number) => i * 2 + c; // c: 0=B, 1=C
  const dist = new Map<number, number>([[key(0, 0), 1], [key(0, 1), 1]]);
  const queue: [number, number][] = [[0, 0], [0, 1]];
  for (let h = 0; h < queue.length; h++) {
    const [i, c] = queue[h];
    const d = dist.get(key(i, c))!;
    if (i === n) return d;
    const next: [number, number][] = c === 0 ? [[i + 1, 0], [i, 1]] : [...(isD(i) ? [[i + 2, 1] as [number, number]] : []), [i, 0]];
    for (const [ni, nc] of next) if (!dist.has(key(ni, nc))) { dist.set(key(ni, nc), d + 1); queue.push([ni, nc]); }
  }
  throw new Error('unreachable');
}

const roundTrip = (value: string, props: Record<string, unknown> = {}) => {
  const svg = parse(renderToStaticMarkup(<BarcodeSymbol value={value} {...props} />));
  const vals = decode(svg, (props.quietZoneModules as number | undefined) ?? 10);
  return { svg, vals, ...interpret(vals) };
};

const afterEachClean = () => vi.restoreAllMocks();
afterEach(afterEachClean);

describe('decoder self-check (ISO/IEC 15417 table typed into this file)', () => {
  it('106 symbol characters, each 6 elements summing to 11 modules, all distinct', () => {
    expect(PATTERNS).toHaveLength(106);
    for (const p of PATTERNS) {
      expect(p).toMatch(/^[1-4]{6}$/);
      expect([...p].reduce((s, c) => s + Number(c), 0), p).toBe(11);
    }
    expect(new Set(PATTERNS).size).toBe(106);
    expect(STOP.split('').reduce((s, c) => s + Number(c), 0)).toBe(13);
  });
  it('anchors: Start B 211214, Start C 211232, Code B 114131, Code C 113141 (value 100 / 99)', () => {
    expect([PATTERNS[104], PATTERNS[105], PATTERNS[100], PATTERNS[99]]).toEqual(['211214', '211232', '114131', '113141']);
  });
  it('checksum arithmetic matches the published worked example (Start A, "PJJ123C" -> 54)', () => {
    const v = [48, 42, 42, 17, 18, 19, 35];
    expect((103 + v.reduce((s, x, i) => s + x * (i + 1), 0)) % 103).toBe(54);
  });
});

describe('round trip through the independent decoder (AC: encode per ISO/IEC 15417, sets B and C)', () => {
  const VECTORS: [string, string][] = [
    ['1 character, letter', 'A'],
    ['1 character, digit', '7'],
    ['1 character, hyphen', '-'],
    ['all digits, even (2)', '12'],
    ['all digits, even (4)', '1234'],
    ['all digits, even (10)', '1234567890'],
    ['all digits, odd (3)', '123'],
    ['all digits, odd (5)', '12345'],
    ['all digits, odd (13)', '1234567890123'],
    ['all zeros', '000000'],
    ['letters only', 'ABCDEFG'],
    ['mixed, digit run in the middle', 'LAB-2026-000123'],
    ['mixed, digits then letter', '123456A'],
    ['mixed, letter then digits', 'A123456'],
    ['mixed, letter / digits / letter', 'A12345B'],
    ['mixed, short digit runs only', 'A1B2C3'],
    ['mixed, hyphenated pairs', '12-34-56'],
    ['mixed, two long runs', 'SPC0000012345XYZ9876'],
    ['32 characters, letters+digits', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
    ['32 characters, all digits', '12345678901234567890123456789012'],
    ['32 characters, hyphens and digits', '1234-5678-9012-3456-7890-1234-56'],
  ];

  it.each(VECTORS)('%s', (_n, value) => {
    expect(value).toMatch(/^[A-Z0-9-]{1,32}$/);
    const r = roundTrip(value);
    expect(r.text).toBe(value);
  });

  it('digit runs are packed: symbol count equals the independent minimum over sets B/C', () => {
    for (const [, v] of VECTORS) {
      const r = roundTrip(v);
      // symbols = start + data + switches (minSymbols) + checksum
      expect(r.symbols.length, v).toBe(minSymbols(v) + 1);
    }
  });

  it('all-digit even value uses Start C and exactly n/2 data symbols', () => {
    const r = roundTrip('1234567890');
    expect(r.start).toBe(START_C);
    expect(r.symbols).toHaveLength(1 + 5 + 1);
  });
  it('a single character (digit included) uses Start B', () => {
    expect(roundTrip('7').start).toBe(START_B);
    expect(roundTrip('A').start).toBe(START_B);
  });
  it('known vector "12": symbols [Start C, 12, checksum 14]', () => {
    expect(roundTrip('12').symbols).toEqual([105, 12, (105 + 12) % 103]);
  });
  it('known vector "A": symbols [Start B, 33, checksum 34]', () => {
    expect(roundTrip('A').symbols).toEqual([104, 33, (104 + 33) % 103]);
  });
  it('known vector "AB1234": Start B, A, B, Code C, 12, 34 (switch only where it pays)', () => {
    expect(roundTrip('AB1234').symbols.slice(0, -1)).toEqual([104, 33, 34, 99, 12, 34]);
  });
  // interpret() already rejects Start A, Code A, FNC1-4 and shift in every vector above (set B data <= 95, set C data < 100).
});

describe('code128Modules and the rendered viewBox', () => {
  it('returns an integer; equals the viewBox width for every vector (default quiet zones, 2 x 10)', () => {
    for (const v of ['A', '12', '1234567890', 'LAB-2026-000123', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', '12345678901234567890123456789012']) {
      const n = code128Modules(v);
      expect(Number.isInteger(n)).toBe(true);
      expect(viewBoxOf(parse(renderToStaticMarkup(<BarcodeSymbol value={v} />)))[2], v).toBe(n);
    }
  });
  it('equals 11*symbols + 13 (stop) + 2 quiet zones of 10, with symbols from the independent minimum', () => {
    for (const v of ['A', '7', '12', '123', 'AB1234', 'A123456', 'LAB-2026-000123', 'SPC0000012345XYZ9876']) {
      expect(code128Modules(v), v).toBe(11 * (minSymbols(v) + 1) + 13 + 20);
    }
  });
  it('hard-coded: "A" and "12" are 3 symbols each = 20 + 33 + 13 = 66 modules', () => {
    expect(code128Modules('A')).toBe(66);
    expect(code128Modules('12')).toBe(66);
  });
  it('quietZoneModules changes both quiet zones and the viewBox width only', () => {
    const base = code128Modules('AB-12');
    const r = roundTrip('AB-12', { quietZoneModules: 12 });
    expect(r.text).toBe('AB-12');
    expect(viewBoxOf(r.svg)[2]).toBe(base + 4);
  });
  it('showText does not change the module count or the decoded value', () => {
    for (const showText of [true, false]) {
      const r = roundTrip('LAB-2026-000123', { showText });
      expect(r.text).toBe('LAB-2026-000123');
      expect(viewBoxOf(r.svg)[2]).toBe(code128Modules('LAB-2026-000123'));
    }
  });
});

describe('invalid values throw and never echo the value (misidentification risk)', () => {
  const BAD: [string, unknown][] = [
    ['empty', ''],
    ['lowercase', 'zq-secret-77'],
    ['mixed case', 'LabSpecimen9'],
    ['space', 'AB CD1234'],
    ['trailing newline', 'ABC123\n'],
    ['33 characters', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'],
    ['non-ASCII Latin', 'ÀB1234'],
    ['Devanagari', 'सुनिता123'],
    ['underscore / slash / dot', 'AB_12/34.5'],
    ['markup', '<svg onload=alert(1)>'],
    ['null', null],
    ['undefined', undefined],
    ['number', 12345],
  ];

  const thrown = (fn: () => unknown) => {
    try { fn(); } catch (e) { return e as Error; }
    return null;
  };

  it.each(BAD)('code128Modules rejects %s', (_n, value) => {
    const e = thrown(() => code128Modules(value as string));
    expect(e, 'must throw').toBeInstanceOf(Error);
    if (typeof value === 'string' && value !== '') {
      expect(e!.message).not.toContain(value);
      expect(String(e)).not.toContain(value);
      expect(e!.stack ?? '').not.toContain(value);
    }
  });

  it.each(BAD)('BarcodeSymbol rejects %s (renders nothing, no guess, no truncation)', (_n, value) => {
    let markup = '';
    const e = thrown(() => { markup = renderToStaticMarkup(<BarcodeSymbol value={value as string} />); });
    expect(e, 'must throw, not render').toBeInstanceOf(Error);
    expect(markup).toBe('');
    if (typeof value === 'string' && value !== '') {
      expect(e!.message).not.toContain(value);
      expect(e!.stack ?? '').not.toContain(value);
    }
  });

  it('error message does not even contain a 4+ character fragment of a rejected value', () => {
    const v = 'zq-secret-77';
    const e = thrown(() => code128Modules(v))!;
    for (let i = 0; i + 4 <= v.length; i++) expect(e.message).not.toContain(v.slice(i, i + 4));
  });

  it('boundary: 32 characters is accepted, 33 is not; 1 accepted, 0 is not', () => {
    expect(() => code128Modules('A'.repeat(32))).not.toThrow();
    expect(() => code128Modules('A'.repeat(33))).toThrow();
    expect(() => code128Modules('A')).not.toThrow();
    expect(() => code128Modules('')).toThrow();
  });
});

describe('value exposure and logging', () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;
  const spy = () => methods.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

  it('console.* is never called for valid or invalid values', () => {
    const spies = spy();
    for (const v of ['A', '12', 'LAB-2026-000123']) { code128Modules(v); renderToStaticMarkup(<BarcodeSymbol value={v} showText />); }
    for (const v of ['bad value', '', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456']) {
      try { code128Modules(v); } catch { /* expected */ }
      try { renderToStaticMarkup(<BarcodeSymbol value={v} />); } catch { /* expected */ }
    }
    render(<BarcodeSymbol value="ZXQ-7K" showText />);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('showText=false: the value appears only in the aria-label (not in any text node, title, attribute or geometry)', () => {
    const markup = renderToStaticMarkup(<BarcodeSymbol value="ZXQ-7K" showText={false} />);
    const svg = parse(markup);
    expect(svg.getAttribute('aria-label')).toContain('ZXQ-7K');
    const stripped = markup.replace(/aria-label="[^"]*"/, '');
    expect(stripped).not.toContain('ZXQ-7K');
    expect(svg.querySelector('title,desc')).toBeNull();
    expect(svg.textContent ?? '').not.toContain('ZXQ-7K');
  });

  it('showText=true: the value is one text node whose content is exactly the value, plus the aria-label', () => {
    const markup = renderToStaticMarkup(<BarcodeSymbol value="ZXQ-7K" showText />);
    const svg = parse(markup);
    expect(svg.textContent!.trim()).toBe('ZXQ-7K');
    expect(svg.getAttribute('aria-label')).toContain('ZXQ-7K');
    expect(markup.replace(/aria-label="[^"]*"/, '').split('ZXQ-7K')).toHaveLength(2); // exactly one other occurrence
  });

  it('markup is inert: role=img, crispEdges, no script/style/image/use/foreignObject/links/handlers', () => {
    for (const showText of [true, false]) {
      const markup = renderToStaticMarkup(<BarcodeSymbol value="AB-1234" showText={showText} />);
      const svg = parse(markup);
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.getAttribute('aria-label')).toBeTruthy();
      expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
      expect(markup).not.toMatch(/<(script|style|image|use|foreignObject|a|iframe|link)\b/i);
      expect(markup).not.toMatch(/\son[a-z]+=|href=|src=|javascript:|data:|url\(/i);
    }
  });
});

describe('sizing in millimetres', () => {
  const mm = (v: string | null) => {
    expect(v, 'width/height attr must be "<n>mm"').toMatch(/^\d+(\.\d+)?mm$/);
    return parseFloat(v!);
  };
  it('moduleWidthMm: svg width = modules x moduleWidthMm mm; viewBox stays in modules', () => {
    for (const w of [0.25, 0.33, 0.5]) {
      const svg = parse(renderToStaticMarkup(<BarcodeSymbol value="LAB-2026-000123" moduleWidthMm={w} />));
      expect(mm(svg.getAttribute('width'))).toBeCloseTo(code128Modules('LAB-2026-000123') * w, 3);
      expect(viewBoxOf(svg)[2]).toBe(code128Modules('LAB-2026-000123'));
    }
  });
  it('does not enforce the 0.25 mm minimum (C5 LabelRenderer does, TRD s4.6)', () => {
    expect(() => renderToStaticMarkup(<BarcodeSymbol value="A" moduleWidthMm={0.1} />)).not.toThrow();
  });
  it('heightMm (no text): svg height = heightMm mm', () => {
    const svg = parse(renderToStaticMarkup(<BarcodeSymbol value="A" heightMm={12} showText={false} />));
    expect(mm(svg.getAttribute('height'))).toBeCloseTo(12, 3);
  });
});

describe('axe (AC-0D-8.6)', () => {
  it.each([[true], [false]])('no critical/serious violation, showText=%s', async (showText) => {
    render(<BarcodeSymbol value="LAB-2026-000123" showText={showText} moduleWidthMm={0.33} />);
    expect(await seriousViolations(document.body)).toEqual([]);
  });
  it('is exposed as a single named image', () => {
    const { container } = render(<BarcodeSymbol value="ZXQ-7K" />);
    const imgs = container.querySelectorAll('[role=img]');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('aria-label')).toMatch(/ZXQ-7K/);
  });
});
