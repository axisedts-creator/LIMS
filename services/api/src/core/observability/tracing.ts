// W3C traceparent (CV §9.4, 02-TRD §6.2 stage 1). Invalid header = no trace context; the request is still served.
import { randomBytes } from 'node:crypto';

export interface TraceContext { readonly trace_id: string; readonly span_id: string }

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** span_id is this server span's own new id (the caller's span id is its parent). */
export function parseTraceparent(h: unknown): TraceContext | undefined {
  if (typeof h !== 'string') return undefined;
  const m = TRACEPARENT.exec(h.trim());
  if (!m || m[1] === 'ff' || /^0+$/.test(m[2]!) || /^0+$/.test(m[3]!)) return undefined;
  return { trace_id: m[2]!, span_id: randomBytes(8).toString('hex') };
}
