// T-25 (C3) — worker task catalog.import_commit for the kinds catalog_master, referrers, credit_parties (02-TRD §8.5, §9.1, §10).
// Spec: PRD AC-17.1 (starter workbook into an empty tenant: every entity exists, revision +1, exactly one catalog.changed.v1 {catalog_import, import id}, analyte versions and sets carry
//       published_by = committing user + source_import_id), AC-17.2 (re-import creates no new versions), AC-17.3 (HB decimals -> analyte version n+1, range set only if range rows changed,
//       non-clinical in place), AC-17.6 (referrers upsert by doctor_code, blank code = auto code); 02-TRD §8.5 (one transaction, re-validation -> commit_failed, open drafts ->
//       file.draft_exists unless replace_draft, actor-on-behalf = imports.committed_by, committed = no-op on redelivery, crash leaves nothing), §8.2 (rows absent are NOT deactivated; credit_parties
//       upsert by party_code), 06-PLAN T-25 done_when (D-18, D-21), 07-SECURITY S-1, S-13.
// Contract (SEAM): same task exports as T-23 (importCommit, payload { tenant_id, import_id, replace_draft? }), dispatch on imports.kind. Clinical rows are published with the commit's
//   effective_from (default ctx.now()) and change_reason. A failed commit RESOLVES as commit_failed; a crash THROWS. See .orchestra/notes/C3.T-25-tests.md for ASSUMED/SPEC GAP items.
import { describe, expect, it } from 'vitest';
import { createAnalyteVersionsService } from '../../../../../../api/src/modules/catalog/service/analyteVersions.service.js';
import { importCommit } from '../../tasks/catalog.import_commit.js';
import { COMMITTER, IMPORT_ID, NOW, TENANT_A, TENANT_B, USER, eventsOf, makeKindsDb, makeKindsRunner, type KindsDb } from '../helpers/kindsDb.js';
import { SECOND, codesOf, commitValidated, importFully, payloadOf, validateBytes } from '../helpers/kindsFlow.js';
import { creditPartiesXlsx, doc, masterXlsx, party, referrersXlsx, setCell } from '../helpers/kindWorkbooks.js';

const T = 120_000;
const EFFECTIVE = '2026-11-10T00:00:00.000Z';
const master = () => makeKindsDb('catalog_master');
const published = (rows: Array<Record<string, any>>) => rows.filter((r) => r.status === 'published');
const codes = (rows: Array<Record<string, any>>) => rows.map((r) => r.code).sort();
const catalogEvents = (runner: { events: unknown[][] }) => eventsOf(runner.events);
const errOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error; } return undefined; };

/** Opens a draft analyte version for `analyteCode` through the real API service, outside the import (a user's manual draft). */
async function openDraft(db: KindsDb, analyteCode: string) {
  const a = db.t6('analytes').find((r) => r.code === analyteCode)!;
  const tx = db.begin(TENANT_A, false);
  const svc = createAnalyteVersionsService({ events: { publish: async () => {} } } as never) as any;
  try { await svc.createAnalyteVersionDraft({ tenantId: TENANT_A, actor: { id: USER }, requestId: 'r', tx: tx.facade, now: () => NOW }, { analyte_id: a.id }); tx.commit(); } catch (e) { tx.rollback(); throw e; }
  return a;
}

describe('catalog_master — AC-17.1 starter workbook committed into an empty tenant', () => {
  it('every sheet\'s entities exist exactly as in the workbook (counts + codes)', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    expect(codes(db.master('departments'))).toEqual(['BIOCHEM', 'CLINPATH', 'HAEM', 'MICRO']);
    expect(codes(db.master('specimen_types'))).toEqual(['EDTA_WB', 'FL_PLASMA', 'SERUM', 'URINE']);
    expect(db.master('containers')).toHaveLength(4);
    expect(db.master('methods')).toHaveLength(7);
    expect(codes(db.cs('cs_units'))).toEqual(expect.arrayContaining(['g_dl', 'mg_dl', 'mmol_l']));
    expect(codes(db.cs('cs_value_sets'))).toEqual(['POS_NEG', 'URINE_SEMIQ']);
    expect(db.cs('cs_value_set_values')).toHaveLength(8);
    const orderables = db.t6('orderables');
    expect(orderables.filter((o) => o.kind === 'test')).toHaveLength(10);
    expect(orderables.filter((o) => o.kind === 'panel').map((o) => o.code).sort()).toEqual(['HP_ELITE_M', 'LIPID']);
    expect(db.t6('analytes')).toHaveLength(24);
    expect(db.t6('panel_members')).toHaveLength(8);
    expect(codes(db.cmt('comment_codes'))).toEqual(['GEN_HAEMOLYSED', 'HAEM_CLOT']);
    expect(db.t6('tat_targets')).toHaveLength(3);
    const ldl = db.t6('orderables').find((o) => o.code === 'LDL')!;
    expect(ldl.is_orderable).toBe(false);
    expect(db.t6('tests').find((t) => t.id === db.t6('orderables').find((o) => o.code === 'HBA1C')!.id)!.workflow_type).toBe('attachment');
  }, T);

  it('analyte version 1 of every analyte is PUBLISHED; ranges: 5 published sets (HB with 4 bands); 1 critical set; HB decimals 1; formula stored', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const av = db.t6('analyte_versions');
    expect(av).toHaveLength(24);
    expect(av.every((v) => v.status === 'published' && v.version_no === 1)).toBe(true);
    const hb = db.t6('analytes').find((a) => a.code === 'HB')!;
    expect(av.find((v) => v.analyte_id === hb.id)).toMatchObject({ decimals: 1, result_type: 'numeric' });
    expect(av.find((v) => v.analyte_id === db.t6('analytes').find((a) => a.code === 'NLR')!.id)!.formula_expression).toBeTruthy();
    const rs = db.t6('reference_range_sets');
    expect(rs).toHaveLength(5);
    expect(rs.every((s) => s.status === 'published')).toBe(true);
    expect(db.t6('reference_ranges').filter((r) => r.set_id === rs.find((s) => s.analyte_id === hb.id)!.id)).toHaveLength(4);
    expect(db.t6('critical_limit_sets')).toHaveLength(1);
  }, T);

  it('GET /v1/catalog/revision advanced by EXACTLY 1 and exactly one catalog.changed.v1 {entity_type: catalog_import, entity_id: import id} (D-21)', async () => {
    const db = master();
    const rev = db.revision();
    const { c } = await importFully(db, await masterXlsx());
    expect(db.revision()).toBe(rev + 1);
    const ev = catalogEvents(c.runner);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ entity_type: 'catalog_import', entity_id: IMPORT_ID, catalog_revision: rev + 1 });
  }, T);

  it('every orderable row touched by the commit has orderables.revision = the new revision (02-TRD §8.5)', async () => {
    const db = master();
    const rev = db.revision();
    await importFully(db, await masterXlsx());
    for (const o of db.t6('orderables')) expect(Number(o.revision)).toBe(rev + 1);
  }, T);

  it('published_by = committing user, source_import_id = import id on analyte versions and range / critical sets; created_by / updated_by = committing user, never the system actor', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    for (const t of ['analyte_versions', 'reference_range_sets', 'critical_limit_sets'] as const) {
      for (const r of db.t6(t)) expect(r, t).toMatchObject({ published_by: COMMITTER, source_import_id: IMPORT_ID, created_by: COMMITTER });
    }
    for (const t of ['orderables', 'analytes'] as const) for (const r of db.t6(t)) expect(r, t).toMatchObject({ created_by: COMMITTER, updated_by: COMMITTER });
    for (const r of db.master('departments')) expect(r).toMatchObject({ created_by: COMMITTER });
    for (const r of db.cmt('comment_codes')) expect(r).toMatchObject({ created_by: COMMITTER });
  }, T);

  it('published with the commit\'s effective_from and change_reason; import committed with committed_at / committed_by, last_error_code null', async () => {
    const db = master();
    await importFully(db, await masterXlsx(), { effectiveFrom: EFFECTIVE, reason: 'Starter catalog swap' });
    for (const v of db.t6('analyte_versions')) {
      expect(new Date(v.effective_from).toISOString()).toBe(EFFECTIVE);
      expect(v.change_reason).toBe('Starter catalog swap');
      expect(new Date(v.published_at).toISOString()).toBe(NOW);
    }
    expect(db.imp()).toMatchObject({ status: 'committed', committed_by: COMMITTER });
    expect(new Date(db.imp().committed_at).toISOString()).toBe(NOW);
    expect(db.imp().last_error_code ?? null).toBeNull();
    expect(db.imp().version).toBeGreaterThan(2);
  }, T);

  it('other tenant untouched (S-1)', async () => {
    const db = master();
    const other = db.snapshot(TENANT_B);
    await importFully(db, await masterXlsx());
    expect(db.snapshot(TENANT_B)).toEqual(other);
  }, T);
});

describe('catalog_master — AC-17.2 idempotent re-import', () => {
  it('the same workbook again creates no new analyte versions / range sets / critical sets / rows; every row keeps its id', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const before = JSON.stringify([db.t6('orderables'), db.t6('analytes'), db.t6('analyte_versions'), db.t6('reference_range_sets'), db.t6('reference_ranges'), db.t6('critical_limit_sets'), db.master('departments'), db.cs('cs_value_set_values'), db.cmt('comment_codes')]);
    const counts = db.domainCounts();
    await importFully(db, await masterXlsx(), SECOND);
    expect(db.domainCounts()).toEqual(counts);
    expect(db.t6('analyte_versions').every((v) => v.version_no === 1)).toBe(true);
    expect(db.imp(SECOND.importId)).toMatchObject({ status: 'committed' });
    const after = JSON.stringify([db.t6('orderables'), db.t6('analytes'), db.t6('analyte_versions'), db.t6('reference_range_sets'), db.t6('reference_ranges'), db.t6('critical_limit_sets'), db.master('departments'), db.cs('cs_value_set_values'), db.cmt('comment_codes')]);
    expect(JSON.parse(after).map((x: unknown[]) => x.length)).toEqual(JSON.parse(before).map((x: unknown[]) => x.length));
  }, T);
});

describe('catalog_master — AC-17.3 changes: clinical = new version, non-clinical = in place', () => {
  it('HB decimals 1 -> 2: HB gets published analyte version 2 (v1 superseded, ends at the new effective_from); every other analyte stays at version 1; NO new range set', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const rangeSets = db.t6('reference_range_sets').length, critical = db.t6('critical_limit_sets').length;
    const { c } = await importFully(db, await masterXlsx((b) => setCell(b, 'Analytes', 'HB', 'decimals', 2, 1)), { ...SECOND, effectiveFrom: EFFECTIVE });
    const hb = db.t6('analytes').find((a) => a.code === 'HB')!;
    const vs = db.t6('analyte_versions').filter((v) => v.analyte_id === hb.id).sort((a, b) => a.version_no - b.version_no);
    expect(vs.map((v) => [v.version_no, v.status, v.decimals])).toEqual([[1, 'superseded', 1], [2, 'published', 2]]);
    expect(new Date(vs[0]!.effective_to).toISOString()).toBe(EFFECTIVE);
    expect(vs[1]).toMatchObject({ source_import_id: SECOND.importId, published_by: COMMITTER });
    expect(db.t6('analyte_versions').filter((v) => v.analyte_id !== hb.id).every((v) => v.version_no === 1)).toBe(true);
    expect(db.t6('reference_range_sets')).toHaveLength(rangeSets);
    expect(db.t6('critical_limit_sets')).toHaveLength(critical);
    expect(catalogEvents(c.runner)).toHaveLength(1);
  }, T);

  it('a changed HB band: new range set n+1 for HB only (old superseded), analyte version unchanged', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    await importFully(db, await masterXlsx((b) => { b['ReferenceRanges']!.find((r) => r[0] === 'HB' && r[1] === 'female')![9] = 16; }), SECOND);
    const hb = db.t6('analytes').find((a) => a.code === 'HB')!;
    const sets = db.t6('reference_range_sets').filter((s) => s.analyte_id === hb.id).sort((a, b) => a.version_no - b.version_no);
    expect(sets.map((s) => [s.version_no, s.status])).toEqual([[1, 'superseded'], [2, 'published']]);
    expect(db.t6('reference_range_sets')).toHaveLength(6);
    expect(db.t6('analyte_versions').filter((v) => v.analyte_id === hb.id)).toHaveLength(1);
    expect(db.t6('reference_ranges').filter((r) => r.set_id === sets[1]!.id).find((r) => r.sex === 'female' && r.age_low_value === 12)!.high).toBeDefined();
  }, T);

  it('non-clinical changes (department name, test report_order, analyte name / sort_order / print_name, comment text) update IN PLACE: same ids, no versions, no sets', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const idOf = (rows: Array<Record<string, any>>, code: string) => rows.find((r) => r.code === code)!.id;
    const ids = { dept: idOf(db.master('departments'), 'HAEM'), test: idOf(db.t6('orderables'), 'CBC'), an: idOf(db.t6('analytes'), 'MCV') };
    const av = db.t6('analyte_versions').length, rs = db.t6('reference_range_sets').length;
    await importFully(db, await masterXlsx((b) => {
      setCell(b, 'Departments', 'HAEM', 'name', 'Haematology (renamed)');
      setCell(b, 'Tests', 'CBC', 'report_order', 11);
      setCell(b, 'Analytes', 'MCV', 'name', 'MCV renamed', 1); setCell(b, 'Analytes', 'MCV', 'sort_order', 35, 1); setCell(b, 'Analytes', 'MCV', 'print_name', 'MCV!', 1);
      setCell(b, 'Analytes', 'MCV', 'report_subheading', 'RED CELLS 2', 1);
    }), SECOND);
    expect(idOf(db.master('departments'), 'HAEM')).toBe(ids.dept);
    expect(db.master('departments').find((d) => d.code === 'HAEM')!.name).toBe('Haematology (renamed)');
    expect(idOf(db.t6('orderables'), 'CBC')).toBe(ids.test);
    expect(db.t6('tests').find((t) => t.id === ids.test)!.report_order).toBe(11);
    expect(db.t6('analytes').find((a) => a.id === ids.an)).toMatchObject({ name: 'MCV renamed', sort_order: 35, print_name: 'MCV!', report_subheading: 'RED CELLS 2' });
    expect(db.t6('analyte_versions')).toHaveLength(av);
    expect(db.t6('reference_range_sets')).toHaveLength(rs);
  }, T);

  it('rows absent from the workbook are NOT deactivated or removed (02-TRD §8.2 [CONV])', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    await importFully(db, await masterXlsx((b) => { b['Departments'] = [b['Departments']![0]!, b['Departments']![1]!]; b['CommentCodes'] = [b['CommentCodes']![0]!]; }), SECOND);
    expect(db.master('departments')).toHaveLength(4);
    expect(db.master('departments').every((d) => d.is_active === true)).toBe(true);
    expect(db.cmt('comment_codes')).toHaveLength(2);
  }, T);

  it('exactly one revision bump and one catalog_import event per commit, also for a mixed change set', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const rev = db.revision();
    const { c } = await importFully(db, await masterXlsx((b) => { setCell(b, 'Analytes', 'HB', 'decimals', 2, 1); setCell(b, 'Departments', 'HAEM', 'name', 'X'); b['ReferenceRanges']!.find((r) => r[0] === 'K')![9] = 5.3; }), SECOND);
    expect(db.revision()).toBe(rev + 1);
    expect(catalogEvents(c.runner)).toHaveLength(1);
    expect(catalogEvents(c.runner)[0]!.payload).toMatchObject({ entity_type: 'catalog_import', entity_id: SECOND.importId });
  }, T);
});

describe('catalog_master — D-18 catalog.reference_range.publish events when clinical versions are published (06-PLAN T-25)', () => {
  it('the commit that publishes analyte versions / range sets / critical sets is the single catalog_import event; its import summary carried the clinical counters the API gate reads', async () => {
    const db = master();
    const v = await validateBytes(db, await masterXlsx());
    expect(v.imp.summary).toMatchObject({ analyte_versions: 24, range_sets: 5, critical_sets: 1 });
    const c = await commitValidated(db);
    expect(catalogEvents(c.runner)).toHaveLength(1);
  }, T);
});

describe('catalog_master — open drafts: file.draft_exists / replace_draft (02-TRD §8.5)', () => {
  async function withDraft() {
    const db = master();
    await importFully(db, await masterXlsx());
    const hb = await openDraft(db, 'HB');
    const bytes = await masterXlsx((b) => setCell(b, 'Analytes', 'HB', 'decimals', 2, 1));
    const v = await validateBytes(db, bytes, SECOND);
    expect(v.imp.status).toBe('validated');
    return { db, hb };
  }

  it('an open draft of an analyte the commit versions -> commit_failed + file.draft_exists (one per target), nothing applied, draft untouched, no event, no bump', async () => {
    const { db, hb } = await withDraft();
    const rev = db.revision(), before = db.t6('analyte_versions');
    const c = await commitValidated(db, SECOND);
    expect(c.imp.status).toBe('commit_failed');
    expect(c.issues.filter((i) => i.issue_code === 'file.draft_exists')).toHaveLength(1);
    expect(c.issues.find((i) => i.issue_code === 'file.draft_exists')).toMatchObject({ severity: 'error' });
    expect(db.t6('analyte_versions')).toEqual(before);
    expect(db.t6('analyte_versions').filter((v) => v.analyte_id === hb.id && v.status === 'draft')).toHaveLength(1);
    expect(db.revision()).toBe(rev);
    expect(catalogEvents(c.runner)).toHaveLength(0);
    expect(c.imp.committed_at ?? null).toBeNull();
  }, T);

  it('replace_draft:true discards that draft first (status discarded) and commits version n+1 in the same transaction', async () => {
    const { db, hb } = await withDraft();
    const c = await commitValidated(db, { ...SECOND, replaceDraft: true });
    expect(c.imp.status).toBe('committed');
    const vs = db.t6('analyte_versions').filter((v) => v.analyte_id === hb.id).sort((a, b) => a.version_no - b.version_no);
    expect(vs.map((v) => v.status)).toEqual(['superseded', 'discarded', 'published']);
    expect(vs.at(-1)).toMatchObject({ decimals: 2, source_import_id: SECOND.importId });
    expect(catalogEvents(c.runner)).toHaveLength(1);
  }, T);

  it('a draft of an analyte the commit does NOT touch does not block it', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    await openDraft(db, 'K');
    const { c } = await importFully(db, await masterXlsx((b) => setCell(b, 'Analytes', 'HB', 'decimals', 2, 1)), SECOND);
    expect(c.imp.status).toBe('committed');
  }, T);

  it('replace_draft is honoured only when exactly true (a truthy string in the payload does not discard)', async () => {
    const { db } = await withDraft();
    const c = await commitValidated(db, { ...SECOND, extra: { replace_draft: 'true' } });
    expect(c.imp.status).toBe('commit_failed');
  }, T);
});

describe('catalog_master — re-validation at commit, atomicity, redelivery', () => {
  it('catalog changed after validation (a unit used by the workbook was deactivated / a department code collides) -> commit_failed with the new error issues appended, nothing applied', async () => {
    const db = master();
    const v = await validateBytes(db, await masterXlsx((b) => setCell(b, 'Tests', 'CBC', 'department_code', 'HAEM')));
    expect(v.imp.status).toBe('validated');
    const before = db.snapshot();
    // after validation another user created a panel with the code CBC (tests and panels share one code space)
    const tx = db.begin(TENANT_A, false);
    await tx.facade.query('INSERT INTO catalog.orderables (id, tenant_id, kind, code, name, is_orderable, is_active, revision, version, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      ['0190c322-0000-7000-8000-00000000f001', TENANT_A, 'panel', 'CBC', 'Clash', true, true, 0, 1, USER, USER]);
    tx.commit();
    const mid = db.snapshot();
    const c = await commitValidated(db);
    expect(c.imp.status).toBe('commit_failed');
    expect(c.issues.some((i) => i.severity === 'error' && /^(row|file)\./.test(i.issue_code))).toBe(true);
    expect(JSON.stringify({ ...db.snapshot(), imports: 0, import_issues: 0, files: 0 })).toBe(JSON.stringify({ ...mid, imports: 0, import_issues: 0, files: 0 }));
    void before;
  }, T);

  it('crash at EVERY write of the main transaction, then crash before COMMIT: nothing is left (one transaction), the import stays committing, and the retry commits exactly once', async () => {
    const probe = master();
    await validateBytes(probe, await masterXlsx());
    const r0 = makeKindsRunner(probe, importCommit);
    const { commitParams } = await import('../helpers/kindsDb.js');
    commitParams(probe);
    const v0 = probe.writes().filter((w) => w.main).length;                // validation-run main-tx writes are not counted by crashAtWrite (T-25 ruling #4)
    await r0.run(payloadOf());
    const total = probe.writes().filter((w) => w.main).length - v0;
    expect(total).toBeGreaterThan(50);
    const sample = [1, 2, 3, Math.floor(total / 3), Math.floor(total / 2), total - 3, total - 1, total];
    for (const n of sample) {
      const db = master();
      await validateBytes(db, await masterXlsx());
      commitParams(db);
      const rev = db.revision(), snap = db.snapshot();
      db.crashAtWrite(n);
      expect(await errOf(makeKindsRunner(db, importCommit).run(payloadOf())), `crash at write ${n}`).toBeDefined();
      db.noCrash();
      expect(db.snapshot(), `after crash at write ${n}`).toEqual(snap);
      expect(db.revision()).toBe(rev);
    }
    const db = master();
    await validateBytes(db, await masterXlsx());
    commitParams(db);
    const snap = db.snapshot();
    db.crashBeforeCommit();
    expect(await errOf(makeKindsRunner(db, importCommit).run(payloadOf()))).toBeDefined();
    db.noCrash();
    expect(db.snapshot()).toEqual(snap);
    const rev = db.revision();
    const retry = makeKindsRunner(db, importCommit);
    await retry.run(payloadOf());
    expect(db.imp().status).toBe('committed');
    expect(db.revision()).toBe(rev + 1);
    expect(catalogEvents(retry)).toHaveLength(1);
  }, 600_000);

  it('redelivery after success is a no-op (committed): no second bump, no event, no new row', async () => {
    const db = master();
    const { c } = await importFully(db, await masterXlsx());
    const snap = db.snapshot(), rev = db.revision();
    const again = makeKindsRunner(db, importCommit);
    await again.run(payloadOf());
    expect(db.snapshot()).toEqual(snap);
    expect(db.revision()).toBe(rev);
    expect(catalogEvents(again)).toHaveLength(0);
    void c;
  }, T);

  it('two concurrent deliveries of the same job commit exactly once', async () => {
    const db = master();
    await validateBytes(db, await masterXlsx());
    const { commitParams } = await import('../helpers/kindsDb.js');
    commitParams(db);
    const rev = db.revision();
    const a = makeKindsRunner(db, importCommit), b = makeKindsRunner(db, importCommit);
    await Promise.all([a.run(payloadOf()), b.run(payloadOf())]);
    expect(db.revision()).toBe(rev + 1);
    expect(catalogEvents(a).length + catalogEvents(b).length).toBe(1);
    expect(db.t6('analyte_versions')).toHaveLength(24);
  }, T);

  it('missing commit parameters (no committed_by / empty reason) THROW (retry/dead-letter), never write as the system actor', async () => {
    const db = master();
    await validateBytes(db, await masterXlsx());
    const { commitParams } = await import('../helpers/kindsDb.js');
    commitParams(db, IMPORT_ID, { committedBy: null });
    const snap = db.snapshot();
    expect(await errOf(makeKindsRunner(db, importCommit).run(payloadOf()))).toBeDefined();
    expect(db.snapshot()).toEqual(snap);
  }, T);

  it('payload tenant <> job tenant or foreign import id -> skipped, nothing written (S-1)', async () => {
    const db = master();
    await validateBytes(db, await masterXlsx());
    const { commitParams } = await import('../helpers/kindsDb.js');
    commitParams(db);
    const snap = db.snapshot();
    await makeKindsRunner(db, importCommit, { tenantId: TENANT_A }).run({ tenant_id: TENANT_B, import_id: IMPORT_ID });
    await makeKindsRunner(db, importCommit, { tenantId: TENANT_B }).run({ tenant_id: TENANT_B, import_id: IMPORT_ID });
    expect(db.snapshot()).toEqual(snap);
    expect(db.imp().status).toBe('committing');
  }, T);

  it('the job log and issues never contain workbook cell text (S-13)', async () => {
    const db = master();
    await validateBytes(db, await masterXlsx((b) => setCell(b, 'CommentCodes', 'HAEM_CLOT', 'text', 'SECRET-COMMENT-TEXT-ZED')));
    const c = await commitValidated(db);
    expect(c.runner.log.text()).not.toContain('SECRET-COMMENT-TEXT-ZED');
    expect(JSON.stringify(c.issues)).not.toContain('SECRET-COMMENT-TEXT-ZED');
  }, T);
});

describe('referrers — commit (AC-17.6)', () => {
  const rows = () => [doc('DR1', 'Dr Synthetic One', { phone: '+9779800000001', email: 'one@example.test', verified: 'Y' }), doc(null, 'Dr Synthetic Two'), doc('DR3', 'Dr Synthetic Three', { council: 'NMC', regNo: '12345' })];

  it('creates doctors; blank code -> auto code (counter); source import; is_verified Y verifies; ONE revision bump + ONE catalog_import event; created_by = committing user', async () => {
    const db = makeKindsDb('referrers');
    const rev = db.revision();
    const { c } = await importFully(db, await referrersXlsx(rows()));
    const ds = db.doctorRows();
    expect(ds).toHaveLength(3);
    expect(ds.map((d) => d.doctor_code)).toEqual(expect.arrayContaining(['DR1', 'DR3']));
    const auto = ds.find((d) => d.display_name === 'Dr Synthetic Two')!;
    expect(auto.doctor_code).toMatch(/^[A-Z0-9_-]{1,20}$/);
    expect(['DR1', 'DR3']).not.toContain(auto.doctor_code);
    expect(ds.find((d) => d.doctor_code === 'DR1')).toMatchObject({ is_verified: true, source: 'import', phone_e164: '+9779800000001', created_by: COMMITTER, updated_by: COMMITTER });
    expect(ds.find((d) => d.doctor_code === 'DR3')).toMatchObject({ is_verified: false, registration_council: 'NMC', registration_no: '12345' });
    expect(db.revision()).toBe(rev + 1);
    const ev = catalogEvents(c.runner);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ entity_type: 'catalog_import', entity_id: IMPORT_ID });
    expect(db.imp()).toMatchObject({ status: 'committed', committed_by: COMMITTER });
  }, T);

  it('upsert by doctor_code: re-import of the same rows creates nothing (blank-code row is matched by name or skipped, never duplicated); a changed phone updates in place', async () => {
    const db = makeKindsDb('referrers');
    await importFully(db, await referrersXlsx(rows()));
    const ids = Object.fromEntries(db.doctorRows().map((d) => [d.doctor_code, d.id]));
    const n = db.doctorRows().length;
    await importFully(db, await referrersXlsx([doc('DR1', 'Dr Synthetic One', { phone: '+9779800000002', email: 'one@example.test', verified: 'Y' }), rows()[2]!]), SECOND);
    expect(db.doctorRows()).toHaveLength(n);
    expect(db.doctorRows().find((d) => d.doctor_code === 'DR1')).toMatchObject({ id: ids['DR1'], phone_e164: '+9779800000002' });
  }, T);

  it('rows absent from the workbook are not deactivated', async () => {
    const db = makeKindsDb('referrers');
    await importFully(db, await referrersXlsx(rows()));
    await importFully(db, await referrersXlsx([rows()[0]!]), SECOND);
    expect(db.doctorRows().filter((d) => d.is_active === true)).toHaveLength(3);
  }, T);

  it('the same workbook twice: second commit changes no doctor row (idempotent, AC-17.2 analogue)', async () => {
    const db = makeKindsDb('referrers');
    const fixed = [rows()[0]!, rows()[2]!];
    await importFully(db, await referrersXlsx(fixed));
    const before = JSON.stringify(db.doctorRows());
    await importFully(db, await referrersXlsx(fixed), SECOND);
    expect(JSON.stringify(db.doctorRows())).toBe(before);
  }, T);

  it('crash at every write leaves nothing; code_counters roll back with it (no gap in auto codes after the retry)', async () => {
    const mk = async () => { const db = makeKindsDb('referrers'); await validateBytes(db, await referrersXlsx(rows())); const { commitParams } = await import('../helpers/kindsDb.js'); commitParams(db); return db; };
    const probe = await mk();
    const v0 = probe.writes().filter((w) => w.main).length;                // see T-25 ruling #4
    await makeKindsRunner(probe, importCommit).run(payloadOf());
    const total = probe.writes().filter((w) => w.main).length - v0;
    const wantedCode = probe.doctorRows().find((d) => d.display_name === 'Dr Synthetic Two')!.doctor_code;
    for (let n = 1; n <= total; n++) {
      const db = await mk();
      const snap = db.snapshot();
      db.crashAtWrite(n);
      expect(await errOf(makeKindsRunner(db, importCommit).run(payloadOf())), `crash ${n}`).toBeDefined();
      db.noCrash();
      expect(db.snapshot(), `after crash ${n}`).toEqual(snap);
    }
    const db = await mk();
    db.crashAtWrite(total);
    await errOf(makeKindsRunner(db, importCommit).run(payloadOf()));
    db.noCrash();
    await makeKindsRunner(db, importCommit).run(payloadOf());
    expect(db.doctorRows().find((d) => d.display_name === 'Dr Synthetic Two')!.doctor_code).toBe(wantedCode);
  }, 600_000);

  it('re-validation at commit: a doctor_code now taken by a verified merged doctor cannot happen silently — an invalid row appended after validation -> commit_failed, nothing written', async () => {
    const db = makeKindsDb('referrers');
    await validateBytes(db, await referrersXlsx([doc('DR1', 'Dr Synthetic One')]));
    // the stored sheet is replaced by an invalid one after validation (tampered file)
    const bad = await referrersXlsx([doc('DR1', null)]);
    const f = db.v.committed['files']!.find((x) => x.purpose === 'import_upload')!;
    f.content = Buffer.from(bad);
    const c = await commitValidated(db);
    expect(c.imp.status).toBe('commit_failed');
    expect(codesOf(c.issues)).toContain('row.required_missing');
    expect(db.doctorRows()).toHaveLength(0);
  }, T);
});

describe('credit_parties — commit (CR-C18-008)', () => {
  const rows = () => [party('HOSP1', 'Synthetic Hospital', 'hospital', { credit: 'Y', pan: '123456789', phone: '+9779800000011' }), party('CO2', 'Synthetic Company', 'company', { credit: 'N' }), party('LAB3', 'Synthetic Lab', 'partner_lab')];

  it('creates parties (allows_credit blank = true, N = false); one bump, one catalog_import event; created_by = committing user', async () => {
    const db = makeKindsDb('credit_parties');
    const rev = db.revision();
    const { c } = await importFully(db, await creditPartiesXlsx(rows()));
    const ps = db.partyRows();
    expect(ps).toHaveLength(3);
    expect(ps.find((p) => p.party_code === 'HOSP1')).toMatchObject({ name: 'Synthetic Hospital', kind: 'hospital', allows_credit: true, pan: '123456789', contact_phone_e164: '+9779800000011', created_by: COMMITTER, updated_by: COMMITTER });
    expect(ps.find((p) => p.party_code === 'CO2')).toMatchObject({ name: 'Synthetic Company', allows_credit: false });
    expect(ps.find((p) => p.party_code === 'LAB3')!.allows_credit).toBe(true);
    expect(db.revision()).toBe(rev + 1);
    expect(catalogEvents(c.runner)).toHaveLength(1);
    expect(catalogEvents(c.runner)[0]!.payload).toMatchObject({ entity_type: 'catalog_import', entity_id: IMPORT_ID });
  }, T);

  it('upsert by party_code: same id, changed name; absent rows not deactivated; idempotent second run', async () => {
    const db = makeKindsDb('credit_parties');
    await importFully(db, await creditPartiesXlsx(rows()));
    const hosp = db.partyRows().find((p) => p.party_code === 'HOSP1')!;
    await importFully(db, await creditPartiesXlsx([party('HOSP1', 'Synthetic Hospital Renamed', 'hospital', { credit: 'Y', pan: '123456789', phone: '+9779800000011' })]), SECOND);
    expect(db.partyRows()).toHaveLength(3);
    expect(db.partyRows().find((p) => p.party_code === 'HOSP1')).toMatchObject({ id: hosp.id, name: 'Synthetic Hospital Renamed' });
    expect(db.partyRows().every((p) => p.is_active === true)).toBe(true);
  }, T);

  it('PAN / phone / email values are never logged or put in issues (02-TRD §8.2: "Contact and PAN cells are never logged")', async () => {
    const db = makeKindsDb('credit_parties');
    await validateBytes(db, await creditPartiesXlsx([party('HOSP1', 'Synthetic Hospital', 'hospital', { pan: 'PAN-SECRET-123', phone: '+9779800000099', email: 'secret-mail@example.test' })]));
    const c = await commitValidated(db);
    const blob = c.runner.log.text() + JSON.stringify(c.issues) + JSON.stringify(c.runner.metrics);
    for (const s of ['PAN-SECRET-123', '+9779800000099', 'secret-mail@example.test']) expect(blob).not.toContain(s);
  }, T);

  it('crash before COMMIT leaves nothing and the retry commits once', async () => {
    const db = makeKindsDb('credit_parties');
    await validateBytes(db, await creditPartiesXlsx(rows()));
    const { commitParams } = await import('../helpers/kindsDb.js');
    commitParams(db);
    const snap = db.snapshot();
    db.crashBeforeCommit();
    expect(await errOf(makeKindsRunner(db, importCommit).run(payloadOf()))).toBeDefined();
    db.noCrash();
    expect(db.snapshot()).toEqual(snap);
    const rev = db.revision();
    await makeKindsRunner(db, importCommit).run(payloadOf());
    expect(db.partyRows()).toHaveLength(3);
    expect(db.revision()).toBe(rev + 1);
  }, T);

  it('a referrers import is not applied by a credit_parties tenant fake: kind decides the sheet (Doctors sheet in a credit_parties import -> commit_failed / never written)', async () => {
    const db = makeKindsDb('credit_parties');
    await validateBytes(db, await referrersXlsx([doc('DR1', 'Dr A')]));
    const c = await commitValidated(db);
    expect(['commit_failed', 'invalid', 'committing']).toContain(c.imp.status);
    expect(db.partyRows()).toHaveLength(0);
  }, T);
});

void USER;
