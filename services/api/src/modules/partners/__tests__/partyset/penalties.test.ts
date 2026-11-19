// T0B-PARTYSET-1 done_when (6) PENALTIES: the penalty catalogue, raise / waive / charge of non compliance events, charged ONCE to the ledger. Real PG17.
// Pins: charging posts exactly one billing.account_ledger_entries row (entry_type debit, amount = the EVENT amount, party_kind credit_party, party_id = the credit party; a partner
// is charged on partner.credit_party_id) through the existing accounts service in the SAME transaction and stores its id in ledger_entry_id; the particular used is the tenant's
// active one with code NON_COMPLIANCE_PENALTY (fixture ledgerWorld; CONTRACT GAP for the lead, see notes); a second charge returns the first result OR is refused
// (common.version_conflict / common.validation_failed) and posts nothing; a waived event is never charged; doctor / referrer parties have no ledger: charge refused, nothing posted.
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, P, SECOND_A, T, TENANT_A, TENANT_B, dbRow, dbRows, fire, idem, ifm, ledgerRows, ledgerWorld, mkEvent, mkPenalty, noWrites, notFound, ok, only, rejected, rejectedAny, req, trailOf, wipe, type LedgerWorld } from './helpers.js';

const createP = (body: unknown, who = ADMIN_A) => fire('createNonCompliancePenalty', req({ headers: idem(), body }), who);
const updateP = (id: string, body: unknown, v = 1, who = ADMIN_A) => fire('updateNonCompliancePenalty', req({ params: { penalty_id: id }, headers: ifm(v), body }), who);
const deact = (id: string, v = 1, who = ADMIN_A) => fire('deactivateNonCompliancePenalty', req({ params: { penalty_id: id }, headers: ifm(v) }), who);
const listP = (q: object = {}, who = ADMIN_A) => fire('listNonCompliancePenalties', req({ query: q }), who);
const raise = (body: unknown, who = ADMIN_A) => fire('raiseNonComplianceEvent', req({ headers: idem(), body }), who);
const waive = (id: string, body: unknown = { reason: 'Synthetic: first offence' }, v = 1, who = ADMIN_A) => fire('waiveNonComplianceEvent', req({ params: { event_id: id }, headers: ifm(v), body }), who);
const charge = (id: string, v = 1, who = ADMIN_A, key: string = idem()['idempotency-key']) => fire('chargeNonComplianceEvent', req({ params: { event_id: id }, headers: { 'idempotency-key': key, ...ifm(v) } }), who);
const listE = (q: object = {}, who = ADMIN_A) => fire('listNonComplianceEvents', req({ query: q }), who);

let W: LedgerWorld;
beforeEach(async () => { await wipe(TENANT_A, TENANT_B); W = await ledgerWorld(TENANT_A); }, T);

describe('penalty catalogue', () => {
  it('create: 201, active, version 1; the code is unique per tenant (/code), the same code is fine in another tenant', async () => {
    const b = ok(await createP({ code: 'LATE_SAMPLE', name: 'Late sample (synthetic)', amount_paisa: 50_000 }), 201);
    expect(b).toMatchObject({ code: 'LATE_SAMPLE', name: 'Late sample (synthetic)', amount_paisa: 50_000, is_active: true, version: 1 });
    rejected(await createP({ code: 'LATE_SAMPLE', name: 'Other', amount_paisa: 1 }), 'common.validation_failed', '/code');
    ok(await createP({ code: 'LATE_SAMPLE', name: 'Late sample B', amount_paisa: 1 }, ADMIN_B), 201);
    expect(await dbRows('partners.non_compliance_penalty', "code = 'LATE_SAMPLE'")).toHaveLength(2);
  }, T);
  it.each([
    [{ code: 'late', name: 'x', amount_paisa: 1 }, '/code'], [{ code: 'A'.repeat(21), name: 'x', amount_paisa: 1 }, '/code'], [{ code: '', name: 'x', amount_paisa: 1 }, '/code'],
    [{ code: 'OK1', name: '', amount_paisa: 1 }, '/name'], [{ code: 'OK1', name: 'n'.repeat(121), amount_paisa: 1 }, '/name'],
    [{ code: 'OK1', name: 'x', amount_paisa: -1 }, '/amount_paisa'], [{ code: 'OK1', name: 'x', amount_paisa: 1.5 }, '/amount_paisa'], [{ code: 'OK1', name: 'x', amount_paisa: '5' }, '/amount_paisa'],
    [{ code: 'OK1', name: 'x', amount_paisa: 100_000_000_001 }, '/amount_paisa'], [{ code: 'OK1', name: 'x' }, '/amount_paisa'], [{ code: 'OK1', name: 'x', amount_paisa: 1, extra: 1 }, '*'],
  ])('create %j is refused at %s and writes nothing', async (body, path) => {
    const o = await createP(body);
    rejected(o, 'common.validation_failed', path);
    noWrites(o);
  }, T);
  it('update changes name / amount with If-Match, never the code; events already raised keep their amount', async () => {
    const pen = await mkPenalty(TENANT_A, { amount_paisa: 50_000 });
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId, { amount_paisa: 50_000 });
    const b = ok(await updateP(pen.id, { name: 'Renamed (synthetic)', amount_paisa: 75_000 }));
    expect(b).toMatchObject({ name: 'Renamed (synthetic)', amount_paisa: 75_000, version: 2, code: pen.code });
    expect((await dbRow('partners.non_compliance_event', ev.id)).amount_paisa).toBe('50000');
    rejected(await updateP(pen.id, { code: 'NEWCODE' }, 2), 'common.validation_failed', '*');
    rejected(await updateP(pen.id, {}, 2), 'common.validation_failed', '*');
    rejected(await updateP(pen.id, { amount_paisa: -5 }, 2), 'common.validation_failed', '/amount_paisa');
    rejected(await updateP(pen.id, { name: 'x' }, 1), 'common.version_conflict');
    rejected(await fire('updateNonCompliancePenalty', req({ params: { penalty_id: pen.id }, body: { name: 'x' } }), ADMIN_A), 'common.precondition_required');
  }, T);
  it('deactivate sets is_active false (nothing deleted); a stale version conflicts; an inactive penalty cannot be used for a new event but old events keep it', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    expect(ok(await deact(pen.id))).toMatchObject({ is_active: false, version: 2 });
    rejected(await deact(pen.id, 1), 'common.version_conflict');
    rejected(await raise({ party_kind: 'credit_party', party_id: W.creditPartyId, penalty_id: pen.id, event_date: '2026-11-17' }), 'common.validation_failed', '/penalty_id');
    expect(await dbRow('partners.non_compliance_event', ev.id)).toMatchObject({ penalty_id: pen.id, status: 'raised' });
    expect(await dbRow('partners.non_compliance_penalty', pen.id)).toMatchObject({ is_active: false });
  }, T);
  it('list: filters is_active and q (case insensitive on code / name), cursor paging, tenant isolation', async () => {
    const a = await mkPenalty(TENANT_A, { code: 'ALPHA1', name: 'Alpha rule' });
    const b = await mkPenalty(TENANT_A, { code: 'BETA1', name: 'Beta rule', is_active: false });
    await mkPenalty(TENANT_B, { code: 'ALPHA1', name: 'Alpha rule B' });
    expect(ok(await listP()).data.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(ok(await listP({ is_active: false })).data.map((x: any) => x.id)).toEqual([b.id]);
    expect(ok(await listP({ q: 'alpha' })).data.map((x: any) => x.id)).toEqual([a.id]);
    const p1 = ok(await listP({ limit: 1 }));
    expect(p1.data).toHaveLength(1);
    const p2 = ok(await listP({ limit: 1, cursor: p1.page.next_cursor }));
    expect(p2.data).toHaveLength(1);
    expect(p2.data[0].id).not.toBe(p1.data[0].id);
    rejected(await listP({ cursor: 'garbage' }), 'common.invalid_cursor');
  }, T);
  it('another tenant cannot update or deactivate the penalty (common.not_found); needs partners.penalty.manage', async () => {
    const pen = await mkPenalty(TENANT_A);
    notFound(await updateP(pen.id, { name: 'x' }, 1, ADMIN_B));
    notFound(await deact(pen.id, 1, ADMIN_B));
    rejected(await createP({ code: 'NOPE1', name: 'x', amount_paisa: 1 }, only(1, P.settingManage)), 'auth.forbidden');
    rejected(await listP({}, only(2, P.settingRead)), 'auth.forbidden');
    expect(await dbRow('partners.non_compliance_penalty', pen.id)).toMatchObject({ version: 1, is_active: true });
  }, T);
});

describe('raise and waive', () => {
  it('raise: status raised, amount defaults to the penalty amount, an explicit amount wins, nothing is posted to the ledger', async () => {
    const pen = await mkPenalty(TENANT_A, { amount_paisa: 50_000 });
    const a = ok(await raise({ party_kind: 'credit_party', party_id: W.creditPartyId, penalty_id: pen.id, event_date: '2026-11-17', reason: 'Synthetic: sample arrived late' }), 201);
    expect(a).toMatchObject({ party_kind: 'credit_party', party_id: W.creditPartyId, penalty_id: pen.id, event_date: '2026-11-17', amount_paisa: 50_000, status: 'raised', version: 1, reason: 'Synthetic: sample arrived late' });
    expect(a.ledger_entry_id ?? null).toBeNull();
    const b = ok(await raise({ party_kind: 'partner', party_id: W.partnerId, penalty_id: pen.id, event_date: '2026-11-17', amount_paisa: 12_345 }), 201);
    expect(b.amount_paisa).toBe(12_345);
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(0);
  }, T);
  it('raise validation: unknown / foreign party /party_id, unknown penalty /penalty_id, bad date /event_date, long reason /reason, negative amount /amount_paisa; nothing written', async () => {
    const pen = await mkPenalty(TENANT_A);
    const base = { party_kind: 'credit_party', party_id: W.creditPartyId, penalty_id: pen.id, event_date: '2026-11-17' };
    const cases: Array<[object, string]> = [
      [{ party_id: '01a1a98a-ac40-7000-8000-00000000dead' }, '/party_id'], [{ penalty_id: '01a1a98a-ac40-7000-8000-00000000dead' }, '/penalty_id'],
      [{ event_date: '2026-13-40' }, '/event_date'], [{ event_date: 'yesterday' }, '/event_date'], [{ reason: 'r'.repeat(501) }, '/reason'], [{ reason: '' }, '/reason'],
      [{ amount_paisa: -1 }, '/amount_paisa'], [{ amount_paisa: 1.5 }, '/amount_paisa'], [{ party_kind: 'robot' }, '/party_kind'],
    ];
    for (const [over, path] of cases) { const o = await raise({ ...base, ...over }); rejected(o, 'common.validation_failed', path); noWrites(o); }
    // a party of another tenant is as unknown as a random id
    const foreign = await ledgerWorld(TENANT_B);
    rejected(await raise({ ...base, party_id: foreign.creditPartyId }), 'common.validation_failed', '/party_id');
    // a penalty of another tenant too
    const otherPen = await mkPenalty(TENANT_B);
    rejected(await raise({ ...base, penalty_id: otherPen.id }), 'common.validation_failed', '/penalty_id');
    expect(await dbRows('partners.non_compliance_event', 'tenant_id = $1', [TENANT_A])).toHaveLength(0);
  }, T);
  it('waive: raised -> waived with a reason, decided_by = the actor, nothing posted; reason required; waived and charged are final', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    rejected(await waive(ev.id, {}), 'common.validation_failed', '/reason');
    rejected(await waive(ev.id, { reason: '' }), 'common.validation_failed', '/reason');
    rejected(await waive(ev.id, { reason: 'r'.repeat(501) }), 'common.validation_failed', '/reason');
    const b = ok(await waive(ev.id));
    expect(b).toMatchObject({ status: 'waived', decided_by: ADMIN_A.userId, version: 2 });
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(0);
    rejected(await waive(ev.id, { reason: 'Synthetic: again' }, 2), 'common.validation_failed');
    const ev2 = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    ok(await charge(ev2.id));
    rejected(await waive(ev2.id, { reason: 'Synthetic: too late' }, 2), 'common.validation_failed');
    expect((await dbRow('partners.non_compliance_event', ev2.id)).status).toBe('charged');
  }, T);
  it('waive: stale If-Match is common.version_conflict, a missing one precondition_required, another tenant common.not_found', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    rejected(await waive(ev.id, { reason: 'Synthetic: x' }, 9), 'common.version_conflict');
    rejected(await fire('waiveNonComplianceEvent', req({ params: { event_id: ev.id }, body: { reason: 'Synthetic: x' } }), ADMIN_A), 'common.precondition_required');
    notFound(await waive(ev.id, { reason: 'Synthetic: x' }, 1, ADMIN_B));
    expect((await dbRow('partners.non_compliance_event', ev.id)).status).toBe('raised');
  }, T);
  it('list events: filters party, penalty, status, from_date / to_date (inclusive), newest event first, tenant isolation', async () => {
    const pen = await mkPenalty(TENANT_A); const pen2 = await mkPenalty(TENANT_A);
    const e1 = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId, { event_date: '2026-11-01' });
    const e2 = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId, { event_date: '2026-11-05', status: 'waived', decided_by: ADMIN_A.userId });
    const e3 = await mkEvent(TENANT_A, pen2.id, 'partner', W.partnerId, { event_date: '2026-11-09' });
    const bw = await ledgerWorld(TENANT_B); const penB = await mkPenalty(TENANT_B); await mkEvent(TENANT_B, penB.id, 'credit_party', bw.creditPartyId);
    expect(ok(await listE()).data.map((x: any) => x.id)).toEqual([e3.id, e2.id, e1.id]);
    expect(ok(await listE({ party_kind: 'partner', party_id: W.partnerId })).data.map((x: any) => x.id)).toEqual([e3.id]);
    expect(ok(await listE({ penalty_id: pen.id })).data.map((x: any) => x.id)).toEqual([e2.id, e1.id]);
    expect(ok(await listE({ status: 'waived' })).data.map((x: any) => x.id)).toEqual([e2.id]);
    expect(ok(await listE({ from_date: '2026-11-05', to_date: '2026-11-09' })).data.map((x: any) => x.id)).toEqual([e3.id, e2.id]);
    const p1 = ok(await listE({ limit: 2 }));
    const p2 = ok(await listE({ limit: 2, cursor: p1.page.next_cursor }));
    expect([...p1.data, ...p2.data].map((x: any) => x.id)).toEqual([e3.id, e2.id, e1.id]);
    rejected(await listE({ status: 'paid' }), 'common.validation_failed', '*');
  }, T);
});

describe('charge: exactly one debit ledger entry, once', () => {
  it('posts ONE debit of the event amount on the party ledger in the same tx, stores its id, event charged / decided_by / version 2', async () => {
    const pen = await mkPenalty(TENANT_A, { amount_paisa: 50_000 });
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId, { amount_paisa: 12_345 });
    const before = await ledgerRows(TENANT_A, W.creditPartyId);
    const o = await charge(ev.id);
    const b = ok(o);
    expect(b).toMatchObject({ id: ev.id, status: 'charged', amount_paisa: 12_345, decided_by: ADMIN_A.userId, version: 2 });
    const rows = await ledgerRows(TENANT_A, W.creditPartyId);
    expect(rows).toHaveLength(before.length + 1);
    expect(rows[rows.length - 1]).toMatchObject({ party_kind: 'credit_party', party_id: W.creditPartyId, entry_type: 'debit', amount_paisa: '12345' });
    expect(b.ledger_entry_id).toBe(rows[rows.length - 1].id);
    expect(await dbRow('partners.non_compliance_event', ev.id)).toMatchObject({ status: 'charged', ledger_entry_id: rows[rows.length - 1].id, amount_paisa: '12345' });
    expect(await trailOf('partners.non_compliance_event', ev.id, o)).toContain(ADMIN_A.userId);   // the decision leaves an audit trail
  }, T);
  it('a partner is charged on its credit party ledger', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'partner', W.partnerId, { amount_paisa: 7_000 });
    const b = ok(await charge(ev.id));
    const rows = await ledgerRows(TENANT_A, W.creditPartyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: b.ledger_entry_id, entry_type: 'debit', amount_paisa: '7000' });
  }, T);
  it('a second charge returns the first result or is refused, and posts nothing (same key and a new key)', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    const key = idem()['idempotency-key'];
    const first = ok(await charge(ev.id, 1, ADMIN_A, key));
    for (const [v, k] of [[1, key], [2, key], [2, idem()['idempotency-key']], [1, idem()['idempotency-key']]] as const) {
      const o = await charge(ev.id, v, ADMIN_A, k);
      if (o.reply) expect(o.reply.body).toMatchObject({ id: ev.id, status: 'charged', ledger_entry_id: first.ledger_entry_id });
      else rejectedAny(o, ['common.version_conflict', 'common.validation_failed']);
    }
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(1);
    expect((await dbRow('partners.non_compliance_event', ev.id)).ledger_entry_id).toBe(first.ledger_entry_id);
  }, T);
  it('5 parallel charge requests of one event post exactly one entry; every success carries the same ledger_entry_id', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => charge(ev.id)));
    const wins = outs.filter((o) => o.reply?.status === 200);
    expect(wins.length).toBeGreaterThanOrEqual(1);
    for (const o of outs) if (o.error) rejectedAny(o, ['common.version_conflict', 'common.validation_failed']);
    expect(new Set(wins.map((o) => o.reply!.body.ledger_entry_id)).size).toBe(1);
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(1);
    expect((await dbRows('partners.non_compliance_event', 'ledger_entry_id IS NOT NULL AND tenant_id = $1', [TENANT_A]))).toHaveLength(1);
  }, T);
  it('a waived event can never be charged (refused, nothing posted, event stays waived)', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    ok(await waive(ev.id));
    for (const v of [1, 2]) rejectedAny(await charge(ev.id, v), ['common.validation_failed', 'common.version_conflict']);
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(0);
    expect(await dbRow('partners.non_compliance_event', ev.id)).toMatchObject({ status: 'waived', ledger_entry_id: null });
  }, T);
  it('if the ledger cannot take the entry the event stays raised: all or nothing (doctor party has no ledger; amount 0 cannot be a debit)', async () => {
    const pen = await mkPenalty(TENANT_A);
    const doc = await mkEvent(TENANT_A, pen.id, 'doctor', W.doctorId);
    rejected(await charge(doc.id), 'common.validation_failed');
    expect(await dbRow('partners.non_compliance_event', doc.id)).toMatchObject({ status: 'raised', ledger_entry_id: null, version: 1 });
    const zero = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId, { amount_paisa: 0 });
    rejected(await charge(zero.id), 'common.validation_failed');
    expect(await dbRow('partners.non_compliance_event', zero.id)).toMatchObject({ status: 'raised', ledger_entry_id: null });
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(0);
  }, T);
  it('no active particular -> the charge fails as a whole (event raised, no entry)', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    const { superTx } = await import('./helpers.js');
    await superTx(async (tx) => { await tx.query("UPDATE billing.account_particulars SET is_active = false WHERE tenant_id = $1 AND code = 'NON_COMPLIANCE_PENALTY'", [TENANT_A]); }, TENANT_A);
    const o = await charge(ev.id);
    expect(o.reply).toBeUndefined();
    expect(o.error).toBeTruthy();
    expect(await dbRow('partners.non_compliance_event', ev.id)).toMatchObject({ status: 'raised', ledger_entry_id: null });
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(0);
  }, T);
  it('If-Match: missing -> precondition_required, stale -> version_conflict; another tenant -> not_found; nothing posted in any case', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    rejected(await fire('chargeNonComplianceEvent', req({ params: { event_id: ev.id }, headers: idem() }), ADMIN_A), 'common.precondition_required');
    rejected(await charge(ev.id, 9), 'common.version_conflict');
    notFound(await charge(ev.id, 1, ADMIN_B));
    notFound(await charge('01a1a98a-ac40-7000-8000-00000000dead'));
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(0);
    expect((await dbRow('partners.non_compliance_event', ev.id)).status).toBe('raised');
  }, T);
  it('needs partners.penalty.manage (raise, waive and charge)', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    const w = only(3, P.settingManage, P.settingRead, P.decide);
    rejected(await charge(ev.id, 1, w), 'auth.forbidden');
    rejected(await waive(ev.id, { reason: 'Synthetic: x' }, 1, w), 'auth.forbidden');
    rejected(await raise({ party_kind: 'credit_party', party_id: W.creditPartyId, penalty_id: pen.id, event_date: '2026-11-17' }, w), 'auth.forbidden');
    expect(await ledgerRows(TENANT_A, W.creditPartyId)).toHaveLength(0);
  }, T);
  it('a charge by one user and a waive by another on the same raised event: one wins, never both', async () => {
    const pen = await mkPenalty(TENANT_A);
    const ev = await mkEvent(TENANT_A, pen.id, 'credit_party', W.creditPartyId);
    const outs = await Promise.all([charge(ev.id, 1, ADMIN_A), waive(ev.id, { reason: 'Synthetic: race' }, 1, SECOND_A)]);
    expect(outs.filter((o) => o.reply?.status === 200)).toHaveLength(1);
    const end = await dbRow('partners.non_compliance_event', ev.id);
    expect(['charged', 'waived']).toContain(end.status);
    expect((await ledgerRows(TENANT_A, W.creditPartyId)).length).toBe(end.status === 'charged' ? 1 : 0);
  }, T);
});
