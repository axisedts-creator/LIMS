// HC-T17 (live PG17): the dynamic half of "log PHI scan test passes" and "metrics in TRD §14 exported".
// 02-TRD §14 (logs "Never: names, phones, addresses, landmark, notes, barcodes, GPS, payment references, consent text, tokens"; metric table), 07-SECURITY §5 item 10 ("planted synthetic name, phone, address,
// barcode, GPS, payment reference through every endpoint and consumer → absent from logs/metrics"), §6, REQ-SEC-098; plan row HC-T17 (DoD §3.7).
// Journeys through A3 pushSyncMutations (the one operation that carries barcodes, GPS and a payment reference): full flow with planted GPS + payment reference, a scan of a planted foreign barcode, a lab outage whose
// error text carries a planted name/phone/address, and a same-mutations replay. The module's RAW log calls (before the shared logger's scrubbers) and the rendered /metrics text are scanned.
// Fails now: no module code increments / observes any lims_homecollection_* metric (and an unregistered name throws in the real registry).
// Metric semantics pinned from the TRD table: mutations_total{type,outcome}: one inc per mutation, type = mutation type, outcome ∈ applied|duplicate|held|rejected (the result outcome);
// push_duration_seconds: one observation per push; clock_skew_seconds{clock_source}: one observation per mutation (anchor|offset|device); events_published_total: one inc per event published by the push.
import { beforeAll, describe, expect, it } from 'vitest';
import { REQUIRED_METRICS } from '../../../../core/observability/metrics.js';
import { PLANT, ensureTaskRegistry, fullFlow, M, pushObserved, pushWorld, type Recorder } from './helpers.js';

const T = 120_000;
const OUTCOMES = ['applied', 'duplicate', 'held', 'rejected'];
const noLabels = (l: unknown) => l === undefined || (typeof l === 'object' && l !== null && Object.keys(l).length === 0);
const hcIncs = (r: Recorder, name: string) => r.incs.filter((i) => i.name === name);

/** every planted string, plus the pieces a scrubber might leave behind, must be absent from raw log calls and from the rendered /metrics text */
async function expectClean(rec: Recorder, label: string): Promise<void> {
  const logs = JSON.stringify(rec.logs);
  const metrics = (await rec.render()) + JSON.stringify([rec.incs, rec.sets, rec.observes]);
  for (const p of Object.values(PLANT)) {
    expect(logs, `${label}: log contains ${p}`).not.toContain(p);
    expect(metrics, `${label}: metrics contain ${p}`).not.toContain(p);
  }
  for (const piece of ['Zorblax', 'Quenthrop', '9801234567', 'Plantedtole', 'PAYREF']) {
    expect(logs, `${label}: log contains ${piece}`).not.toContain(piece);
    expect(metrics, `${label}: metrics contain ${piece}`).not.toContain(piece);
  }
}

describe('HC-T17 live: metrics emitted by the push pipeline (TRD §14)', () => {
  beforeAll(async () => { await ensureTaskRegistry(); }, T);

  it('the 8 TRD §14 metrics are registered in the core registry (precondition of every test below)', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_homecollection_')).length).toBe(8);
  });

  it('a full visit flow counts every mutation once in lims_homecollection_mutations_total{type,outcome} with exactly those two labels', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const flow = fullFlow(w);
    const { reply, error, rec } = await pushObserved(w, flow);
    expect(error).toBeUndefined();
    expect(reply!.status).toBe(200);
    const hits = hcIncs(rec, 'lims_homecollection_mutations_total');
    expect(hits).toHaveLength(flow.length);
    for (const h of hits) { expect(Object.keys(h.labels ?? {}).sort()).toEqual(['outcome', 'type']); expect(OUTCOMES).toContain(h.labels!['outcome']); expect(h.by).toBe(1); }
    expect(hits.map((h) => h.labels!['type']).sort()).toEqual(flow.map((m) => m.type).sort());
    // the counted outcome is the outcome the device was told
    const told = reply!.body.results.map((r: any) => r.outcome).sort();
    expect(hits.map((h) => h.labels!['outcome']).sort()).toEqual(told);
    expect(told.every((o: string) => o === 'applied')).toBe(true);
  });

  it('the same mutations in a NEW batch are counted with outcome "duplicate", one per mutation', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const flow = fullFlow(w);
    const first = await pushObserved(w, flow);
    expect(first.reply!.status).toBe(200);
    const second = await pushObserved(w, flow);   // batchOf keeps device_seq on the objects; a new batch_id is generated per call
    expect(second.reply!.status).toBe(200);
    const hits = hcIncs(second.rec, 'lims_homecollection_mutations_total');
    expect(hits).toHaveLength(flow.length);
    expect(hits.every((h) => h.labels!['outcome'] === 'duplicate')).toBe(true);
  });

  it('one push observes lims_homecollection_push_duration_seconds exactly once, with no labels and a non-negative finite value', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const { reply, rec } = await pushObserved(w, fullFlow(w));
    expect(reply!.status).toBe(200);
    const obs = rec.observes.filter((o) => o.name === 'lims_homecollection_push_duration_seconds');
    expect(obs).toHaveLength(1);
    expect(noLabels(obs[0]!.labels)).toBe(true);
    expect(Number.isFinite(obs[0]!.value) && obs[0]!.value >= 0).toBe(true);
    expect(await rec.render()).toMatch(/^lims_homecollection_push_duration_seconds_count \d+/m);
  });

  it('clock skew is observed per mutation under {clock_source} ∈ anchor|offset|device (anchor path here: the world sends its anchor)', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const flow = fullFlow(w);
    const { reply, rec } = await pushObserved(w, flow);
    expect(reply!.status).toBe(200);
    const obs = rec.observes.filter((o) => o.name === 'lims_homecollection_clock_skew_seconds');
    expect(obs).toHaveLength(flow.length);
    for (const o of obs) { expect(Object.keys(o.labels ?? {})).toEqual(['clock_source']); expect(o.labels!['clock_source']).toBe('anchor'); expect(Number.isFinite(o.value) && o.value >= 0).toBe(true); }
  });

  it('published events are counted in lims_homecollection_events_published_total (no labels): one inc per event the push published', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const { reply, rec } = await pushObserved(w, fullFlow(w));
    expect(reply!.status).toBe(200);
    const hits = hcIncs(rec, 'lims_homecollection_events_published_total');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const h of hits) expect(noLabels(h.labels)).toBe(true);
    expect(hits.reduce((n, h) => n + h.by, 0)).toBeGreaterThanOrEqual(1);
    expect(await rec.render()).toMatch(/^lims_homecollection_events_published_total \d+/m);
  });
});

describe('HC-T17 live: PHI log scan - planted name, phone, address, barcode, GPS, payment reference (TRD §14 "Never", 07-SECURITY §5.10)', () => {
  beforeAll(async () => { await ensureTaskRegistry(); }, T);

  it('full flow with planted GPS on arrived/collected and a planted payment reference leaves none of them in raw log calls or /metrics', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const gps = { status: 'ok', latitude: PLANT.latitude, longitude: PLANT.longitude, accuracy_m: 5 };
    const flow = [M.arrived(w, { gps }), M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!, { gps, typeCode: w.specimens[0]!.specimenTypeCode }),
      M.collected(w, w.specimens[1]!, { gps, typeCode: w.specimens[1]!.specimenTypeCode, min: 11 }), M.payment(w, { reference: PLANT.paymentRef }), M.completed(w)];
    const { reply, error, rec } = await pushObserved(w, flow);
    expect(error).toBeUndefined();
    expect(reply!.status).toBe(200);
    expect(rec.incs.length, 'the journey must emit metrics, or the scan below is vacuous').toBeGreaterThan(0);
    await expectClean(rec, 'full flow');
  });

  it('scanning a planted foreign barcode (barcode_mismatch / held path) does not put that barcode, nor the visit specimens\' barcodes, in logs or metrics', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const flow = [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!, { scanned: PLANT.barcode, typeCode: w.specimens[0]!.specimenTypeCode })];
    const { reply, error, rec } = await pushObserved(w, flow);
    expect(error).toBeUndefined();
    expect(reply!.status).toBe(200);
    expect(rec.incs.some((i) => i.name === 'lims_homecollection_mutations_total'), 'the journey must emit metrics').toBe(true);
    await expectClean(rec, 'barcode mismatch');
    const logs = JSON.stringify(rec.logs), metrics = await rec.render();
    for (const s of w.specimens) { expect(logs, s.barcode).not.toContain(s.barcode); expect(metrics, s.barcode).not.toContain(s.barcode); }
  });

  it('a lab outage whose error text carries a planted name, phone and address is logged by code only (the message is never logged), and still surfaces as common.dependency_unavailable', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const flow = [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!, { typeCode: w.specimens[0]!.specimenTypeCode })];
    const boom = new Error(`lab down for ${PLANT.name} ${PLANT.phone} ${PLANT.address} ${PLANT.barcode}`);
    const { reply, error, rec } = await pushObserved(w, flow, { labFailsWith: boom });
    const code = (error as any)?.code ?? reply?.body?.code;
    expect(code).toBe('common.dependency_unavailable');
    expect(rec.logs.some((l) => l.msg === 'homecollection.lab_unavailable'), 'the outage must be logged (code only), or the scan is vacuous').toBe(true);
    await expectClean(rec, 'lab outage');
  });

  it('every raw log call of the journeys carries only id/code/count-like fields: no name, phone, address, landmark, note, barcode, GPS, payment reference, consent text, token or message key', { timeout: T }, async () => {
    const w = await pushWorld({ file: 17 });
    const boom = new Error(`lab down for ${PLANT.name}`);
    const { rec } = await pushObserved(w, [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!, { typeCode: w.specimens[0]!.specimenTypeCode })], { labFailsWith: boom });
    const keys = new Set<string>();
    const walk = (x: unknown): void => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.add(k.toLowerCase()); walk(v); } };
    for (const l of rec.logs) walk(l.fields);
    expect(rec.logs.length).toBeGreaterThan(0);
    const bad = [...keys].filter((k) => /(^|_)(name|names|phone|mobile|address|landmark|note|notes|barcode|barcodes|latitude|longitude|lat|lng|gps|reference|consent|token|message|stack|err)($|_)/.test(k));
    expect(bad).toEqual([]);
  });
});
