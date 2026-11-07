// T0A-06 / AC-0A-3.1, 3.2, 3.3 (TRD §3.2 B.S. wrapper; gate 15 `bsdate-golden`; 04 D13, L16; CV §13).
// ASSUMED (not named in spec; see .orchestra/notes/T0A-06-tests.md):
//   impl entry `packages/shared-ts/src/bsdate/index.ts` (+ `impl.ts` = only importer of the raw lib), single-file/`.ts`-suffixed imports.
//   golden-2000-2099.json = { "months": [{bs_year,bs_month,days,ad_first_day[,projection]}] x1200, "probes": [{ad:'YYYY-MM-DD', bs:'YYYY-MM-DD'}] x200 }
//   review.json = { "entries": [{ key, values:{<lib>:...}, status:'resolved', resolved_by, resolution }] }  (empty array is valid)
//   Errors: thrown object has `.code === 'common.date_out_of_range'` (LimsError itself lands in T0A-08, so no instanceof check).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const INDEX = new URL('../src/bsdate/index.ts', import.meta.url);
const FIX = fileURLToPath(new URL('../../test-fixtures/bsdate/', import.meta.url));
const load = () => import(INDEX.href);
const readJson = (f) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));

// ---- independent oracles (no B.S. library involved) ----
const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
const isoOf = (n) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const pad = (n, w) => String(n).padStart(w, '0');
const bsIso = (y, m, d) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const bsStr = (b) => bsIso(b.year, b.month, b.day);
const OUT_OF_RANGE = (e) => { assert.equal(e?.code, 'common.date_out_of_range'); return true; };

const golden = () => readJson('golden-2000-2099.json');

describe('golden fixture is self-consistent (independent of any library)', () => {
  it('1200 month rows 2000-01..2099-12, days 29..32, ad_first_day chains exactly', () => {
    const { months } = golden();
    assert.equal(months.length, 1200);
    months.forEach((r, i) => {
      assert.equal(r.bs_year, 2000 + Math.floor(i / 12));
      assert.equal(r.bs_month, (i % 12) + 1);
      assert.ok(Number.isInteger(r.days) && r.days >= 29 && r.days <= 32, `days ${r.days} @${i}`);
      assert.match(r.ad_first_day, /^\d{4}-\d{2}-\d{2}$/);
      if (i > 0) assert.equal(dayNum(r.ad_first_day), dayNum(months[i - 1].ad_first_day) + months[i - 1].days, `chain @${i}`);
    });
  });
  it('anchor: 2082-04-01 B.S. = 2025-07-17 (01 §4.8 fact, FY 2082/83 start)', () => {
    const r = golden().months.find((m) => m.bs_year === 2082 && m.bs_month === 4);
    assert.equal(r.ad_first_day, '2025-07-17');
  });
  it('projection flag (04 D13): true for far-future years, not true for past/near years', () => {
    for (const r of golden().months) {
      if (r.bs_year >= 2090) assert.equal(r.projection, true, `${r.bs_year}-${r.bs_month}`);
      if (r.bs_year <= 2085) assert.notEqual(r.projection, true, `${r.bs_year}-${r.bs_month}`);
    }
  });
  it('200 probes, each consistent with the month table', () => {
    const { months, probes } = golden();
    assert.equal(probes.length, 200);
    for (const p of probes) {
      const n = dayNum(p.ad);
      const m = [...months].reverse().find((r) => dayNum(r.ad_first_day) <= n);
      assert.ok(m, `probe ${p.ad} inside table`);
      const d = n - dayNum(m.ad_first_day) + 1;
      assert.ok(d <= m.days, `probe ${p.ad} inside month`);
      assert.equal(p.bs, bsIso(m.bs_year, m.bs_month, d));
    }
  });
});

// LD-08 / LD-20 (2026-11-07): no human review gate. Package-sourced entries (resolved_by 'LD-08')
// are accepted when flagged `verify_before_golive: true`; any other resolver must be a named non-empty string.
describe('review.json (done_when: zero unresolved entries)', () => {
  it('exists, has an entries array, and every entry is resolved (LD-08 package value flagged verify_before_golive)', () => {
    const rv = readJson('review.json');
    assert.ok(Array.isArray(rv.entries), 'entries array');
    for (const e of rv.entries) {
      assert.equal(e.status, 'resolved', `unresolved: ${JSON.stringify(e.key)}`);
      assert.ok(typeof e.resolved_by === 'string' && e.resolved_by.trim().length > 0, 'resolved_by');
      if (e.resolved_by === 'LD-08') {
        assert.equal(e.verify_before_golive, true, `LD-08 entry missing verify_before_golive: ${JSON.stringify(e.key)}`);
      }
      assert.ok(e.resolution !== undefined && e.resolution !== null && e.resolution !== '', 'resolution');
      assert.ok(e.key !== undefined, 'key');
      assert.ok(e.values && Object.keys(e.values).length >= 2, 'values from >= 2 libraries');
    }
  });
});

describe('AC-0A-3.1 golden: bsToAd / adToBs equal the fixture', () => {
  it('every month: first day, last day, daysInBsMonth, one past the end throws', async () => {
    const { bsToAd, adToBs, daysInBsMonth } = await load();
    for (const r of golden().months) {
      const k = `${r.bs_year}-${r.bs_month}`;
      assert.equal(daysInBsMonth(r.bs_year, r.bs_month), r.days, k);
      assert.equal(bsToAd({ year: r.bs_year, month: r.bs_month, day: 1 }), r.ad_first_day, k);
      assert.equal(bsStr(adToBs(r.ad_first_day)), bsIso(r.bs_year, r.bs_month, 1), k);
      const last = isoOf(dayNum(r.ad_first_day) + r.days - 1);
      assert.equal(bsToAd({ year: r.bs_year, month: r.bs_month, day: r.days }), last, k);
      assert.equal(bsStr(adToBs(last)), bsIso(r.bs_year, r.bs_month, r.days), k);
      assert.throws(() => bsToAd({ year: r.bs_year, month: r.bs_month, day: r.days + 1 }), undefined, `${k} day ${r.days + 1}`);
    }
  });
  it('every probe converts both ways', async () => {
    const { bsToAd, adToBs, parseBs } = await load();
    for (const p of golden().probes) {
      assert.equal(bsStr(adToBs(p.ad)), p.bs, `adToBs ${p.ad}`);
      assert.equal(bsToAd(parseBs(p.bs)), p.ad, `bsToAd ${p.bs}`);
    }
  });
});

describe('AC-0A-3.2 range 1975–2099 B.S. -> common.date_out_of_range', () => {
  it('BS_SUPPORTED is 1975..2099', async () => {
    const { BS_SUPPORTED } = await load();
    assert.deepEqual({ ...BS_SUPPORTED }, { minYear: 1975, maxYear: 2099 });
  });
  it('adToBs throws below/above the range; edges inside the range work', async () => {
    const { adToBs, bsToAd } = await load();
    for (const ad of ['1900-01-01', '1918-01-01', '2050-01-01', '2100-01-01', '9999-12-31', '0001-01-01']) {
      assert.throws(() => adToBs(ad), OUT_OF_RANGE, ad);
    }
    assert.equal(adToBs('1919-01-01').year, 1975); // 1919-01-01 is Poush 1975 B.S.
    const last = golden().months.at(-1); // 2099-12
    const lastAd = isoOf(dayNum(last.ad_first_day) + last.days - 1);
    assert.equal(adToBs(lastAd).year, 2099);
    assert.throws(() => adToBs(isoOf(dayNum(lastAd) + 1)), OUT_OF_RANGE, 'day after 2099-12 end');
    assert.equal(bsToAd({ year: 2099, month: 12, day: last.days }), lastAd);
  });
  it('bsToAd / daysInBsMonth / fiscalYearBs throw out of range', async () => {
    const { bsToAd, daysInBsMonth, fiscalYearBs } = await load();
    for (const y of [1974, 2100, 0, -1, 99999]) {
      assert.throws(() => bsToAd({ year: y, month: 1, day: 1 }), OUT_OF_RANGE, `bsToAd ${y}`);
      assert.throws(() => daysInBsMonth(y, 1), OUT_OF_RANGE, `daysInBsMonth ${y}`);
    }
    assert.throws(() => fiscalYearBs('1900-01-01'), OUT_OF_RANGE);
    assert.throws(() => fiscalYearBs('2100-01-01'), OUT_OF_RANGE);
  });
  it('malformed input is rejected (never guessed)', async () => {
    const { adToBs, bsToAd, parseBs } = await load();
    for (const bad of ['', 'not-a-date', '2025-02-30', '2025-13-01', '2025-7-17', '2025-07-17T00:00:00Z', '17/07/2025']) {
      assert.throws(() => adToBs(bad), undefined, `adToBs ${JSON.stringify(bad)}`);
    }
    for (const b of [{ year: 2082, month: 0, day: 1 }, { year: 2082, month: 13, day: 1 }, { year: 2082, month: 4, day: 0 },
      { year: 2082.5, month: 4, day: 1 }, { year: NaN, month: 4, day: 1 }, { year: 2082, month: 4, day: -1 }]) {
      assert.throws(() => bsToAd(b), undefined, JSON.stringify(b));
    }
    for (const bad of ['', '2082-04', '2082-04-01-01', 'abcd-ef-gh', '2082.04.01', '2082-4-1x']) {
      assert.throws(() => parseBs(bad), undefined, `parseBs ${JSON.stringify(bad)}`);
    }
  });
});

describe('AC-0A-3.3 fiscalYearBs (FY starts Shrawan 1, 04 L16)', () => {
  const fy = (y) => `${y}/${pad((y + 1) % 100, 2)}`;
  it('Shrawan 1 of every golden year -> "Y/(Y+1)%100", previous day -> "(Y-1)/(Y%100)"', async () => {
    const { fiscalYearBs } = await load();
    for (const r of golden().months.filter((m) => m.bs_month === 4)) {
      const Y = r.bs_year;
      const on = fiscalYearBs(r.ad_first_day);
      assert.equal(on.long, fy(Y), `Shrawan 1 ${Y}`);
      assert.equal(on.short, fy(Y).slice(1), `short ${Y}`);
      assert.equal(on.startsOn, r.ad_first_day);
      const prev = fiscalYearBs(isoOf(dayNum(r.ad_first_day) - 1));
      assert.equal(prev.long, fy(Y - 1), `day before Shrawan 1 ${Y}`);
      assert.equal(prev.endsOn, isoOf(dayNum(r.ad_first_day) - 1));
      assert.equal(prev.short, fy(Y - 1).slice(1));
    }
  });
  it('century wrap and spec example', async () => {
    const { fiscalYearBs } = await load();
    const m = (y, mo) => golden().months.find((r) => r.bs_year === y && r.bs_month === mo);
    assert.equal(fiscalYearBs(m(2099, 4).ad_first_day).long, '2099/00');
    assert.equal(fiscalYearBs(isoOf(dayNum(m(2000, 4).ad_first_day) - 1)).long, '1999/00');
    const f = fiscalYearBs('2025-07-17');
    assert.deepEqual({ ...f }, { short: '082/83', long: '2082/83', startsOn: '2025-07-17', endsOn: isoOf(dayNum(m(2083, 4).ad_first_day) - 1) });
    assert.equal(fiscalYearBs('2025-07-16').long, '2081/82');
  });
  it('whole FY is constant: Baisakh 1 and Ashadh end of year Y+1 share the FY started Shrawan 1 of Y', async () => {
    const { fiscalYearBs } = await load();
    const ms = golden().months;
    for (const Y of [2000, 2050, 2082, 2098]) {
      const start = ms.find((r) => r.bs_year === Y && r.bs_month === 4);
      const nextBaisakh = ms.find((r) => r.bs_year === Y + 1 && r.bs_month === 1);
      const nextAshadh = ms.find((r) => r.bs_year === Y + 1 && r.bs_month === 3);
      const lastDay = isoOf(dayNum(nextAshadh.ad_first_day) + nextAshadh.days - 1);
      for (const ad of [nextBaisakh.ad_first_day, lastDay]) assert.equal(fiscalYearBs(ad).long, fy(Y), ad);
      assert.equal(fiscalYearBs(lastDay).endsOn, lastDay);
    }
  });
});

describe('instantToBs / formatBs / formatAd / parseBs (TRD §3.2, CV §13)', () => {
  it('instantToBs defaults to Asia/Kathmandu (+05:45): FY boundary 2025-07-17 00:00 NPT', async () => {
    const { instantToBs, adToBs } = await load();
    assert.deepEqual({ ...instantToBs('2025-07-16T18:15:00.000Z') }, { year: 2082, month: 4, day: 1 });
    assert.deepEqual({ ...instantToBs('2025-07-16T18:14:59.999Z') }, { ...adToBs('2025-07-16') });
    assert.deepEqual({ ...instantToBs('2025-07-16T18:15:00.000Z', 'UTC') }, { ...adToBs('2025-07-16') });
  });
  it('formatBs iso / display', async () => {
    const { formatBs } = await load();
    assert.equal(formatBs({ year: 2082, month: 4, day: 1 }, 'iso'), '2082-04-01');
    assert.equal(formatBs({ year: 2082, month: 4, day: 1 }, 'display'), '2082-04-01 B.S.');
    assert.equal(formatBs({ year: 2000, month: 12, day: 31 }, 'iso'), '2000-12-31');
  });
  it('formatAd date and datetime (tenant tz)', async () => {
    const { formatAd } = await load();
    assert.equal(formatAd('2025-07-17'), '17/07/2025');
    assert.equal(formatAd('2025-07-16T18:15:00.000Z', 'Asia/Kathmandu'), '17/07/2025 12:00 AM');
    assert.equal(formatAd('2025-07-17T06:30:00.000Z', 'Asia/Kathmandu'), '17/07/2025 12:15 PM');
  });
  it('parseBs accepts YYYY-MM-DD and YYYY/MM/DD', async () => {
    const { parseBs } = await load();
    assert.deepEqual({ ...parseBs('2082-04-01') }, { year: 2082, month: 4, day: 1 });
    assert.deepEqual({ ...parseBs('2082/04/01') }, { year: 2082, month: 4, day: 1 });
  });
});

describe('library isolation + pinned versions (04 D13, CV §2)', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  it('only src/bsdate/impl.ts imports the raw TS B.S. library', () => {
    const files = walk(SRC_DIR).filter((f) => /\.(ts|tsx|mjs|js)$/.test(f));
    const importers = files.filter((f) => /nepali-date-converter|bikram-sambat/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(importers.map((f) => f.replace(SRC_DIR, '').replaceAll('\\', '/')), ['bsdate/impl.ts']);
  });
  it('pins @remotemerge/nepali-date-converter 1.2.7 (exact) and nepali_utils 3.0.8 (exact)', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    assert.equal(pkg.dependencies?.['@remotemerge/nepali-date-converter'], '1.2.7');
    const pub = readFileSync(fileURLToPath(new URL('../../shared-dart/pubspec.yaml', import.meta.url)), 'utf8');
    assert.match(pub, /^\s+nepali_utils:\s*3\.0\.8\s*$/m);
  });
});
