// C11 T-18 — probe generator + hand-written probe tables (06-PLAN T-18; 07-SECURITY §4 abuse cases, §5.1–5.3).
// Not a test file: shared by coverage.probes.test.ts, generated.probes.test.ts (runs everywhere) and live.probes.test.ts (gated on a migrated PG).
// Everything operation-shaped is READ FROM contracts/openapi/anatomic.yaml at run time (no operationId, path or permission is typed twice); only the TRD code <-> operationId
// table (02-TRD §5 numbering A1–A12, M1–M15, R1–R10, I1–I4, Q1–Q7, K1–K22, same order as handlers/index.ts) and the 07-SECURITY §5.1 id lists are written by hand.
import { join } from 'node:path';
import { loadSpec, operationIds, REPO_ROOT } from '../../../../core/module.js';

export const SPEC: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'anatomic.yaml'));
export const OPS: string[] = operationIds(SPEC);

/** 02-TRD §5 numbering (the numbering 07-SECURITY §5.1 cites). Verified against the spec by coverage.probes.test.ts. */
export const TRD: Record<string, string> = {
  A1: 'listAnatomicCases', A2: 'lookupAnatomicObject', A3: 'getAnatomicCase', A4: 'accessionAnatomicCase', A5: 'updateAnatomicCaseDetails', A6: 'addAnatomicPart', A7: 'updateAnatomicPart',
  A8: 'saveAnatomicGross', A9: 'startAnatomicProcessing', A10: 'markAnatomicCaseReady', A11: 'cancelAnatomicCase', A12: 'listAnatomicAssignees',
  M1: 'createAnatomicBlocks', M2: 'createAnatomicSlides', M3: 'markAnatomicSlidesReady', M4: 'saveAnatomicSlideAssessment', M5: 'createAnatomicStainOrder', M6: 'listAnatomicStainOrders',
  M7: 'startAnatomicStainOrder', M8: 'completeAnatomicStainOrder', M9: 'cancelAnatomicStainOrder', M10: 'linkAnatomicAddonItem', M11: 'recordAnatomicMovements', M12: 'listAnatomicBlocks',
  M13: 'listAnatomicBlockMovements', M14: 'listAnatomicSlideMovements', M15: 'getAnatomicLabels',
  R1: 'getAnatomicReportDraft', R2: 'saveAnatomicReportDraft', R3: 'signOutAnatomicCase', R4: 'startAnatomicCaseChange', R5: 'discardAnatomicCaseChange', R6: 'listAnatomicReportVersions',
  R7: 'getAnatomicReportVersion', R8: 'createAnatomicAddendum', R9: 'updateAnatomicAddendum', R10: 'signAnatomicAddendum',
  I1: 'uploadAnatomicImage', I2: 'getAnatomicImageContent', I3: 'updateAnatomicImage', I4: 'deactivateAnatomicImage',
  Q1: 'saveAnatomicMolecularResults', Q2: 'listAnatomicBatches', Q3: 'createAnatomicBatch', Q4: 'getAnatomicBatch', Q5: 'addAnatomicBatchMembers', Q6: 'removeAnatomicBatchMembers', Q7: 'closeAnatomicBatch',
  K1: 'getAnatomicSettings', K2: 'updateAnatomicSettings', K3: 'listAnatomicStains', K4: 'createAnatomicStain', K5: 'updateAnatomicStain', K6: 'listAnatomicTestProfiles', K7: 'upsertAnatomicTestProfile',
  K8: 'listAnatomicAssays', K9: 'createAnatomicAssay', K10: 'updateAnatomicAssay', K11: 'listAnatomicCodedValues', K12: 'upsertAnatomicCodedValue', K13: 'listAnatomicSynopticTemplates',
  K14: 'createAnatomicSynopticTemplate', K15: 'getAnatomicSynopticTemplate', K16: 'updateAnatomicSynopticTemplate', K17: 'publishAnatomicSynopticTemplate', K18: 'retireAnatomicSynopticTemplate',
  K19: 'createAnatomicSynopticTemplateVersion', K20: 'listAnatomicTextTemplates', K21: 'createAnatomicTextTemplate', K22: 'updateAnatomicTextTemplate',
};
export const trd = (code: string): string => TRD[code]!;

// ---------------------------------------------------------------- tenant ids used by the non-live probes (never collide with the live fixtures)
export const T_A = '01a1a98a-ac40-7000-8000-00000000a001', T_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const B_ID = '0190c418-0002-7000-8000-0000000000b1'; // "an id that exists only in tenant B"

// ---------------------------------------------------------------- spec reading
export interface PathParam { name: string; schema: any }
export interface OpInfo {
  operationId: string; method: string; path: string; permission: string; pathParams: PathParam[]; queryRequired: PathParam[]; needsIfMatch: boolean;
  bodyRequired: boolean; bodySchema: any | undefined; bodyExample: any | undefined; isMultipart: boolean;
}
function deref(s: any): any {
  if (s?.$ref) {
    const name = String(s.$ref).split('/').pop();
    if (name === 'Uuid') return { type: 'string', format: 'uuid' };
    const local = String(s.$ref).startsWith('#') ? String(s.$ref).slice(2).split('/').reduce((o: any, k: string) => o?.[k], SPEC) : undefined;
    return local ? deref(local) : { type: 'string' };
  }
  return s;
}
export function ops(): OpInfo[] {
  const out: OpInfo[] = [];
  for (const [path, item] of Object.entries<any>(SPEC.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!op?.operationId) continue;
      const params: any[] = op.parameters ?? [];
      const content = op.requestBody?.content ?? {};
      const mime = Object.keys(content)[0];
      out.push({
        operationId: op.operationId, method: method.toUpperCase(), path, permission: op['x-permission'],
        pathParams: params.filter((p) => p.in === 'path').map((p) => ({ name: p.name, schema: deref(p.schema) })),
        queryRequired: params.filter((p) => p.in === 'query' && p.required).map((p) => ({ name: p.name, schema: deref(p.schema) })),
        needsIfMatch: params.some((p) => /\/IfMatch$/.test(p.$ref ?? '') || (p.in === 'header' && /^if-match$/i.test(p.name ?? ''))),
        bodyRequired: !!op.requestBody?.required, isMultipart: !!mime && /multipart/.test(mime),
        bodySchema: mime ? content[mime].schema : undefined, bodyExample: content[mime ?? '']?.examples?.synthetic?.value,
      });
    }
  }
  return out;
}
export const OP: Record<string, OpInfo> = Object.fromEntries(ops().map((o) => [o.operationId, o]));

// ---------------------------------------------------------------- 07-SECURITY §5.1 id kinds
/** path-parameter names of §5.1 ("path ids of tenant B for every ...") -> entity kind. `code` (coded value) and `test_id` are handled separately (key-addressed upserts, see UPSERT_BY_KEY). */
export const PATH_KIND: Record<string, string> = {
  case_id: 'case', part_id: 'part', slide_id: 'slide', block_id: 'block', stain_order_id: 'stainOrder', addendum_id: 'addendum', image_id: 'image', batch_id: 'batch',
  template_id: 'template', stain_id: 'stain', assay_id: 'assay', text_template_id: 'textTemplate', test_id: 'test', code: 'code',
};
/** non-id path params (enum / number): given a legal value so validation never precedes the 404 the probe is after */
export function legalPathValue(p: PathParam, kindId: (kind: string) => string): string {
  const kind = PATH_KIND[p.name];
  if (kind) return kindId(kind);
  if (p.schema?.enum) return String(p.schema.enum[0]);
  if (p.schema?.type === 'integer') return String(p.schema.minimum ?? 1);
  return 'x';
}
/** key-addressed upserts: PUT .../{test_id} and .../values/{code} create the caller's OWN row when the key is unknown to the caller's tenant — so tenant B's key is not a 404 there
 *  (02-TRD §5; deviation from the literal 07-SECURITY §5.1 wording, recorded in .orchestra/notes/C11.T-18-tests.md). Their isolation is proved live by "no write ever lands on B's row". */
export const UPSERT_BY_KEY: readonly string[] = ['upsertAnatomicTestProfile', 'upsertAnatomicCodedValue'];

export const hasIdPath = (o: OpInfo): boolean => o.pathParams.some((p) => PATH_KIND[p.name]);
export const isRead = (o: OpInfo): boolean => o.method === 'GET';

/** 07-SECURITY §5.1: "list endpoints with B data present -> zero B rows (A1, M6, M12, Q2, K3, K6, K8, K11, K13, K20)" */
export const LIST_OPS: readonly string[] = ['A1', 'M6', 'M12', 'Q2', 'K3', 'K6', 'K8', 'K11', 'K13', 'K20'].map(trd);
/** pathless reads that are tenant-scoped too (K1 settings, A12 assignees) */
export const TENANT_READS: readonly string[] = ['K1', 'A12'].map(trd);
/** 07-SECURITY §5.1 "bulk arrays mixing A and B ids (M3, M11, Q5, Q6) -> per-id not_found" */
export const BULK_OPS: readonly string[] = ['M3', 'M11', 'Q5', 'Q6'].map(trd);
/** 07-SECURITY §5.3: privileged operations (permission + aal2 + live membership) */
export const SIGNOUT_OPS: readonly string[] = ['R3', 'R4', 'R5', 'R10'].map(trd);
export const CONFIG_WRITE_OPS = (): string[] => ops().filter((o) => o.permission === 'anatomic.config.manage').map((o) => o.operationId);

/** 07-SECURITY §5.1 second bullet: ids of tenant B placed in a BODY of a request that is otherwise tenant A's. `at` is a JSON pointer into the body; `kind` the B entity. */
export const BODY_ID_PROBES: readonly { op: string; at: string; kind: string; arrayItem?: true }[] = [
  { op: trd('A4'), at: '/assigned_pathologist_membership_id', kind: 'membership' },
  { op: trd('A5'), at: '/assigned_pathologist_membership_id', kind: 'membership' },
  { op: trd('A6'), at: '/specimen_id', kind: 'specimen' },
  { op: trd('M1'), at: '/part_id', kind: 'part' },
  { op: trd('M2'), at: '/part_id', kind: 'part' },
  { op: trd('M2'), at: '/block_id', kind: 'block' },
  { op: trd('M5'), at: '/block_id', kind: 'block' },
  { op: trd('M5'), at: '/part_id', kind: 'part' },
  { op: trd('M5'), at: '/addon_order_item_id', kind: 'orderItem' },
  { op: trd('M5'), at: '/stain_id', kind: 'stain' },
  { op: trd('M10'), at: '/order_item_id', kind: 'orderItem' },
  { op: trd('R2'), at: '/image_ids/0', kind: 'image' },
  { op: trd('R8'), at: '/stain_order_ids/0', kind: 'stainOrder' },
  { op: trd('R8'), at: '/addon_case_item_id', kind: 'caseItem' },
  { op: trd('R9'), at: '/stain_order_ids/0', kind: 'stainOrder' },
  { op: trd('R9'), at: '/addon_case_item_id', kind: 'caseItem' },
  { op: trd('I1'), at: '/part_id', kind: 'part' },
  { op: trd('I3'), at: '/part_id', kind: 'part' },
  { op: trd('Q5'), at: '/members/0/case_id', kind: 'case' },
  { op: trd('K7'), at: '/test_id', kind: 'test' },
];

/** AB-5: server-owned fields a body must never set */
export const FORBIDDEN_BODY_KEYS: readonly string[] = ['tenant_id', 'status', 'accession_no', 'signed_by_membership_id'];

// ---------------------------------------------------------------- request samples (spec example first, schema walk second)
const UUID_SAMPLE = '0190c418-0001-7000-8000-0000000000a1';
export function sample(schema: any, depth = 0): unknown {
  const s = deref(schema);
  if (!s || depth > 6) return undefined;
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: any) => sample(x, depth + 1)));
  if (s.oneOf || s.anyOf) return sample((s.oneOf ?? s.anyOf)[0], depth + 1);
  if (s.enum) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  switch (t) {
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const k of s.required ?? []) o[k] = sample(s.properties?.[k], depth + 1);
      return o;
    }
    case 'array': return Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => sample(s.items, depth + 1));
    case 'integer': case 'number': return s.minimum ?? 1;
    case 'boolean': return true;
    case 'string': {
      if (s.format === 'uuid') return UUID_SAMPLE;
      if (s.format === 'date-time') return '2026-11-10T04:00:00.000Z';
      if (s.format === 'date') return '2026-11-10';
      const pat = String(s.pattern ?? '');
      const v = /A-Z/.test(pat) ? 'CODE1' : /a-z/.test(pat) ? 'code1' : 'Synthetic';
      return v.length >= (s.minLength ?? 0) ? v : v.padEnd(s.minLength, 'x');
    }
    default: return s.properties ? sample({ ...s, type: 'object' }, depth + 1) : undefined;
  }
}
/** A SynopticDefinitionV1 that passes the service validation (same shape as integration/synoptic.live.test.ts DEF) — a generated sample cannot know the cross-field rules, and a 422 template_invalid
 *  must not mask the 404 the probe is after. */
export const VALID_SYNOPTIC_DEFINITION = {
  schema_version: 1, title: 'Synthetic probe template', applies_to_case_kinds: ['histology'],
  sections: [{ key: 'tumour', heading: 'Tumour', fields: [{ key: 'site', label: 'Site', type: 'text', required: true }, { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] }] }],
};
const BODY_OVERRIDE: Record<string, (b: any) => any> = {
  updateAnatomicSynopticTemplate: (b) => ({ ...b, definition: structuredClone(VALID_SYNOPTIC_DEFINITION) }),
  createAnatomicSynopticTemplate: (b) => ({ ...b, template_key: 'probe_tpl', definition: structuredClone(VALID_SYNOPTIC_DEFINITION) }),
};
export function sampleBody(o: OpInfo): any {
  if (!o.bodySchema || o.isMultipart) return undefined;
  const b = structuredClone(o.bodyExample ?? sample(o.bodySchema));
  return BODY_OVERRIDE[o.operationId]?.(b) ?? b;
}
export function setPointer(root: any, pointer: string, value: unknown): void {
  const keys = pointer.split('/').slice(1);
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k: any = /^\d+$/.test(keys[i]!) ? Number(keys[i]) : keys[i];
    if (cur[k] === undefined || cur[k] === null) cur[k] = /^\d+$/.test(keys[i + 1]!) ? [] : {};
    cur = cur[k];
  }
  const last: any = /^\d+$/.test(keys.at(-1)!) ? Number(keys.at(-1)) : keys.at(-1);
  cur[last] = value;
}

/** Request for an operation with every path id taken from `kindId` (e.g. tenant B's ids), legal enum/number path values, If-Match "1", required query values and a schema-valid body. */
export function buildRequest(o: OpInfo, kindId: (kind: string) => string): { params: Record<string, string>; query: Record<string, unknown>; headers: Record<string, string>; body: any } {
  const params = Object.fromEntries(o.pathParams.map((p) => [p.name, legalPathValue(p, kindId)]));
  const query = Object.fromEntries(o.queryRequired.map((p) => [p.name, sample(p.schema) ?? 'x']));
  const headers: Record<string, string> = o.needsIfMatch ? { 'if-match': '"1"' } : {};
  return { params, query, headers, body: sampleBody(o) };
}

// ---------------------------------------------------------------- what each operationId is probed by (the done_when of T-18)
/** probe kinds an operation receives. Every one of the 70 ids must have >= 1 (coverage.probes.test.ts). */
export function probeKinds(o: OpInfo): string[] {
  const k: string[] = [];
  if (hasIdPath(o) && !UPSERT_BY_KEY.includes(o.operationId)) k.push('path-id-of-tenant-B -> 404');
  if (hasIdPath(o)) k.push('path-id-of-other-centre -> 404');
  if (BODY_ID_PROBES.some((b) => b.op === o.operationId)) k.push('body-id-of-tenant-B -> never cross-linked');
  if (BULK_OPS.includes(o.operationId)) k.push('bulk A+B ids -> per-id not_found');
  if (LIST_OPS.includes(o.operationId) || TENANT_READS.includes(o.operationId)) k.push('list/read shows zero B rows');
  if (o.operationId === trd('A2')) k.push('lookup of B label/accession -> 404');
  if (o.permission === 'anatomic.config.manage' || SIGNOUT_OPS.includes(o.operationId)) k.push('privilege: forbidden / mfa_required pass through');
  if (o.bodySchema && !o.isMultipart) k.push('AB-5 server-owned body fields -> 400 unknown_field');
  if (o.operationId === trd('I1')) k.push('AB-6/7 upload content');
  if (o.operationId === trd('I2')) k.push('AB-1 image content of tenant B -> 404, no bytes');
  return k;
}
