// Test helper (C6-T12): where did a text label land on each page? Dependency-free (no pdf-lib/qpdf), classic-xref PDFs only.
// Tracks q/Q/cm and Tm/Td so the answer is in page user space whatever way the stamp was drawn. Synthetic data only.
import { inflateSync } from 'node:zlib';

type Obj = { dict: string; stream?: Buffer };
type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

function parseObjects(pdf: Buffer): Map<number, Obj> {
  const s = pdf.toString('latin1');
  const objs = new Map<number, Obj>();
  const re = /(\d+) 0 obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const sIdx = s.indexOf('stream', start);
    const eIdx = s.indexOf('endobj', start);
    if (sIdx !== -1 && sIdx < eIdx && !/\bendobj\b/.test(s.slice(start, sIdx))) {
      const dict = s.slice(start, sIdx);
      let b = sIdx + 'stream'.length;
      if (s[b] === '\r') b++;
      if (s[b] === '\n') b++;
      const end = s.indexOf('endstream', b);
      let data = Buffer.from(s.slice(b, end), 'latin1');
      if (/FlateDecode/.test(dict)) {
        try {
          data = inflateSync(data);
        } catch {
          /* leave raw */
        }
      }
      objs.set(Number(m[1]), { dict, stream: data });
      re.lastIndex = end;
    } else {
      objs.set(Number(m[1]), { dict: s.slice(start, eIdx) });
      re.lastIndex = eIdx;
    }
  }
  return objs;
}

const refs = (t: string) => [...t.matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1]));

function pageObjects(objs: Map<number, Obj>): number[] {
  const root = [...objs.entries()].find(([, o]) => /\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent/.test(o.dict));
  const walk = (n: number): number[] => {
    const o = objs.get(n);
    if (!o) return [];
    if (/\/Type\s*\/Page\b(?!s)/.test(o.dict)) return [n];
    return refs(/\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? '').flatMap(walk);
  };
  return root ? walk(root[0]) : [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page\b(?!s)/.test(o.dict)).map(([n]) => n);
}

/** Page attribute, inherited through /Parent. Returns the raw value text or undefined. */
function inherited(objs: Map<number, Obj>, pageNum: number, key: string): string | undefined {
  for (let n: number | undefined = pageNum, hops = 0; n !== undefined && hops < 16; hops++) {
    const d: string = objs.get(n)?.dict ?? '';
    const v = new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|-?\\d+(?!\\s+\\d+\\s+R)|\\d+ 0 R)`).exec(d)?.[1];
    if (v) {
      const r = /^(\d+) 0 R$/.exec(v);
      return r ? objs.get(Number(r[1]))?.dict.trim() : v;
    }
    n = refs(/\/Parent\s*(\d+ 0 R)/.exec(d)?.[1] ?? '')[0];
  }
  return undefined;
}

const nums = (t: string) => [...t.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);

export type Placed = {
  /** text origin (left end of the baseline) in page user space */
  x: number;
  y: number;
  /** unit vector of the text direction in page user space */
  dx: number;
  dy: number;
};
export type PageGeometry = { box: [number, number, number, number]; rotate: number; found: Placed | undefined };

function decodeString(tok: string): string {
  if (tok.startsWith('<')) {
    const h = tok.replace(/[^0-9a-fA-F]/g, '');
    let r = '';
    for (let i = 0; i + 1 < h.length; i += 2) r += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
    return r;
  }
  return tok.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) =>
    /^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c
  );
}

function findText(content: string, needle: string): Placed | undefined {
  const tok = /(\((?:[^)\\]|\\.)*\)|<[0-9a-fA-F\s]*>)|(-?\d*\.?\d+)|\/[^\s/<>\[\]()]+|(\[|\])|([A-Za-z'"*]+)/g;
  let ctm = I;
  const stack: M[] = [];
  let tm = I;
  let ops: (string | number)[] = [];
  let inArray = false;
  let arrText = '';
  let hit: Placed | undefined;
  const record = (text: string) => {
    if (hit || !text.includes(needle)) return;
    const x = tm[4] * ctm[0] + tm[5] * ctm[2] + ctm[4];
    const y = tm[4] * ctm[1] + tm[5] * ctm[3] + ctm[5];
    const dx = tm[0] * ctm[0] + tm[1] * ctm[2];
    const dy = tm[0] * ctm[1] + tm[1] * ctm[3];
    const len = Math.hypot(dx, dy) || 1;
    hit = { x, y, dx: dx / len, dy: dy / len };
  };
  for (const t of content.matchAll(tok)) {
    if (t[1] !== undefined) {
      if (inArray) arrText += decodeString(t[1]);
      else ops.push(t[1]);
    } else if (t[2] !== undefined) ops.push(Number(t[2]));
    else if (t[3] !== undefined) {
      inArray = t[3] === '[';
      if (inArray) arrText = '';
    } else if (t[4] !== undefined) {
      const op = t[4];
      const n = ops.filter((o): o is number => typeof o === 'number');
      if (op === 'q') stack.push(ctm);
      else if (op === 'Q') ctm = stack.pop() ?? I;
      else if (op === 'cm' && n.length === 6) ctm = mul(n as M, ctm);
      else if (op === 'BT') tm = I;
      else if (op === 'Tm' && n.length === 6) tm = n as M;
      else if (op === 'Td' && n.length === 2) tm = mul([1, 0, 0, 1, n[0]!, n[1]!], tm);
      else if (op === 'Tj') record(typeof ops[0] === 'string' ? decodeString(ops[0]) : '');
      else if (op === 'TJ') record(arrText);
      ops = [];
    }
  }
  return hit;
}

/** For each page (in order): effective CropBox (else MediaBox), /Rotate, and where `needle` was drawn. */
export function locateText(pdf: Uint8Array, needle: string): PageGeometry[] {
  const objs = parseObjects(Buffer.from(pdf));
  return pageObjects(objs).map((pn) => {
    const page = objs.get(pn)!;
    const b = nums(inherited(objs, pn, 'CropBox') ?? inherited(objs, pn, 'MediaBox') ?? '[0 0 612 792]');
    const r = Number(inherited(objs, pn, 'Rotate') ?? 0);
    const cont = /\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? '';
    const ids = refs(cont).flatMap((n) => {
      const o = objs.get(n);
      return o && !o.stream && o.dict.trim().startsWith('[') ? refs(o.dict) : [n];
    });
    const content = ids.map((n) => objs.get(n)?.stream?.toString('latin1') ?? '').join('\n');
    return {
      box: [Math.min(b[0]!, b[2]!), Math.min(b[1]!, b[3]!), Math.max(b[0]!, b[2]!), Math.max(b[1]!, b[3]!)],
      rotate: ((r % 360) + 360) % 360,
      found: findText(content, needle),
    };
  });
}

/**
 * Where the label sits as a reader sees it: origin in display coordinates (0,0 = bottom-left of the screen, y up),
 * the display size, and the on-screen text direction. /Rotate turns the page clockwise.
 */
export function onScreen(g: PageGeometry) {
  const f = g.found;
  if (!f) return undefined;
  const [x0, y0, x1, y1] = g.box;
  const w = x1 - x0;
  const h = y1 - y0;
  const px = f.x - x0;
  const py = f.y - y0;
  switch (g.rotate) {
    case 90:
      return { sx: py, sy: w - px, W: h, H: w, dx: f.dy, dy: -f.dx };
    case 180:
      return { sx: w - px, sy: h - py, W: w, H: h, dx: -f.dx, dy: -f.dy };
    case 270:
      return { sx: h - py, sy: px, W: h, H: w, dx: -f.dy, dy: f.dx };
    default:
      return { sx: px, sy: py, W: w, H: h, dx: f.dx, dy: f.dy };
  }
}
