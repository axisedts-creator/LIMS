// T0A-08 / TRD §3.1 clock + types. IsoUtc = 2026-11-05T04:15:00.000Z (IC §2.1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = () => import(new URL('../src/clock/index.ts', import.meta.url).href);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('clock', () => {
  it('toIsoUtc formats ms-precision UTC with zero padding, independent of local TZ', async () => {
    const { toIsoUtc } = await load();
    assert.equal(toIsoUtc(new Date(Date.UTC(2026, 10, 5, 4, 15, 0, 123))), '2026-11-05T04:15:00.123Z');
    assert.equal(toIsoUtc(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))), '2026-01-01T00:00:00.000Z');
    assert.equal(toIsoUtc(new Date('2026-11-05T09:59:59.007+05:45')), '2026-11-05T04:14:59.007Z');
    assert.equal(toIsoUtc(new Date(0)), '1970-01-01T00:00:00.000Z');
  });
  it('toIsoUtc throws on an Invalid Date', async () => {
    const { toIsoUtc } = await load();
    assert.throws(() => toIsoUtc(new Date('nope')));
  });
  it('systemClock.now() is IsoUtc-shaped and tracks real time', async () => {
    const { systemClock } = await load();
    const a = Date.now(); const s = systemClock.now(); const b = Date.now();
    assert.match(s, ISO); const t = Date.parse(s); assert.ok(t >= a && t <= b, `${a} <= ${t} <= ${b}`);
  });
  it('systemClock reads time at call (follows mocked Date)', async (ctx) => {
    const { systemClock } = await load();
    ctx.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 5, 6, 7, 8, 9, 10) });
    assert.equal(systemClock.now(), '2030-06-06T07:08:09.010Z');
    ctx.mock.timers.tick(1500);
    assert.equal(systemClock.now(), '2030-06-06T07:08:10.510Z');
  });
  it('fixedClock(iso).now() always returns that instant', async () => {
    const { fixedClock } = await load();
    const c = fixedClock('2026-11-05T04:15:00.000Z');
    assert.equal(c.now(), '2026-11-05T04:15:00.000Z'); assert.equal(c.now(), '2026-11-05T04:15:00.000Z');
    assert.notEqual(fixedClock('2026-11-06T00:00:00.000Z').now(), c.now());
  });
  it('fixedClock rejects non-IsoUtc input (wrong shape, offset, date-only, garbage)', async () => {
    const { fixedClock } = await load();
    for (const bad of ['2026-11-05', '2026-11-05T04:15:00Z', '2026-11-05T04:15:00.000+05:45', 'yesterday', '', '2026-13-45T99:99:99.000Z']) assert.throws(() => fixedClock(bad), undefined, bad);
  });
});

describe('types.ts', () => {
  it('re-exports the branded types from @lims/contracts/ports/common (type-only, no runtime exports)', async () => {
    const src = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
    assert.match(src, /@lims\/contracts\/ports\/common/);
    for (const n of ['Uuid', 'Uuidv7', 'IsoUtc', 'IsoDate', 'DecimalString', 'Code', 'Money']) assert.match(src, new RegExp(`\\b${n}\\b`), n);
  });
});
