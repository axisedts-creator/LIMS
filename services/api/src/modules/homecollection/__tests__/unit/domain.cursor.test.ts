// C17 HC-T02 — snapshot cursor (02-TRD §6.2 step 3: cursor_now = base64url(JSON{v:1, d, r:[[route_id, route_version]…sorted], s, w}); opaque to the device).
// Interface expected from the writer (../../domain/cursor.ts) — SEAMS:
//   export interface CursorState { d: string /* route_date YYYY-MM-DD */; r: ReadonlyArray<readonly [string, number]> /* [route_id, route_version] */; s: number /* settings.version */; w: string /* device.status */ }
//   export function encodeCursor(c: CursorState): string
//        JSON with keys in the order v,d,r,s,w and v = 1; r sorted ascending by route_id (input order irrelevant); base64url, NO padding.
//        Route ids are opaque strings here (the spec example id "01a1a98a..." is not a uuid) — do not validate their format.
//   export function decodeCursor(s: unknown): CursorState | null
//        pure, never throws; returns null for anything that is not a well-formed v:1 cursor (device input is untrusted).
//   export function cursorsEqual(deviceCursor: unknown, currentCursor: string): boolean
//        the "unchanged" test of the pull: true only when deviceCursor is a well-formed cursor string equal to currentCursor; false for undefined/garbage.
import { describe, expect, it } from 'vitest';
import { cursorsEqual, decodeCursor, encodeCursor } from '../../domain/cursor.js';

// 02-TRD §6.2 SnapshotDto.cursor example
const SPEC_CURSOR = 'eyJ2IjoxLCJkIjoiMjAyNi0xMS0wNiIsInIiOltbIjAxYTFhOThhLi4uIiw0XV0sInMiOjIsInciOiJhY3RpdmUifQ';
const SPEC_STATE = { d: '2026-11-06', r: [['01a1a98a...', 4]] as Array<[string, number]>, s: 2, w: 'active' };
const b64 = (o: unknown): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

describe('encodeCursor', () => {
  it('reproduces the spec example byte for byte', () => {
    expect(encodeCursor(SPEC_STATE)).toBe(SPEC_CURSOR);
  });
  it('is base64url without padding or +/ characters', () => {
    const c = encodeCursor({ d: '2026-11-06', r: [['a', 1], ['b', 22]], s: 1, w: 'wipe_requested' });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('payload JSON has v:1 and key order v,d,r,s,w', () => {
    const json = Buffer.from(encodeCursor(SPEC_STATE), 'base64url').toString('utf8');
    expect(json).toBe('{"v":1,"d":"2026-11-06","r":[["01a1a98a...",4]],"s":2,"w":"active"}');
  });
  it('sorts routes by route_id so input order does not matter', () => {
    const a = encodeCursor({ d: '2026-11-06', r: [['r2', 7], ['r1', 3]], s: 1, w: 'active' });
    const b = encodeCursor({ d: '2026-11-06', r: [['r1', 3], ['r2', 7]], s: 1, w: 'active' });
    expect(a).toBe(b);
    expect(decodeCursor(a)?.r).toEqual([['r1', 3], ['r2', 7]]);
  });
  it('does not mutate its input', () => {
    const r: Array<[string, number]> = [['r2', 7], ['r1', 3]];
    encodeCursor({ d: '2026-11-06', r, s: 1, w: 'active' });
    expect(r).toEqual([['r2', 7], ['r1', 3]]);
  });
  it('supports a phlebotomist with no routes today', () => {
    const c = encodeCursor({ d: '2026-11-06', r: [], s: 1, w: 'active' });
    expect(decodeCursor(c)).toEqual({ d: '2026-11-06', r: [], s: 1, w: 'active' });
  });
});

describe('decodeCursor', () => {
  it('round-trips', () => {
    const st = { d: '2026-11-06', r: [['r1', 3], ['r2', 9]] as Array<[string, number]>, s: 4, w: 'wipe_requested' };
    expect(decodeCursor(encodeCursor(st))).toEqual(st);
  });
  it('decodes the spec example', () => {
    expect(decodeCursor(SPEC_CURSOR)).toEqual(SPEC_STATE);
  });
  it.each([
    ['undefined', undefined], ['null', null], ['number', 7], ['object', {}], ['empty', ''], ['not base64url', '***not base64***'], ['standard base64 with padding chars', '!!!!'],
    ['base64 of non-JSON', b64('hello')], ['JSON array', b64([1, 2])], ['JSON string', b64('"x"')], ['JSON null', b64('null')],
    ['wrong version', b64({ v: 2, d: '2026-11-06', r: [], s: 1, w: 'active' })],
    ['missing version', b64({ d: '2026-11-06', r: [], s: 1, w: 'active' })],
    ['missing d', b64({ v: 1, r: [], s: 1, w: 'active' })],
    ['d not a date', b64({ v: 1, d: 'yesterday', r: [], s: 1, w: 'active' })],
    ['r not an array', b64({ v: 1, d: '2026-11-06', r: 'x', s: 1, w: 'active' })],
    ['r item not a pair', b64({ v: 1, d: '2026-11-06', r: [['a']], s: 1, w: 'active' })],
    ['r item version not an integer', b64({ v: 1, d: '2026-11-06', r: [['a', 1.5]], s: 1, w: 'active' })],
    ['r item id not a string', b64({ v: 1, d: '2026-11-06', r: [[1, 1]], s: 1, w: 'active' })],
    ['s not an integer', b64({ v: 1, d: '2026-11-06', r: [], s: '1', w: 'active' })],
    ['w not a string', b64({ v: 1, d: '2026-11-06', r: [], s: 1, w: 3 })],
  ])('returns null (never throws) for %s', (_n, input) => {
    expect(() => decodeCursor(input)).not.toThrow();
    expect(decodeCursor(input)).toBeNull();
  });
  it('a __proto__ key in the JSON does not pollute Object.prototype and does not yield a cursor', () => {
    const r = decodeCursor(b64('{"v":1,"d":"2026-11-06","r":[],"s":1,"w":"active","__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (r !== null) expect((r as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('cursorsEqual (the pull "unchanged" test)', () => {
  const now = encodeCursor({ d: '2026-11-06', r: [['r1', 3]], s: 2, w: 'active' });
  it('equal cursors => true', () => expect(cursorsEqual(now, now)).toBe(true));
  it('a route version bump => false', () => {
    expect(cursorsEqual(encodeCursor({ d: '2026-11-06', r: [['r1', 2]], s: 2, w: 'active' }), now)).toBe(false);
  });
  it('a settings version change => false', () => {
    expect(cursorsEqual(encodeCursor({ d: '2026-11-06', r: [['r1', 3]], s: 1, w: 'active' }), now)).toBe(false);
  });
  it('a device status change (wipe requested) => false', () => {
    expect(cursorsEqual(encodeCursor({ d: '2026-11-06', r: [['r1', 3]], s: 2, w: 'wipe_requested' }), now)).toBe(false);
  });
  it('a new day => false', () => {
    expect(cursorsEqual(encodeCursor({ d: '2026-11-07', r: [['r1', 3]], s: 2, w: 'active' }), now)).toBe(false);
  });
  it('an added or removed route => false', () => {
    expect(cursorsEqual(encodeCursor({ d: '2026-11-06', r: [['r1', 3], ['r2', 1]], s: 2, w: 'active' }), now)).toBe(false);
    expect(cursorsEqual(encodeCursor({ d: '2026-11-06', r: [], s: 2, w: 'active' }), now)).toBe(false);
  });
  it('missing / garbage device cursor => false, even when the current cursor is garbage too', () => {
    expect(cursorsEqual(undefined, now)).toBe(false);
    expect(cursorsEqual(null, now)).toBe(false);
    expect(cursorsEqual('', now)).toBe(false);
    expect(cursorsEqual('garbage', now)).toBe(false);
    expect(cursorsEqual('garbage', 'garbage')).toBe(false);
    expect(cursorsEqual(123, now)).toBe(false);
  });
});
