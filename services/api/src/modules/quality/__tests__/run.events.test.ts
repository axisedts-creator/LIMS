// C9 T-10 — events/publish.ts: publishQcRunRejected (03-IC §3.21; 02-TRD §7.7, §10.1; PRD AC-06.8). "event payload validation (03-IC example + generated)".
// Real core `createEvents({ producer: 'quality' })` (validates the whole envelope against contracts/events/quality.qc_run.rejected.v1.schema.json, fails closed with common.internal) + the in-memory tx fake.
// SEAM: `createQualityEvents(events)` -> `{ publishQcRunRejected(ctx, payload, { runVersion }) }`, aggregate { qc_run, payload.qc_run_id, runVersion }, key `<qc_run_id>:rejected` (run.helpers.ts header).
// Fails now: "Cannot find module ../events/publish.js".
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../core/events/publish.js';
import { ctxFor, makeEventDb } from '../../../core/events/__tests__/helpers.js';
import { manifest } from '../index.js';
import { createQualityEvents } from '../events/publish.js';

const EVENT = 'quality.qc_run.rejected.v1';
const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const RUN = V7('000000100001'), INS = V7('0000000d0001'), ANA = V7('000000080001');
const CANON = ['1-3s', '2-2s', '2of3-2s', 'R-4s', '4-1s', '3-1s', '6x', '8x', '9x', '10x', '12x'];

/** The 03-IC §3.21 example payload, verbatim. */
const IC_EXAMPLE = { qc_run_id: RUN, instrument_id: INS, analyte_ids: [ANA], rules_violated: ['1-3s'], rule_mode: 'classic', controls_per_run: 2, run_at: '2026-11-05T06:00:00.000Z',
  last_in_control_run_at: '2026-11-05T01:00:00.000Z', hold_since: '2026-11-05T01:00:00.000Z', rejected_at: '2026-11-05T06:00:05.000Z' };

function setup() {
  const db = makeEventDb();
  const events = createQualityEvents(createEvents({ producer: 'quality' }) as never);
  const ctx = ctxFor(db) as never;
  const pub = (payload: Record<string, unknown>, runVersion = 2) => db.transaction(() => events.publishQcRunRejected(ctx, payload, { runVersion }));
  const stored = () => db.events.filter((e) => e.eventType === EVENT);
  return { db, pub, stored };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

describe('03-IC §3.21 example', () => {
  it('validates, is stored once, and the envelope carries producer quality, aggregate qc_run/<id>/seq = runVersion and key <qc_run_id>:rejected', async () => {
    const s = setup();
    const r = await s.pub(IC_EXAMPLE, 4);
    expect(r).toMatchObject({ duplicate: false, eventId: expect.any(String) });
    const [e] = s.stored();
    expect(s.stored()).toHaveLength(1);
    expect(e!.key).toBe(`${RUN}:rejected`);
    expect(e!.envelope).toMatchObject({ event_type: EVENT, producer: 'quality', aggregate: { type: 'qc_run', id: RUN, seq: 4 }, idempotency_key: `${RUN}:rejected`, payload: IC_EXAMPLE });
  });
  it('the publisher adds no key to the payload and does not mutate the caller\'s object', async () => {
    const s = setup();
    const p = structuredClone(IC_EXAMPLE);
    await s.pub(p);
    expect(p).toEqual(IC_EXAMPLE);
    expect(Object.keys(s.stored()[0]!.envelope.payload).sort()).toEqual(Object.keys(IC_EXAMPLE).sort());
  });
  it('last_in_control_run_at is optional (omitted when unknown, TRD §7.7 H2)', async () => {
    const s = setup();
    const { last_in_control_run_at: _drop, ...rest } = IC_EXAMPLE;
    await expect(s.pub(rest)).resolves.toMatchObject({ duplicate: false });
    expect(s.stored()[0]!.envelope.payload).not.toHaveProperty('last_in_control_run_at');
  });
  it('the module manifest lists the event under produces', () => {
    expect([...(manifest.produces ?? [])]).toContain(EVENT);
  });
});

describe('idempotency (AC-06.8: re-processing produces no second event)', () => {
  it('the same run twice -> one stored event, the second call is duplicate:true with the first event id', async () => {
    const s = setup();
    const a = await s.pub(IC_EXAMPLE, 2);
    const b = await s.pub(IC_EXAMPLE, 3);
    expect(b).toMatchObject({ duplicate: true, eventId: a.eventId });
    expect(s.stored()).toHaveLength(1);
  });
  it('another run id -> a second event', async () => {
    const s = setup();
    await s.pub(IC_EXAMPLE);
    await s.pub({ ...IC_EXAMPLE, qc_run_id: V7('000000100002') });
    expect(s.stored().map((e) => e.key)).toEqual([`${RUN}:rejected`, `${V7('000000100002')}:rejected`]);
  });
  it('a rolled-back transaction leaves no event, so the retry publishes it', async () => {
    const s = setup();
    const ev = createQualityEvents(createEvents({ producer: 'quality' }) as never);
    await expect(s.db.transaction(() => ev.publishQcRunRejected(ctxFor(s.db) as never, IC_EXAMPLE, { runVersion: 2 }), { rollback: true })).rejects.toThrow('forced rollback');
    expect(s.stored()).toEqual([]);
    expect(await s.pub(IC_EXAMPLE)).toMatchObject({ duplicate: false });
  });
});

describe('generated VALID payloads (every rule x mode x N x optional field)', () => {
  it('each single rejection rule of the enum, classic/modern, N 2/3/4, with and without last_in_control_run_at, publishes', async () => {
    const s = setup();
    let i = 0;
    for (const rule of CANON) for (const mode of ['classic', 'modern']) for (const n of [2, 3, 4]) for (const withLast of [true, false]) {
      const { last_in_control_run_at, ...noLast } = IC_EXAMPLE;
      const payload = { ...(withLast ? IC_EXAMPLE : noLast), qc_run_id: V7((0x200000 + i++).toString(16).padStart(12, '0')), rules_violated: [rule], rule_mode: mode, controls_per_run: n };
      await expect(s.pub(payload), JSON.stringify([rule, mode, n, withLast])).resolves.toMatchObject({ duplicate: false });
    }
    expect(s.stored()).toHaveLength(i);
  });
  it('all eleven rules together, in canonical order, publish', async () => {
    const s = setup();
    await expect(s.pub({ ...IC_EXAMPLE, rules_violated: CANON })).resolves.toMatchObject({ duplicate: false });
  });
  it('several analytes (up to 100) are accepted', async () => {
    const s = setup();
    const many = Array.from({ length: 100 }, (_, k) => V7((0x300000 + k).toString(16).padStart(12, '0')));
    await expect(s.pub({ ...IC_EXAMPLE, analyte_ids: many })).resolves.toMatchObject({ duplicate: false });
  });
});

describe('generated INVALID payloads fail closed: rejected, nothing stored (02-CV §7.3)', () => {
  const invalid: Array<[string, Record<string, unknown>]> = [];
  for (const k of ['qc_run_id', 'instrument_id', 'analyte_ids', 'rules_violated', 'rule_mode', 'controls_per_run', 'run_at', 'hold_since', 'rejected_at']) {
    const { [k]: _gone, ...rest } = IC_EXAMPLE as Record<string, unknown>;
    invalid.push([`missing ${k}`, rest]);
  }
  invalid.push(['extra key (sample_barcode)', { ...IC_EXAMPLE, sample_barcode: 'X' }]);
  invalid.push(['extra key (value)', { ...IC_EXAMPLE, value: '106.8' }]);
  invalid.push(['empty rules_violated', { ...IC_EXAMPLE, rules_violated: [] }]);
  invalid.push(['duplicate rule', { ...IC_EXAMPLE, rules_violated: ['1-3s', '1-3s'] }]);
  invalid.push(['1-2s is a warning, never a rejection rule', { ...IC_EXAMPLE, rules_violated: ['1-2s'] }]);
  invalid.push(['unknown rule', { ...IC_EXAMPLE, rules_violated: ['5-5s'] }]);
  invalid.push(['rules_violated not an array', { ...IC_EXAMPLE, rules_violated: '1-3s' }]);
  invalid.push(['empty analyte_ids', { ...IC_EXAMPLE, analyte_ids: [] }]);
  invalid.push(['101 analyte_ids', { ...IC_EXAMPLE, analyte_ids: Array.from({ length: 101 }, (_, k) => V7((0x400000 + k).toString(16).padStart(12, '0'))) }]);
  invalid.push(['analyte id not a uuid', { ...IC_EXAMPLE, analyte_ids: ['not-a-uuid'] }]);
  invalid.push(['run id not a uuidv7', { ...IC_EXAMPLE, qc_run_id: '0190a000-0000-4000-8000-000000000001' }]);
  invalid.push(['bad rule_mode', { ...IC_EXAMPLE, rule_mode: 'strict' }]);
  invalid.push(['controls_per_run 0', { ...IC_EXAMPLE, controls_per_run: 0 }]);
  invalid.push(['controls_per_run 7', { ...IC_EXAMPLE, controls_per_run: 7 }]);
  invalid.push(['controls_per_run as string', { ...IC_EXAMPLE, controls_per_run: '2' }]);
  invalid.push(['run_at with an offset', { ...IC_EXAMPLE, run_at: '2026-11-05T11:45:00.000+05:45' }]);
  invalid.push(['hold_since without milliseconds', { ...IC_EXAMPLE, hold_since: '2026-11-05T01:00:00Z' }]);
  invalid.push(['rejected_at as epoch number', { ...IC_EXAMPLE, rejected_at: 1793858405000 }]);
  invalid.push(['last_in_control_run_at null (must be absent)', { ...IC_EXAMPLE, last_in_control_run_at: null }]);

  it.each(invalid)('%s', async (_name, payload) => {
    const s = setup();
    const e = await failure(s.pub(payload));
    expect(e).toBeInstanceOf(Error);
    expect(s.stored()).toEqual([]);
    expect(s.db.writes().filter((w) => /INSERT\s+INTO\s+core\.event_log/i.test(w.text))).toEqual([]);   // validated BEFORE the insert
  });
  it('the error text never echoes the payload (ids, run times)', async () => {
    const s = setup();
    const e = await failure(s.pub({ ...IC_EXAMPLE, rules_violated: [] }));
    expect(String(e.message) + JSON.stringify(e)).not.toContain(RUN);
  });
});
