// Test helper (C6-T05): minimal PDF text extraction, no dependencies (02-TRD §14 "pixel-independent assertions via PDF text extraction").
// Handles Chromium/Skia output: FlateDecode streams, Type0/Identity-H fonts with /ToUnicode CMaps, classic xref objects (no object streams).
import { inflateSync } from 'node:zlib';

type Obj = { dict: string; stream?: Buffer };

function parseObjects(pdf: Buffer): Map<number, Obj> {
  const s = pdf.toString('latin1');
  const objs = new Map<number, Obj>();
  const re = /(\d+) 0 obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const sIdx = s.indexOf('stream', start);
    const eIdx = s.indexOf('endobj', start);
    let obj: Obj;
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
      obj = { dict, stream: data };
      re.lastIndex = end;
    } else {
      obj = { dict: s.slice(start, eIdx) };
      re.lastIndex = eIdx;
    }
    objs.set(num, obj);
  }
  return objs;
}

const refs = (t: string) => [...t.matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1]));

function inlineOrRef(objs: Map<number, Obj>, text: string, key: string): string {
  const m = new RegExp(`/${key}\\s*(<<[\\s\\S]*?>>|(\\d+) 0 R)`).exec(text);
  if (!m) return '';
  return m[2] ? (objs.get(Number(m[2]))?.dict ?? '') : m[1];
}

function hexToBytes(h: string): number[] {
  const c = h.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i < c.length; i += 2) out.push(parseInt(c.slice(i, i + 2).padEnd(2, '0'), 16));
  return out;
}

const uni = (hex: string) => {
  const b = hexToBytes(hex);
  let r = '';
  for (let i = 0; i + 1 < b.length; i += 2) r += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  return r;
};

type CMap = { width: number; map: Map<number, string> };

function parseCMap(text: string): CMap {
  const map = new Map<number, string>();
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  let width = cs ? cs[1]!.length / 2 : 0;
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const e of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      if (!width) width = e[1]!.length / 2;
      map.set(parseInt(e[1]!, 16), uni(e[2]!));
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const e of blk[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      if (!width) width = e[1]!.length / 2;
      const a = parseInt(e[1]!, 16);
      const b = parseInt(e[2]!, 16);
      if (e[3]!.startsWith('[')) {
        [...e[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((x, i) => map.set(a + i, uni(x[1]!)));
      } else {
        const base = uni(e[3]!.slice(1, -1));
        for (let c = a; c <= b; c++) {
          map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - a)));
        }
      }
    }
  }
  return { width: width || 1, map };
}

function decode(cm: CMap | undefined, bytes: number[]): string {
  if (!cm) return String.fromCharCode(...bytes);
  let r = '';
  for (let i = 0; i + cm.width <= bytes.length; i += cm.width) {
    let code = 0;
    for (let k = 0; k < cm.width; k++) code = (code << 8) | bytes[i + k]!;
    r += cm.map.get(code) ?? '';
  }
  return r;
}

function litBytes(l: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < l.length - 1; i++) {
    if (l[i] === '\\') {
      i++;
      const c = l[i]!;
      if (/[0-7]/.test(c)) {
        let o = c;
        while (o.length < 3 && /[0-7]/.test(l[i + 1] ?? '')) o += l[++i];
        out.push(parseInt(o, 8));
      } else out.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[c] ?? c.charCodeAt(0));
    } else out.push(l.charCodeAt(i));
  }
  return out;
}

function pageOrder(objs: Map<number, Obj>): number[] {
  const root = [...objs.entries()].find(([, o]) => /\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent/.test(o.dict));
  const walk = (n: number): number[] => {
    const o = objs.get(n);
    if (!o) return [];
    if (/\/Type\s*\/Page\b(?!s)/.test(o.dict)) return [n];
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? '';
    return refs(kids).flatMap(walk);
  };
  if (root) return walk(root[0]);
  return [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page\b(?!s)/.test(o.dict)).map(([n]) => n);
}

/** Text of every page, in page order. Text-showing operators are joined with '\n'. */
export function pdfPages(pdf: Uint8Array): string[] {
  const buf = Buffer.from(pdf);
  const objs = parseObjects(buf);
  const cmaps = new Map<number, CMap | undefined>();
  const fontCMap = (n: number) => {
    if (!cmaps.has(n)) {
      const tu = refs(/\/ToUnicode\s*(\d+ 0 R)/.exec(objs.get(n)?.dict ?? '')?.[1] ?? '')[0];
      const st = tu ? objs.get(tu)?.stream : undefined;
      cmaps.set(n, st ? parseCMap(st.toString('latin1')) : undefined);
    }
    return cmaps.get(n);
  };
  return pageOrder(objs).map((pn) => {
    const page = objs.get(pn)!;
    const res = inlineOrRef(objs, page.dict, 'Resources');
    const fonts = new Map<string, number>();
    for (const f of inlineOrRef(objs, res, 'Font').matchAll(/\/([^\s/<>\[\]]+)\s+(\d+) 0 R/g)) {
      fonts.set(f[1]!, Number(f[2]));
    }
    const cont = /\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? '';
    const content = refs(cont).map((n) => objs.get(n)?.stream?.toString('latin1') ?? '').join('\n');
    const lines: string[] = [];
    let cur: CMap | undefined;
    const tok =
      /\/([^\s/<>\[\]()]+)\s+[-\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|(<[0-9a-fA-F\s]*>|\((?:[^)\\]|\\.)*\))\s*Tj/g;
    for (const t of content.matchAll(tok)) {
      if (t[1] !== undefined) {
        const fn = fonts.get(t[1]);
        cur = fn !== undefined ? fontCMap(fn) : undefined;
      } else if (t[2] !== undefined) {
        let s = '';
        for (const p of t[2].matchAll(/<([0-9a-fA-F\s]*)>|(\((?:[^)\\]|\\.)*\))/g)) {
          s += decode(cur, p[1] !== undefined ? hexToBytes(p[1]) : litBytes(p[2]!));
        }
        lines.push(s);
      } else if (t[3] !== undefined) {
        lines.push(decode(cur, t[3].startsWith('<') ? hexToBytes(t[3].slice(1, -1)) : litBytes(t[3])));
      }
    }
    return lines.join('\n');
  });
}

export const pdfText = (pdf: Uint8Array) => pdfPages(pdf).join('\n\f\n');

/** Base font names (subset prefix stripped) declared anywhere in the file. */
export function pdfFontNames(pdf: Uint8Array): string[] {
  const s = Buffer.from(pdf).toString('latin1');
  return [...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/<>\[\]()]+)/g)].map((m) => m[1]!))];
}

/** Whitespace-collapsed, NFC-normalised, for substring assertions. */
export const norm = (t: string) => t.normalize('NFC').replace(/\s+/g, ' ').trim();
