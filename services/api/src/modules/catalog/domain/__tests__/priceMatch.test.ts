// T-19 (C3) — domain/priceMatch.ts: price-list precedence, fall-through and effective windows (02-TRD §7.4; PRD AC-13.1, AC-13.2, AC-13.3, AC-07.6). PURE: no I/O, no clock.
// Spec: 06-PLAN row T-19 done_when "Precedence x5, fall-through, effective windows". Source order (03-IC §4.2 [CONV default]): explicit > credit_party > referrer > centre > tenant_default.
// SEAMS expected from the writer (domain/priceMatch.ts):
//   export type PriceSource = 'explicit' | 'credit_party' | 'referrer' | 'centre' | 'tenant_default';
//   export const SOURCE_ORDER: readonly PriceSource[]                       // exactly the order above
//   export function effectiveVersion<V extends { status: string; effective_from?: Date|string|null; effective_to?: Date|string|null }>(versions: readonly V[], at: Date|string): V | undefined
//        // published|superseded with effective_from <= at < effective_to (null = open end); draft / discarded never; windows half-open [from, to)
//   export interface PriceListInput { id: string; falls_through: boolean; is_active: boolean;
//        versions: ReadonlyArray<{ version_no: number; status: string; effective_from?: Date|string|null; effective_to?: Date|string|null; items: ReadonlyMap<string, number> }> }  // items: orderable id -> unit price paisa
//   export function priceMatch(q: { lists: Partial<Record<PriceSource, PriceListInput | undefined>>; orderableId: string; at: Date|string }):
//        { found: true; source: PriceSource; priceListId: string; priceListVersion: number; unitPricePaisa: number } | { found: false }
// `found:false` is the domain's "catalog.no_price"; the service maps it. An absent / undefined entry in `lists` = no list assigned for that source.
import { describe, expect, it } from 'vitest';
import { SOURCE_ORDER, effectiveVersion, priceMatch, type PriceListInput, type PriceSource } from '../priceMatch.js';

const O = '0190c300-0000-7000-8000-0000000000a1';          // the orderable being priced (synthetic)
const OTHER = '0190c300-0000-7000-8000-0000000000a2';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-06-01T00:00:00.000Z');
const T2 = new Date('2026-09-01T00:00:00.000Z');
const MID = new Date('2026-03-15T00:00:00.000Z');
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

type Ver = PriceListInput['versions'][number];
const ver = (no: number, status: string, from: Date | null, to: Date | null, prices: Record<string, number>): Ver => ({
  version_no: no, status, ...(from ? { effective_from: from } : {}), ...(to ? { effective_to: to } : {}), items: new Map(Object.entries(prices)),
});
/** A list with one published version [T0, ∞) and the given prices. */
const list = (id: string, prices: Record<string, number>, o: Partial<PriceListInput> = {}): PriceListInput =>
  ({ id, falls_through: true, is_active: true, versions: [ver(1, 'published', T0, null, prices)], ...o });
const LISTS: Record<PriceSource, PriceListInput> = {
  explicit: list('L-explicit', { [O]: 500 }), credit_party: list('L-party', { [O]: 600 }), referrer: list('L-ref', { [O]: 700 }),
  centre: list('L-centre', { [O]: 800 }), tenant_default: list('L-default', { [O]: 900 }),
};
const price = (lists: Partial<Record<PriceSource, PriceListInput | undefined>>, at: Date | string = MID, orderableId = O) => priceMatch({ lists, orderableId, at });

describe('SOURCE_ORDER', () => {
  it('is explicit > credit_party > referrer > centre > tenant_default (AC-13.1)', () => {
    expect([...SOURCE_ORDER]).toEqual(['explicit', 'credit_party', 'referrer', 'centre', 'tenant_default']);
  });
});

describe('precedence x5 (AC-13.1: 600 / 700 / 800 / 900 / explicit)', () => {
  it('every source priced: explicit wins', () => {
    expect(price(LISTS)).toEqual({ found: true, source: 'explicit', priceListId: 'L-explicit', priceListVersion: 1, unitPricePaisa: 500 });
  });
  it('H+X+C2 (no explicit): credit party 600 beats referrer 700, centre 800, default 900', () => {
    const { explicit: _e, ...rest } = LISTS;
    expect(price(rest)).toMatchObject({ found: true, source: 'credit_party', unitPricePaisa: 600, priceListId: 'L-party' });
  });
  it('X+C2: referrer 700', () => {
    expect(price({ referrer: LISTS.referrer, centre: LISTS.centre, tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'referrer', unitPricePaisa: 700 });
  });
  it('C2 alone: centre 800 over the default', () => {
    expect(price({ centre: LISTS.centre, tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'centre', unitPricePaisa: 800 });
  });
  it('none: tenant default 900', () => {
    expect(price({ tenant_default: LISTS.tenant_default })).toMatchObject({ found: true, source: 'tenant_default', unitPricePaisa: 900, priceListId: 'L-default' });
  });
  it('all 32 subsets of the five sources: the winner is the first present source in SOURCE_ORDER (matrix)', () => {
    for (let mask = 1; mask < 32; mask++) {
      const lists: Partial<Record<PriceSource, PriceListInput>> = {};
      SOURCE_ORDER.forEach((s, i) => { if (mask & (1 << i)) lists[s] = LISTS[s]; });
      const want = SOURCE_ORDER.find((s) => lists[s])!;
      expect(price(lists), `mask ${mask.toString(2)}`).toMatchObject({ found: true, source: want, unitPricePaisa: LISTS[want].versions[0]!.items.get(O) });
    }
  });
  it('no list at all, or an undefined entry, is not found', () => {
    expect(price({})).toEqual({ found: false });
    expect(price({ credit_party: undefined, tenant_default: undefined })).toEqual({ found: false });
  });
  it('an `undefined` entry is "no list": the next source is used', () => {
    expect(price({ explicit: undefined, referrer: LISTS.referrer })).toMatchObject({ source: 'referrer', unitPricePaisa: 700 });
  });
});

describe('fall-through (AC-13.2)', () => {
  const lacking = (o: Partial<PriceListInput> = {}) => list('L-party', { [OTHER]: 111 }, o);          // has a price for another orderable only
  it('falls_through=true and the item is missing: priced from the next source', () => {
    expect(price({ credit_party: lacking({ falls_through: true }), tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'tenant_default', unitPricePaisa: 900 });
  });
  it('falls_through=false and the item is missing: not found — the lower source is NOT consulted', () => {
    expect(price({ credit_party: lacking({ falls_through: false }), tenant_default: LISTS.tenant_default })).toEqual({ found: false });
  });
  it('falls_through=false but the item IS present: the list wins', () => {
    expect(price({ credit_party: list('L-party', { [O]: 600 }, { falls_through: false }), tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'credit_party', unitPricePaisa: 600 });
  });
  it('fall-through chains through several lists, skipping each one that lacks the item', () => {
    expect(price({ explicit: lacking(), credit_party: lacking(), referrer: lacking(), centre: LISTS.centre, tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'centre', unitPricePaisa: 800 });
  });
  it('a closed list (falls_through=false) in the middle of the chain stops it', () => {
    expect(price({ explicit: lacking(), credit_party: lacking({ falls_through: false }), centre: LISTS.centre })).toEqual({ found: false });
  });
  it('the explicit list lacking the item with falls_through=true continues down; with false it ends', () => {
    expect(price({ explicit: lacking({ falls_through: true }), tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'tenant_default' });
    expect(price({ explicit: lacking({ falls_through: false }), tenant_default: LISTS.tenant_default })).toEqual({ found: false });
  });
  it('the tenant default lacking the item (last source) is not found', () => {
    expect(price({ tenant_default: list('L-default', { [OTHER]: 1 }) })).toEqual({ found: false });
  });
  it('exhausting every list is not found (never a made-up price)', () => {
    const l = lacking();
    expect(price({ explicit: l, credit_party: l, referrer: l, centre: l, tenant_default: l })).toEqual({ found: false });
  });
  it('AC-07.6: a package/panel with no item of its own is not found even though its component tests are priced', () => {
    const PKG = '0190c300-0000-7000-8000-0000000000b1';
    const l = list('L-default', { [O]: 900, [OTHER]: 100 });                       // components priced, the package is not
    expect(price({ tenant_default: l }, MID, PKG)).toEqual({ found: false });
  });
  it('a price of 0 paisa is a real price (not "missing")', () => {
    expect(price({ credit_party: list('L-party', { [O]: 0 }), tenant_default: LISTS.tenant_default })).toMatchObject({ found: true, source: 'credit_party', unitPricePaisa: 0 });
  });
  it('an orderable id that collides with Object.prototype names is not found (no inherited-property lookups)', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(price({ tenant_default: LISTS.tenant_default }, MID, id), id).toEqual({ found: false });
  });
});

describe('a list with no version effective at `at` is treated as absent, regardless of falls_through (AC-13.2)', () => {
  const draftOnly = (ft: boolean) => list('L-party', {}, { falls_through: ft, versions: [ver(1, 'draft', null, null, { [O]: 1 })] });
  it.each([true, false])('draft v1 only, falls_through=%s: skipped; the default list answers', (ft) => {
    expect(price({ credit_party: draftOnly(ft), tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'tenant_default', unitPricePaisa: 900 });
  });
  it('a draft is never priced from, even when it holds the item and nothing else exists', () => {
    expect(price({ credit_party: draftOnly(true) })).toEqual({ found: false });
  });
  it('a discarded version is never priced from', () => {
    const l = list('L-party', {}, { versions: [ver(1, 'discarded', T0, null, { [O]: 1 })] });
    expect(price({ credit_party: l, tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'tenant_default' });
  });
  it('the first published version starting in the future: skipped until it starts (inclusive start)', () => {
    const l = (ft: boolean) => list('L-party', {}, { falls_through: ft, versions: [ver(1, 'published', T1, null, { [O]: 600 })] });
    expect(price({ credit_party: l(false), tenant_default: LISTS.tenant_default }, ms(T1, -1))).toMatchObject({ source: 'tenant_default' });
    expect(price({ credit_party: l(false), tenant_default: LISTS.tenant_default }, T1)).toMatchObject({ source: 'credit_party', unitPricePaisa: 600 });
  });
  it('a list whose only version already ended is skipped (at == effective_to is OUTSIDE the half-open window)', () => {
    const l = list('L-party', {}, { falls_through: false, versions: [ver(1, 'superseded', T0, T1, { [O]: 600 })] });
    expect(price({ credit_party: l, tenant_default: LISTS.tenant_default }, T1)).toMatchObject({ source: 'tenant_default' });
    expect(price({ credit_party: l, tenant_default: LISTS.tenant_default }, ms(T1, -1))).toMatchObject({ source: 'credit_party' });
  });
  it('a list with zero versions is skipped', () => {
    expect(price({ credit_party: list('L-party', {}, { versions: [] }), tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'tenant_default' });
  });
  it('no effective version AND no default list: not found', () => {
    expect(price({ credit_party: draftOnly(false) })).toEqual({ found: false });
  });
});

describe('inactive lists are skipped as if absent (02-TRD §7.4)', () => {
  it('an inactive list holding the item is not used, even with falls_through=false', () => {
    expect(price({ credit_party: list('L-party', { [O]: 600 }, { is_active: false, falls_through: false }), tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'tenant_default', unitPricePaisa: 900 });
  });
  it('an inactive tenant default and nothing else: not found', () => {
    expect(price({ tenant_default: list('L-default', { [O]: 900 }, { is_active: false }) })).toEqual({ found: false });
  });
});

describe('effective windows (AC-13.3): v2 until T1, v3 from T1', () => {
  const versioned = list('L-default', {}, {
    versions: [ver(1, 'superseded', T0, ms(T0, 86_400_000), { [O]: 100 }), ver(2, 'superseded', ms(T0, 86_400_000), T1, { [O]: 200 }), ver(3, 'published', T1, null, { [O]: 300 })],
  });
  it('at < T1 uses v2 (price + version number)', () => {
    expect(price({ tenant_default: versioned }, ms(T1, -1))).toEqual({ found: true, source: 'tenant_default', priceListId: 'L-default', priceListVersion: 2, unitPricePaisa: 200 });
  });
  it('at == T1 uses v3 (start inclusive) and far in the future too', () => {
    expect(price({ tenant_default: versioned }, T1)).toMatchObject({ priceListVersion: 3, unitPricePaisa: 300 });
    expect(price({ tenant_default: versioned }, new Date('2099-01-01T00:00:00.000Z'))).toMatchObject({ priceListVersion: 3, unitPricePaisa: 300 });
  });
  it('a historical `at` inside v1 uses the superseded v1 (re-pricing an old order)', () => {
    expect(price({ tenant_default: versioned }, ms(T0, 3_600_000))).toMatchObject({ priceListVersion: 1, unitPricePaisa: 100 });
  });
  it('before the first version started: no version effective, so not found', () => {
    expect(price({ tenant_default: versioned }, ms(T0, -1))).toEqual({ found: false });
  });
  it('the version row order in the input does not matter', () => {
    const shuffled = { ...versioned, versions: [...versioned.versions].reverse() };
    expect(price({ tenant_default: shuffled }, ms(T1, -1))).toMatchObject({ priceListVersion: 2 });
    expect(price({ tenant_default: shuffled }, T1)).toMatchObject({ priceListVersion: 3 });
  });
  it('the item lookup is inside the EFFECTIVE version only: v3 lacking the item does not borrow v2 price', () => {
    const l = list('L-default', {}, { versions: [ver(2, 'superseded', T0, T1, { [O]: 200 }), ver(3, 'published', T1, null, { [OTHER]: 1 })] });
    expect(price({ tenant_default: l }, T2)).toEqual({ found: false });
  });
  it('ISO string `at` and ISO string windows behave like Dates', () => {
    const l = list('L-default', {}, { versions: [{ version_no: 7, status: 'published', effective_from: T1.toISOString(), effective_to: null, items: new Map([[O, 77]]) }] });
    expect(price({ tenant_default: l }, T1.toISOString())).toMatchObject({ priceListVersion: 7, unitPricePaisa: 77 });
    expect(price({ tenant_default: l }, ms(T1, -1).toISOString())).toEqual({ found: false });
  });
  it('the explicit list is evaluated at `at` too (a draft-only explicit list falls through)', () => {
    const e = list('L-explicit', {}, { versions: [ver(1, 'draft', null, null, { [O]: 1 })] });
    expect(price({ explicit: e, tenant_default: LISTS.tenant_default })).toMatchObject({ source: 'tenant_default' });
  });
});

describe('effectiveVersion', () => {
  const vs = [ver(1, 'superseded', T0, T1, {}), ver(2, 'published', T1, null, {}), ver(3, 'draft', null, null, {}), ver(4, 'discarded', T0, null, {})];
  it('picks the published|superseded version whose half-open window contains `at`', () => {
    expect(effectiveVersion(vs, MID)?.version_no).toBe(1);
    expect(effectiveVersion(vs, ms(T1, -1))?.version_no).toBe(1);
    expect(effectiveVersion(vs, T1)?.version_no).toBe(2);
  });
  it('undefined before any window, for drafts and for discarded versions', () => {
    expect(effectiveVersion(vs, ms(T0, -1))).toBeUndefined();
    expect(effectiveVersion([vs[2]!, vs[3]!], MID)).toBeUndefined();
    expect(effectiveVersion([], MID)).toBeUndefined();
  });
  it('a published version with an end (data oddity) is honoured: at == effective_to is outside', () => {
    expect(effectiveVersion([ver(1, 'published', T0, T1, {})], T1)).toBeUndefined();
  });
});

describe('purity', () => {
  it('does not mutate its input and is deterministic', () => {
    const lists = structuredClone({ ...LISTS, centre: undefined, referrer: undefined });
    const frozen = Object.freeze(Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v && Object.freeze({ ...v, versions: Object.freeze(v.versions.map((x) => Object.freeze({ ...x }))) })])));
    const a = price(frozen as never); const b = price(frozen as never);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ source: 'explicit' });
  });
});
