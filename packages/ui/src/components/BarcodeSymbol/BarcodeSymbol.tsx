// T0D-12c / LD-107 (CR-C11-007, CR-C5-T10-001): Code 128 (ISO/IEC 15417) SVG symbol, code sets B and C only.
// A wrong barcode on a specimen label is a misidentification risk: invalid values throw (never a guess, never truncated, never stripped),
// the error never contains the value, and the value is never logged. Pure render: works in react-dom/server renderToStaticMarkup.
// The 0.25 mm minimum module width is NOT enforced here; C5 LabelRenderer does (TRD s4.6).

// Symbol character widths (bar, space, bar, space, bar, space), values 0..105.
const WIDTHS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232'
).split(' ');
const STOP = '2331112'; // 13 modules
const CODE_C = 99;
const CODE_B = 100;
const START_B = 104;
const START_C = 105;
const VALID = /^[A-Z0-9-]{1,32}$/;
const DEFAULT_QUIET = 10;

function assertValid(value: unknown): asserts value is string {
  // Never include the value in this message (LD-107).
  if (typeof value !== 'string' || !VALID.test(value)) throw new Error('BarcodeSymbol: value must be 1-32 characters of A-Z, 0-9 or hyphen');
}

/** Symbol values start..checksum with the fewest symbols over sets B/C (digit pairs packed in C). */
function encode(value: string): number[] {
  const n = value.length;
  const pair = (i: number) => i + 1 < n && /^\d\d$/.test(value.slice(i, i + 2));
  // costB[i] / costC[i]: symbols needed for value[i..] when currently in set B / C
  const costB = new Array<number>(n + 1).fill(0);
  const costC = new Array<number>(n + 1).fill(0);
  const stay = (i: number): [number, number] => [1 + costB[i + 1]!, pair(i) ? 1 + costC[i + 2]! : Infinity];
  for (let i = n - 1; i >= 0; i--) {
    const [stayB, stayC] = stay(i);
    costB[i] = Math.min(stayB, 1 + stayC);
    costC[i] = Math.min(stayC, 1 + stayB);
  }
  let set = costC[0]! < costB[0]! ? 1 : 0;
  const out = [set ? START_C : START_B];
  for (let i = 0; i < n; ) {
    const [stayB, stayC] = stay(i);
    if (set === 0 && stayB > 1 + stayC) { out.push(CODE_C); set = 1; }
    else if (set === 1 && stayC > 1 + stayB) { out.push(CODE_B); set = 0; }
    if (set === 1) { out.push(Number(value.slice(i, i + 2))); i += 2; }
    else { out.push(value.charCodeAt(i) - 32); i += 1; }
  }
  out.push(out.reduce((s, v, i) => s + v * Math.max(i, 1), 0) % 103);
  return out;
}

function quiet(q: number | undefined): number {
  const v = q ?? DEFAULT_QUIET;
  if (!Number.isInteger(v) || v < 0) throw new Error('BarcodeSymbol: quietZoneModules must be a non-negative integer');
  return v;
}

const bodyModules = (symbols: number) => symbols * 11 + 13;

/** Total module count of the symbol for `value`, including both default quiet zones (10 modules each). */
export function code128Modules(value: string): number {
  assertValid(value);
  return bodyModules(encode(value).length) + 2 * DEFAULT_QUIET;
}

export interface BarcodeSymbolProps {
  value: string;
  moduleWidthMm?: number;
  heightMm?: number;
  quietZoneModules?: number;
  showText?: boolean;
}

const DEFAULT_HEIGHT = 50; // modules, when heightMm/moduleWidthMm do not fix it
const TEXT_BAND = 12; // modules reserved under the bars for the human-readable line
const mm = (v: number) => `${Number(v.toFixed(4))}mm`;

export function BarcodeSymbol({ value, moduleWidthMm, heightMm, quietZoneModules, showText = false }: BarcodeSymbolProps) {
  assertValid(value);
  const q = quiet(quietZoneModules);
  const symbols = encode(value);
  const W = bodyModules(symbols.length) + 2 * q;
  const H = heightMm && moduleWidthMm ? Math.max(1 + (showText ? TEXT_BAND : 0), Math.round(heightMm / moduleWidthMm)) : DEFAULT_HEIGHT + (showText ? TEXT_BAND : 0);
  const barH = H - (showText ? TEXT_BAND : 0);

  // Elements alternate bar/space across all symbols (each symbol has 6 elements, the stop 7 starting and ending with a bar).
  const elements: [number, number][] = [];
  let x = q;
  for (const w of [...symbols.map((s) => WIDTHS[s]), STOP].join('')) {
    elements.push([x, Number(w)]);
    x += Number(w);
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={moduleWidthMm ? mm(W * moduleWidthMm) : undefined}
      height={heightMm ? mm(heightMm) : undefined}
      preserveAspectRatio="none"
      role="img"
      aria-label={value}
      shapeRendering="crispEdges"
    >
      {/* Literal black on white whatever the theme: scanners need the contrast (LD-107). */}
      <rect x={0} y={0} width={W} height={H} fill="#fff" />
      {elements.filter((_, i) => i % 2 === 0).map(([bx, bw]) => (
        <rect key={bx} x={bx} y={0} width={bw} height={barH} fill="#000" />
      ))}
      {showText && (
        <text x={W / 2} y={H - 2} textAnchor="middle" fontSize={10} fontFamily="'Noto Sans Mono', monospace" fill="#000">
          {value}
        </text>
      )}
    </svg>
  );
}
