// C12.T-02 — domain/fefo.ts (02-TRD §4.4; PRD AC-18.1). Pure ordering + cover over candidate rows (the SQL already filtered qty > 0,
// status 'available', not expired — §4.4 first paragraph; the domain only orders and covers).
// Expected interface (domain/fefo.ts):
//   suggestFefo({ candidates, qtyBase, now, timezone }) → { lines, shortfallQtyBase }
//     candidates: { lotId, lotNo, expiryOn: 'YYYY-MM-DD' | null, createdAt: ISO instant, availableQtyBase: DecimalString,
//                   openContainers: { openExpiryAt: ISO instant | null }[] }[]
//     qtyBase: positive DecimalString; now: ISO instant; timezone: IANA name (tenant timezone, 'Asia/Kathmandu')
//     lines: { lotId, lotNo, expiryOn, effectiveExpiryAt: ISO instant | null, hasOpenContainer, takeQtyBase, availableQtyBase }[] in take order
// Sort key (ascending): 1 has_open_container (open first; an open container counts only if open_expiry_at is null or > now);
//   2 effective_expiry = least(earliest open container open_expiry_at, end of expiry_on day in tenant tz), null last; 3 expiry_on (nulls last);
//   4 lots.created_at; 5 lot_id. Rows are taken in order until qtyBase is covered.
import { describe, expect, it } from 'vitest';
import { suggestFefo } from '../../domain/fefo.js';
import { codeOf, norm } from './helpers.js';

const TZ = 'Asia/Kathmandu'; // UTC+05:45, no DST
const NOW = '2026-11-13T04:00:00Z';

interface Cand { lotId: string; lotNo: string; expiryOn: string | null; createdAt: string; availableQtyBase: string; openContainers: { openExpiryAt: string | null }[] }
const cand = (lotNo: string, expiryOn: string | null, avail: string, over: Partial<Cand> = {}): Cand => ({
  lotId: `00000000-0000-4000-8000-${lotNo.padStart(12, '0')}`,
  lotNo,
  expiryOn,
  createdAt: '2026-01-01T00:00:00Z',
  availableQtyBase: avail,
  openContainers: [],
  ...over,
});
const run = (candidates: Cand[], qty: string, now = NOW) => suggestFefo({ candidates, qtyBase: qty, now, timezone: TZ });
const order = (r: ReturnType<typeof run>) => r.lines.map((l) => l.lotNo);
/** End of the Kathmandu calendar day 'YYYY-MM-DD' lies in [18:00:00Z, 18:15:00Z] of that same date (UTC+05:45). */
const isEndOfKathmanduDay = (iso: string | null, ymd: string) => {
  expect(iso).not.toBeNull();
  const t = Date.parse(iso!);
  const [y, m, d] = ymd.split('-').map(Number);
  expect(t).toBeGreaterThanOrEqual(Date.UTC(y!, m! - 1, d!, 18, 0, 0));
  expect(t).toBeLessThanOrEqual(Date.UTC(y!, m! - 1, d!, 18, 15, 0));
};

describe('AC-18.1 FEFO suggestion', () => {
  // A: sealed, expiry 2027-01-31; B: sealed, expiry 2026-12-31; C: expiry 2027-03-31 with an open container whose open expiry is 2026-12-20.
  const A = cand('1', '2027-01-31', '20');
  const B = cand('2', '2026-12-31', '20');
  const C = cand('3', '2027-03-31', '20', { openContainers: [{ openExpiryAt: '2026-12-20T12:00:00Z' }] });

  it('asking 50 orders C (open), then B, then A, and covers the quantity', () => {
    const r = run([A, B, C], '50');
    expect(order(r)).toEqual(['3', '2', '1']);
    expect(r.lines.map((l) => norm(l.takeQtyBase))).toEqual(['20', '20', '10']);
    expect(norm(r.shortfallQtyBase)).toBe('0');
    expect(r.lines.map((l) => l.hasOpenContainer)).toEqual([true, false, false]);
    expect(r.lines.map((l) => l.expiryOn)).toEqual(['2027-03-31', '2026-12-31', '2027-01-31']);
    expect(r.lines.map((l) => norm(l.availableQtyBase))).toEqual(['20', '20', '20']);
  });
  it('lists expiry and quantity per lot; effective expiry of C is the open expiry, of B the end of its expiry day', () => {
    const r = run([A, B, C], '50');
    expect(Date.parse(r.lines[0]!.effectiveExpiryAt!)).toBe(Date.parse('2026-12-20T12:00:00Z'));
    isEndOfKathmanduDay(r.lines[1]!.effectiveExpiryAt, '2026-12-31');
    isEndOfKathmanduDay(r.lines[2]!.effectiveExpiryAt, '2027-01-31');
  });
  it('input order does not matter', () => {
    for (const perm of [[A, B, C], [C, B, A], [B, A, C], [A, C, B]]) expect(order(run(perm, '50'))).toEqual(['3', '2', '1']);
  });
  it('takes only what is needed: 15 units come from C alone', () => {
    const r = run([A, B, C], '15');
    expect(order(r)).toEqual(['3']);
    expect(norm(r.lines[0]!.takeQtyBase)).toBe('15');
    expect(norm(r.shortfallQtyBase)).toBe('0');
  });
  it('exact cover stops at the lot that completes it (40 = C 20 + B 20, A not listed)', () => {
    const r = run([A, B, C], '40');
    expect(order(r)).toEqual(['3', '2']);
    expect(norm(r.shortfallQtyBase)).toBe('0');
  });
  it('insufficient stock: lists every lot and reports shortfall_qty_base', () => {
    const r = run([A, B, C], '100');
    expect(order(r)).toEqual(['3', '2', '1']);
    expect(r.lines.map((l) => norm(l.takeQtyBase))).toEqual(['20', '20', '20']);
    expect(norm(r.shortfallQtyBase)).toBe('40');
  });
  it('no candidates: no lines, whole quantity short', () => {
    const r = run([], '7.5');
    expect(r.lines).toEqual([]);
    expect(norm(r.shortfallQtyBase)).toBe('7.5');
  });
  it('decimal quantities are exact (0.1 + 0.2 covers 0.3; no binary-float shortfall)', () => {
    const r = run([cand('1', '2027-01-01', '0.1'), cand('2', '2027-02-01', '0.2')], '0.3');
    expect(r.lines.map((l) => norm(l.takeQtyBase))).toEqual(['0.1', '0.2']);
    expect(norm(r.shortfallQtyBase)).toBe('0');
  });
  it('sub-unit precision: six decimals survive (0.000001 short of the request)', () => {
    const r = run([cand('1', '2027-01-01', '1.999999')], '2');
    expect(norm(r.shortfallQtyBase)).toBe('0.000001');
  });
  it('never takes more than is available from one lot, and takes are positive', () => {
    const r = run([A, B, C], '55');
    for (const l of r.lines) {
      expect(Number(l.takeQtyBase)).toBeGreaterThan(0);
      expect(Number(l.takeQtyBase)).toBeLessThanOrEqual(Number(l.availableQtyBase));
    }
  });
});

describe('§4.4 sort key details', () => {
  it('key 1: any open container beats an earlier-expiring sealed lot', () => {
    const sealedEarly = cand('1', '2026-12-01', '5');
    const openLate = cand('2', '2028-01-01', '5', { openContainers: [{ openExpiryAt: null }] });
    expect(order(run([sealedEarly, openLate], '10'))).toEqual(['2', '1']);
  });
  it('an open container already past its open expiry does not count as open', () => {
    const stale = cand('1', '2027-06-01', '5', { openContainers: [{ openExpiryAt: '2026-11-01T00:00:00Z' }] }); // before NOW
    const sealedLater = cand('2', '2027-07-01', '5');
    const r = run([sealedLater, stale], '10');
    expect(order(r)).toEqual(['1', '2']); // ordered by expiry, as two sealed lots
    expect(r.lines.map((l) => l.hasOpenContainer)).toEqual([false, false]);
  });
  it('an open container whose open expiry is exactly now is not open (open_expiry_at must be > now)', () => {
    const edge = cand('1', '2027-06-01', '5', { openContainers: [{ openExpiryAt: NOW }] });
    const sealedEarlier = cand('2', '2027-01-01', '5');
    expect(order(run([edge, sealedEarlier], '10'))).toEqual(['2', '1']);
  });
  it('key 2: among open lots, the earlier effective expiry (open expiry) goes first', () => {
    const o1 = cand('1', '2028-01-01', '5', { openContainers: [{ openExpiryAt: '2026-12-25T00:00:00Z' }] });
    const o2 = cand('2', '2028-01-01', '5', { openContainers: [{ openExpiryAt: '2026-12-10T00:00:00Z' }] });
    expect(order(run([o1, o2], '10'))).toEqual(['2', '1']);
  });
  it('effective expiry is the earliest open container of the lot', () => {
    const multi = cand('1', '2028-01-01', '5', { openContainers: [{ openExpiryAt: '2026-12-25T00:00:00Z' }, { openExpiryAt: '2026-12-02T00:00:00Z' }] });
    const single = cand('2', '2028-01-01', '5', { openContainers: [{ openExpiryAt: '2026-12-10T00:00:00Z' }] });
    const r = run([single, multi], '10');
    expect(order(r)).toEqual(['1', '2']);
    expect(Date.parse(r.lines[0]!.effectiveExpiryAt!)).toBe(Date.parse('2026-12-02T00:00:00Z'));
  });
  it('effective expiry = least(open expiry, end of expiry_on day): a lot expiring before its open container is limited by its expiry date', () => {
    const l = cand('1', '2026-12-01', '5', { openContainers: [{ openExpiryAt: '2027-06-01T00:00:00Z' }] });
    const r = run([l], '1');
    isEndOfKathmanduDay(r.lines[0]!.effectiveExpiryAt, '2026-12-01');
    expect(r.lines[0]!.hasOpenContainer).toBe(true);
  });
  it('an open container with no open expiry takes its effective expiry from expiry_on', () => {
    const r = run([cand('1', '2027-03-31', '5', { openContainers: [{ openExpiryAt: null }] })], '1');
    isEndOfKathmanduDay(r.lines[0]!.effectiveExpiryAt, '2027-03-31');
  });
  it('end of expiry_on is computed in the tenant timezone (Kathmandu day, not UTC day)', () => {
    const r = run([cand('1', '2026-12-31', '5')], '1');
    // UTC end of day would be 23:59:59.999Z; Kathmandu end of day is 5h45m earlier (18:14:59.999Z).
    expect(Date.parse(r.lines[0]!.effectiveExpiryAt!)).toBeLessThan(Date.UTC(2026, 11, 31, 19, 0, 0));
  });
  it('key 3: same effective expiry → earlier expiry_on first', () => {
    // both open, both with open expiry 2026-12-10; expiry_on differs
    const a = cand('1', '2027-05-01', '5', { openContainers: [{ openExpiryAt: '2026-12-10T00:00:00Z' }] });
    const b = cand('2', '2027-04-01', '5', { openContainers: [{ openExpiryAt: '2026-12-10T00:00:00Z' }] });
    expect(order(run([a, b], '10'))).toEqual(['2', '1']);
  });
  it('null expiry sorts last (sealed lots)', () => {
    const none = cand('1', null, '5');
    const dated = cand('2', '2030-01-01', '5');
    const r = run([none, dated], '10');
    expect(order(r)).toEqual(['2', '1']);
    expect(r.lines[1]!.expiryOn).toBeNull();
    expect(r.lines[1]!.effectiveExpiryAt).toBeNull();
  });
  it('null expiry sorts last among open lots too (open container with no expiry anywhere)', () => {
    const noneOpen = cand('1', null, '5', { openContainers: [{ openExpiryAt: null }] });
    const datedOpen = cand('2', '2030-01-01', '5', { openContainers: [{ openExpiryAt: null }] });
    expect(order(run([noneOpen, datedOpen], '10'))).toEqual(['2', '1']);
  });
  it('key 4: identical expiry → older lots.created_at first', () => {
    const newer = cand('1', '2027-01-01', '5', { createdAt: '2026-06-01T00:00:00Z' });
    const older = cand('2', '2027-01-01', '5', { createdAt: '2026-02-01T00:00:00Z' });
    expect(order(run([newer, older], '10'))).toEqual(['2', '1']);
  });
  it('key 5: identical everything → lower lot_id first (deterministic)', () => {
    const hi = cand('9', '2027-01-01', '5');
    const lo = cand('1', '2027-01-01', '5');
    expect(order(run([hi, lo], '10'))).toEqual(['1', '9']);
    expect(order(run([lo, hi], '10'))).toEqual(['1', '9']);
  });
  it('does not mutate its input', () => {
    const input = [cand('2', '2027-02-01', '5'), cand('1', '2027-01-01', '5')];
    const snapshot = JSON.stringify(input);
    run(input, '10');
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('input validation', () => {
  const one = [cand('1', '2027-01-01', '5')];
  it.each([['0'], ['-1'], ['abc'], ['1.0000001'], ['']])('rejects quantity %j', (q) => {
    expect(codeOf(() => run(one, q))).toBe('common.validation_failed');
  });
});
