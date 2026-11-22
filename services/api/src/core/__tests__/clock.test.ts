// T0D-FIX-6 (LD-448): core/clock.ts toDate(v: Date | string): Date. The pipeline's ctx.now() is an ISO STRING (core/pipeline/index.ts), the unit fakes return a Date.
// toDate accepts both and answers a Date; anything else is a typed LimsError (never a TypeError / RangeError, never an Invalid Date).
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../errors.js';
import { toDate } from '../clock.js';

const ISO = '2026-11-22T06:00:00.000Z';
const fail = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } throw new Error('expected a throw'); };

describe('core/clock toDate', () => {
  it('an ISO string (what ctx.now() returns in the pipeline) -> the Date of that instant', () => {
    const d = toDate(ISO);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(Date.parse(ISO));
    expect(d.toISOString()).toBe(ISO);
  });
  it('a Date (what the unit fakes return) -> a Date of the same instant', () => {
    const src = new Date(ISO);
    const d = toDate(src);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(src.getTime());
  });
  it('the result is safe to mutate: setting it does not change the Date that was passed in', () => {
    const src = new Date(ISO);
    toDate(src).setUTCFullYear(2000);
    expect(src.toISOString()).toBe(ISO);
  });
  it('an ISO string with an offset keeps the instant', () => {
    expect(toDate('2026-11-22T11:45:00.000+05:45').toISOString()).toBe(ISO);
  });
  it.each(['garbage', '', '2026-13-45T99:00:00Z', 'NaN'])('invalid string %j -> a typed LimsError', (v) => {
    const e = fail(() => toDate(v));
    expect(isLimsError(e)).toBe(true);
    expect(e).not.toBeInstanceOf(TypeError);
    expect(e).not.toBeInstanceOf(RangeError);
  });
  it('an Invalid Date object -> a typed LimsError, not an Invalid Date passed on', () => {
    expect(isLimsError(fail(() => toDate(new Date('nope'))))).toBe(true);
  });
  it.each([[undefined], [null], [{}], [[]]])('a value that is neither Date nor string (%j) -> a typed LimsError', (v) => {
    expect(isLimsError(fail(() => toDate(v as never)))).toBe(true);
  });
  it('the error does not echo the bad value (no data in errors)', () => {
    const e = fail(() => toDate('secret-looking-value-123')) as { message: string; detail?: string };
    expect(`${e.message} ${e.detail ?? ''}`).not.toContain('secret-looking-value-123');
  });
  it('the pipeline clock stays a string: core/pipeline/index.ts still builds ctx.now as an ISO string (Date-like option rejected, LD-448)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../pipeline/index.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/now:\s*\(\)\s*=>\s*\(tx \? tx\.startedAt\.toISOString\(\) : new Date\(\)\.toISOString\(\)\)/);
  });
});
