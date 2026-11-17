// QR Model 2 encoder: byte mode, error-correction level M (04-UI-UX §3.2 [CONV]), versions 1–10 (<= 213 bytes), mask by the
// standard penalty rules. Pure, no network, deterministic: same text -> same image.
// [CONV] in-tree until C0 pins a QR encoder package (02-TRD §1 "QR code encoder: C0 pins"; .orchestra/cr/C6-T07.nonblocking.md).
// ponytail: versions 1–10 only; a verify URL is ~60 bytes. Extend the two tables if a longer payload ever appears.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

const rawModules = (v: number): number => {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
};
const rawCodewords = (v: number) => Math.floor(rawModules(v) / 8);
const dataCodewords = (v: number) => rawCodewords(v) - ECC_PER_BLOCK[v]! * BLOCKS[v]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(deg: number): number[] {
  const r = new Array<number>(deg).fill(0);
  r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < deg) r[j]! ^= r[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return r;
}
/** Reed–Solomon ECC codewords of `data` (exported for the self-check). */
export function rsRemainder(data: readonly number[], deg: number): number[] {
  const div = rsDivisor(deg);
  const r = new Array<number>(deg).fill(0);
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    div.forEach((c, i) => (r[i]! ^= gfMul(c, f)));
  }
  return r;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0;
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]!))];
  for (const l of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && l[i] === l[i - 1]) run++;
      else {
        if (run >= 5) p += run - 2;
        run = 1;
      }
    }
    const s = `0000${l.map((b) => (b ? '1' : '0')).join('')}0000`;
    for (const pat of ['10111010000', '00001011101']) for (let k = s.indexOf(pat); k !== -1; k = s.indexOf(pat, k + 1)) p += 40;
  }
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y]![x]) dark++;
      if (x < n - 1 && y < n - 1) {
        const c = m[y]![x];
        if (m[y]![x + 1] === c && m[y + 1]![x] === c && m[y + 1]![x + 1] === c) p += 3;
      }
    }
  }
  return p + (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let v = 1;
  while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(v) * 8) v++;
  if (v > 10) throw new Error('qr payload too long');

  const bits: number[] = [];
  const put = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // blocks + interleave
  const nb = BLOCKS[v]!, ecl = ECC_PER_BLOCK[v]!, raw = rawCodewords(v);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, (k += shortLen - ecl + (i < nShort ? 0 : 1)));
    const e = rsRemainder(d, ecl);
    if (i < nShort) d.push(0);
    blocks.push([...d, ...e]);
  }
  const cw: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => (i !== shortLen - ecl || j >= nShort) && cw.push(b[i]!));

  const n = 17 + 4 * v;
  const m = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (x: number, y: number, d: boolean) => {
    m[y]![x] = d;
    fn[y]![x] = true;
  };
  for (let i = 0; i < n; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < n && y >= 0 && y < n) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align: number[] = [];
  if (v > 1) {
    const na = Math.floor(v / 7) + 2;
    const step = Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2;
    align.push(6);
    for (let pos = n - 7; align.length < na; pos -= step) align.splice(1, 0, pos);
  }
  const last = align.length - 1;
  align.forEach((cx, i) =>
    align.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const drawFormat = (mask: number) => {
    const d = (0b00 << 3) | mask; // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    const b = (i: number) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6));
    set(8, 8, b(7));
    set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, b(i));
    set(8, n - 8, true);
  };
  drawFormat(0); // reserve the format area
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bt = ((vb >>> i) & 1) !== 0, a = n - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bt);
      set(b, a, bt);
    }
  }
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (!fn[y]![x] && i < cw.length * 8) {
          m[y]![x] = ((cw[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
  const applyMask = (k: number) => {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y]![x] && MASKS[k]!(x, y)) m[y]![x] = !m[y]![x];
  };
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) {
    applyMask(k);
    drawFormat(k);
    const p = penalty(m);
    if (p < bestP) [best, bestP] = [k, p];
    applyMask(k);
  }
  applyMask(best);
  drawFormat(best);
  return m;
}

/** data: URI of an SVG QR image with a 4-module quiet zone. */
export function qrDataUri(text: string): string {
  const m = qrMatrix(text);
  const q = 4, s = m.length + 2 * q;
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x + q} ${y + q}h1v1h-1z`)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
