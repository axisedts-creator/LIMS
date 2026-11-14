// T-25 (C3) test helper: drive the two worker tasks over a KindsDb the way the system does (upload -> catalog.import_validate -> API commitImport stores params -> catalog.import_commit).
// The tasks are the EXISTING exports (tasks/catalog.import_validate.ts `importValidate`, tasks/catalog.import_commit.ts `importCommit`): T-25 extends them to the kinds
// catalog_master / referrers / credit_parties (SEAM: dispatch on imports.kind inside the same task names, 02-TRD §10 lists one commit task).
import { importCommit } from '../../tasks/catalog.import_commit.js';
import { importValidate } from '../../tasks/catalog.import_validate.js';
import { IMPORT_ID, TENANT_A, UPLOAD_FILE_ID, commitParams, makeKindsRunner, seedKindImport, uid, type KindsDb } from './kindsDb.js';

export const IMPORT_2 = uid(601);
export const FILE_2 = uid(701);
/** Assumed summary counters the validation job stores for catalog_master (see imports.commit.kinds.test.ts SEAM header). */
export const CLINICAL = ['analyte_versions', 'range_sets', 'critical_sets'] as const;

export interface FlowOpts { importId?: string; fileId?: string; tenantId?: string }
export const payloadOf = (o: FlowOpts & { replaceDraft?: boolean; extra?: Record<string, unknown> } = {}) =>
  ({ tenant_id: o.tenantId ?? TENANT_A, import_id: o.importId ?? IMPORT_ID, ...(o.replaceDraft === undefined ? {} : { replace_draft: o.replaceDraft }), ...(o.extra ?? {}) });

/** Seeds an `uploaded` import and runs the validation job once. */
export async function validateBytes(db: KindsDb, bytes: Uint8Array, o: FlowOpts = {}) {
  const importId = o.importId ?? IMPORT_ID, tenantId = o.tenantId ?? TENANT_A;
  seedKindImport(db, bytes, { importId, fileId: o.fileId ?? UPLOAD_FILE_ID, tenantId });
  const runner = makeKindsRunner(db, importValidate, { tenantId });
  await runner.run(payloadOf({ importId, tenantId }));
  return { runner, imp: db.imp(importId, tenantId), issues: db.issues(importId, tenantId) };
}

/** What the API commitImport stores + enqueues, then one run of catalog.import_commit. */
export async function commitValidated(db: KindsDb, o: FlowOpts & { replaceDraft?: boolean; effectiveFrom?: string; reason?: string; committedBy?: string | null; extra?: Record<string, unknown> } = {}) {
  const importId = o.importId ?? IMPORT_ID, tenantId = o.tenantId ?? TENANT_A;
  commitParams(db, importId, { tenantId, effectiveFrom: o.effectiveFrom, reason: o.reason, committedBy: o.committedBy });
  const runner = makeKindsRunner(db, importCommit, { tenantId });
  await runner.run(payloadOf({ importId, tenantId, replaceDraft: o.replaceDraft, extra: o.extra }));
  return { runner, imp: db.imp(importId, tenantId), issues: db.issues(importId, tenantId) };
}

/** validate (must end `validated`) then commit. */
export async function importFully(db: KindsDb, bytes: Uint8Array, o: FlowOpts & { replaceDraft?: boolean; effectiveFrom?: string; reason?: string } = {}) {
  const v = await validateBytes(db, bytes, o);
  if (v.imp.status !== 'validated') throw new Error(`fixture: import ended ${v.imp.status}: ${v.issues.map((i) => `${i.sheet}:${i.row_no}:${i.issue_code}`).join(', ')}`);
  const c = await commitValidated(db, o);
  return { v, c };
}
export const SECOND = { importId: IMPORT_2, fileId: FILE_2 };
export const codesOf = (issues: Array<Record<string, any>>) => issues.map((i) => i.issue_code);
export const errorsOf = (issues: Array<Record<string, any>>) => issues.filter((i) => i.severity === 'error');
