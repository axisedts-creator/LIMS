// T23 service tests: IRD Annex tracker (01-PRD AC-E3.1-E3.3, 03-APP-FLOW s2.5 IR1-IR8, 02-TRD s5.10, 08 A25 D-215, 07-SECURITY D-T20 / P-2 / P-19).
// Readiness (AC-E3.4) is ird.readiness.test.ts. Expected now: fails to load (../ird.service.js missing).
import { beforeEach, describe, expect, it } from 'vitest';
import { createIrdService } from '../ird.service.js';
import {
  NOW, PDF, STAFF_ID, STATUSES, SUPPORT, TENANT_A, TENANT_B, TODAY, REQ_ID, bytes, doc, idN, makeCtx, makeRepo, platformRec, rec, recIn, rejection,
  type FakeRepo, type Rec, type Status,
} from './ird.helpers.js';

let seq = 0x9000;
const newId = () => idN(seq++);
let f: FakeRepo; let svc: any;
const mk = (records: Rec[] = [], docs: any[] = []) => { f = makeRepo({ records, docs }); svc = createIrdService({ repo: f.repo, newId } as never); return f; };
beforeEach(() => mk());
const code = async (p: unknown) => (await rejection(p)).code as string;
const RECORD_KEYS = ['record_id', 'tenant_id', 'annex_code', 'status', 'reference_no', 'office_name', 'counterparty_name', 'software_version', 'submitted_on', 'completed_on', 'notes', 'supersedes_id', 'version'];
const noNulls = (b: Record<string, unknown>) => { for (const [k, v] of Object.entries(b)) { expect(RECORD_KEYS).toContain(k); expect(v).not.toBeNull(); expect(v).not.toBeUndefined(); } };

// ------------------------------------------------------------------------------------------------ transition table (03-APP-FLOW s2.5)
// Hard-coded from the spec table (NOT imported from domain/ird-annex.state.ts) so the service is checked against the document, not against its own helper.
const ALLOWED: Record<Status, Status[]> = {
  not_started: ['in_preparation'], in_preparation: ['submitted', 'not_started'], submitted: ['completed', 'rejected'], rejected: ['in_preparation'], completed: ['superseded'], superseded: [],
};
const FIELDS: Record<Status, Record<string, string>> = {
  not_started: {}, in_preparation: {}, submitted: { submittedOn: '2026-11-05' }, completed: { completedOn: '2026-11-06', referenceNo: 'REF-NEW-1' }, rejected: { note: 'Rejected: wrong office' }, superseded: {},
};
const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));
describe('transitionIrdAnnex: every (from, to) pair against the 03-APP-FLOW s2.5 table', () => {
  it.each(PAIRS.filter(([a, b]) => ALLOWED[a].includes(b)))('allowed %s -> %s: saved, history row appended, version bumped', async (from, to) => {
    const r = recIn(from); mk([r]);
    const out = await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: to, ...FIELDS[to] });
    expect(out.status).toBe(200);
    expect(f.by('transition')).toHaveLength(1);
    expect(f.by('transition')[0]!.args.slice(0, 3)).toEqual([r.id, 3, to]);
    expect(f.events.filter((e) => e.recordId === r.id)).toEqual([expect.objectContaining({ fromStatus: from, toStatus: to, tenantId: TENANT_A, actorId: expect.any(String) })]);
    if (to !== 'superseded') { expect(out.body).toMatchObject({ record_id: r.id, status: to, version: 4 }); expect(out.version).toBe(4); noNulls(out.body); }
  });
  it.each(PAIRS.filter(([a, b]) => !ALLOWED[a].includes(b)))('forbidden %s -> %s: 409 identity.annex_invalid_transition, nothing written (fields complete or absent)', async (from, to) => {
    const r = recIn(from); mk([r]);
    for (const input of [{ ...FIELDS[to], submittedOn: '2026-11-05', completedOn: '2026-11-06', referenceNo: 'REF-NEW-1', note: 'x' }, {}]) {
      expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: to, ...input }))).toBe('identity.annex_invalid_transition');
    }
    for (const m of ['transition', 'insert', 'insertEvent', 'insertPlatformEvent']) expect(f.by(m)).toHaveLength(0);
    expect(f.rowOf(r.id)).toMatchObject({ status: from, version: 3 });
  });
});

describe('AC-E3.1 submitted needs submitted_on (08 A13 P-1)', () => {
  it('in_preparation -> submitted without submitted_on: 400 common.validation_failed pointing at /submitted_on; nothing written', async () => {
    const r = recIn('in_preparation', { annex_code: 'annex_3' }); mk([r]);
    const e = await rejection(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'submitted' }));
    expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? [])).toContain('/submitted_on');
    for (const m of ['transition', 'insertEvent', 'insertPlatformEvent']) expect(f.by(m)).toHaveLength(0);
  });
  it.each([['future date', '2026-11-09'], ['not a date', 'tomorrow'], ['impossible date', '2026-02-30'], ['wrong format', '08/11/2026'], ['empty', ''], ['datetime', '2026-11-08T00:00:00Z']])('submitted_on %s -> 400', async (_n, v) => {
    const r = recIn('in_preparation'); mk([r]);
    expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'submitted', submittedOn: v }))).toBe('common.validation_failed');
    expect(f.by('transition')).toHaveLength(0);
  });
  it('submitted_on = today is accepted (date <= today, "today" from ctx.now())', async () => {
    const r = recIn('in_preparation'); mk([r]);
    const out = await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'submitted', submittedOn: TODAY });
    expect(out.body).toMatchObject({ status: 'submitted', submitted_on: TODAY });
  });
});

describe('AC-E3.2 submitted -> completed', () => {
  it('with reference_no and completed_on: saved, ird_annex_events row appended', async () => {
    const r = recIn('submitted', { annex_code: 'annex_3' }); mk([r]);
    const out = await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'completed', completedOn: '2026-11-06', referenceNo: 'REF-3-2083' });
    expect(out.body).toMatchObject({ status: 'completed', reference_no: 'REF-3-2083', completed_on: '2026-11-06', submitted_on: '2026-11-01', version: 4 });
    expect(f.by('transition')[0]!.args[3]).toEqual({ completedOn: '2026-11-06', referenceNo: 'REF-3-2083' });
    expect(f.events).toEqual([expect.objectContaining({ recordId: r.id, fromStatus: 'submitted', toStatus: 'completed' })]);
  });
  it.each([
    ['no reference_no', { completedOn: '2026-11-06' }], ['blank reference_no', { completedOn: '2026-11-06', referenceNo: '   ' }], ['no completed_on', { referenceNo: 'R1' }],
    ['completed_on before submitted_on', { completedOn: '2026-10-31', referenceNo: 'R1' }], ['reference_no > 100', { completedOn: '2026-11-06', referenceNo: 'R'.repeat(101) }],
  ])('%s -> 400 common.validation_failed', async (_n, input) => {
    const r = recIn('submitted'); mk([r]);
    expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'completed', ...input }))).toBe('common.validation_failed');
    expect(f.by('transition')).toHaveLength(0); expect(f.events).toHaveLength(0);
  });
  it('completed_on = submitted_on is allowed (>=)', async () => {
    const r = recIn('submitted'); mk([r]);
    expect((await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'completed', completedOn: '2026-11-01', referenceNo: 'R1' })).body.status).toBe('completed');
  });
  it('rejected needs a note (IR5): missing/blank/> 1000 -> 400; the note goes to the history row', async () => {
    const r = recIn('submitted'); mk([r]);
    for (const note of [undefined, '', '   ', 'n'.repeat(1001)]) expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'rejected', note }))).toBe('common.validation_failed');
    expect(f.by('transition')).toHaveLength(0);
    await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'rejected', note: 'Rejected: wrong office' });
    expect(f.events).toEqual([expect.objectContaining({ fromStatus: 'submitted', toStatus: 'rejected', note: 'Rejected: wrong office' })]);
  });
});

describe('AC-E3.3 invalid edge', () => {
  it('not_started -> completed directly: 409 identity.annex_invalid_transition (edge check beats the missing-field 400)', async () => {
    const r = rec(); mk([r]);
    expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 1, toStatus: 'completed' }))).toBe('identity.annex_invalid_transition');
    expect(f.by('transition')).toHaveLength(0);
  });
});

describe('IR7 completed -> superseded creates the successor in the same transaction [CONV]', () => {
  it('annex_2: old -> superseded FIRST (partial unique index), then successor not_started with supersedes_id; returns the successor', async () => {
    const r = recIn('completed', { annex_code: 'annex_2' }); mk([r]); const c = makeCtx();
    const out = await svc.transitionIrdAnnex(c.ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'superseded' });
    expect(f.order.filter((m) => m === 'transition' || m === 'insert')).toEqual(['transition', 'insert']);
    const ins = f.by('insert')[0]!; expect(ins.args[0]).toMatchObject({ tenantId: TENANT_A, annexCode: 'annex_2', status: 'not_started', supersedesId: r.id });
    expect(f.by('transition')[0]!.tx).toBe(c.tx); expect(ins.tx).toBe(c.tx);                           // one request transaction
    expect(f.rowOf(r.id).status).toBe('superseded');
    expect(out.status).toBe(200); expect(out.body).toMatchObject({ annex_code: 'annex_2', tenant_id: TENANT_A, status: 'not_started', supersedes_id: r.id, version: 1 });
    expect(out.body.record_id).not.toBe(r.id); noNulls(out.body);
    expect(f.events).toContainEqual(expect.objectContaining({ recordId: r.id, fromStatus: 'completed', toStatus: 'superseded' }));
  });
  it.each(['annex_3', 'annex_7'] as const)('%s successor keeps the same annex and tenant', async (annex) => {
    const r = recIn('completed', { annex_code: annex, tenant_id: TENANT_B }); mk([r]);
    const out = await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'superseded' });
    expect(out.body).toMatchObject({ annex_code: annex, tenant_id: TENANT_B, status: 'not_started', supersedes_id: r.id });
  });
  it('successor insert failure propagates (the request transaction rolls the superseded status back); nothing is swallowed', async () => {
    const r = recIn('completed'); mk([r]); f.fail['insert'] = new Error('db down');
    expect((await rejection(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'superseded' }))).message).toBe('db down');
  });
  it('a stale version supersedes nothing and creates no successor', async () => {
    const r = recIn('completed'); mk([r]);
    expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 2, toStatus: 'superseded' }))).toBe('common.version_conflict');
    expect(f.by('insert')).toHaveLength(0); expect(f.rowOf(r.id).status).toBe('completed');
  });
  it('a non-superseding transition creates no successor', async () => {
    const r = recIn('submitted'); mk([r]);
    await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'rejected', note: 'n' });
    expect(f.by('insert')).toHaveLength(0);
  });
});

describe('transitionIrdAnnex: preconditions and input', () => {
  it('If-Match absent -> 428 common.precondition_required; malformed -> 400; stale -> 409 common.version_conflict', async () => {
    const r = recIn('in_preparation'); mk([r]);
    expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: undefined, toStatus: 'not_started' }))).toBe('common.precondition_required');
    for (const v of [0, -1, 1.5, 'x', NaN]) expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: v, toStatus: 'not_started' }))).toBe('common.validation_failed');
    expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 2, toStatus: 'not_started' }))).toBe('common.version_conflict');
    expect(f.events).toHaveLength(0); expect(f.rowOf(r.id)).toMatchObject({ status: 'in_preparation', version: 3 });   // none of the three refused calls changed anything
  });
  it('unknown record -> 404; malformed id -> 400/404; to_status missing or not in the enum -> 400', async () => {
    const r = recIn('in_preparation'); mk([r]);
    expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: idN(0xdead), expectedVersion: 1, toStatus: 'submitted', submittedOn: TODAY }))).toBe('common.not_found');
    expect(['common.validation_failed', 'common.not_found']).toContain(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: "1' OR '1'='1", expectedVersion: 1, toStatus: 'submitted' })));
    for (const to of [undefined, 'bogus', 'COMPLETED', 7, null, '__proto__']) expect(await code(svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: to }))).toBe('common.validation_failed');
    expect(f.by('transition')).toHaveLength(0);
  });
  it('platform_superadmin sees a tenant record by id only through the platform repo find (no tenant claim, no withTenantScope)', async () => {
    const r = recIn('in_preparation', { tenant_id: TENANT_B }); mk([r]); const c = makeCtx();
    await svc.transitionIrdAnnex(c.ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'not_started' });
    expect(c.ctx.db.withTenantScope).not.toHaveBeenCalled();
    expect(f.events[0]).toMatchObject({ tenantId: TENANT_B });
  });
});

// ------------------------------------------------------------------------------------------------ platform_events (08 A25 D-215)
describe('Annex 1 changes write platform_events annex_1_changed; tenant annexes do not', () => {
  const ev = () => f.platformEvents.filter((e) => e.eventType === 'annex_1_changed');
  it('createPlatformIrdAnnex: platform-level annex_1 (tenant_id NULL), not_started, IR1 history row, one annex_1_changed event, 201 + ETag version', async () => {
    const c = makeCtx(); const out = await svc.createPlatformIrdAnnex(c.ctx, { softwareVersion: '1.1.0', notes: 'Synthetic note' });
    expect(f.by('insert')[0]!.args[0]).toMatchObject({ tenantId: null, annexCode: 'annex_1', status: 'not_started', softwareVersion: '1.1.0', notes: 'Synthetic note' });
    expect(out.status).toBe(201); expect(out.version).toBe(1);
    expect(out.body).toMatchObject({ annex_code: 'annex_1', status: 'not_started', software_version: '1.1.0', notes: 'Synthetic note', version: 1 }); expect(out.body).not.toHaveProperty('tenant_id'); noNulls(out.body);
    expect(f.events).toEqual([expect.objectContaining({ recordId: out.body.record_id, tenantId: null, fromStatus: null, toStatus: 'not_started' })]);
    expect(ev()).toEqual([expect.objectContaining({ targetId: out.body.record_id, targetTenantId: null, actorPlatformStaffId: STAFF_ID, requestId: REQ_ID })]);
    expect(ev()[0]!.targetType).toEqual(expect.any(String));
  });
  it('updateIrdAnnex on annex_1 writes the event; on annex_2 it does not', async () => {
    const a1 = platformRec('in_preparation', { version: 2 }), a2 = recIn('in_preparation'); mk([a1, a2]);
    await svc.updateIrdAnnex(makeCtx().ctx, { recordId: a1.id, expectedVersion: 2, patch: { software_version: '1.2.0' } });
    expect(ev()).toEqual([expect.objectContaining({ targetId: a1.id, targetTenantId: null })]);
    await svc.updateIrdAnnex(makeCtx().ctx, { recordId: a2.id, expectedVersion: 3, patch: { reference_no: 'R-2' } });
    expect(ev()).toHaveLength(1);
  });
  it('transitionIrdAnnex on annex_1 writes the event (also for the supersede, which creates a platform-level successor); annex_2/3/7 never do', async () => {
    const a1 = platformRec('completed'); mk([a1]);
    const out = await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: a1.id, expectedVersion: 3, toStatus: 'superseded' });
    expect(out.body).toMatchObject({ annex_code: 'annex_1', status: 'not_started', supersedes_id: a1.id }); expect(out.body).not.toHaveProperty('tenant_id');
    expect(ev().length).toBeGreaterThanOrEqual(1); expect(ev().every((e) => e.targetTenantId === null)).toBe(true);
    mk([recIn('submitted', { annex_code: 'annex_7' }), recIn('completed', { annex_code: 'annex_3' })]);
    const [s7, c3] = f.records;
    await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: s7!.id, expectedVersion: 3, toStatus: 'rejected', note: 'n' });
    await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: c3!.id, expectedVersion: 3, toStatus: 'superseded' });
    expect(f.platformEvents).toHaveLength(0);
  });
  it('the event detail is non-PHI: no note / reference number / software free text', async () => {
    const a1 = platformRec('submitted', { reference_no: 'SECRET-REF-9' }); mk([a1]);
    await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: a1.id, expectedVersion: 3, toStatus: 'completed', completedOn: '2026-11-06', referenceNo: 'SECRET-REF-9' });
    await svc.updateIrdAnnex(makeCtx().ctx, { recordId: a1.id, expectedVersion: 4, patch: { notes: 'PLANTED-NOTE-77' } });
    const dump = JSON.stringify(f.platformEvents.map((e) => e.detail)); expect(f.platformEvents.length).toBeGreaterThanOrEqual(2);
    expect(dump).not.toContain('SECRET-REF-9'); expect(dump).not.toContain('PLANTED-NOTE-77');
  });
  it('a failing platform_events insert fails the request (no silent loss of the D-215 trail)', async () => {
    mk([platformRec('in_preparation', { version: 2 })]); f.fail['insertPlatformEvent'] = new Error('events down');
    expect((await rejection(svc.updateIrdAnnex(makeCtx().ctx, { recordId: f.records[0]!.id, expectedVersion: 2, patch: { notes: 'x' } }))).message).toBe('events down');
  });
});

// ------------------------------------------------------------------------------------------------ create / update / list
describe('createPlatformIrdAnnex validation', () => {
  it.each([[{}], [{ softwareVersion: '' }], [{ softwareVersion: 'v'.repeat(41) }], [{ softwareVersion: 5 }], [{ softwareVersion: '1.0', notes: 'n'.repeat(2001) }], [{ softwareVersion: '1.0', notes: 7 }]])('%j -> 400, no row', async (input) => {
    expect(await code(svc.createPlatformIrdAnnex(makeCtx().ctx, input))).toBe('common.validation_failed');
    expect(f.by('insert')).toHaveLength(0); expect(f.platformEvents).toHaveLength(0);
  });
  it('boundary: software_version 40 chars and notes 2000 chars are accepted; only these fields are forwarded (no tenant_id / annex_code / status override)', async () => {
    await svc.createPlatformIrdAnnex(makeCtx().ctx, { softwareVersion: 'v'.repeat(40), notes: 'n'.repeat(2000), tenantId: TENANT_A, annexCode: 'annex_2', status: 'completed' });
    expect(f.by('insert')[0]!.args[0]).toMatchObject({ tenantId: null, annexCode: 'annex_1', status: 'not_started' });
  });
});

describe('updateIrdAnnex', () => {
  it('sets fields, unsets listed ones, bumps the version, returns the record with ETag version', async () => {
    const r = recIn('in_preparation', { notes: 'old', office_name: 'Old office', version: 2 }); mk([r]);
    const out = await svc.updateIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 2, patch: { reference_no: 'REF-2', counterparty_name: 'DC operator', unset: ['notes', 'office_name'] } });
    expect(f.by('update')[0]!.args.slice(0, 4)).toEqual([r.id, 2,{ reference_no: 'REF-2', counterparty_name: 'DC operator' }, ['notes', 'office_name']]);
    expect(out).toMatchObject({ status: 200, version: 3 }); expect(out.body).toMatchObject({ reference_no: 'REF-2', counterparty_name: 'DC operator', version: 3 });
    expect(out.body).not.toHaveProperty('notes'); expect(out.body).not.toHaveProperty('office_name'); noNulls(out.body);
  });
  it.each([
    ['unknown key', { colour: 'red' }], ['status (mass assignment)', { status: 'completed' }], ['tenant_id', { tenant_id: TENANT_B }], ['version', { version: 9 }], ['submitted_on', { submitted_on: '2026-11-01' }],
    ['reference_no > 100', { reference_no: 'R'.repeat(101) }], ['office_name > 200', { office_name: 'O'.repeat(201) }], ['counterparty_name > 200', { counterparty_name: 'O'.repeat(201) }],
    ['software_version > 40', { software_version: 'v'.repeat(41) }], ['notes > 2000', { notes: 'n'.repeat(2001) }], ['empty reference_no', { reference_no: '' }], ['non-string', { office_name: 5 }],
    ['unset a non-column', { unset: ['status'] }], ['unset not an array', { unset: 'notes' }], ['set and unset the same field', { notes: 'x', unset: ['notes'] }], ['unset > 5 entries', { unset: ['notes', 'notes', 'notes', 'notes', 'notes', 'notes'] }],
  ])('%s -> 400 common.validation_failed, nothing written', async (_n, patch) => {
    const r = recIn('in_preparation'); mk([r]);
    expect(await code(svc.updateIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, patch }))).toBe('common.validation_failed');
    expect(f.by('update')).toHaveLength(0); expect(f.platformEvents).toHaveLength(0);
  });
  it('boundaries accepted: reference_no 100, office_name 200, counterparty_name 200, software_version 40, notes 2000', async () => {
    const r = recIn('in_preparation'); mk([r]);
    await svc.updateIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, patch: { reference_no: 'R'.repeat(100), office_name: 'O'.repeat(200), counterparty_name: 'C'.repeat(200), software_version: 'v'.repeat(40), notes: 'n'.repeat(2000) } });
    expect(f.by('update')).toHaveLength(1);
  });
  it('If-Match absent -> 428; stale -> 409 common.version_conflict; unknown record -> 404', async () => {
    const r = recIn('in_preparation'); mk([r]);
    expect(await code(svc.updateIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: undefined, patch: { notes: 'x' } }))).toBe('common.precondition_required');
    expect(await code(svc.updateIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 1, patch: { notes: 'x' } }))).toBe('common.version_conflict');
    expect(await code(svc.updateIrdAnnex(makeCtx().ctx, { recordId: idN(0xdead), expectedVersion: 1, patch: { notes: 'x' } }))).toBe('common.not_found');
  });
  it('update never changes status, dates or tenant (the repo is handed only the five editable columns)', async () => {
    const r = recIn('submitted'); mk([r]);
    await svc.updateIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, patch: { notes: 'x' } });
    expect(f.rowOf(r.id)).toMatchObject({ status: 'submitted', submitted_on: '2026-11-01', tenant_id: TENANT_A });
  });
});

describe('listPlatformIrdAnnexes', () => {
  const seed = () => mk([platformRec('completed'), platformRec('not_started', { annex_code: 'annex_1' }), recIn('completed', { annex_code: 'annex_2', tenant_id: TENANT_A }), recIn('submitted', { annex_code: 'annex_3', tenant_id: TENANT_A }), recIn('completed', { annex_code: 'annex_2', tenant_id: TENANT_B })]);
  it('no tenant_id filter = the platform-level Annex 1 records ONLY (repo asked for tenantId null); no tenant row leaks', async () => {
    seed(); const out = await svc.listPlatformIrdAnnexes(makeCtx(SUPPORT).ctx, {});
    expect(f.by('list')[0]!.args[0]).toMatchObject({ tenantId: null });
    expect(out.status).toBe(200); expect(out.body.data).toHaveLength(2); expect(out.body.data.every((x: any) => x.annex_code === 'annex_1' && !('tenant_id' in x))).toBe(true); out.body.data.forEach(noNulls);
  });
  it('tenant_id + annex_code + status filters are passed to the repo and applied', async () => {
    seed(); const out = await svc.listPlatformIrdAnnexes(makeCtx().ctx, { tenantId: TENANT_A, annexCode: 'annex_3', status: 'submitted' });
    expect(f.by('list')[0]!.args[0]).toEqual({ tenantId: TENANT_A, annexCode: 'annex_3', status: 'submitted' });
    expect(out.body.data).toEqual([expect.objectContaining({ annex_code: 'annex_3', status: 'submitted', tenant_id: TENANT_A })]);
  });
  it.each([[{ tenantId: 'not-a-uuid' }], [{ annexCode: 'annex_9' }], [{ status: 'done' }], [{ annexCode: "annex_1' OR 1=1" }]])('%j -> 400, repo not called', async (input) => {
    seed(); expect(await code(svc.listPlatformIrdAnnexes(makeCtx().ctx, input))).toBe('common.validation_failed'); expect(f.by('list')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ authorisation
describe('PlatformAuthz on every operation (read = superadmin + support, manage = superadmin, both need aal2)', () => {
  const r = () => recIn('in_preparation');
  const OPS: Array<[string, 'read' | 'manage', () => unknown]> = [
    ['listPlatformIrdAnnexes', 'read', () => ({})],
    ['createPlatformIrdAnnex', 'manage', () => ({ softwareVersion: '1.0' })],
    ['updateIrdAnnex', 'manage', () => ({ recordId: f.records[0]!.id, expectedVersion: 3, patch: { notes: 'x' } })],
    ['transitionIrdAnnex', 'manage', () => ({ recordId: f.records[0]!.id, expectedVersion: 3, toStatus: 'not_started' })],
    ['uploadIrdAnnexDocument', 'manage', () => ({ recordId: f.records[0]!.id, file: PDF() })],
    ['downloadIrdAnnexDocument', 'read', () => ({ recordId: f.records[0]!.id, documentId: idN(0x1) })],
  ];
  it.each(OPS.filter(([, k]) => k === 'manage'))('%s: platform_support -> 403 auth.forbidden before any repo / upload call', async (op, _k, input) => {
    mk([r()]); const c = makeCtx(SUPPORT);
    expect(await code(svc[op](c.ctx, input()))).toBe('auth.forbidden');
    expect(f.calls).toHaveLength(0); expect(c.accept).not.toHaveBeenCalled(); expect(f.platformEvents).toHaveLength(0);
  });
  it.each(OPS)('%s: aal1 -> auth.mfa_required; no platform role / unknown role / tenant-user ctx -> auth.forbidden or auth.unauthenticated; repo untouched', async (op, _k, input) => {
    mk([r()]);
    expect(await code(svc[op](makeCtx({ aal: 'aal1' }).ctx, input()))).toBe('auth.mfa_required');
    for (const o of [{ platformRole: undefined }, { platformRole: 'tenant_admin' }, { platformRole: 'platform_superadmin_x' }]) {
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(await code(svc[op](makeCtx(o).ctx, input())));
    }
    expect(f.calls).toHaveLength(0);
  });
  it('platform_support may list and download (platform.tenant.read)', async () => {
    const a = platformRec('completed'); const d = doc(a.id, { tenant_id: null }); mk([a], [d]);
    const c = makeCtx(SUPPORT, { [d.object_path]: bytes('%PDF-1.4') });
    expect((await svc.listPlatformIrdAnnexes(c.ctx, {})).status).toBe(200);
    expect((await svc.downloadIrdAnnexDocument(c.ctx, { recordId: a.id, documentId: d.id })).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------ upload (P-19, 02-CV s10.2)
describe('uploadIrdAnnexDocument', () => {
  it('annex_1 (platform-level): accept() options per 02-CV s10.2; path platform/ird/{record}/{uuid}.pdf; row scan_state from the scan; 201 IrdAnnexDocument', async () => {
    const a = platformRec('in_preparation'); mk([a]); const c = makeCtx();
    const out = await svc.uploadIrdAnnexDocument(c.ctx, { recordId: a.id, file: PDF() });
    const [file, opts] = c.accept.mock.calls[0]! as [any, any];
    expect(file.filename).toBe('annex-2.pdf');
    expect([...opts.allow].sort()).toEqual(['application/pdf', 'image/jpeg', 'image/png']); expect(opts.maxBytes).toBe(15 * 1024 * 1024);
    expect(opts.bucket).toBe('identity-assets'); expect(opts.scan).toBe('required'); expect(opts).not.toHaveProperty('images');   // PDF/JPEG are stored as received; core re-encodes PNG only
    expect(opts.objectPath).toMatch(new RegExp(`^platform/ird/${a.id}/[0-9a-f-]{36}\\.(pdf|png|jpg)$`));
    expect(f.by('insertDocument')[0]!.args[0]).toMatchObject({ tenantId: null, recordId: a.id, bucket: 'identity-assets', objectPath: opts.objectPath, originalFilename: 'annex-2.pdf', contentType: 'application/pdf', sizeBytes: file.bytes.length, sha256: 'cd'.repeat(32), scanState: 'clean' });
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ record_id: a.id, original_filename: 'annex-2.pdf', content_type: 'application/pdf', sha256: 'cd'.repeat(32), scan_state: 'clean' });
    expect(out.body.document_id).toMatch(/^[0-9a-f-]{36}$/); expect(Object.keys(out.body).sort()).toEqual(['content_type', 'created_at', 'document_id', 'original_filename', 'record_id', 'scan_state', 'sha256', 'size_bytes']);
  });
  it('tenant record: path starts with the RECORD\'s tenant id and the row carries it (never a caller-supplied one)', async () => {
    const a = recIn('in_preparation', { tenant_id: TENANT_B }); mk([a]); const c = makeCtx();
    await svc.uploadIrdAnnexDocument(c.ctx, { recordId: a.id, file: PDF(), tenantId: TENANT_A, objectPath: '../x' } as never);
    expect((c.accept.mock.calls[0]![1] as any).objectPath).toMatch(new RegExp(`^${TENANT_B}/ird/${a.id}/`));
    expect(f.by('insertDocument')[0]!.args[0]).toMatchObject({ tenantId: TENANT_B });
  });
  it('the client filename never reaches the stored key', async () => {
    const a = platformRec('in_preparation'); mk([a]); const c = makeCtx();
    await svc.uploadIrdAnnexDocument(c.ctx, { recordId: a.id, file: { filename: '../../etc/passwd%00.pdf', mimeType: 'application/pdf', bytes: bytes('%PDF-1.4') } });
    expect((c.accept.mock.calls[0]![1] as any).objectPath).not.toMatch(/passwd|\.\./);
  });
  it('scanner down (accept -> unavailable): row stored scan_state "pending", upload still 201 (P-19); NO identity.rescan_upload job (re-scan happens on download)', async () => {
    const a = platformRec('in_preparation'); mk([a]); const c = makeCtx(); c.acceptMode.v = 'unavailable';
    const out = await svc.uploadIrdAnnexDocument(c.ctx, { recordId: a.id, file: PDF() });
    expect(f.by('insertDocument')[0]!.args[0]).toMatchObject({ scanState: 'pending' }); expect(out.body.scan_state).toBe('pending'); expect(out.status).toBe(201);
    expect(f.calls.map((x) => x.m)).not.toContain('enqueueJob');
  });
  it.each([['common.payload_too_large'], ['common.unsupported_media_type'], ['common.upload_quarantined']])('accept() rejects with %s -> propagated unchanged, no document row', async (errCode) => {
    const { LimsError } = await import('../../../../core/errors.js');
    const a = platformRec('in_preparation'); mk([a]); const c = makeCtx(); c.acceptMode.v = new LimsError(errCode);
    expect(await code(svc.uploadIrdAnnexDocument(c.ctx, { recordId: a.id, file: PDF() }))).toBe(errCode);
    expect(f.by('insertDocument')).toHaveLength(0);
  });
  it('unknown record -> 404 and accept() is never called (no stored bytes for a record that does not exist)', async () => {
    const c = makeCtx(); expect(await code(svc.uploadIrdAnnexDocument(c.ctx, { recordId: idN(0xdead), file: PDF() }))).toBe('common.not_found'); expect(c.accept).not.toHaveBeenCalled();
  });
  it.each([[undefined], [null], ['x'], [{}], [{ filename: 'a.pdf' }], [{ filename: 5, mimeType: 'application/pdf', bytes: new Uint8Array(1) }], [{ filename: 'a'.repeat(201) + '.pdf', mimeType: 'application/pdf', bytes: bytes('%PDF-') }]])('malformed file %j -> 4xx, no row', async (file) => {
    const a = platformRec('in_preparation'); mk([a]); const c = makeCtx();
    expect(['common.validation_failed', 'common.unsupported_media_type']).toContain(await code(svc.uploadIrdAnnexDocument(c.ctx, { recordId: a.id, file })));
    expect(f.by('insertDocument')).toHaveLength(0);
  });
  it('a refused row leaves no orphan object: the stored object is deleted', async () => {
    const a = platformRec('in_preparation'); mk([a]); f.fail['insertDocument'] = new Error('db down'); const c = makeCtx();
    expect((await rejection(svc.uploadIrdAnnexDocument(c.ctx, { recordId: a.id, file: PDF() }))).message).toBe('db down');
    expect(c.remove).toHaveBeenCalledTimes(1); expect(c.stored.size).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ download (P-2, P-19, D-T20)
describe('downloadIrdAnnexDocument', () => {
  const PDFBYTES = bytes('%PDF-1.4 synthetic annex');
  const setup = (state: 'clean' | 'pending' | 'quarantined', o: { annex?: Rec } = {}) => {
    const a = o.annex ?? platformRec('completed'); const d = doc(a.id, { tenant_id: a.tenant_id, scan_state: state }); mk([a], [d]);
    const c = makeCtx({}, { [d.object_path]: PDFBYTES }); return { a, d, c };
  };
  const dl = (s: ReturnType<typeof setup>) => svc.downloadIrdAnnexDocument(s.c.ctx, { recordId: s.a.id, documentId: s.d.id });
  const dlEvents = () => f.platformEvents.filter((e) => e.eventType === 'ird_document_downloaded');

  it('clean: 200 with the exact bytes; attachment + nosniff + no-store (P-2); no re-scan; ird_document_downloaded written (platform_events, not access_log)', async () => {
    const s = setup('clean'); const out = await dl(s);
    expect(out.status).toBe(200); expect(Buffer.from(out.body)).toEqual(Buffer.from(PDFBYTES));
    expect(out.headers['content-disposition']).toMatch(/^attachment/); expect(out.headers['x-content-type-options']).toBe('nosniff'); expect(out.headers['cache-control']).toBe('no-store');
    expect(out.headers['content-type']).toBe('application/pdf');
    expect(s.c.scan).not.toHaveBeenCalled();
    expect(s.c.audit).not.toHaveBeenCalled(); // 02-TRD §9: no access_log row (platform ctx has no tenantId); platform_events only
    expect(dlEvents()).toEqual([expect.objectContaining({ targetId: s.d.id, targetTenantId: null, actorPlatformStaffId: STAFF_ID, requestId: REQ_ID })]);
    expect(JSON.stringify(dlEvents()[0]!.detail)).toContain(s.a.id);
  });
  it('a tenant-level document records its tenant as target_tenant_id', async () => {
    const s = setup('clean', { annex: recIn('completed', { tenant_id: TENANT_B }) }); await dl(s);
    expect(dlEvents()[0]).toMatchObject({ targetTenantId: TENANT_B });
  });
  it('EVERY call writes an event: 3 downloads -> 3 events', async () => {
    const s = setup('clean'); await dl(s); await dl(s); await dl(s); expect(dlEvents()).toHaveLength(3);
  });
  it('pending + scanner now clean: re-scanned on download (bytes from ctx.storage.read), state updated to clean, 200', async () => {
    const s = setup('pending'); const out = await dl(s);
    expect(s.c.scan).toHaveBeenCalledTimes(1); expect(Buffer.from(s.c.scan.mock.calls[0]![0] as Uint8Array)).toEqual(Buffer.from(PDFBYTES));
    expect(s.c.read).toHaveBeenCalled(); expect(f.by('setDocumentScanState')[0]!.args).toEqual([s.d.id, 'clean']); expect(f.docOf(s.d.id).scan_state).toBe('clean');
    expect(out.status).toBe(200);
  });
  it('pending + scanner still down (unavailable): 422 common.upload_quarantined, no bytes, row stays pending', async () => {
    const s = setup('pending'); s.c.scanMode.v = 'unavailable';
    expect(await code(dl(s))).toBe('common.upload_quarantined'); expect(f.docOf(s.d.id).scan_state).toBe('pending'); expect(f.by('setDocumentScanState')).toHaveLength(0);
  });
  it('pending + scanner throws: fails closed with 422 (not a 500), row stays pending', async () => {
    const s = setup('pending'); s.c.scanMode.v = 'throw';
    expect(await code(dl(s))).toBe('common.upload_quarantined'); expect(f.docOf(s.d.id).scan_state).toBe('pending');
  });
  it('pending + infected: row -> quarantined (kept across the 422 via commitOnError), 422, the next call does not re-scan', async () => {
    const s = setup('pending'); s.c.scanMode.v = 'infected';
    expect(await code(dl(s))).toBe('common.upload_quarantined');
    expect(f.by('setDocumentScanState')[0]!.args).toEqual([s.d.id, 'quarantined']); expect(s.c.commitOnError).toHaveBeenCalled();
    s.c.scan.mockClear(); expect(await code(dl(s))).toBe('common.upload_quarantined'); expect(s.c.scan).not.toHaveBeenCalled();
  });
  it('quarantined: 422 without reading the object or scanning', async () => {
    const s = setup('quarantined'); expect(await code(dl(s))).toBe('common.upload_quarantined');
    expect(s.c.scan).not.toHaveBeenCalled(); expect(s.c.read).not.toHaveBeenCalled();
  });
  it('a denied call (422) still writes ird_document_downloaded (outcome denied) and asks for the write to survive the error', async () => {
    const s = setup('pending'); s.c.scanMode.v = 'unavailable'; await rejection(dl(s));
    expect(dlEvents()).toHaveLength(1); expect(JSON.stringify(dlEvents()[0]!.detail)).toContain('denied'); expect(s.c.commitOnError).toHaveBeenCalled();
  });
  it('unknown document, document of another record, malformed ids -> 404/400; no bytes, no event', async () => {
    const s = setup('clean'); const other = platformRec('completed'); f.records.push(other);
    expect(await code(svc.downloadIrdAnnexDocument(s.c.ctx, { recordId: other.id, documentId: s.d.id }))).toBe('common.not_found');
    expect(await code(svc.downloadIrdAnnexDocument(s.c.ctx, { recordId: s.a.id, documentId: idN(0xdead) }))).toBe('common.not_found');
    expect(['common.validation_failed', 'common.not_found']).toContain(await code(svc.downloadIrdAnnexDocument(s.c.ctx, { recordId: s.a.id, documentId: '../../x' })));
    expect(dlEvents()).toHaveLength(0); expect(s.c.read).not.toHaveBeenCalled();
  });
  it('a hostile original_filename cannot inject headers (CR/LF, quotes)', async () => {
    const s = setup('clean'); f.docs[0]!.original_filename = 'a"\r\nSet-Cookie: x=1.pdf';
    const out = await dl(s); expect(out.headers['content-disposition']).not.toMatch(/[\r\n]/); expect(Object.keys(out.headers).some((k) => /set-cookie/i.test(k))).toBe(false);
  });
});

describe('time and identity come from the platform ctx only', () => {
  it('"today" is ctx.now() (a clock one day later accepts what was a future date)', async () => {
    const r = recIn('in_preparation'); mk([r]);
    const later = makeCtx({ now: () => new Date(NOW.getTime() + 24 * 3600_000) }).ctx;
    expect((await svc.transitionIrdAnnex(later, { recordId: r.id, expectedVersion: 3, toStatus: 'submitted', submittedOn: '2026-11-09' })).body.status).toBe('submitted');
  });
  it('writes carry the platform actor id (history row, repo actor argument)', async () => {
    const r = recIn('in_preparation'); mk([r]);
    await svc.transitionIrdAnnex(makeCtx().ctx, { recordId: r.id, expectedVersion: 3, toStatus: 'not_started' });
    expect(f.events[0]!.actorId).toBe(idN(0xd1)); expect(f.by('transition')[0]!.args[4]).toBe(idN(0xd1));
  });
});
