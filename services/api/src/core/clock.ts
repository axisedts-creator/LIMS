// T0D-FIX-6 (LD-448): the pipeline's ctx.now() is an ISO STRING (core/pipeline/index.ts); unit fakes return a Date.
// toDate accepts both and answers a fresh Date. Anything else (bad string, Invalid Date, other type) is a programming/clock fault:
// common.internal, never a TypeError/RangeError and never the value itself in the error (no data in errors).
import { LimsError } from './errors.js';

// ISO 8601 date-time with zone only: V8's Date.parse is lenient ('abc-123' parses as year 123).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function toDate(v: Date | string): Date {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' && ISO.test(v) ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new LimsError('common.internal');
  return new Date(t);
}
