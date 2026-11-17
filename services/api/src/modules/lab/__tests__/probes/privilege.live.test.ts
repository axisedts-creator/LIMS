// C5 T-32 / 07-SECURITY §5.1 P-10 (role x operation matrix) and §5.2 S-01, S-02, S-04, S-06, S-10, S-11, S-12, S-15, S-16, S-18, S-19, S-21 (handler-visible parts), on a real PG17.
// In this checkout the core does not enforce x-permission before the handler (no reference in services/api/src/core), so the handler's own IdentityPort.assertRole IS the gate: these probes prove it
// for every operation. The IdentityPort fake (kit.ts) models auth.forbidden / auth.mfa_required exactly as the real port hands them over; the privileged set is read from contracts/permissions.yaml.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../../core/module.js';
import { ALL_LAB_PERMS, FULL_A, MEM, NOW, OPS, ROLES, T, TENANT_A, as, closePools, codeOf, fire, grantsOfRole, live, mk, objs, owner, req, requestFor, requireDb, seedResult, seen, snapshot, statusOf, uid, type Objs, type Outcome } from './kit.js';

let A: Objs; let VERIFIED: string; let APPROVED: string;
const allLogs: string[] = [];
const keep = (o: Outcome): Outcome => { allLogs.push(...o.probe.logs); return o; };
/** Ruling D: for amendResult 02-TRD.md:266 maps auth.forbidden to lab.amend_requires_pathologist (403; 07-SECURITY.md:66,121 S-04; 01-PRD.md:225 AC-17.2; 02-TRD.md:260); every other operation stays auth.forbidden. */
const deniedCode = (operationId: string): string => (operationId === 'amendResult' ? 'lab.amend_requires_pathologist' : 'auth.forbidden');
const nonAudit =(o: Outcome): string[] => o.probe.writes.filter((w) => !/audit\.access_log/i.test(w));

beforeAll(async () => {
  if (!live) return;
  A = await objs('a');
  VERIFIED = await seedResult(A, { status: 'verified', verifiedBy: MEM.a });          // verified by membership a500 = the approver below -> self approval
  APPROVED = await seedResult(A, { status: 'approved' });
}, T);
afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

// ---------------------------------------------------------------- P-10
describe.skipIf(!live)('P-10 role x operation: a default role gets exactly the operations whose x-permission it holds; everything else is 403 auth.forbidden with no write', () => {
  describe.each(ROLES.map((r) => [r] as const))('%s', (role) => {
    it.each(OPS.map((o) => [o.id] as const))('%s', { timeout: T }, async (id) => {
      const op = OPS.find((o) => o.id === id)!;
      const who = mk('a', { grants: grantsOfRole(role), allCentres: true, centreIds: [A.centre] });
      const out = keep(await fire(id, requestFor(id, A), who));
      if (grantsOfRole(role).includes(op.permission)) {
        expect(codeOf(out), `${role} holds ${op.permission}: ${out.error?.message}`).not.toBe('auth.forbidden');
        expect(out.probe.identity.calls.map((c) => c.permission), `${id} must ask for its contract permission`).toContain(op.permission);
      } else {
        expect(out.reply, `${role} lacks ${op.permission} but got ${out.reply?.status}`).toBeUndefined();
        expect(codeOf(out), `${out.error?.message}`).toBe(deniedCode(id));
        expect((out.error as any).statusCode).toBe(403);
        expect(nonAudit(out), 'a refused request writes nothing').toEqual([]);
      }
    });
  });
  it('front_desk gets 403 on every result operation (abuse case 1), including GET /v1/lab/orders/{id}/results', { timeout: T }, async () => {
    const who = mk('a', { grants: grantsOfRole('front_desk'), allCentres: true, centreIds: [A.centre] });
    const out = keep(await fire('listOrderResults', requestFor('listOrderResults', A), who));
    expect(codeOf(out)).toBe('auth.forbidden');
    for (const o of OPS.filter((x) => /^lab\.(result|critical_value|qc)/.test(x.permission))) expect(codeOf(keep(await fire(o.id, requestFor(o.id, A), who))), o.id).toBe(deniedCode(o.id));
  });
  it('a user with NO lab permission at all is refused everywhere (deny by default)', { timeout: T }, async () => {
    const who = mk('a', { grants: [], allCentres: true });
    for (const o of OPS) expect(codeOf(keep(await fire(o.id, requestFor(o.id, A), who))), o.id).toBe(deniedCode(o.id));
  });
  it('privileged permissions at aal1 => 403 auth.mfa_required on every operation that needs one (approve, amend, config.manage, qc_hold.release)', { timeout: T }, async () => {
    const who = mk('a', { grants: ALL_LAB_PERMS, mfa: 'aal1', allCentres: true, centreIds: [A.centre] });
    const priv = OPS.filter((o) => ['lab.result.approve', 'lab.result.amend', 'lab.config.manage', 'lab.qc_hold.release'].includes(o.permission));
    expect(priv.length).toBe(9);
    for (const o of priv) {
      const out = keep(await fire(o.id, requestFor(o.id, A), who));
      expect(codeOf(out), `${o.id}: ${out.error?.message}`).toBe('auth.mfa_required');
      expect(nonAudit(out), o.id).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- S-01 / S-02 / S-04
describe.skipIf(!live)('S-01 approve', () => {
  it('without lab.result.approve (lab_technologist) => 403 auth.forbidden', { timeout: T }, async () => {
    const out = keep(await fire('approveResult', req({ params: { result_id: VERIFIED }, headers: { 'if-match': '"1"' }, body: {} }), mk('a', { grants: grantsOfRole('lab_technologist'), allCentres: true })));
    expect(codeOf(out)).toBe('auth.forbidden');
  });
  it('at aal1 => 403 auth.mfa_required; bulk form too; the result stays verified', { timeout: T }, async () => {
    const who = mk('a', { grants: grantsOfRole('pathologist'), mfa: 'aal1', allCentres: true });
    expect(codeOf(keep(await fire('approveResult', req({ params: { result_id: VERIFIED }, headers: { 'if-match': '"1"' }, body: {} }), who)))).toBe('auth.mfa_required');
    expect(codeOf(keep(await fire('bulkApproveResults', req({ headers: { 'idempotency-key': uid() }, body: { items: [{ id: VERIFIED, version: 1 }] } }), who)))).toBe('auth.mfa_required');
    expect((await owner('SELECT status FROM lab.results WHERE id = $1', [VERIFIED]))[0].status).toBe('verified');
  });
  it('membership revoked after the token was issued (IdentityPort refuses the privileged check) => refused, not approved', { timeout: T }, async () => {
    for (const refuse of ['auth.forbidden', 'auth.unauthenticated']) {
      const out = keep(await fire('approveResult', req({ params: { result_id: VERIFIED }, headers: { 'if-match': '"1"' }, body: {} }), mk('a', { grants: grantsOfRole('pathologist'), allCentres: true, refuse })));
      expect(codeOf(out), refuse).toBe(refuse);
    }
    expect((await owner('SELECT status FROM lab.results WHERE id = $1', [VERIFIED]))[0].status).toBe('verified');
  });
});
describe.skipIf(!live)('S-02 / S-04', () => {
  it('S-02: approver = verifier => 403 lab.self_approval_forbidden, result unchanged (single and bulk)', { timeout: T }, async () => {
    // Ruling C1: own fresh graph + verified result; the shared VERIFIED of fixture A is mutated by the P-10 matrix above (test order, not the refusal).
    const F = await objs('a'); const own = await seedResult(F, { status: 'verified', verifiedBy: MEM.a });
    const who = mk('a', { grants: grantsOfRole('pathologist'), allCentres: true, membershipId: MEM.a });
    const one = keep(await fire('approveResult', req({ params: { result_id: own }, headers: { 'if-match': '"1"' }, body: {} }), who));
    expect(codeOf(one), `${one.error?.message}`).toBe('lab.self_approval_forbidden');
    expect((one.error as any).statusCode).toBe(403);
    const bulk = keep(await fire('bulkApproveResults', req({ headers: { 'idempotency-key': uid() }, body: { items: [{ id: own, version: 1 }] } }), who));
    expect(codeOf(bulk) ?? bulk.reply?.body?.results?.[0]?.code).toBe('lab.self_approval_forbidden');
    expect((await owner('SELECT status, approved_by_membership_id FROM lab.results WHERE id = $1', [own]))[0]).toMatchObject({ status: 'verified', approved_by_membership_id: null });
  });
  it('S-04: a technologist amend => 403 lab.amend_requires_pathologist, nothing written', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    const out = keep(await fire('amendResult', req({ params: { result_id: APPROVED }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { amendment_reason_code: 'transcription_error', value_numeric: '6' } }),
      mk('a', { grants: grantsOfRole('lab_technologist'), allCentres: true })));
    expect(codeOf(out), `${out.error?.message}`).toBe('lab.amend_requires_pathologist');
    expect((out.error as any).statusCode).toBe(403);
    expect({ ...(await snapshot(TENANT_A)), access_log: '' }).toEqual({ ...before, access_log: '' });
  });
  it('S-21: amendResult with a module-only reason code => 400 common.validation_failed (08 R1, A13 P-1)', { timeout: T }, async () => {
    for (const code of ['module_phase_progression', 'module_preliminary_update', 'supplementary_report']) {
      const out = keep(await fire('amendResult', req({ params: { result_id: APPROVED }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { amendment_reason_code: code, value_numeric: '6' } }),
        mk('a', { grants: grantsOfRole('pathologist'), allCentres: true })));
      expect(codeOf(out), `${code}: ${out.error?.message}`).toBe('common.validation_failed');
      expect((out.error as any).statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------- S-06 / S-11 / S-15 / S-16
describe.skipIf(!live)('S-06 / S-11 / S-15 / S-16', () => {
  const notif = (at: string) => req({ params: { critical_event_id: A.criticalId }, headers: { 'idempotency-key': uid() }, body: { notified_party_kind: 'clinician', notified_party_name: 'Dr Synthetic', contact_method: 'phone',
    notified_at: at, outcome: 'reached', read_back_confirmed: false } });
  it('S-06: notified_at > now + 5 min => 400 common.validation_failed, no notification row', { timeout: T }, async () => {
    const n = async () => Number((await owner('SELECT count(*)::int AS n FROM lab.critical_notifications WHERE critical_event_id = $1', [A.criticalId]))[0].n);
    const before = await n();
    const out = keep(await fire('logCriticalNotification', notif(new Date(NOW.getTime() + 6 * 60_000).toISOString()), FULL_A));
    expect(codeOf(out), `${out.error?.message}`).toBe('common.validation_failed');
    expect(await n()).toBe(before);
    const ok = keep(await fire('logCriticalNotification', notif(new Date(NOW.getTime() - 60_000).toISOString()), FULL_A));   // control: a past time is accepted
    expect(statusOf(ok), `${ok.error?.code} ${ok.error?.message}`).toBeGreaterThanOrEqual(200);
    expect(statusOf(ok)).toBeLessThan(300);
  });
  it('S-11: status board with a range > 7 days => 400 common.validation_failed; 7 days is accepted', { timeout: T }, async () => {
    const q = (to: string) => req({ query: { registered_at_from: '2026-06-01T00:00:00.000Z', registered_at_to: to } });
    expect(codeOf(keep(await fire('getStatusBoard', q('2026-06-09T00:00:00.000Z'), FULL_A)))).toBe('common.validation_failed');
    expect(statusOf(keep(await fire('getStatusBoard', q('2026-06-08T00:00:00.000Z'), FULL_A)))).toBe(200);
  });
  it('S-15: delta rule create / version by a technologist => 403; by lab_manager at aal1 => auth.mfa_required; nothing written', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    for (const id of ['createDeltaCheckRule', 'versionDeltaCheckRule', 'deactivateDeltaCheckRule']) {
      expect(codeOf(keep(await fire(id, requestFor(id, A), mk('a', { grants: grantsOfRole('lab_technologist'), allCentres: true })))), id).toBe('auth.forbidden');
      expect(codeOf(keep(await fire(id, requestFor(id, A), mk('a', { grants: grantsOfRole('lab_manager'), mfa: 'aal1', allCentres: true })))), id).toBe('auth.mfa_required');
    }
    expect((await snapshot(TENANT_A))['delta_check_rules']).toEqual(before['delta_check_rules']);
  });
  it('S-16: QC hold release without the permission => 403; at aal1 => mfa_required; the hold stays active', { timeout: T }, async () => {
    // Ruling C5.T-32-ruling.md: use a fresh hold; the shared A.holdId is legitimately released by the P-10 matrix above (test order, not the refusal).
    const H = await objs('a');
    expect(codeOf(keep(await fire('releaseQcHold', requestFor('releaseQcHold', H), mk('a', { grants: grantsOfRole('lab_technologist'), allCentres: true }))))).toBe('auth.forbidden');
    expect(codeOf(keep(await fire('releaseQcHold', requestFor('releaseQcHold', H), mk('a', { grants: grantsOfRole('lab_manager'), mfa: 'aal1', allCentres: true }))))).toBe('auth.mfa_required');
    expect((await owner('SELECT status, released_by_membership_id FROM lab.qc_holds WHERE id = $1', [H.holdId]))[0]).toMatchObject({ status: 'active', released_by_membership_id: null });
  });
});

// ---------------------------------------------------------------- S-10 access log of label printing
describe.skipIf(!live)('S-10 label access log (08 A13 D-4)', () => {
  const logCount = async (action: string, entityId: string) => Number((await owner('SELECT count(*)::int AS n FROM audit.access_log WHERE tenant_id = $1 AND action = $2 AND entity_id = $3', [TENANT_A, action, entityId]))[0].n);
  it('printSpecimenLabels writes one specimen_label.print access-log row per specimen', { timeout: T }, async () => {
    const S2 = await objs('a');
    const b1 = await logCount('specimen_label.print', A.specimenId); const b2 = await logCount('specimen_label.print', S2.specimenId);
    const out = keep(await fire('printSpecimenLabels', req({ body: { specimen_ids: [A.specimenId, S2.specimenId] } }), FULL_A));
    expect(statusOf(out), `${out.error?.code} ${out.error?.message}`).toBeLessThan(300);
    expect(await logCount('specimen_label.print', A.specimenId)).toBe(b1 + 1);
    expect(await logCount('specimen_label.print', S2.specimenId)).toBe(b2 + 1);
  });
  it('requestOrderLabelPrint writes no access-log row and changes no label counter', { timeout: T }, async () => {
    const S2 = await objs('a');
    const cnt = async () => (await owner('SELECT label_print_count, version FROM lab.specimens WHERE id = $1', [S2.specimenId]))[0];
    const before = await cnt(); const logs = await logCount('specimen_label.print', S2.specimenId);
    const out = keep(await fire('requestOrderLabelPrint', requestFor('requestOrderLabelPrint', S2), FULL_A));
    expect(statusOf(out), `${out.error?.code} ${out.error?.message}`).toBeLessThan(300);
    expect(out.probe.accessCalls.filter((e) => e.action === 'specimen_label.print')).toEqual([]);
    expect(await logCount('specimen_label.print', S2.specimenId)).toBe(logs);
    expect(await cnt()).toEqual(before);
  });
});

// ---------------------------------------------------------------- S-12 / S-19 / S-18
const payloadKeys = (file: string): Set<string> => {
  const s = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/events', file), 'utf8'));
  return new Set(Object.keys(s.$defs?.Payload?.properties ?? s.properties?.payload?.properties ?? {}));
};
describe.skipIf(!live)('S-12 producer payloads carry no key outside the 03-IC schemas', () => {
  it('receive + reject publish only schema keys (no barcode / value / comment)', { timeout: T }, async () => {
    const R = await objs('a', { state: 'collected' }); const X = await objs('a');
    const recv = keep(await fire('receiveSpecimen', requestFor('receiveSpecimen', R), FULL_A));
    expect(statusOf(recv), `${recv.error?.code} ${recv.error?.message}`).toBe(200);
    const rej = keep(await fire('rejectSpecimen', requestFor('rejectSpecimen', X), FULL_A));
    expect(statusOf(rej), `${rej.error?.code} ${rej.error?.message}`).toBe(200);
    const events = [...recv.probe.events, ...rej.probe.events];
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      const keys = payloadKeys(`${e.type}.schema.json`);
      expect(keys.size, `schema of ${e.type}`).toBeGreaterThan(0);
      for (const k of Object.keys(e.input?.payload ?? {})) expect(keys.has(k), `${e.type} payload key ${k}`).toBe(true);
      expect(JSON.stringify(e.input?.payload)).not.toMatch(new RegExp(`${R.barcode}|${X.barcode}|Sentinel`));
    }
  });
});
describe.skipIf(!live)('S-19 error bodies carry no barcode / value / name; S-18 logs carry none either', () => {
  it('failing requests that NAME a barcode / value never echo it', { timeout: T }, async () => {
    const secret = 'ZZSECRET9981';
    const unknown = keep(await fire('lookupSpecimenByBarcode', req({ body: { barcode: secret } }), FULL_A));
    expect(codeOf(unknown)).toBe('common.not_found');
    expect(seen(unknown.error)).not.toContain(secret);
    const again = keep(await fire('receiveSpecimen', requestFor('receiveSpecimen', A), FULL_A));   // already received => invalid transition
    expect(statusOf(again)).toBe(409);
    for (const needle of [A.barcode, A.regNo, 'Sentinel']) expect(seen(again.error), needle).not.toContain(needle);
    const bad = keep(await fire('bulkEnterResults', req({ headers: { 'idempotency-key': uid() }, body: { entries: [{ result_id: A.resultId, version: 1, value_numeric: 'NaN-777' }] } }), FULL_A));
    expect(seen(bad.error) + JSON.stringify(bad.reply?.body ?? '')).not.toContain('NaN-777');
  });
  it('S-18: no log line of any probe request above contains a barcode, registration number or patient name', () => {
    expect(allLogs.length >= 0).toBe(true);
    const text = allLogs.join('\n');
    for (const needle of [A.barcode, A.regNo, 'Sentinel', 'ZZSECRET9981', 'NaN-777']) expect(text, needle).not.toContain(needle);
  });
});
void as;
