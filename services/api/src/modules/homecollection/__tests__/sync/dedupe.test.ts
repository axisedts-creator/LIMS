// HC-T12 push pipeline: dedupe + envelope (02-TRD §6.3 steps 1-4.5 and 6-7), 01-PRD US-08-2/3/10/11/12, US-07-1 (stored mutations), 07-SECURITY AB3, AB4, AB12 (pipeline), AB14, §5.1 cross-tenant probes.
// SELECT -> guard -> INSERT order (review #14), JCS payload hash (m#38), sync_batches inserted last (review #3), common.not_found mutation not stored + re-evaluated on resend (review #7), 413 limits.
// Fails now: A3 is an HC-T01 stub (common.internal "not implemented").
// NOT re-tested here (core pipeline): replay of the SAME batch_id under the same Idempotency-Key (stored response replayed, never reaches the handler), `422 common.idempotency_key_reused` for a changed body under one key,
//   `401 auth.token_expired`. Here a replay = the same mutations in a NEW batch (E2 / AB3).
// ASSUMED: `sync_batches.unresolved_mutations` = array of {client_mutation_id, type, device_seq}; a 413 / 400 / 409 refusal stores nothing; a mutation answered `duplicate` carries the STORED code; handler 413 limits come from
//   config (LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS 100, ..._PUSH_MAX_BYTES 524288) and are counted on the request body as received.
import { describe, expect, it } from 'vitest';
import { A, HC_CENTRE, M, MEMBER, MEMBER2, NOBODY, PHLEBO_B, T, addVisit, batchOf, batchRow, codes, colRows, countAll, deviceRow, eventsOf, flagRows, fullFlow, hc, hdr, mutByClient, mutRows, outcomes,
  payloadHash, push, pushFails, pushM, pushWorld, seed, uid, v7, visitRow, type Mut, type PushWorld } from './helpers.js';

const FILE = 1;
/** A committed sync_batches row + a stored mutation, as an EARLIER push would have left them (FK order: batch row first). */
const stored = async (w: PushWorld, m: Mut, o: { outcome: string; code?: string; sha?: string; payload?: unknown }) => {
  if (!m.device_seq) m.device_seq = w.seq();   // numbered like batchOf would (the DB CHECK needs >= 1)
  const b = hc.syncBatch(w.s, w.device.id, { membership_id: w.member });
  await seed('homecollection.sync_batches', b);
  await seed('homecollection.mutations', hc.mutation(w.s, w.device.id, b.id, w.visit.id, { client_mutation_id: m.client_mutation_id, device_seq: m.device_seq, type: m.type, membership_id: w.member, payload: o.payload ?? m.payload,
    payload_sha256: o.sha ?? payloadHash(o.payload ?? m.payload), outcome: o.outcome, ...(o.code ? { outcome_code: o.code } : {}), centre_id: w.visit.centre_id }));
};

describe('US-08-2 / AB3: the same mutations in a NEW batch are duplicates, never applied twice', () => {
  it('replay (new batch_id, same client_mutation_ids and payloads) -> every mutation `duplicate` with the STORED code; no new mutation / collection / event rows; the new batch row counts them', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const wrong = M.collected(w, w.specimens[1]!, { scanned: 'NOTMYTUBE1', min: 11 });
    const ms = [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!), wrong];
    const first = await pushM(w, ms);
    expect(outcomes(first)).toEqual(['applied', 'applied', 'applied', 'held']);
    const before = await countAll(w);
    expect(before.events).toBe(1);
    const batchId = v7();
    const again = await pushM(w, ms, { batchId });
    expect(outcomes(again)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(codes(again)).toEqual([undefined, undefined, undefined, A + 'barcode_mismatch']);   // the held one carries the stored hold code; `code` omitted (not null) when the stored outcome had none
    expect(again.body.results.map((x: any) => x.client_mutation_id)).toEqual(ms.map((m) => m.client_mutation_id));
    expect(again.body.batch_id).toBe(batchId);
    const after = await countAll(w);
    expect({ ...after, batches: 0 }).toEqual({ ...before, batches: 0 });   // nothing new but the batch row
    expect(after.batches).toBe(before.batches + 1);
    const b = await batchRow(batchId);
    expect([b.mutation_count, b.applied_count, b.held_count, b.rejected_count, b.duplicate_count]).toEqual([4, 0, 0, 0, 4]);
  });
  it('US-08-1 + 08-2: the full 7-mutation flow, retried as a new batch, emits NO second homecollection.collection.synced.v1', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = fullFlow(w);
    expect(outcomes(await pushM(w, ms))).toEqual(Array(7).fill('applied'));
    expect(outcomes(await pushM(w, ms))).toEqual(Array(7).fill('duplicate'));
    expect(await eventsOf(w.who.tenant, w.visit.id)).toHaveLength(1);
    expect(await colRows(w.visit.id)).toHaveLength(2);
  });
  it('mixed batch: known ids are duplicates, the new one is evaluated and applied; the event of this batch carries only the new mutation', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const pre = [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!)];
    await pushM(w, pre);
    const c2 = M.collected(w, w.specimens[1]!, { min: 11 });
    const r = await pushM(w, [...pre, c2]);
    expect(outcomes(r)).toEqual(['duplicate', 'duplicate', 'duplicate', 'applied']);
    const ev = await eventsOf(w.who.tenant, w.visit.id);
    expect(ev).toHaveLength(2);
    expect(ev[1]!.envelope.payload.collections.map((c: any) => c.client_mutation_id)).toEqual([c2.client_mutation_id]);
    expect(ev[0]!.idempotency_key).not.toBe(ev[1]!.idempotency_key);
  });
});

describe('US-08-3 / AB4: same client_mutation_id, different payload hash', () => {
  it('-> rejected common.idempotency_key_reused for THAT mutation; the stored row is untouched; nothing new is stored or emitted', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const pay = M.payment(w, { paisa: 180000 });
    expect(outcomes(await pushM(w, [pay]))).toEqual(['applied']);
    const before = { ...(await countAll(w)), row: await mutByClient(pay.client_mutation_id) };
    const edited = { ...pay, payload: { ...pay.payload, amount: { amount_paisa: 1, currency: 'NPR' } } };
    const siblings = M.completed(w);
    const r = await pushM(w, [edited, siblings]);
    expect(r.body.results[0]).toMatchObject({ client_mutation_id: pay.client_mutation_id, outcome: 'rejected', code: 'common.idempotency_key_reused' });
    expect(r.body.results[1].outcome).toBe('applied');   // the rest of the batch is not poisoned
    const row = await mutByClient(pay.client_mutation_id);
    expect([row.payload, row.payload_sha256, row.outcome]).toEqual([before.row.payload, before.row.payload_sha256, 'applied']);
    expect((await mutRows(w)).filter((m) => m.client_mutation_id === pay.client_mutation_id)).toHaveLength(1);   // not stored as a second row (unique key)
    expect((await eventsOf(w.who.tenant, w.visit.id)).flatMap((e) => e.envelope.payload.payments).map((p: any) => p.amount.amount_paisa)).toEqual([180000]);
    const b = await batchRow(r.body.batch_id);
    expect([b.rejected_count, b.applied_count]).toEqual([1, 1]);
  });
  it('the hash is the JCS (RFC 8785) hash of the payload computed by the server: key order / nesting order do not matter, the stored payload_sha256 equals the independent computation for every type', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = fullFlow(w);
    await pushM(w, ms);
    const rows = await mutRows(w);
    expect(rows).toHaveLength(7);
    for (const m of ms) expect((await mutByClient(m.client_mutation_id)).payload_sha256, m.type).toBe(payloadHash(m.payload));
    // same facts, different key order (JSON object member order is not significant): must be `duplicate`, NOT `reused`
    const reorder = (m: Mut): Mut => ({ ...m, payload: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(m.payload).reverse()))) });
    const pay = ms.find((m) => m.type === 'payment.captured')!;
    const flipped = reorder({ ...pay, payload: { ...pay.payload, amount: { currency: 'NPR', amount_paisa: 180000 } } });
    expect(Object.keys(flipped.payload)).not.toEqual(Object.keys(pay.payload));
    expect(outcomes(await pushM(w, [reorder(ms[0]!), flipped]))).toEqual(['duplicate', 'duplicate']);
  });
});

describe('TRD §6.3 step 4: SELECT -> guard -> INSERT with the outcome (review #14)', () => {
  it('a stored mutation is answered from its stored row BEFORE any guard: an `applied` arrived resent after the visit was completed is `duplicate`, not visit_closed', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, status: 'completed' });
    const m = M.arrived(w);
    await stored(w, m, { outcome: 'applied' });
    const r = await pushM(w, [m]);
    expect([outcomes(r), codes(r)]).toEqual([['duplicate'], [undefined]]);
    expect(await mutRows(w)).toHaveLength(1);   // only the seeded row
  });
  it('stored `held` row: duplicate with the stored code; stored row with a different hash: rejected idempotency_key_reused', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const held = M.collected(w, w.specimens[0]!);
    await stored(w, held, { outcome: 'held', code: A + 'barcode_mismatch' });
    const reused = M.consent(w);
    await stored(w, reused, { outcome: 'applied', payload: { ...reused.payload, given: false } });
    const r = await pushM(w, [held, reused]);
    expect(r.body.results.map((x: any) => [x.outcome, x.code])).toEqual([['duplicate', A + 'barcode_mismatch'], ['rejected', 'common.idempotency_key_reused']]);
    expect(await colRows(w.visit.id)).toHaveLength(0);   // the guard never ran, so no collection effect
  });
  it('concurrent pushes of the same mutations (two batch ids) -> exactly one applies, the other answers duplicate; no 5xx, one collection, one event (row lock + ON CONFLICT DO NOTHING)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!), M.payment(w)];
    const rs = await Promise.allSettled([pushM(w, ms), pushM(w, ms), pushM(w, ms)]);
    expect(rs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const outs = rs.map((r) => outcomes((r as PromiseFulfilledResult<any>).value));
    for (let i = 0; i < ms.length; i++) expect(outs.map((o) => o[i]).sort(), `mutation ${i}`).toEqual(['applied', 'duplicate', 'duplicate']);
    expect(await mutRows(w)).toHaveLength(4);
    expect((await colRows(w.visit.id)).filter((c) => c.status === 'applied')).toHaveLength(1);
    expect(await eventsOf(w.who.tenant, w.visit.id)).toHaveLength(1);
  });
});

describe('common.not_found: unknown / invisible visit (review #7, US-08-12)', () => {
  it('unknown visit id -> rejected common.not_found; NOT stored in mutations; listed in sync_batches.unresolved_mutations (ids, type, seq — no payload)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ghost = M.collected(w, w.specimens[0]!, { visit: uid() });
    const good = M.consent(w);
    const r = await pushM(w, [ghost, good]);
    expect(r.body.results.map((x: any) => [x.outcome, x.code])).toEqual([['rejected', 'common.not_found'], ['applied', undefined]]);
    expect(await mutByClient(ghost.client_mutation_id)).toBeUndefined();
    expect((await mutRows(w)).map((m) => m.client_mutation_id)).toEqual([good.client_mutation_id]);
    const b = await batchRow(r.body.batch_id);
    expect([b.mutation_count, b.applied_count, b.rejected_count]).toEqual([2, 1, 1]);
    const un = JSON.stringify(b.unresolved_mutations);
    expect(un).toContain(ghost.client_mutation_id);
    expect(un).toContain('specimen.collected');
    expect(b.unresolved_mutations.map((u: any) => u.device_seq)).toEqual([ghost.device_seq]);
    expect(un).not.toContain(w.specimens[0]!.barcode);   // no payload
    expect(un).not.toContain('scanned_barcode');
  });
  it('a later resend of the same id is evaluated AGAIN (here: the visit now exists, assigned to the pusher) -> applied, not duplicate; and the resend\'s batch has no unresolved list', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const lateVisitId = uid();
    const m = M.consent(w, { visit: lateVisitId });
    expect(outcomes(await pushM(w, [m]))).toEqual(['rejected']);
    await addVisit(w, { id: lateVisitId });
    const r = await pushM(w, [m]);
    expect(outcomes(r)).toEqual(['applied']);
    expect((await mutByClient(m.client_mutation_id)).visit_id).toBe(lateVisitId);
    expect((await batchRow(r.body.batch_id)).unresolved_mutations ?? []).toEqual([]);
    expect(outcomes(await pushM(w, [m]))).toEqual(['duplicate']);   // and now it IS stored
  });
  it('a visit of ANOTHER tenant is invisible (RLS): rejected common.not_found, no side effect on the other tenant\'s rows (07 §5.1)', { timeout: T }, async () => {
    const a = await pushWorld({ file: FILE });
    const b = await pushWorld({ file: FILE, s: 'b' });
    const r = await pushM(b, [M.consent(b, { visit: a.visit.id }), M.arrived(b, { visit: a.visit.id })]);
    expect(r.body.results.map((x: any) => [x.outcome, x.code])).toEqual([['rejected', 'common.not_found'], ['rejected', 'common.not_found']]);
    expect(await mutRows(a)).toHaveLength(0);
    expect((await visitRow(a.visit.id)).status).toBe('assigned');
  });
});

describe('sync_batches last, device counters, atomicity (TRD §6.3 steps 3, 6, 7)', () => {
  it('one sync_batches row per push: id = batch_id, device/membership, clock inputs, anchors, final counts; devices.max_device_seq_received = max seq, last_push_at = receipt time', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const wrong = M.collected(w, w.specimens[1]!, { scanned: 'NOPE0001', min: 11 });
    const ms = [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!), wrong, M.payment(w, { paisa: 100 })];
    const body = batchOf(w, ms);
    const r = await push(w, body);
    expect(r.status).toBe(200);
    expect(r.body.batch_id).toBe(body.batch_id);
    expect(new Date(r.body.server_time).getTime()).toBe(w.now.getTime());
    expect(r.body.device_command).toBe('none');
    expect(r.body.handover_items).toEqual([]);
    const b = await batchRow(body.batch_id);
    expect([b.device_id, b.membership_id, b.mutation_count, b.applied_count, b.held_count, b.rejected_count, b.duplicate_count]).toEqual([w.device.id, w.member, 5, 4, 1, 0, 0]);
    expect([b.now_boot_id, Number(b.now_monotonic_ms)]).toEqual(['b-1', body.now.monotonic_ms]);
    expect(b.anchors).toHaveLength(1);
    expect(new Date(b.received_at).getTime()).toBe(w.now.getTime());
    const d = await deviceRow(w.device.id);
    expect(Number(d.max_device_seq_received)).toBe(5);
    expect(new Date(d.last_push_at).getTime()).toBe(w.now.getTime());
    expect((await mutRows(w)).every((m) => m.batch_id === body.batch_id)).toBe(true);
  });
  it('max_device_seq_received never goes down: an older batch (lower seqs, all duplicates) leaves it unchanged', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = [M.identity(w), M.consent(w), M.arrived(w)];
    await pushM(w, ms);
    await pushM(w, ms.slice(0, 1));
    expect(Number((await deviceRow(w.device.id)).max_device_seq_received)).toBe(3);
  });
  it('LabPort failure -> 503 common.dependency_unavailable for the WHOLE batch and nothing is committed (no mutation, collection, event, batch row; counters unchanged); plain Error too', { timeout: T }, async () => {
    for (const labPlain of [false, true]) {
      const w = await pushWorld({ file: FILE });
      const e: any = await pushFails(w, batchOf(w, [M.identity(w), M.consent(w), M.arrived(w), M.collected(w, w.specimens[0]!)]), { fx: { labFails: true, labPlain } });
      expect([e.code, e.statusCode]).toEqual(['common.dependency_unavailable', 503]);
      expect(await countAll(w)).toEqual({ mutations: 0, collections: 0, flags: 0, events: 0, batches: 0, handovers: 0 });
      expect(Number((await deviceRow(w.device.id)).max_device_seq_received)).toBe(0);
      expect((await visitRow(w.visit.id)).status).toBe('assigned');
    }
  });
  it('lookupSpecimens is called once per DISTINCT order touched (not per mutation), with the {orderId} form only', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const other = await addVisit(w);
    const r = await pushM(w, [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!), M.collected(w, w.specimens[1]!, { min: 11 }), M.payment(w),
      M.identity(w, { visit: other.visit.id, min: 8 }), M.consent(w, { visit: other.visit.id, min: 9 }), M.collected(w, other.specimens[0]!, { visit: other.visit.id, min: 13 })]);
    expect(outcomes(r)).toEqual(Array(8).fill('applied'));
    const orders = r.probe.lab.map((c) => c.orderId);
    expect([...new Set(orders)].sort()).toEqual([w.order.id, other.order.id].sort());
    expect(orders).toHaveLength(2);
    expect(r.probe.lab.every((c) => !('specimenIds' in c))).toBe(true);   // the {specimenIds} form needs lab.specimen.read, which phlebotomists lack
  });
});

describe('limits and envelope (AB14, US-08-11, TRD §5 preamble / §6.3 step 1)', () => {
  const consents = (w: PushWorld, n: number, pad = 0): Mut[] => Array.from({ length: n }, (_x, i) => ({ ...M.consent(w, { seq: i + 1, min: 7 }), ...(pad ? { payload: { consent_text_version: 'hc-consent-v1', given: true, pad: 'x'.repeat(pad) } } : {}) }));
  it('exactly 100 mutations is accepted; 101 -> 413 common.payload_too_large and nothing stored', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ok = await push(w, batchOf(w, consents(w, 100)));
    expect([ok.status, ok.body.results.length]).toEqual([200, 100]);
    const w2 = await pushWorld({ file: FILE });
    const e: any = await pushFails(w2, batchOf(w2, consents(w2, 101)));
    expect([e.code, e.statusCode]).toEqual(['common.payload_too_large', 413]);
    expect(await countAll(w2)).toEqual({ mutations: 0, collections: 0, flags: 0, events: 0, batches: 0, handovers: 0 });
  });
  it('body larger than 512 KB (LIMS_HOMECOLLECTION_PUSH_MAX_BYTES) -> 413 common.payload_too_large, nothing stored', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const body = batchOf(w, consents(w, 90, 6000));
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(524288);
    const e: any = await pushFails(w, body);
    expect([e.code, e.statusCode]).toEqual(['common.payload_too_large', 413]);
    expect((await mutRows(w))).toHaveLength(0);
  });
  it('header X-Lims-Device-Id differs from body.device_id -> 400 common.id_mismatch BEFORE any other check (even with 101 mutations)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const e: any = await pushFails(w, batchOf(w, consents(w, 101)), { headers: hdr(v7()) });
    expect([e.code, e.statusCode]).toEqual(['common.id_mismatch', 400]);
  });
  it('unregistered device / a device of another membership / signed_off -> 409 homecollection.device_not_registered; nothing stored', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ghost = v7();
    const e1: any = await pushFails(w, { ...batchOf(w, [M.consent(w)]), device_id: ghost }, { headers: hdr(ghost) });
    expect([e1.code, e1.statusCode]).toEqual(['homecollection.device_not_registered', 409]);
    const theirs = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    const e2: any = await pushFails(w, { ...batchOf(w, [M.consent(w)]), device_id: theirs.device.id }, { headers: hdr(theirs.device.id) });   // PHLEBO pushing on MEMBER2's device (AB1)
    expect(e2.code).toBe('homecollection.device_not_registered');
    const off = await pushWorld({ file: FILE, deviceExtra: { status: 'signed_off', signed_off_at: '2028-01-01T00:00:00.000Z' } });
    const e3: any = await pushFails(off, batchOf(off, [M.consent(off)]));
    expect(e3.code).toBe('homecollection.device_not_registered');
    expect(await mutRows(off)).toHaveLength(0);
  });
  it('a wipe_requested device MAY still push (it must finish uploading before it wipes, US-13-5)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, deviceExtra: { status: 'wipe_requested', wipe_requested_at: '2028-01-01T00:00:00.000Z', wipe_requested_by: MEMBER2.a, wipe_reason_code: 'lost' } });
    expect(outcomes(await pushM(w, [M.consent(w)]))).toEqual(['applied']);
  });
  it('app version below min_app_version -> 426 homecollection.app_version_unsupported', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const e: any = await pushFails(w, batchOf(w, [M.consent(w)]), { headers: hdr(w.device.id, '0.0.1') });
    expect([e.code, e.statusCode]).toEqual(['homecollection.app_version_unsupported', 426]);
    expect(await mutRows(w)).toHaveLength(0);
  });
  it('permission: an actor without homecollection.sync.upload -> auth.forbidden', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const e: any = await pushFails(w, batchOf(w, [M.consent(w)]), { who: { ...NOBODY, membershipId: w.member } });
    expect(e.code).toBe('auth.forbidden');
    expect(await mutRows(w)).toHaveLength(0);
  });
  it('cross-tenant device id: tenant B pushing on tenant A\'s device -> 409 device_not_registered (RLS), no rows in A', { timeout: T }, async () => {
    const a = await pushWorld({ file: FILE });
    const e: any = await pushFails(a, { ...batchOf(a, [M.consent(a)]) }, { who: PHLEBO_B });
    expect(e.code).toBe('homecollection.device_not_registered');
    expect(await mutRows(a)).toHaveLength(0);
  });
  it('payment / collection / handover ids of ANOTHER tenant inside a mutation are not found (07 §5.1): payment order, specimen, to_centre_id', { timeout: T }, async () => {
    const a = await pushWorld({ file: FILE });
    const b = await pushWorld({ file: FILE, s: 'b' });
    const r = await pushM(b, [M.payment(b, { order: a.order.id }), ...[M.identity(b), M.consent(b)], M.collected(b, a.specimens[0]!), M.handover(b, [a.specimens[0]!.specimenId], { to: HC_CENTRE.a })]);
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(['rejected', 'applied', 'applied', 'rejected', 'rejected']);
    expect(r.body.results[0].code).toBe('common.validation_failed');
    expect(r.body.results[3].code).toBe('common.not_found');
    expect((await colRows(a.visit.id)).length + (await flagRows(a.visit.id)).length).toBe(0);
  });
});

