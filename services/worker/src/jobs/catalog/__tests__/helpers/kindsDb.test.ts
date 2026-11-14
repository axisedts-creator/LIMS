// T-25 fixture self-check (helpers/kindsDb.ts): the composite routes the REAL API services' SQL, shares ONE revision, commits/rolls back every sub-fake together, mirrors departments to
// comment codes, and lets a test created in the same transaction as its department pass the FK (Postgres semantics). Passing here proves the fixture, not T-25.
import { describe, expect, it } from 'vitest';
import { createCommentsService } from '../../../../../../api/src/modules/catalog/service/comments.service.js';
import { createCreditPartiesService } from '../../../../../../api/src/modules/catalog/service/creditParties.service.js';
import { createMastersService } from '../../../../../../api/src/modules/catalog/service/masters.service.js';
import { createReferrersService } from '../../../../../../api/src/modules/catalog/service/referrers.service.js';
import { createTestsService } from '../../../../../../api/src/modules/catalog/service/tests.service.js';
import { COMMITTER, NOW, TENANT_A, TENANT_B, eventsOf, makeKindsDb, type KindsDb } from './kindsDb.js';

const T = 20_000;
async function inTx<R>(db: KindsDb, fn: (ctx: any, events: unknown[][]) => Promise<R>, opts: { rollback?: boolean } = {}): Promise<R> {
  const events: unknown[][] = [];
  const tx = db.begin(TENANT_A, true);
  const ctx = { tenantId: TENANT_A, actor: { id: COMMITTER }, requestId: '0190a000-0000-7000-8000-0000000000f1', tx: tx.facade, now: () => NOW };
  try { const r = await fn(ctx, events); if (opts.rollback) throw new Error('forced'); tx.commit(); return r; } catch (e) { tx.rollback(); throw e; }
}
const deps = (events: unknown[][]) => ({ events: { publish: async (...a: unknown[]) => { events.push(a); } } }) as never;

describe('kindsDb composite — catalog_master', () => {
  it('one transaction: department -> test (same tx FK) -> comment code in the department (mirror) -> value set; shared revision; rows visible after COMMIT only', { timeout: T }, async () => {
    const db = makeKindsDb('catalog_master');
    const rev = db.revision();
    await inTx(db, async (ctx, events) => {
      const masters = createMastersService(deps(events)) as any, tests = createTestsService(deps(events)) as any, comments = createCommentsService(deps(events)) as any;
      const dept = await masters['createDepartment'](ctx, { code: 'HAEM', name: 'Haematology', report_order: 10 });
      await tests['createTest'](ctx, { code: 'CBC', name: 'Complete Blood Count', department_id: dept.id, workflow_type: 'standard', report_order: 10, specimen_requirements: [] });
      await comments['createCommentCode'](ctx, { code: 'HAEM_CLOT', department_id: dept.id, text: 'Synthetic comment.' });
      await masters['createValueSet'](ctx, { code: 'POS_NEG', display: 'Positive/negative', is_ordered: false, values: [{ code: 'NEG' }, { code: 'POS' }] });
      expect(db.master('departments')).toHaveLength(0);                                 // not committed yet
      expect(events.length).toBe(4);
    });
    expect(db.master('departments').map((r) => r.code)).toEqual(['HAEM']);
    expect(db.t6('tests')).toHaveLength(1);
    expect(db.cmt('comment_codes').map((r) => r.code)).toEqual(['HAEM_CLOT']);
    expect(db.cs('cs_value_sets').map((r) => r.code)).toEqual(['POS_NEG']);
    expect(db.cs('cs_value_set_values')).toHaveLength(2);
    expect(db.revision()).toBe(rev + 4);                                                // the services bump per call; T-25 must bump ONCE
  }, T);

  it('rollback discards every sub-fake and the revision together; other tenant untouched', { timeout: T }, async () => {
    const db = makeKindsDb('catalog_master');
    const before = db.snapshot(), other = db.snapshot(TENANT_B);
    await expect(inTx(db, async (ctx, events) => {
      const masters = createMastersService(deps(events)) as any, comments = createCommentsService(deps(events)) as any;
      const dept = await masters['createDepartment'](ctx, { code: 'HAEM', name: 'Haematology', report_order: 10 });
      await comments['createCommentCode'](ctx, { code: 'X1', department_id: dept.id, text: 't' });
    }, { rollback: true })).rejects.toThrow('forced');
    expect(db.snapshot()).toEqual(before);
    expect(db.snapshot(TENANT_B)).toEqual(other);
  }, T);

  it('crashAtWrite(n) kills the n-th write of the main transaction and leaves nothing', { timeout: T }, async () => {
    const db = makeKindsDb('catalog_master');
    const before = db.snapshot();
    db.crashAtWrite(2);
    await expect(inTx(db, async (ctx, events) => {
      const masters = createMastersService(deps(events)) as any;
      await masters['createDepartment'](ctx, { code: 'HAEM', name: 'Haematology', report_order: 10 });
    })).rejects.toThrow('simulated crash');
    db.noCrash();
    expect(db.snapshot()).toEqual(before);
  }, T);

  it('eventsOf reads the recorded catalog.changed.v1 publishes', { timeout: T }, async () => {
    const db = makeKindsDb('catalog_master');
    await inTx(db, async (ctx, events) => {
      await (createMastersService(deps(events)) as any)['createDepartment'](ctx, { code: 'HAEM', name: 'Haematology', report_order: 10 });
      expect(eventsOf(events)).toHaveLength(1);
      expect(eventsOf(events)[0]!.payload).toMatchObject({ entity_type: 'department', change_kind: 'created' });
    });
  }, T);
});

describe('kindsDb composite — referrers / credit_parties', () => {
  it('referrers: createDoctor through the doctors fake, code_counters, shared revision', { timeout: T }, async () => {
    const db = makeKindsDb('referrers');
    const rev = db.revision();
    await inTx(db, async (ctx, events) => { await (createReferrersService({ ...deps(events), identity: { getActor: async () => ({ permissions: [] }), assertRole: async () => {} } } as never) as any)['createDoctor'](ctx, { display_name: 'Dr Synthetic One' }); });
    expect(db.doctorRows()).toHaveLength(1);
    expect(db.doctorRows()[0]!.doctor_code).toMatch(/^[A-Z0-9_-]{1,20}$/);
    expect(db.revision()).toBe(rev + 1);
  }, T);

  it('credit_parties: createCreditParty through the parties fake', { timeout: T }, async () => {
    const db = makeKindsDb('credit_parties');
    await inTx(db, async (ctx, events) => { await (createCreditPartiesService({ ...deps(events), identity: { getActor: async () => ({ permissions: [] }), assertRole: async () => {} } } as never) as any)['createCreditParty'](ctx, { name: 'Synthetic Hospital', kind: 'hospital' }); });
    expect(db.partyRows()).toHaveLength(1);
    expect(db.partyRows()[0]).toMatchObject({ name: 'Synthetic Hospital', kind: 'hospital', allows_credit: true });
  }, T);
});
