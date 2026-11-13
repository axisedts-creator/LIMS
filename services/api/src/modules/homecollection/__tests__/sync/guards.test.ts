// HC-T12 push guards: one integration test per row/branch of 03-APP-FLOW §4 (server-wins rules), evaluated in device_seq order against a REAL PG17.
// 01-PRD US-07-2/3/4/5/6/7 (server side), US-08-4/5/6/7/8/9, 07-SECURITY AB2, AB5, AB6, §5.2 (cross-centre), §5.3 (assignee probes). Fails now: A3 is an HC-T01 stub (common.internal "not implemented").
// ASSUMED (spec silent): result `code` is the full error code (`homecollection.visit_closed`, ...); `mutations.outcome_code` stores the same string; collections.hold_code ends with the short code; a mutation
// rejected for a SPECIMEN `common.not_found` IS stored (only a missing visit is not); a centre-denied mutation is `rejected` (code not pinned).
import { describe, expect, it } from 'vitest';
import { A, M, MEMBER, MEMBER2, T, addVisit, codes, colRows, deviceRow, flagRows, fullFlow, mutByClient, mutRows, outcomes, prelude, pushM, pushWorld, setSettings, TENANT_B, transitionRows, visitRow, at, type Mut,
  type PushWorld } from './helpers.js';

const FILE = 0;
const one = async (w: PushWorld, ms: Mut[]) => (await pushM(w, ms)).body.results;
const lastOf = (r: any[]) => r[r.length - 1];
const heldRow = async (w: PushWorld, m: Mut) => (await colRows(w.visit.id)).find((c) => c.client_mutation_id === m.client_mutation_id);

describe('visit.arrived / identity_checked / consent_recorded (US-07-2/3, US-08-5)', () => {
  it('assigned visit: all three applied; V8 moves the visit assigned -> in_progress on the first one (arrived_at = corrected time)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const r = await pushM(w, [M.arrived(w), M.identity(w), M.consent(w)]);
    expect(r.status).toBe(200);
    expect(outcomes(r)).toEqual(['applied', 'applied', 'applied']);
    expect(r.body.results.map((x: any) => x.device_seq)).toEqual([1, 2, 3]);   // same order as the request
    const v = await visitRow(w.visit.id);
    expect(v.status).toBe('in_progress');
    expect(new Date(v.arrived_at).toISOString()).toBe(at(w.date, '04:05'));   // anchor 04:00Z + 5 min (clock correction §7.5)
    expect((await transitionRows(w.visit.id)).map((t) => `${t.from_status}>${t.to_status}`)).toEqual(['assigned>in_progress']);   // ONE transition, not three
    expect((await mutRows(w)).map((m) => m.outcome)).toEqual(['applied', 'applied', 'applied']);
  });
  it.each([['completed'], ['failed']])('visit already %s -> rejected homecollection.visit_closed (fact kept in mutations)', { timeout: T }, async (status) => {
    const w = await pushWorld({ file: FILE, status });
    const ms = [M.arrived(w), M.identity(w), M.consent(w)];
    const r = await pushM(w, ms);
    expect(outcomes(r)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(codes(r)).toEqual([A + 'visit_closed', A + 'visit_closed', A + 'visit_closed']);
    expect((await mutRows(w)).map((m) => [m.outcome, m.outcome_code])).toEqual(ms.map(() => ['rejected', A + 'visit_closed']));
    expect((await visitRow(w.visit.id)).status).toBe(status);
  });
  it('closed is checked BEFORE the assignee: a closed visit of someone else -> visit_closed, not visit_not_assigned', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, status: 'completed', member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    expect(codes(await pushM(w, [M.arrived(w)]))).toEqual([A + 'visit_closed']);
  });
  it('AB2-style: the pusher was never an assignee -> rejected visit_not_assigned; the visit does not move', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    const r = await pushM(w, [M.arrived(w), M.identity(w), M.consent(w)]);
    expect(outcomes(r)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(codes(r)).toEqual(Array(3).fill(A + 'visit_not_assigned'));
    expect((await visitRow(w.visit.id)).status).toBe('assigned');
  });
  it('US-08-5: reassigned to B AFTER A captured, A was the assignee at the corrected capture time -> A\'s arrived is applied (asg(t) = A)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }, { member: MEMBER2.a, at: '@05:30' }] });
    expect(w.member).toBe(MEMBER.a);   // the device is A's; the current assignee is B (reassigned at 05:30Z, after A's capture)
    expect((await visitRow(w.visit.id)).assigned_membership_id).toBe(MEMBER2.a);
    expect(outcomes(await pushM(w, [M.arrived(w, { min: 40 })]))).toEqual(['applied']);
  });
  it('consent text version different from the current setting -> still applied (a fact), the version is stored in the payload', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const m = M.consent(w, { version: 'hc-consent-OLD' });
    expect(outcomes(await pushM(w, [m]))).toEqual(['applied']);
    expect((await mutByClient(m.client_mutation_id)).payload.consent_text_version).toBe('hc-consent-OLD');
  });
  it('identity mismatch (either identifier) -> applied as a fact, the visit stays in_progress (the device then sends visit.failed)', { timeout: T }, async () => {
    for (const bad of [{ name: 'mismatch' as const }, { second: 'mismatch' as const }]) {
      const w = await pushWorld({ file: FILE });
      expect(outcomes(await pushM(w, [M.arrived(w), M.identity(w, bad)]))).toEqual(['applied', 'applied']);
      expect((await visitRow(w.visit.id)).status).toBe('in_progress');
    }
  });
  it('US-07-2: after a mismatch the collection is held (identity must be matches/matches) — the server never lets a mismatching identity collect', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const c = M.collected(w, w.specimens[0]!);
    const r = await one(w, [M.arrived(w), M.identity(w, { name: 'mismatch' }), M.consent(w), c]);
    expect([lastOf(r).outcome, lastOf(r).code]).toEqual(['held', A + 'mutation_superseded']);
  });
});

describe('specimen.collected: the 7 ordered checks (03-APP-FLOW §4)', () => {
  it('all green (identity matches/matches + consent given earlier in device_seq, assignee, ordered, barcode equal, none applied yet) -> applied; collection row applied; barcode_verified true for camera and hid', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = [...prelude(w), M.collected(w, w.specimens[0]!, { method: 'camera' }), M.collected(w, w.specimens[1]!, { method: 'hid', min: 11 })];
    expect(outcomes(await pushM(w, ms))).toEqual(['applied', 'applied', 'applied', 'applied']);
    const cols = await colRows(w.visit.id);
    expect(cols.map((c) => [c.status, c.barcode_verified, c.hold_code ?? '', c.scan_method].join('/')).sort()).toEqual(['applied/true//camera', 'applied/true//hid']);
    expect(cols.every((c) => c.collected_by_membership_id === w.member && c.order_id === w.order.id && c.centre_id === w.visit.centre_id)).toBe(true);
    expect((await visitRow(w.visit.id)).status).toBe('in_progress');   // V8 also fires on the first applied specimen.collected
  });
  it('US-08-9 / US-07-5: scan_method manual + matching barcode -> applied with barcode_verified false', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const c = M.collected(w, w.specimens[0]!, { method: 'manual' });
    expect(outcomes(await pushM(w, [...prelude(w), c]))).toEqual(['applied', 'applied', 'applied']);
    const row = await heldRow(w, c);
    expect([row.status, row.barcode_verified, row.scan_method]).toEqual(['applied', false, 'manual']);
  });
  it('(1) visit cancelled on the server -> held mutation_superseded + flag collected_after_cancel; the visit stays cancelled', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, status: 'cancelled' });
    const c = M.collected(w, w.specimens[0]!);
    const r = await one(w, [...prelude(w), c]);
    expect([lastOf(r).outcome, lastOf(r).code]).toEqual(['held', A + 'mutation_superseded']);
    expect((await heldRow(w, c)).status).toBe('held');
    expect((await flagRows(w.visit.id)).filter((f) => f.status === 'open').map((f) => f.kind)).toContain('collected_after_cancel');
    expect((await visitRow(w.visit.id)).status).toBe('cancelled');
  });
  it.each([['completed'], ['failed']])('(1) visit %s -> held mutation_superseded + flag held_collection', { timeout: T }, async (status) => {
    const w = await pushWorld({ file: FILE, status });
    const c = M.collected(w, w.specimens[0]!);
    const r = await one(w, [...prelude(w), c]);
    expect([lastOf(r).outcome, lastOf(r).code]).toEqual(['held', A + 'mutation_superseded']);
    expect((await flagRows(w.visit.id)).map((f) => f.kind)).toContain('held_collection');
  });
  it('(2) AB2: the pusher is not the assignee at capture time and never was -> held visit_not_assigned (fact kept, never applied)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    const c = M.collected(w, w.specimens[0]!);
    const r = await one(w, [...prelude(w), c]);
    expect([lastOf(r).outcome, lastOf(r).code]).toEqual(['held', A + 'visit_not_assigned']);
    const row = await heldRow(w, c);
    expect([row.status, row.hold_code]).toEqual(['held', expect.stringMatching(/visit_not_assigned$/)]);
    expect((await mutByClient(c.client_mutation_id)).outcome).toBe('held');   // kept, with its payload
    expect((await flagRows(w.visit.id)).map((f) => f.kind)).toContain('held_collection');
  });
  it('(3) no identity check / no consent before it in device_seq -> held mutation_superseded (review m#29)', { timeout: T }, async () => {
    for (const pre of [(w: PushWorld) => [] as Mut[], (w: PushWorld) => [M.identity(w)], (w: PushWorld) => [M.consent(w)]]) {
      const w = await pushWorld({ file: FILE });
      const ms = pre(w); const c = M.collected(w, w.specimens[0]!);
      const r = await one(w, [...ms, c]);
      expect([lastOf(r).outcome, lastOf(r).code]).toEqual(['held', A + 'mutation_superseded']);
    }
  });
  it('(3) the checks must PRECEDE the collection in device_seq: identity + consent with higher seq -> held', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const c = M.collected(w, w.specimens[0]!, { seq: 1 });
    const r = await one(w, [c, M.identity(w, { seq: 2 }), M.consent(w, { seq: 3 })]);
    expect(r[0].outcome).toBe('held');
  });
  it('(3) consent refused (given:false) or second identifier mismatch -> held', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    expect(lastOf(await one(w, [M.identity(w), M.consent(w, { given: false }), M.collected(w, w.specimens[0]!)])).outcome).toBe('held');
    const w2 = await pushWorld({ file: FILE });
    expect(lastOf(await one(w2, [M.identity(w2, { second: 'mismatch' }), M.consent(w2), M.collected(w2, w2.specimens[0]!)])).outcome).toBe('held');
  });
  it('(3) identity/consent applied in an EARLIER batch count ("applied earlier" is not limited to this batch)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    expect(outcomes(await pushM(w, prelude(w)))).toEqual(['applied', 'applied']);
    expect(outcomes(await pushM(w, [M.collected(w, w.specimens[0]!)]))).toEqual(['applied']);
  });
  it('(3) an identity check that was itself NOT applied (visit not assigned to the author) does not satisfy the guard', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    const r = await one(w, [M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!)]);
    expect([r[0].outcome, r[1].outcome, lastOf(r).outcome]).toEqual(['rejected', 'rejected', 'held']);
  });
  it('(4) specimen not in lookupSpecimens({orderId}) (another visit\'s tube, an unknown id) -> rejected common.not_found; stored as rejected, no collection', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const other = await addVisit(w);
    const foreign = M.collected(w, other.specimens[0]!);   // belongs to ANOTHER visit's order: US-07-4 "This tube belongs to another patient" -> nothing recorded as a collection
    const unknown = M.collected(w, { specimenId: '01a1a98a-ac40-7000-8000-0000feed0001', barcode: 'NOSUCH1' }, { min: 11 });
    const r = await one(w, [...prelude(w), foreign, unknown]);
    expect(r.slice(2).map((x: any) => [x.outcome, x.code])).toEqual([['rejected', 'common.not_found'], ['rejected', 'common.not_found']]);
    expect(await colRows(w.visit.id)).toHaveLength(0);
    expect((await mutByClient(foreign.client_mutation_id)).outcome).toBe('rejected');
  });
  it('(5) specimen no longer `ordered` in C5 (collected at a walk-in counter) or inactive -> held mutation_superseded', { timeout: T }, async () => {
    for (const over of [{ status: 'collected' }, { isActive: false }]) {
      const w = await pushWorld({ file: FILE });
      const r = (await pushM(w, [...prelude(w), M.collected(w, w.specimens[0]!)], { fx: { lab: { [w.order.id]: [over, {}] } } })).body.results;
      expect([lastOf(r).outcome, lastOf(r).code]).toEqual(['held', A + 'mutation_superseded']);
    }
  });
  it('(6) AB6 / US-08-7: scanned barcode differs from the barcode C5 returns -> held homecollection.barcode_mismatch', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const c = M.collected(w, w.specimens[0]!, { scanned: w.specimens[1]!.barcode });   // a typed barcode of ANOTHER tube of the same order
    const r = await one(w, [...prelude(w), c]);
    expect([lastOf(r).outcome, lastOf(r).code]).toEqual(['held', A + 'barcode_mismatch']);
    expect((await heldRow(w, c)).hold_code).toMatch(/barcode_mismatch$/);
  });
  it('(7) an applied collection already exists for the specimen (different client_mutation_id) -> held mutation_superseded; exactly one applied row per specimen', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    expect(outcomes(await pushM(w, [...prelude(w), M.collected(w, w.specimens[0]!)]))).toEqual(['applied', 'applied', 'applied']);
    const again = await pushM(w, [M.collected(w, w.specimens[0]!, { min: 14 })]);
    expect([again.body.results[0].outcome, again.body.results[0].code]).toEqual(['held', A + 'mutation_superseded']);
    expect((await colRows(w.visit.id)).map((c) => c.status).sort()).toEqual(['applied', 'held']);
  });
  it('precedence: (1) before (2) before (3) before (4) before (5) before (6)', { timeout: T }, async () => {
    // cancelled + not assignee + no identity + unknown specimen -> (1) mutation_superseded with collected_after_cancel
    const a = await pushWorld({ file: FILE, status: 'cancelled', member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    expect(codes(await pushM(a, [M.collected(a, { specimenId: '01a1a98a-ac40-7000-8000-0000feed0002', barcode: 'X' })]))).toEqual([A + 'mutation_superseded']);
    // not assignee + no identity -> (2) visit_not_assigned
    const b = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    expect(codes(await pushM(b, [M.collected(b, b.specimens[0]!)]))).toEqual([A + 'visit_not_assigned']);
    // no identity + unknown specimen -> (3) held, NOT (4) rejected
    const c = await pushWorld({ file: FILE });
    expect(outcomes(await pushM(c, [M.collected(c, { specimenId: '01a1a98a-ac40-7000-8000-0000feed0003', barcode: 'X' })]))).toEqual(['held']);
    // unknown specimen + wrong barcode -> (4) rejected not_found
    const d = await pushWorld({ file: FILE });
    expect(codes(await pushM(d, [...prelude(d), M.collected(d, { specimenId: '01a1a98a-ac40-7000-8000-0000feed0004', barcode: 'X' })])).slice(2)).toEqual(['common.not_found']);
    // status != ordered + wrong barcode -> (5) mutation_superseded, NOT (6) barcode_mismatch
    const e = await pushWorld({ file: FILE });
    const r = await pushM(e, [...prelude(e), M.collected(e, e.specimens[0]!, { scanned: 'WRONG1' })], { fx: { lab: { [e.order.id]: [{ status: 'collected' }, {}] } } });
    expect(codes(r).slice(2)).toEqual([A + 'mutation_superseded']);
  });
  it('US-08-5: A was the assignee when the collection was captured but the visit was reassigned to B since (05:30Z, after the capture) -> A\'s collection is applied (never-assigned case: see (2))', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }, { member: MEMBER2.a, at: '@05:30' }] });
    const c = M.collected(w, w.specimens[0]!, { min: 41 });
    expect(outcomes(await pushM(w, [M.identity(w, { min: 38 }), M.consent(w, { min: 39 }), c]))).toEqual(['applied', 'applied', 'applied']);
    expect((await heldRow(w, c)).status).toBe('applied');
  });
  it('a centre the membership may not act in (assertRole denied for the visit centre) -> every mutation of that visit is rejected, nothing applied (07 §5.2)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const r = await pushM(w, [M.arrived(w), ...prelude(w), M.collected(w, w.specimens[0]!)], { fx: { deniedCentres: [w.visit.centre_id] } });
    expect(new Set(outcomes(r))).toEqual(new Set(['rejected']));
    expect((await colRows(w.visit.id)).filter((c) => c.status === 'applied')).toHaveLength(0);
    expect((await visitRow(w.visit.id)).status).toBe('assigned');
  });
});

describe('specimen.not_collected (US-07-6)', () => {
  it('applied for an assigned visit + flag specimen_not_collected; completing with `partial` yields outcome partial', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const ms = [...prelude(w), M.collected(w, w.specimens[0]!), M.notCollected(w, w.specimens[1]!, { reason: 'patient_declined_tube' }), M.completed(w, { outcome: 'partial' })];
    expect(outcomes(await pushM(w, ms))).toEqual(Array(5).fill('applied'));
    expect((await flagRows(w.visit.id)).map((f) => f.kind)).toContain('specimen_not_collected');
    const v = await visitRow(w.visit.id);
    expect([v.status, v.outcome]).toEqual(['completed', 'partial']);
  });
  it('closed visit -> rejected visit_closed; not assigned -> rejected visit_not_assigned', { timeout: T }, async () => {
    const a = await pushWorld({ file: FILE, status: 'completed' });
    expect(codes(await pushM(a, [M.notCollected(a, a.specimens[0]!)]))).toEqual([A + 'visit_closed']);
    const b = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    expect(codes(await pushM(b, [M.notCollected(b, b.specimens[0]!)]))).toEqual([A + 'visit_not_assigned']);
  });
});

describe('payment.captured (US-07-7, AB5, D-PAY)', () => {
  it('applied; stored with the payload (method, amount_paisa 180000 NPR)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const p = M.payment(w);
    expect(outcomes(await pushM(w, [p]))).toEqual(['applied']);
    expect((await mutByClient(p.client_mutation_id)).payload).toEqual(p.payload);
  });
  it('AB5: payment for an order that is not the visit\'s order -> rejected common.validation_failed; visit without an order_id -> rejected too', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const other = await addVisit(w);
    expect(codes(await pushM(w, [M.payment(w, { order: other.order.id })]))).toEqual(['common.validation_failed']);
    const b = await pushWorld({ file: FILE, kind: 'booking', visitExtra: { order_id: null, status: 'unassigned' } });
    expect(codes(await pushM(b, [M.payment(b, { order: w.order.id })]))).toEqual(['common.validation_failed']);
  });
  it('never an assignee of the visit -> rejected visit_not_assigned + flag payment_rejected (finance enters it manually in C4)', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    expect(codes(await pushM(w, [M.payment(w)]))).toEqual([A + 'visit_not_assigned']);
    expect((await flagRows(w.visit.id)).map((f) => f.kind)).toContain('payment_rejected');
  });
  it('payment method outside settings.payment_methods -> rejected common.validation_failed', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    expect(codes(await pushM(w, [M.payment(w, { method: 'barter_goats' })]))).toEqual(['common.validation_failed']);
  });
  it('requires_reference method: missing reference -> rejected validation_failed; with reference -> applied (tenant B settings)', { timeout: T }, async () => {
    await setSettings(TENANT_B, 'payment_methods = $2::jsonb', [JSON.stringify([{ code: 'cash', display: 'Cash', requires_reference: false }, { code: 'fonepay_qr', display: 'Fonepay QR', requires_reference: true }])]);
    const w = await pushWorld({ file: FILE, s: 'b' });
    expect(codes(await pushM(w, [M.payment(w, { method: 'fonepay_qr' })]))).toEqual(['common.validation_failed']);
    expect(outcomes(await pushM(w, [M.payment(w, { method: 'fonepay_qr', reference: 'FP-SYN-0001' })]))).toEqual(['applied']);
  });
  it('D-PAY: applied EVEN when the visit is cancelled / completed / failed', { timeout: T }, async () => {
    for (const status of ['cancelled', 'completed', 'failed']) {
      const w = await pushWorld({ file: FILE, status });
      expect(outcomes(await pushM(w, [M.payment(w)]))).toEqual(['applied']);
    }
  });
  it('a previous assignee (reassigned away) may still record the payment: the rule is "never assigned", not "not assigned now"', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    expect(outcomes(await pushM(w, [M.payment(w)]))).toEqual(['applied']);
  });
});

describe('visit.completed / visit.failed (V9, V10)', () => {
  it('full US-07-1 flow in ONE batch (7 mutations): all applied; visit completed, outcome collected, completed_at corrected', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const r = await pushM(w, fullFlow(w));
    expect(outcomes(r)).toEqual(Array(7).fill('applied'));
    const v = await visitRow(w.visit.id);
    expect([v.status, v.outcome]).toEqual(['completed', 'collected']);
    expect(new Date(v.completed_at).toISOString()).toBe(at(w.date, '04:20'));
    expect((await transitionRows(w.visit.id)).map((t) => `${t.from_status}>${t.to_status}`)).toEqual(['assigned>in_progress', 'in_progress>completed']);
    expect((await mutRows(w)).map((m) => Number(m.device_seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('0 applied collections -> completed with outcome none', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    expect(outcomes(await pushM(w, [M.arrived(w), M.completed(w, { outcome: 'collected' })]))).toEqual(['applied', 'applied']);
    expect((await visitRow(w.visit.id)).outcome).toBe('none');
  });
  it('already closed -> rejected visit_closed; not assigned -> rejected visit_not_assigned', { timeout: T }, async () => {
    const a = await pushWorld({ file: FILE, status: 'completed' });
    expect(codes(await pushM(a, [M.completed(a), M.failed(a)]))).toEqual([A + 'visit_closed', A + 'visit_closed']);
    const b = await pushWorld({ file: FILE, member: MEMBER2.a, assignees: [{ member: MEMBER.a, at: '2028-01-01T00:00:00.000Z' }] });
    expect(codes(await pushM(b, [M.failed(b)]))).toEqual([A + 'visit_not_assigned']);
  });
  it('visit.failed from assigned or in_progress -> failed with the reason; reason identity_mismatch opens flag identity_mismatch', { timeout: T }, async () => {
    const a = await pushWorld({ file: FILE });
    expect(outcomes(await pushM(a, [M.failed(a, { reason: 'patient_not_home' })]))).toEqual(['applied']);
    const va = await visitRow(a.visit.id);
    expect([va.status, va.status_reason_code]).toEqual(['failed', 'patient_not_home']);
    const b = await pushWorld({ file: FILE });
    expect(outcomes(await pushM(b, [M.arrived(b), M.identity(b, { name: 'mismatch' }), M.failed(b, { reason: 'identity_mismatch' })]))).toEqual(['applied', 'applied', 'applied']);
    expect((await visitRow(b.visit.id)).status).toBe('failed');
    expect((await flagRows(b.visit.id)).map((f) => f.kind)).toContain('identity_mismatch');
  });
  it('device_seq must be strictly increasing inside the batch: a decreasing seq -> 400 common.validation_failed, nothing stored, max_device_seq_received untouched', { timeout: T }, async () => {
    const w = await pushWorld({ file: FILE });
    const e: any = await pushM(w, [M.identity(w, { seq: 2 }), M.consent(w, { seq: 1 })]).catch((x) => x);
    expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]);
    expect(await mutRows(w)).toHaveLength(0);
    expect(Number((await deviceRow(w.device.id)).max_device_seq_received)).toBe(0);
  });
});

