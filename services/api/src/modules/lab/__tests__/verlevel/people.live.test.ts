// T0B-VERLEVEL-1 (LD-316) done_when (5) PEOPLE: distinct people, the enterer rule on and off, the existing self approval rule, the pathologist rule, and "every refusal is audited".
//   lab.verifier_not_distinct (409): a person already in the chain of this result version signs again.
//   lab.enterer_cannot_verify (403): the person who entered the result signs it, unless the policy has allow_enterer_verify (default false; LD-318 follow-up 4).
//   lab.self_approval_forbidden (403, existing): the approver verified the same version.
//   lab.pathologist_required (403): the sign-off that would be the final one comes from a signer without lab.result.approve while the policy requires a pathologist.
// Audit: a refusal keeps one audit.access_log row with outcome 'denied', entity_id = the result id, actor_id = the caller (ctx.audit.access + ctx.commitOnError, core/audit/access.ts); the action code is
//   chosen by the writer from audit.g_cs_access_actions (the list is generated from the spec; not pinned here).
import { afterAll, describe, expect, it } from 'vitest';
import { T, closePools, live, requireDb, seedResult, objs, MEM, FULL_A } from '../probes/kit.js';
import { approve, chainOf, code, deniedAudit, http, newCase, person, policyFor, rowOf, verify, why, bulk, dto } from './helpers.js';

afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

describe.skipIf(!live)('distinct people (lab.verifier_not_distinct)', () => {
  it('the same technologist cannot sign a level 3 result twice: 409, nothing appended, the refusal is audited', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 3);
    const t = person('tech');
    expect((await verify(t, k.id)).reply?.status).toBe(200);
    const again = await verify(t, k.id);
    expect([code(again), http(again)], why(again)).toEqual(['lab.verifier_not_distinct', 409]);
    expect(await chainOf(k.id)).toHaveLength(1);
    expect((await rowOf(k.id)).signoff_count).toBe(1);
    expect((await deniedAudit(k.id, t.userId!)).length, 'denied audit row committed with the failed request').toBeGreaterThanOrEqual(1);
    expect(again.probe.commitOnError, 'the handler asked the pipeline to keep the audit row').toBe(true);
  });
  it('the check is by PERSON (user id), not by role or by membership string: two technologists are two people', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 3);
    expect((await verify(person('tech'), k.id)).reply?.status).toBe(200);
    expect((await verify(person('tech'), k.id)).reply?.status).toBe(200);
    expect(await chainOf(k.id)).toHaveLength(2);
  });
  it('a person who signed as verifier cannot also approve the same result: lab.self_approval_forbidden stays (403)', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const p = person('patho');                       // a pathologist verifies (holds lab.result.verify) ...
    const v = await verify(p, k.id);
    expect(v.reply?.status, why(v)).toBe(200);
    const a = await approve(p, k.id);                // ... and then tries to approve it
    expect([code(a), http(a)], why(a)).toEqual(['lab.self_approval_forbidden', 403]);
    expect(await chainOf(k.id)).toHaveLength(1);
    expect((await rowOf(k.id)).status).toBe('verified');
    expect((await deniedAudit(k.id, p.userId!)).length).toBeGreaterThanOrEqual(1);
    // a different pathologist can
    expect((await approve(person('patho'), k.id)).reply?.status).toBe(200);
  });
  it('legacy row (verified before sign-off chains existed: no chain rows, verified_by only): a different pathologist approves, the verifier still gets lab.self_approval_forbidden', { timeout: T * 3 }, async () => {
    const S = await objs('a');
    const rid = await seedResult(S, { status: 'verified', verifiedBy: MEM.a });
    const same = await approve(FULL_A, rid);   // FULL_A is membership a500 = the verifier
    expect(code(same), why(same)).toBe('lab.self_approval_forbidden');
    const other = await approve(person('patho'), rid);
    expect(other.reply?.status, why(other)).toBe(200);
    expect(dto(other).status).toBe('approved');
  });
});

describe.skipIf(!live)('the enterer rule (lab.enterer_cannot_verify; allow_enterer_verify default false, switchable per policy)', () => {
  it('default: the technologist who entered the result cannot verify it (403), nothing appended, audited', { timeout: T * 3 }, async () => {
    const enterer = person('tech');
    const k = await newCase({ enterer }); await policyFor(k, 2);
    const o = await verify(enterer, k.id);
    expect([code(o), http(o)], why(o)).toEqual(['lab.enterer_cannot_verify', 403]);
    expect(await chainOf(k.id)).toHaveLength(0);
    expect((await rowOf(k.id)).status).toBe('resulted');
    expect((await deniedAudit(k.id, enterer.userId!)).length).toBeGreaterThanOrEqual(1);
  });
  it('default: a pathologist who entered the result cannot approve it either (level 1: approve from resulted)', { timeout: T * 3 }, async () => {
    const enterer = person('patho');
    const k = await newCase({ enterer }); await policyFor(k, 1);
    const o = await approve(enterer, k.id);
    expect(code(o), why(o)).toBe('lab.enterer_cannot_verify');
    expect((await rowOf(k.id)).status).toBe('resulted');
  });
  it('allow_enterer_verify = true: the enterer may sign (and is still counted as one person, once)', { timeout: T * 3 }, async () => {
    const enterer = person('tech');
    const k = await newCase({ enterer }); await policyFor(k, 2, { enterer: true });
    const o = await verify(enterer, k.id);
    expect(o.reply?.status, why(o)).toBe(200);
    expect((await chainOf(k.id)).map((c) => c.signer_user_id)).toEqual([enterer.userId]);
    const again = await verify(enterer, k.id);
    expect(code(again), 'distinct people still applies').toBe('lab.verifier_not_distinct');
  });
  it('the rule is the policy of the result (test scope here), not a global switch: another result of the same enterer with allow true is fine, with the default it is refused', { timeout: T * 3 }, async () => {
    const enterer = person('tech');
    const [on, off] = [await newCase({ enterer }), await newCase({ enterer })];
    await policyFor(on, 2, { enterer: true }); await policyFor(off, 2, { enterer: false });
    expect((await verify(enterer, on.id)).reply?.status).toBe(200);
    expect(code(await verify(enterer, off.id))).toBe('lab.enterer_cannot_verify');
  });
  it('a result with no enterer on record (instrument origin) is not blocked by the enterer rule', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const { asOwner, TENANT_A } = await import('../probes/kit.js');
    await asOwner(TENANT_A, async (c) => { await c.query('DELETE FROM lab.result_observations WHERE result_id = $1', [k.id]); await c.query("UPDATE lab.results SET origin = 'instrument' WHERE id = $1", [k.id]); });
    const o = await verify(person('tech'), k.id);
    expect(o.reply?.status, why(o)).toBe(200);
  });
});

describe.skipIf(!live)('the pathologist rule (lab.pathologist_required) and the order of the checks', () => {
  it('a technologist cannot make the final sign-off when a pathologist is required: 403, nothing appended, audited', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 1, { pathologist: true });
    const t = person('tech');
    const o = await verify(t, k.id);
    expect([code(o), http(o)], why(o)).toEqual(['lab.pathologist_required', 403]);
    expect(await chainOf(k.id)).toHaveLength(0);
    expect((await rowOf(k.id)).status).toBe('resulted');
    expect((await deniedAudit(k.id, t.userId!)).length).toBeGreaterThanOrEqual(1);
  });
  it('the same technologist is fine when the policy does not require a pathologist (final by count)', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 1, { pathologist: false });
    const o = await verify(person('tech'), k.id);
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o).status).toBe('approved');
  });
  it('approveResult keeps its role gate: a technologist (no lab.result.approve) is 403 auth.forbidden (P-10 gate), never a sign-off', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 1);
    const o = await approve(person('tech'), k.id);
    expect(code(o), why(o)).toBe('auth.forbidden');
    expect(await chainOf(k.id)).toHaveLength(0);
  });
  it('aal1 approver: auth.mfa_required passes through unchanged, nothing appended', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 1);
    const o = await approve(person('patho', 'a', { mfa: 'aal1' }), k.id);
    expect(code(o), why(o)).toBe('auth.mfa_required');
    expect(await chainOf(k.id)).toHaveLength(0);
  });
  it('stale If-Match is still common.version_conflict and appends nothing', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const { fire, req } = await import('../probes/kit.js');
    const o = await fire('verifyResult', req({ params: { result_id: k.id }, headers: { 'if-match': '"99"' }, body: {} }), person('tech'));
    expect(code(o)).toBe('common.version_conflict');
    expect(await chainOf(k.id)).toHaveLength(0);
  });
  it('a held result (on_hold) is still lab.result_on_hold; a refusal by the hold appends no sign-off (gates unchanged)', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const { asOwner, TENANT_A } = await import('../probes/kit.js');
    await asOwner(TENANT_A, (c) => c.query('UPDATE lab.results SET on_hold = true WHERE id = $1', [k.id]));
    const o = await verify(person('tech'), k.id);
    expect(code(o), why(o)).toBe('lab.result_on_hold');
    expect(await chainOf(k.id)).toHaveLength(0);
  });
  it('an unacknowledged flag is still lab.flag_ack_required (gates unchanged); with the acknowledgement the sign-off is recorded', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const { asOwner, TENANT_A } = await import('../probes/kit.js');
    await asOwner(TENANT_A, (c) => c.query("UPDATE lab.results SET delta_status = 'fail' WHERE id = $1", [k.id]));
    const t = person('tech');
    expect(code(await verify(t, k.id))).toBe('lab.flag_ack_required');
    expect(await chainOf(k.id)).toHaveLength(0);
    const ok = await verify(t, k.id, ['delta']);
    expect(ok.reply?.status, why(ok)).toBe(200);
    expect(await chainOf(k.id)).toHaveLength(1);
  });
  it('critical value acknowledgement still blocks the pathologist sign-off (lab.critical_ack_required) and appends nothing', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 1);
    const { asOwner, TENANT_A, ins, uid } = await import('../probes/kit.js');
    await asOwner(TENANT_A, (c) => ins(c, 'lab.critical_value_log', { id: uid(), tenant_id: TENANT_A, centre_id: k.S.centre, result_id: k.id, result_version_no: 1, order_id: k.S.orderId, patient_id: k.S.patientId,
      analyte_id: uid(), direction: 'high', value_sha256_prefix16: 'a1b2c3d4e5f60718', value_numeric: 99, detected_at: '2026-06-15T04:40:00.000Z' }));
    const o = await approve(person('patho'), k.id);
    expect(code(o), why(o)).toBe('lab.critical_ack_required');
    expect(await chainOf(k.id)).toHaveLength(0);
  });
});

describe.skipIf(!live)('bulk: the same rules per result, per result failures, the batch is never aborted (done_when 7)', () => {
  it('bulkVerifyResults mixed batch: ok / not distinct / enterer / pathologist required / stale version, in input order, only the ok one is signed', { timeout: T * 4 }, async () => {
    const t = person('tech');
    const ok = await newCase(); await policyFor(ok, 2);
    const dup = await newCase(); await policyFor(dup, 3); expect((await verify(t, dup.id)).reply?.status).toBe(200);
    const mine = await newCase({ enterer: t }); await policyFor(mine, 2);
    const fin = await newCase(); await policyFor(fin, 1, { pathologist: true });
    const stale = await newCase(); await policyFor(stale, 2);
    const o = await bulk('bulkVerifyResults', t, [ok.id, dup.id, mine.id, fin.id, stale.id], { [stale.id]: 99 });
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o).results.map((r: any) => [r.id, r.outcome, r.code])).toEqual([
      [ok.id, 'ok', undefined], [dup.id, 'error', 'lab.verifier_not_distinct'], [mine.id, 'error', 'lab.enterer_cannot_verify'],
      [fin.id, 'error', 'lab.pathologist_required'], [stale.id, 'error', 'common.version_conflict'],
    ]);
    expect(dto(o).results[0].result).toMatchObject({ id: ok.id, status: 'verified', signoff_count: 1, signoff_required: 2, next_step: 'approve' });
    expect((await chainOf(ok.id)).length).toBe(1);
    expect((await chainOf(dup.id)).length).toBe(1);   // only t's first sign-off
    for (const k of [mine, fin, stale]) expect(await chainOf(k.id), 'refused rows add nothing').toHaveLength(0);
    expect(o.probe.events.filter((e) => e.type === 'lab.result.signed_off.v1'), 'one event per recorded sign-off').toHaveLength(1);
  });
  it('bulkApproveResults mixed batch: ok / self approval / not in order (level 2 from resulted) / enterer, per result codes, the others approved', { timeout: T * 4 }, async () => {
    const p = person('patho'); const t = person('tech');
    const ok = await newCase(); await policyFor(ok, 2); expect((await verify(t, ok.id)).reply?.status).toBe(200);
    const own = await newCase(); await policyFor(own, 2); expect((await verify(p, own.id)).reply?.status).toBe(200);   // p verified it: cannot approve
    const early = await newCase(); await policyFor(early, 2);                                                           // resulted, level 2: approve is not yet a transition
    const entered = await newCase({ enterer: p }); await policyFor(entered, 1);                                         // p entered it, level 1 approve from resulted
    const lvl1 = await newCase(); await policyFor(lvl1, 1);                                                             // level 1 approve from resulted is fine
    const o = await bulk('bulkApproveResults', p, [ok.id, own.id, early.id, entered.id, lvl1.id]);
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o).results.map((r: any) => [r.id, r.outcome, r.code])).toEqual([
      [ok.id, 'ok', undefined], [own.id, 'error', 'lab.self_approval_forbidden'], [early.id, 'error', 'lab.result_invalid_transition'],
      [entered.id, 'error', 'lab.enterer_cannot_verify'], [lvl1.id, 'ok', undefined],
    ]);
    expect((await rowOf(ok.id)).status).toBe('approved');
    expect((await rowOf(lvl1.id)).status).toBe('approved');
    expect((await rowOf(own.id)).status).toBe('verified');
    expect(o.probe.events.filter((e) => e.type === 'lab.result.signed_off.v1')).toHaveLength(2);
    expect(o.probe.events.filter((e) => e.type === 'lab.result.approved.v1')).toHaveLength(2);
  });
  it('the same result twice in one batch: the second item is common.version_conflict, never a second sign-off by the same person', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 3);
    const t = person('tech');
    const { fire, req, uid } = await import('../probes/kit.js');
    const { PORTS } = await import('./helpers.js');
    const v = (await rowOf(k.id)).version;
    const o = await fire('bulkVerifyResults', req({ headers: { 'idempotency-key': uid() }, body: { items: [{ id: k.id, version: v }, { id: k.id, version: v }] } }), t, { ports: PORTS });
    expect(dto(o).results.map((r: any) => [r.outcome, r.code])).toEqual([['ok', undefined], ['error', 'common.version_conflict']]);
    expect(await chainOf(k.id)).toHaveLength(1);
  });
});
