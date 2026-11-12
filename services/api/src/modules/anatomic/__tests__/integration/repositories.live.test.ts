// C11 T-04 live-DB integration: repositories over migrated PG17 with tenants A/B and centres A1/A2 (done_when; AC-13.2; REQ-SEC-024; 05-SCHEMA §7).
// Gated: skipped unless LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL are set (see ./setup.ts). The imports below fail now because the repos do not exist.
// ASSUMED API (spec gives no signatures; all functions take the request `tx` first and ONE input object; rows in/out are snake_case column objects):
//   cases.repo     : insertCase(tx, row) -> row | getCase(tx, {tenantId, caseId}) -> row|undefined | listCases(tx, {tenantId, limit?}) -> row[]
//                    insertCaseTransition(tx, row) -> row | listCaseTransitions(tx, {tenantId, caseId}) -> row[]
//   parts.repo     : insertPart(tx, row) -> row | listParts(tx, {tenantId, caseId}) -> row[]
//   counters.repo  : bumpAccessionCounter(tx, {tenantId, seriesKey, yearAd, actorId}) -> number   (lazy INSERT … ON CONFLICT DO NOTHING + atomic UPDATE, 02-TRD §4.2)
//   config.repo    : insertStain(tx, row) -> row | listStains(tx, {tenantId}) -> row[]
// Every repo call is explicit about tenant_id; RLS (lims_app) is the second wall. Tests below prove each wall separately.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCase, insertCase, insertCaseTransition, listCases, listCaseTransitions } from '../../repository/cases.repo.js';
import { bumpAccessionCounter } from '../../repository/counters.repo.js';
import { insertStain, listStains } from '../../repository/config.repo.js';
import { insertPart, listParts } from '../../repository/parts.repo.js';
import { crudSuite } from './crud.cases.js';
import { caseRow,CENTRE_A1, CENTRE_A2, CENTRE_B1, CLAIMS, ID, LIVE, openHarness, partRow, stainRow, SYS, TENANT_A, TENANT_B, transitionRow, YEAR, type Harness } from './setup.js';

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
const why = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return [e?.code, e?.message, e?.cause?.code, e?.cause?.message, e?.statusCode].join('|'); } return 'NO_ERROR'; };
const mine = (rows: Array<{ id: string }>) => ids(rows.filter((r) => Object.values(ID).includes(r.id)));

describe.skipIf(!LIVE)('anatomic repositories over a real DB (tenants A/B, centres A1/A2)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
    await h.cleanup(); // leftovers of a crashed run
    await h.seed('anatomic.cases', caseRow(ID.caseA1, TENANT_A, CENTRE_A1));
    await h.seed('anatomic.cases', caseRow(ID.caseA2, TENANT_A, CENTRE_A2));
    await h.seed('anatomic.cases', caseRow(ID.caseB1, TENANT_B, CENTRE_B1));
    await h.seed('anatomic.parts', partRow(ID.partA1, ID.caseA1, TENANT_A, CENTRE_A1));
    await h.seed('anatomic.parts', partRow(ID.partA2, ID.caseA2, TENANT_A, CENTRE_A2));
    await h.seed('anatomic.case_transitions', transitionRow(ID.trA1, ID.caseA1, TENANT_A, CENTRE_A1));
    await h.seed('anatomic.stains', stainRow(ID.stainA, TENANT_A, 'T04HE'));
    await h.seed('anatomic.stains', stainRow(ID.stainB, TENANT_B, 'T04HE')); // same code in the other tenant is legal
  });
  afterAll(async () => { if (h) { await h.cleanup().catch(() => undefined); await h.close(); } });

  describe('RLS centre scoping (AC-13.2: A1 user never sees A2)', () => {
    it('centre-scoped A1 user: listCases returns the A1 case only', async () => {
      const rows = await h.asApp(CLAIMS.a1Only, (tx) => listCases(tx, { tenantId: TENANT_A, limit: 200 }));
      expect(mine(rows)).toEqual([ID.caseA1]);
    });
    it('centre-scoped A1 user: getCase of an A2 case is undefined, of an A1 case is the row', async () => {
      expect(await h.asApp(CLAIMS.a1Only, (tx) => getCase(tx, { tenantId: TENANT_A, caseId: ID.caseA2 }))).toBeUndefined();
      const own = await h.asApp(CLAIMS.a1Only, (tx) => getCase(tx, { tenantId: TENANT_A, caseId: ID.caseA1 }));
      expect(own).toMatchObject({ id: ID.caseA1, tenant_id: TENANT_A, centre_id: CENTRE_A1, status: 'received' });
    });
    it('child tables follow the case centre: A1 user sees part/transition of A1 only', async () => {
      expect(ids(await h.asApp(CLAIMS.a1Only, (tx) => listParts(tx, { tenantId: TENANT_A, caseId: ID.caseA1 })))).toEqual([ID.partA1]);
      expect(await h.asApp(CLAIMS.a1Only, (tx) => listParts(tx, { tenantId: TENANT_A, caseId: ID.caseA2 }))).toEqual([]);
      expect(ids(await h.asApp(CLAIMS.a1Only, (tx) => listCaseTransitions(tx, { tenantId: TENANT_A, caseId: ID.caseA1 })))).toEqual([ID.trA1]);
    });
    it('all-centres staff and the system actor see A1 and A2', async () => {
      for (const claims of [CLAIMS.allA, CLAIMS.sysA]) {
        const rows = await h.asApp(claims, (tx) => listCases(tx, { tenantId: TENANT_A, limit: 200 }));
        expect(mine(rows)).toEqual([ID.caseA1, ID.caseA2].sort());
      }
    });
    it('centre-scoped user cannot insert a case for another centre (RLS WITH CHECK → 42501)', async () => {
      expect(await why(h.asApp(CLAIMS.a1Only, (tx) => insertCase(tx, caseRow(ID.caseA2.replace(/2$/, '9'), TENANT_A, CENTRE_A2))))).toMatch(/42501|forbidden|row-level security/i);
    });
  });

  describe('tenant isolation, two independent walls (REQ-SEC-024)', () => {
    it('wall 1 — the repo filter alone: on a superuser tx (RLS bypassed) listCases/getCase/listStains for tenant A never return tenant B rows', async () => {
      const cases = await h.asSuperuser((tx) => listCases(tx as never, { tenantId: TENANT_A, limit: 500 }));
      expect(cases.every((r: any) => r.tenant_id === TENANT_A)).toBe(true);
      expect(mine(cases)).toEqual([ID.caseA1, ID.caseA2].sort());
      expect(await h.asSuperuser((tx) => getCase(tx as never, { tenantId: TENANT_A, caseId: ID.caseB1 }))).toBeUndefined();
      expect(await h.asSuperuser((tx) => listParts(tx as never, { tenantId: TENANT_B, caseId: ID.caseA1 }))).toEqual([]);
      const stains = await h.asSuperuser((tx) => listStains(tx as never, { tenantId: TENANT_A }));
      expect(ids(stains.filter((s: any) => s.code === 'T04HE'))).toEqual([ID.stainA]);
    });
    it('wall 2 — RLS alone: with claims of tenant A, asking for tenant B (or for a B id) returns nothing', async () => {
      expect(await h.asApp(CLAIMS.allA, (tx) => listCases(tx, { tenantId: TENANT_B, limit: 200 }))).toEqual([]);
      expect(await h.asApp(CLAIMS.allA, (tx) => getCase(tx, { tenantId: TENANT_B, caseId: ID.caseB1 }))).toBeUndefined();
      expect(await h.asApp(CLAIMS.allA, (tx) => getCase(tx, { tenantId: TENANT_A, caseId: ID.caseB1 }))).toBeUndefined();
    });
    it('tenant B system actor sees its own case and none of A', async () => {
      const rows = await h.asApp(CLAIMS.sysB, (tx) => listCases(tx, { tenantId: TENANT_B, limit: 200 }));
      expect(mine(rows)).toEqual([ID.caseB1]);
    });
    it('inserting a row with another tenant_id than the claims is refused (RLS WITH CHECK → 42501)', async () => {
      expect(await why(h.asApp(CLAIMS.sysA, (tx) => insertStain(tx, stainRow(ID.stainB.replace(/2$/, '8'), TENANT_B, 'T04X'))))).toMatch(/42501|forbidden|row-level security/i);
    });
  });

  describe('CRUD', () => {
    it('config.repo: stains are per tenant — same code in A and B each list once, duplicate in one tenant → 23505', async () => {
      const a = await h.asApp(CLAIMS.sysA, (tx) => listStains(tx, { tenantId: TENANT_A }));
      const b = await h.asApp(CLAIMS.sysB, (tx) => listStains(tx, { tenantId: TENANT_B }));
      expect(ids(a.filter((s: any) => s.code === 'T04HE'))).toEqual([ID.stainA]);
      expect(ids(b.filter((s: any) => s.code === 'T04HE'))).toEqual([ID.stainB]);
      expect(await why(h.asApp(CLAIMS.sysA, (tx) => insertStain(tx, stainRow(ID.stainA.replace(/1$/, '7'), TENANT_A, 'T04HE'))))).toMatch(/23505|conflict|duplicate/i);
    });
    it('cases.repo + parts.repo: insert returns the stored row, read-back matches, letter is unique per case', async () => {
      const newCase = ID.caseA1.replace(/1$/, '8'); // uid(108)
      const stored = await h.asApp(CLAIMS.sysA, async (tx) => {
        const c = await insertCase(tx, caseRow(newCase, TENANT_A, CENTRE_A1, { priority: 'urgent' }));
        await insertPart(tx, partRow(ID.partA1.replace(/1$/, '8'), newCase, TENANT_A, CENTRE_A1, 'A'));
        return c;
      });
      expect(stored).toMatchObject({ id: newCase, tenant_id: TENANT_A, centre_id: CENTRE_A1, priority: 'urgent', status: 'received', version: 1 });
      expect(await h.asApp(CLAIMS.sysA, (tx) => getCase(tx, { tenantId: TENANT_A, caseId: newCase }))).toMatchObject({ id: newCase, priority: 'urgent' });
      expect(await why(h.asApp(CLAIMS.sysA, (tx) => insertPart(tx, partRow(ID.partA1.replace(/1$/, '6'), ID.caseA1, TENANT_A, CENTRE_A1, 'A'))))).toMatch(/23505|conflict|duplicate/i);
      await h.cleanup(); // removes uid(108) rows too (same id prefix); re-seed the shared fixtures for the remaining tests
      await h.seed('anatomic.cases', caseRow(ID.caseA1, TENANT_A, CENTRE_A1));
      await h.seed('anatomic.cases', caseRow(ID.caseA2, TENANT_A, CENTRE_A2));
      await h.seed('anatomic.cases', caseRow(ID.caseB1, TENANT_B, CENTRE_B1));
      await h.seed('anatomic.parts', partRow(ID.partA1, ID.caseA1, TENANT_A, CENTRE_A1));
      await h.seed('anatomic.parts', partRow(ID.partA2, ID.caseA2, TENANT_A, CENTRE_A2));
      await h.seed('anatomic.case_transitions', transitionRow(ID.trA1, ID.caseA1, TENANT_A, CENTRE_A1));
      await h.seed('anatomic.stains', stainRow(ID.stainA, TENANT_A, 'T04HE'));
      await h.seed('anatomic.stains', stainRow(ID.stainB, TENANT_B, 'T04HE'));
    });
    it('cases.repo: insertCaseTransition appends a row visible to listCaseTransitions', async () => {
      const row = transitionRow(ID.trA1.replace(/1$/, '2'), ID.caseA1, TENANT_A, CENTRE_A1);
      await h.asApp(CLAIMS.sysA, (tx) => insertCaseTransition(tx, { ...row, from_status: 'received', to_status: 'accessioned' }));
      const list = await h.asApp(CLAIMS.sysA, (tx) => listCaseTransitions(tx, { tenantId: TENANT_A, caseId: ID.caseA1 }));
      expect(list.map((r: any) => r.to_status).sort()).toEqual(['accessioned', 'received']);
    });
  });

  describe('counters.repo (02-TRD §4.2; AC-02.2 at repository level)', () => {
    it('first bump creates the row and returns 1, next returns 2; tenants and series are independent', async () => {
      const bump = (claims: Record<string, unknown>, tenantId: string, seriesKey: string) =>
        h.asApp(claims, (tx) => bumpAccessionCounter(tx, { tenantId, seriesKey, yearAd: YEAR, actorId: SYS }));
      expect(await bump(CLAIMS.sysA, TENANT_A, 'histology')).toBe(1);
      expect(await bump(CLAIMS.sysA, TENANT_A, 'histology')).toBe(2);
      expect(await bump(CLAIMS.sysA, TENANT_A, 'cytology')).toBe(1);
      expect(await bump(CLAIMS.sysB, TENANT_B, 'histology')).toBe(1);
    });
    it('20 parallel transactions get 20 distinct consecutive numbers (row lock serialises, no gaps)', async () => {
      const out = await Promise.all(Array.from({ length: 20 }, () => h.asApp(CLAIMS.sysA, (tx) => bumpAccessionCounter(tx, { tenantId: TENANT_A, seriesKey: 'ihc', yearAd: YEAR, actorId: SYS }))));
      expect([...out].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });
    it('a rolled-back transaction does not consume a number', async () => {
      await expect(h.asApp(CLAIMS.sysA, async (tx) => { await bumpAccessionCounter(tx, { tenantId: TENANT_A, seriesKey: 'molecular', yearAd: YEAR, actorId: SYS }); throw new Error('boom'); })).rejects.toThrow('boom');
      expect(await h.asApp(CLAIMS.sysA, (tx) => bumpAccessionCounter(tx, { tenantId: TENANT_A, seriesKey: 'molecular', yearAd: YEAR, actorId: SYS }))).toBe(1);
    });
  });

  describe('one live CRUD case per repository (plan row T-04 "integration per repo"; optimistic version lock; other-tenant isolation)', () => {
    crudSuite(() => h);
  });

  describe('grants the repositories rely on (05-SCHEMA §7): no DELETE, class-A tables insert-only', () => {
    it('lims_app cannot DELETE a case or UPDATE a case transition (42501)', async () => {
      expect(await h.rawApp(CLAIMS.sysA, 'DELETE FROM anatomic.cases WHERE tenant_id = $1 AND id = $2', [TENANT_A, ID.caseA1])).toMatch(/^E42501/);
      expect(await h.rawApp(CLAIMS.sysA, `UPDATE anatomic.case_transitions SET reason_code = 'x' WHERE tenant_id = $1 AND id = $2`, [TENANT_A, ID.trA1])).toMatch(/^E42501/);
    });
  });
});
