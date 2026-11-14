// C11 T-04 review item 1: one live CRUD case per repository (plan row T-04 "integration per repo"). Called from repositories.live.test.ts
// inside its describe.skipIf(!LIVE), so it never runs without LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL.
// Flow per repo: insert (superuser tx, session_replication_role=replica so lab./frontdesk./core. FK parents are not needed; RLS bypassed)
//   -> get/list as lims_app (sysA) returns the row -> updateX with the current version returns version+1 and the patched column
//   -> updateX again with the OLD version returns undefined (optimistic lock) -> get/list with the OTHER tenant's tenantId (repo filter, RLS bypassed) is empty.
// Class-A repos (movements, versions, submissions) are insert-only: insert + get/list + other-tenant check, no update.
import { expect, it } from 'vitest';
import { insertAddendum, getAddendum, listAddenda, updateAddendum } from '../../repository/addenda.repo.js';
import { insertBatch, getBatch, listBatches, updateBatch, insertBatchMember, getBatchMember, listBatchMembers, updateBatchMember } from '../../repository/batches.repo.js';
import { insertBlock, getBlock, listBlocks, updateBlock } from '../../repository/blocks.repo.js';
import { insertCase, getCase, listCases, updateCase, insertCaseItem, getCaseItem, listCaseItems, updateCaseItem } from '../../repository/cases.repo.js';
import {
  insertCodedCancelReason, getCodedCancelReason, listCodedCancelReasons, updateCodedCancelReason,
  insertCodedDiagnosis, getCodedDiagnosis, listCodedDiagnoses, updateCodedDiagnosis,
  insertCodedCytologyAdequacy, getCodedCytologyAdequacy, listCodedCytologyAdequacies, updateCodedCytologyAdequacy,
} from '../../repository/codedValues.repo.js';
import { insertStain, getStain, listStains, updateStain } from '../../repository/config.repo.js';
import { insertReportDraft, getReportDraft, listReportDrafts, updateReportDraft } from '../../repository/drafts.repo.js';
import { insertGrossRecord, getGrossRecord, listGrossRecords, updateGrossRecord } from '../../repository/gross.repo.js';
import { insertImage, getImage, listImages, updateImage } from '../../repository/images.repo.js';
import { insertMolecularResult, getMolecularResult, listMolecularResults, updateMolecularResult } from '../../repository/molecular.repo.js';
import { insertObjectMovement, getObjectMovement, listObjectMovements } from '../../repository/movements.repo.js';
import { insertPart, getPart, listParts, updatePart } from '../../repository/parts.repo.js';
import { insertSlide, getSlide, listSlides, updateSlide } from '../../repository/slides.repo.js';
import { insertSpecimenLink, getSpecimenLink, listSpecimenLinks, updateSpecimenLink } from '../../repository/specimenLinks.repo.js';
import { insertStainOrder, getStainOrder, listStainOrders, updateStainOrder } from '../../repository/stainOrders.repo.js';
import { insertItemSubmission, getItemSubmission, listItemSubmissions } from '../../repository/submissions.repo.js';
import { insertSynopticTemplate, getSynopticTemplate, listSynopticTemplates, updateSynopticTemplate, insertTextTemplate, getTextTemplate, listTextTemplates, updateTextTemplate } from '../../repository/templates.repo.js';
import { insertReportVersion, getReportVersion, listReportVersions } from '../../repository/versions.repo.js';
import { CENTRE_A1, CLAIMS, ID, SYS, TENANT_A, TENANT_B, uid, type Harness } from './setup.js';

type Fn = (tx: any, i: any) => Promise<any>;
interface Spec {
  name: string;
  insert: Fn;
  row: Record<string, unknown>;
  /** get by id (tenant filter inside) */
  get: Fn;
  /** list scoped so the inserted row is in it */
  list: (tx: any, tenantId: string) => Promise<any[]>;
  /** omitted for class-A (insert-only) repos */
  update?: { fn: Fn; patch: Record<string, unknown> };
  /** extra reads that must also find the row for tenant A and nothing for tenant B */
  extra?: Array<(tx: any, tenantId: string) => Promise<any>>;
}

const MEMB = '01a1a98a-ac40-7000-8000-00000000a500'; // seeded membership of tenant A (FK is off for superuser fixture inserts anyway)
const K = (n: number) => uid(1000 + n); // fixture ids 1xxx: matched by cleanup() prefix
const base = { tenant_id: TENANT_A, created_by: SYS, updated_by: SYS };
const inCase = { ...base, centre_id: CENTRE_A1, case_id: ID.caseA1 };
const CASE = ID.caseA1;
const T0 = '2026-11-10T04:00:00.000Z';
const mkAssay = { assay: K(40), target: K(41), value: K(42) };

export const SPECS: Spec[] = [
  { name: 'cases.repo (updateCase)', insert: insertCase, row: { ...base, id: K(1), centre_id: CENTRE_A1, order_id: K(501), patient_id: K(601), case_kind: 'cytology', status: 'received', priority: 'routine', received_at: T0 },
    get: (tx, i) => getCase(tx, { tenantId: i.tenantId, caseId: i.id }), list: (tx, t) => listCases(tx, { tenantId: t, limit: 500 }).then((r) => r.filter((x: any) => x.id === K(1))),
    update: { fn: updateCase, patch: { priority: 'urgent' } } },
  { name: 'cases.repo (case_items)', insert: insertCaseItem, row: { ...inCase, id: K(2), order_item_id: K(502), test_id: K(602), role: 'addon' },
    get: getCaseItem, list: (tx, t) => listCaseItems(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(2))),
    update: { fn: updateCaseItem, patch: { lab_approved_version_no: 1 } } },
  { name: 'parts.repo (updatePart)', insert: insertPart, row: { ...inCase, id: K(3), letter: 'Q', letter_seq: 17 },
    get: getPart, list: (tx, t) => listParts(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(3))),
    update: { fn: updatePart, patch: { site_text: 'synthetic site' } } },
  { name: 'config.repo (updateStain)', insert: insertStain, row: { ...base, id: K(4), code: 'T04CRUD', display: 'Stain T04CRUD (SYNTHETIC)', kind: 'routine' },
    get: getStain, list: (tx, t) => listStains(tx, { tenantId: t }).then((r) => r.filter((x: any) => x.id === K(4))),
    update: { fn: updateStain, patch: { display: 'Renamed (SYNTHETIC)' } } },
  { name: 'gross.repo', insert: insertGrossRecord, row: { ...inCase, id: K(5), part_id: ID.partA1, gross_text: 'synthetic gross', grossed_by_membership_id: MEMB },
    get: getGrossRecord, list: (tx, t) => listGrossRecords(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(5))),
    update: { fn: updateGrossRecord, patch: { gross_text: 'edited synthetic gross' } } },
  { name: 'blocks.repo', insert: insertBlock, row: { ...inCase, id: K(6), part_id: ID.partA1, seq: 1, label: 'T04-BLK-1' },
    get: getBlock, list: (tx, t) => listBlocks(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(6))),
    update: { fn: updateBlock, patch: { note: 'recut' } } },
  { name: 'stainOrders.repo', insert: insertStainOrder, row: { ...inCase, id: K(7), stain_id: ID.stainA, stain_code: 'T04HE', stain_kind: 'special', block_id: K(6), requested_at: T0, requested_by_membership_id: MEMB },
    get: getStainOrder, list: (tx, t) => listStainOrders(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(7))),
    update: { fn: updateStainOrder, patch: { note: 'urgent recut' } } },
  { name: 'slides.repo', insert: insertSlide, row: { ...inCase, id: K(8), part_id: ID.partA1, block_id: K(6), seq: 1, label: 'T04-SLD-1', stain_id: ID.stainA, stain_code: 'T04HE' },
    get: getSlide, list: (tx, t) => listSlides(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(8))),
    update: { fn: updateSlide, patch: { finding_text: 'synthetic finding' } } },
  { name: 'movements.repo (insert-only)', insert: insertObjectMovement, row: { ...inCase, id: K(9), object_kind: 'block', object_id: K(6), movement: 'stored', from_location_status: 'in_lab', to_location_status: 'stored', location_text: 'cabinet 1' },
    get: getObjectMovement, list: (tx, t) => listObjectMovements(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(9))) },
  { name: 'images.repo', insert: insertImage, row: { ...inCase, id: K(10), kind: 'gross', object_path: `${TENANT_A}/2026/11/${K(10)}.png`, state: 'processing', scan_state: 'pending' },
    get: getImage, list: (tx, t) => listImages(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(10))),
    update: { fn: updateImage, patch: { caption: 'synthetic caption' } } },
  { name: 'drafts.repo', insert: insertReportDraft, row: { ...inCase, id: K(11), kind: 'initial', impression_text: 'synthetic impression' },
    get: getReportDraft, list: (tx, t) => listReportDrafts(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(11))),
    update: { fn: updateReportDraft, patch: { comment_text: 'synthetic comment' } } },
  { name: 'versions.repo (insert-only)', insert: insertReportVersion, row: { ...inCase, id: K(12), version_no: 1, version_kind: 'original', signed_by_membership_id: MEMB, signed_at: T0 },
    get: getReportVersion, list: (tx, t) => listReportVersions(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(12))) },
  { name: 'submissions.repo (insert-only)', insert: insertItemSubmission, row: { ...inCase, id: K(13), case_item_id: K(2), item_version_no: 1, report_version_id: K(12), idempotency_key: `anatomic:${K(2)}:1`, lab_result_id: K(701), lab_version_no: 1, lab_status: 'pending', replayed: false, submitted_at: T0 },
    get: getItemSubmission, list: (tx, t) => listItemSubmissions(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(13))) },
  { name: 'addenda.repo', insert: insertAddendum, row: { ...inCase, id: K(14), seq: 1, kind: 'ihc', text: 'synthetic addendum' },
    get: getAddendum, list: (tx, t) => listAddenda(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(14))),
    update: { fn: updateAddendum, patch: { text: 'edited synthetic addendum' } } },
  { name: 'molecular.repo', insert: insertMolecularResult, row: { ...inCase, id: K(15), assay_id: mkAssay.assay, assay_code: 'T04ASSAY', target_id: mkAssay.target, target_code: 'T04TGT', result_value_id: mkAssay.value, result_code: 'POS' },
    get: getMolecularResult, list: (tx, t) => listMolecularResults(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(15))),
    update: { fn: updateMolecularResult, patch: { comment_text: 'synthetic comment' } } },
  { name: 'batches.repo (batches)', insert: insertBatch, row: { ...base, id: K(16), batch_no: 'T04-B1', assay_id: mkAssay.assay },
    get: getBatch, list: (tx, t) => listBatches(tx, { tenantId: t, limit: 500 }).then((r) => r.filter((x: any) => x.id === K(16))),
    update: { fn: updateBatch, patch: { kit_name: 'synthetic kit' } } },
  { name: 'batches.repo (batch_members)', insert: insertBatchMember, row: { ...base, id: K(17), batch_id: K(16), case_id: CASE, position: 1 },
    get: getBatchMember, list: (tx, t) => listBatchMembers(tx, { tenantId: t, batchId: K(16) }).then((r) => r.filter((x: any) => x.id === K(17))),
    update: { fn: updateBatchMember, patch: { position: 2 } } },
  { name: 'specimenLinks.repo', insert: insertSpecimenLink, row: { ...base, id: K(18), centre_id: CENTRE_A1, specimen_id: K(702), case_id: CASE, part_id: ID.partA1, link_kind: 'part', last_seq: 1, last_status: 'received' },
    get: getSpecimenLink, list: (tx, t) => listSpecimenLinks(tx, { tenantId: t, caseId: CASE }).then((r) => r.filter((x: any) => x.id === K(18))),
    update: { fn: updateSpecimenLink, patch: { last_seq: 2 } } },
  { name: 'templates.repo (synoptic)', insert: insertSynopticTemplate, row: { ...base, id: K(19), template_key: 't04_synoptic', version_no: 1, title: 'T04 synoptic (SYNTHETIC)', applies_to_case_kinds: ['histology'], definition: JSON.stringify({ title: 'T04 synoptic (SYNTHETIC)' }) },
    get: getSynopticTemplate, list: (tx, t) => listSynopticTemplates(tx, { tenantId: t, limit: 500 }).then((r) => r.filter((x: any) => x.id === K(19))),
    update: { fn: updateSynopticTemplate, patch: { title: 'T04 synoptic v2 (SYNTHETIC)' } } },
  { name: 'templates.repo (text)', insert: insertTextTemplate, row: { ...base, id: K(20), short_code: 't04txt', section: 'comment', title: 'T04 text (SYNTHETIC)', body: 'synthetic body' },
    get: getTextTemplate, list: (tx, t) => listTextTemplates(tx, { tenantId: t, limit: 500 }).then((r) => r.filter((x: any) => x.id === K(20))),
    update: { fn: updateTextTemplate, patch: { body: 'edited synthetic body' } } },
  ...([
    ['cs_cancel_reasons', insertCodedCancelReason, getCodedCancelReason, listCodedCancelReasons, updateCodedCancelReason, 21],
    ['cs_diagnoses', insertCodedDiagnosis, getCodedDiagnosis, listCodedDiagnoses, updateCodedDiagnosis, 22],
    ['cs_cytology_adequacy', insertCodedCytologyAdequacy, getCodedCytologyAdequacy, listCodedCytologyAdequacies, updateCodedCytologyAdequacy, 23],
  ] as const).map(([t, ins, get, list, upd, n]): Spec => ({
    name: `codedValues.repo (${t})`, insert: ins as Fn, row: { ...base, id: K(n), code: `T04_${n}`, display: `T04 ${t} (SYNTHETIC)` },
    get: get as Fn, list: (tx, tn) => (list as Fn)(tx, { tenantId: tn, limit: 500 }).then((r: any[]) => r.filter((x) => x.id === K(n))),
    update: { fn: upd as Fn, patch: { display: `T04 ${t} v2 (SYNTHETIC)` } },
  })),
];

export function crudSuite(getH: () => Harness): void {
  for (const s of SPECS) {
    it(`${s.name}: insert → get/list → ${s.update ? 'update (version+1, stale → undefined) → ' : ''}other tenant sees nothing`, async () => {
      const h = getH();
      const stored = await h.asSuperuser((tx) => s.insert(tx as never, s.row));
      expect(stored).toMatchObject({ id: s.row['id'], tenant_id: TENANT_A });
      const got = await h.asApp(CLAIMS.sysA, (tx) => s.get(tx, { tenantId: TENANT_A, id: s.row['id'] }));
      expect(got).toMatchObject({ id: s.row['id'], tenant_id: TENANT_A });
      expect((await h.asApp(CLAIMS.sysA, (tx) => s.list(tx, TENANT_A))).map((r: any) => r.id)).toEqual([s.row['id']]);

      if (s.update) {
        const cur = got.version as number;
        const up = await h.asApp(CLAIMS.sysA, (tx) => s.update!.fn(tx, { tenantId: TENANT_A, id: s.row['id'], expectedVersion: cur, actorId: SYS, patch: s.update!.patch }));
        expect(up).toMatchObject({ id: s.row['id'], version: cur + 1, ...s.update.patch });
        // the stale writer (still holding `cur`) must not match
        expect(await h.asApp(CLAIMS.sysA, (tx) => s.update!.fn(tx, { tenantId: TENANT_A, id: s.row['id'], expectedVersion: cur, actorId: SYS, patch: s.update!.patch }))).toBeUndefined();
        // an update scoped to the other tenant never touches the row (explicit tenant_id in the UPDATE)
        expect(await h.asSuperuser((tx) => s.update!.fn(tx as never, { tenantId: TENANT_B, id: s.row['id'], expectedVersion: cur + 1, actorId: SYS, patch: s.update!.patch }))).toBeUndefined();
      }

      // repo filter alone (superuser tx bypasses RLS): the other tenant's id gets nothing back
      expect(await h.asSuperuser((tx) => s.get(tx as never, { tenantId: TENANT_B, id: s.row['id'] }))).toBeUndefined();
      expect(await h.asSuperuser((tx) => s.list(tx as never, TENANT_B))).toEqual([]);
    });
  }
}
