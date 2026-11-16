// T0B-SWEEP-2 (LD-270 done_when 2): type-correct minimal request from the OpenAPI schema (moved out of run.ts; SWEEP-1 sent payload '{}').
// Required fields only; placeholder of the right type / format / enum / bounds / pattern; values named in `ids` (seeded row ids) win.
import { randomUUID } from 'node:crypto';
import type { Operation } from './ops.js';

type S = Record<string, any>;
const SAMPLE_UUID = '0193a5c0-0000-7000-8000-0000000000ff';   // v7 shape: matches the generic and the v7 uuid patterns

/** One string the regex accepts: first alternative, first class member, `rep(min,max)` repetitions. Handles the contract subset. */
function fromRegex(src: string, rep: (min: number, max: number) => number): string {
  let i = 0;
  const atom = (): string[] => {          // returns candidate chars/strings for one atom
    const c = src[i++]!;
    if (c === '\\') {
      const e = src[i++]!;
      if (e === 'd') return ['1'];
      if (e === 'w') return ['a'];
      if (e === 's') return [' '];
      if (e === 'x') { const h = src.slice(i, i + 2); i += 2; return [String.fromCharCode(parseInt(h, 16))]; }
      return [e];
    }
    if (c === '[') {
      const neg = src[i] === '^';
      if (neg) i++;
      const members: string[] = [];
      while (i < src.length && src[i] !== ']') {
        let a = src[i++]!;
        if (a === '\\') { const e = src[i++]!; a = e === 'x' ? String.fromCharCode(parseInt(src.slice(i, (i += 2)), 16)) : e === 'd' ? '1' : e; }
        if (src[i] === '-' && src[i + 1] !== ']' && src[i + 1] !== undefined) {   // range a-b: `a` is a member; skip the end
          i++;
          if (src[i++] === '\\') i += src[i] === 'x' ? 3 : 1;
        }
        members.push(a);
      }
      i++;
      return neg ? ['a'] : members.length ? [members.find((m) => m !== ' ') ?? members[0]!] : ['a'];
    }
    if (c === '(') {
      if (src.startsWith('?:', i)) i += 2;
      const alts: string[] = [];
      let cur = '';
      for (;;) {
        if (i >= src.length) break;
        if (src[i] === ')') { i++; break; }
        if (src[i] === '|') { i++; alts.push(cur); cur = ''; continue; }
        cur += piece();
      }
      alts.push(cur);
      return [alts[0]!];
    }
    if (c === '.') return ['a'];
    return [c];
  };
  const piece = (): string => {
    const a = atom()[0]!;
    const q = src[i];
    let min = 1, max = 1;
    if (q === '*') { i++; min = 0; max = Infinity; }
    else if (q === '+') { i++; min = 1; max = Infinity; }
    else if (q === '?') { i++; min = 0; max = 1; }
    else if (q === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (m) { i += m[0].length; min = Number(m[1]); max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min; }
    }
    return a.repeat(rep(min, max));
  };
  let out = '';
  while (i < src.length) {
    if (src[i] === '^' || src[i] === '$') { i++; continue; }
    if (src[i] === '|') break;               // top-level alternation: first branch
    out += piece();
  }
  return out;
}

function patterned(s: S): string | undefined {
  const lo = s.minLength ?? 0, hi = s.maxLength ?? Infinity;
  let re: RegExp;
  try { re = new RegExp(s.pattern, 'u'); } catch { return undefined; }
  const policies = [(a: number) => a, (a: number, b: number) => Math.min(b, Math.max(a, 1)), (a: number, b: number) => Math.min(b, Math.max(a, 8)),
    (a: number, b: number) => Math.min(b, Math.max(a, lo))];
  for (const p of policies) {
    const v = fromRegex(s.pattern, p);
    if (re.test(v) && v.length >= lo && v.length <= hi) return v;
  }
  return undefined;
}

const typeOf = (s: S): string | undefined => (Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type);

/** allOf merged into one schema; the first oneOf/anyOf branch merged in (union bodies). */
function flatten(s: S): S {
  let out: S = { ...s };
  const merge = (a: S, b: S): S => ({
    ...a, ...b,
    ...(a.properties || b.properties ? { properties: { ...(a.properties ?? {}), ...(b.properties ?? {}) } } : {}),
    ...(a.required || b.required ? { required: [...new Set([...(a.required ?? []), ...(b.required ?? [])])] } : {}),
  });
  if (Array.isArray(out.allOf)) { const parts = out.allOf as S[]; delete out.allOf; for (const p of parts) out = merge(out, flatten(p)); }
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(out[k]) && out[k].length) { const first = flatten(out[k][0]); delete out[k]; delete out.discriminator; out = merge(out, first); }
  }
  return out;
}

export function sampleValue(schema: S | undefined, name = '', ids: Record<string, string> = {}, salt = 0): unknown {
  const s = flatten(schema ?? {});
  if (ids[name] !== undefined) return ids[name];
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) { const e = s.enum.filter((x: unknown) => x !== null); return e[salt % e.length] ?? s.enum[0]; }
  const t = typeOf(s) ?? (s.properties ? 'object' : s.items ? 'array' : 'string');
  if (t === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of s.required ?? []) o[k] = sampleValue(s.properties?.[k] ?? {}, k, ids);
    return o;
  }
  if (t === 'array') {
    const n = Math.max(s.minItems ?? 0, 0);
    return Array.from({ length: n }, (_, j) => sampleValue(s.items ?? {}, name, {}, j));
  }
  if (t === 'boolean') return false;
  if (t === 'integer' || t === 'number') {
    let v = s.minimum ?? (typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : undefined) ?? (s.maximum !== undefined && s.maximum < 1 ? s.maximum : 1);
    if (s.multipleOf) v = Math.ceil(v / s.multipleOf) * s.multipleOf;
    if (s.maximum !== undefined && v > s.maximum) v = s.maximum;
    return t === 'integer' ? Math.ceil(v) : v;
  }
  // string
  if (s.format === 'uuid') return salt ? SAMPLE_UUID.slice(0, -4) + String(salt).padStart(4, '0') : SAMPLE_UUID;
  if (s.format === 'date-time') return '2026-11-16T00:00:00.000Z';
  if (s.format === 'date') return '2026-11-16';
  if (s.format === 'email') return 'sweep@example.test';
  if (typeof s.pattern === 'string') {
    const v = patterned(s);
    if (v !== undefined) return salt && /^[A-Za-z]+$/.test(v) ? v + 'abcdefghij'[salt % 10] : v;
  }
  if (s.example !== undefined && typeof s.example === 'string') return s.example;
  const lo = s.minLength ?? 0, hi = s.maxLength ?? Infinity;
  let v = salt ? `sweep${salt}` : 'sweep';
  if (v.length < lo) v = v.padEnd(lo, 'x');
  if (v.length > hi) v = v.slice(0, Math.max(hi, lo));
  return v;
}

const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

export function buildRequest(op: Operation, token: string | undefined, ids: Record<string, string> = {}):
  { method: string; url: string; headers: Record<string, string>; payload: string | undefined } {
  const param = (n: string, where: string) => op.params.find((x) => x.in === where && x.name === n);
  let url = op.path.replace(/\{([^}]+)\}/g, (_, n: string) => encodeURIComponent(asText(sampleValue(param(n, 'path')?.schema, n, ids))));
  const qs = op.params.filter((p) => p.in === 'query' && p.required).map((p) => {
    const v = sampleValue(p.schema, p.name, ids);
    return `${encodeURIComponent(p.name)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : asText(v))}`;
  });
  if (qs.length) url += `?${qs.join('&')}`;
  const headers: Record<string, string> = { 'user-agent': 'lims-sweep/1' };
  for (const p of op.params.filter((x) => x.in === 'header' && x.required)) headers[p.name.toLowerCase()] = asText(sampleValue(p.schema, p.name, ids));
  // a fresh key per call: a replayed key would answer from the idempotency store, not the service
  if ((op.idempotency && op.idempotency !== 'none') || headers['idempotency-key'] !== undefined) headers['idempotency-key'] = randomUUID();
  if (headers['if-match'] !== undefined && !/^"/.test(headers['if-match'])) headers['if-match'] = '"1"';
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (op.hasBody) {
    const t = op.bodyType ?? 'application/json';
    if (t.includes('json')) { headers['content-type'] = 'application/json'; payload = JSON.stringify(sampleValue(op.bodySchema ?? { type: 'object' }, '', ids)); }
    else if (t.startsWith('multipart/')) {
      headers['content-type'] = 'multipart/form-data; boundary=sweep';
      const s = flatten(op.bodySchema ?? {});
      const parts = (s.required ?? []).map((k: string) => {
        const ps = flatten(s.properties?.[k] ?? {});
        return ps.format === 'binary'
          ? `--sweep\r\nContent-Disposition: form-data; name="${k}"; filename="sweep.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 sweep\r\n`
          : `--sweep\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${asText(sampleValue(ps, k, ids))}\r\n`;
      });
      payload = `${parts.join('')}--sweep--\r\n`;
    } else { headers['content-type'] = t.includes('*') ? 'application/octet-stream' : t; payload = 'sweep'; }
  }
  return { method: op.method.toUpperCase(), url, headers, payload };
}
