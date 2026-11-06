// Tenant accent derivation (04-UI-UX §1.6, AC-0D-8.2).
export const DEFAULT_ACCENT = '#1D4ED8';
const WHITE = '#FFFFFF';
const DARK = '#0F172A';
const HEX = /^#[0-9A-Fa-f]{6}$/;
const STEP = 0.02;

export interface DerivedAccent {
  accent: string;
  fg: string;
  subtle: string;
  link: string;
}

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb: Rgb): string =>
  '#' + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase();

const lin = (c: number): number => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// sRGB <-> OKLab (Ottosson). Lightness is the only channel changed; a/b (chroma, hue) kept.
const toLinear = (c: number): number => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number): number => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toOklab(hex: string): Rgb {
  const [r, g, b] = toRgb(hex).map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: Rgb): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return toHex([
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

/** Darken in OKLCH lightness steps of 0.02 until white reaches 4.5:1 (terminates at black = 21:1). */
function darkenUntilWhitePasses(hex: string): string {
  const [L0, a, b] = toOklab(hex);
  let out = hex;
  for (let L = L0; contrast(WHITE, out) < 4.5; ) {
    L = Math.max(0, L - STEP);
    out = L === 0 ? '#000000' : fromOklab([L, a, b]);
  }
  return out;
}

export function deriveAccent(input?: unknown): DerivedAccent {
  const accentIn = typeof input === 'string' && HEX.test(input) ? input.toUpperCase() : DEFAULT_ACCENT;
  const onWhite = contrast(WHITE, accentIn);
  const onDark = contrast(DARK, accentIn);
  let accent = accentIn;
  let fg: string;
  if (Math.max(onWhite, onDark) >= 4.5) {
    fg = onWhite >= onDark ? WHITE : DARK;
  } else {
    accent = darkenUntilWhitePasses(accentIn);
    fg = WHITE;
  }
  // [CONV] subtle = color-mix(in srgb, accent 8%, white): a light tint, matching the default token #EFF6FF.
  const subtle = toHex(toRgb(accent).map((c) => 255 + (c - 255) * 0.08) as Rgb);
  return { accent, fg, subtle, link: darkenUntilWhitePasses(accent) };
}
