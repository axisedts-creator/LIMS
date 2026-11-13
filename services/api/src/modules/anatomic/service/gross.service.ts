// Gross record + stage transitions + cancel — A8 saveAnatomicGross, A9 startAnatomicProcessing, A10 markAnatomicCaseReady, A11 cancelAnatomicCase
// (02-TRD §5 A8–A11, §7 C3/C4/C7, D-66 signout_locked). Order in every operation: load case (404) -> IdentityPort.assertRole(anatomic.case.work, case centre)
// -> lock/state guard -> If-Match -> body -> version check -> write. No submitted value is echoed or logged (REQ-SEC-098); a throw rolls the caller's transaction back.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertTransition, type CaseStatus } from '../domain/case.state.js';
import { insertCaseTransition, listCaseItems, updateCase } from '../repository/cases.repo.js';
import { listCodedCancelReasons, listGlobalCancelReasons } from '../repository/codedValues.repo.js';
import { getSettings, getTestProfileByTestId } from '../repository/config.repo.js';
import { getOpenDraft } from '../repository/drafts.repo.js';
import { insertGrossRecord, listGrossRecords, updateGrossRecord } from '../repository/gross.repo.js';
import { listBlocks } from '../repository/blocks.repo.js';
import { listMolecularResults } from '../repository/molecular.repo.js';
import { getPart, listParts } from '../repository/parts.repo.js';
import { listSlides } from '../repository/slides.repo.js';
import { listItemSubmissions } from '../repository/submissions.repo.js';
import type { Row } from '../repository/_sql.js';
import { anatomicCtx, assertAt, bad, caseDto, isObj, iso, loadCase, put, strict, text } from './case.service.js';
import type { AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** If-Match "<n>": n >= 0 ("0" = create, A8 only) or n >= 1. Absent -> 428; malformed -> 400. */
export function ifMatch(headers: unknown, allowZero: boolean): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"(0|[1-9][0-9]{0,9})"$/.exec(h) : null;
  const n = m ? Number(m[1]) : NaN;
  if (!m || n > 2147483647 || (n === 0 && !allowZero)) throw bad('/headers/if-match');
  return n;
}

// ---- A8 saveAnatomicGross ----
const DIM = /^[0-9]{1,4}(\.[0-9])?$/, WEIGHT = /^[0-9]{1,5}(\.[0-9]{1,2})?$/, NONZERO = /[1-9]/;

export async function saveGross(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const p = isObj(params) ? params : {};
  const cs = await loadCase(c, p['case_id']);
  await assertAt(c, 'anatomic.case.work', cs);
  const partId = typeof p['part_id'] === 'string' && UUID.test(p['part_id']) ? p['part_id'] : undefined;
  const part = partId ? await getPart(c.tx, { tenantId: c.tenantId, id: partId }) : undefined;
  if (!part || part['case_id'] !== cs['id']) throw new LimsError('common.not_found');

  const status = cs['status'] as CaseStatus;
  if (status === 'received' || status === 'cancelled') throw new LimsError('anatomic.case_invalid_transition'); // edits start at accessioned (§7)
  if (status === 'signed_out' && !(await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }))) throw new LimsError('anatomic.signout_locked'); // D-66 (b)

  const version = ifMatch(headers, true);
  const b = strict(body, ['gross_text', 'pieces_count', 'dimensions_mm', 'weight_g', 'is_complete']);
  const grossText = text(b['gross_text'], '/gross_text', 20000);
  let pieces: number | undefined;
  if (b['pieces_count'] !== undefined) {
    const v = b['pieces_count'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 999) throw bad('/pieces_count');
    pieces = v;
  }
  let dims: string[] | undefined;
  if (b['dimensions_mm'] !== undefined) {
    const v = b['dimensions_mm'];
    if (!Array.isArray(v) || v.length < 1 || v.length > 3) throw bad('/dimensions_mm');
    v.forEach((d, i) => { if (typeof d !== 'string' || !DIM.test(d) || !NONZERO.test(d)) throw bad(`/dimensions_mm/${i}`); });
    dims = v as string[];
  }
  let weight: string | undefined;
  if (b['weight_g'] !== undefined) {
    const v = b['weight_g'];
    if (typeof v !== 'string' || !WEIGHT.test(v) || !NONZERO.test(v)) throw bad('/weight_g');
    weight = v;
  }
  if (typeof b['is_complete'] !== 'boolean') throw bad('/is_complete');
  const complete = b['is_complete'];

  const existing = (await listGrossRecords(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).find((g) => g['part_id'] === part['id']);
  let saved: Row | undefined;
  if (version === 0) {
    if (existing) throw new LimsError('common.version_conflict');
    if (!c.actor.membershipId) throw new LimsError('auth.unauthenticated'); // grossed_by_membership_id is NOT NULL
    const row: Row = {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], part_id: part['id'], gross_text: grossText,
      is_complete: complete, completed_at: complete ? c.now().toISOString() : null, grossed_by_membership_id: c.actor.membershipId, created_by: c.actor.id, updated_by: c.actor.id,
    };
    if (pieces !== undefined) row['pieces_count'] = pieces;
    if (dims !== undefined) row['dimensions_mm'] = dims;
    if (weight !== undefined) row['weight_g'] = weight;
    try {
      saved = await insertGrossRecord(c.tx, row);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === '23505') throw new LimsError('common.version_conflict'); // lost the (tenant, part) race
      throw e;
    }
  } else {
    if (!existing || Number(existing['version']) !== version) throw new LimsError('common.version_conflict');
    const patch: Row = { gross_text: grossText, pieces_count: pieces ?? null, dimensions_mm: dims ?? null, weight_g: weight ?? null, is_complete: complete }; // PUT: omitted = cleared
    if (!complete) patch['completed_at'] = null; // DB CHECK is_complete = (completed_at IS NOT NULL)
    else if (!existing['is_complete'] || !existing['completed_at']) patch['completed_at'] = c.now().toISOString(); // an already complete record keeps its completed_at (AC-03.3)
    saved = await updateGrossRecord(c.tx, { tenantId: c.tenantId, id: existing['id'], expectedVersion: version, actorId: c.actor.id, patch });
  }
  if (!saved) throw new LimsError('common.version_conflict');

  const o: Obj = { id: saved['id'], part_id: saved['part_id'], gross_text: saved['gross_text'], is_complete: saved['is_complete'], version: Number(saved['version']) };
  put(o, 'pieces_count', saved['pieces_count']); put(o, 'dimensions_mm', saved['dimensions_mm']); put(o, 'weight_g', saved['weight_g']); put(o, 'completed_at', iso(saved['completed_at']));
  return { status: 200, body: o };
}

// ---- shared by A9–A11 ----
/** Load (row lock) + role + If-Match + optimistic version check. */
async function loadForTransition(hctx: unknown, params: unknown, headers: unknown): Promise<{ c: AnatomicCtx; cs: Row; version: number }> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined, true);
  await assertAt(c, 'anatomic.case.work', cs);
  const version = ifMatch(headers, false);
  return { c, cs, version };
}

async function moveCase(c: AnatomicCtx, cs: Row, version: number, patch: Row, to: CaseStatus, reasonCode?: string): Promise<Result> {
  if (Number(cs['version']) !== version) throw new LimsError('common.version_conflict');
  const updated = await updateCase(c.tx, { tenantId: c.tenantId, id: cs['id'], expectedVersion: version, actorId: c.actor.id, patch: { ...patch, status: to } });
  if (!updated) throw new LimsError('common.version_conflict'); // a parallel writer won: exactly one transition row is written
  const row: Row = { id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], from_status: cs['status'], to_status: to, created_by: c.actor.id };
  if (reasonCode !== undefined) row['reason_code'] = reasonCode;
  await insertCaseTransition(c.tx, row);
  return { status: 200, body: caseDto(updated, await listParts(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })) };
}

const invalid = (): LimsError => new LimsError('anatomic.case_invalid_transition');

// ---- A9 startAnatomicProcessing (C3) ----
export async function startProcessing(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const { c, cs, version } = await loadForTransition(hctx, params, headers);
  if (Number(cs['version']) !== version) throw new LimsError('common.version_conflict');
  assertTransition(cs['status'] as CaseStatus, 'in_processing');
  const tenantId = c.tenantId, caseId = cs['id'];
  switch (cs['case_kind']) {
    case 'histology': {
      if ((await listBlocks(c.tx, { tenantId, caseId })).length < 1) throw invalid();
      const settings = await getSettings(c.tx, { tenantId });
      if (settings?.['require_gross_complete_for_processing'] !== false) {
        // [CONV] parts carry no profile: when any active item's test profile requires gross, every part needs a complete gross
        let requires = false;
        for (const item of await listCaseItems(c.tx, { tenantId, caseId, activeOnly: true })) {
          const profile = await getTestProfileByTestId(c.tx, { tenantId, testId: item['test_id'] });
          if (profile?.['requires_gross'] === true) { requires = true; break; }
        }
        if (requires) {
          const done = new Set((await listGrossRecords(c.tx, { tenantId, caseId })).filter((g) => g['is_complete'] === true).map((g) => g['part_id']));
          if ((await listParts(c.tx, { tenantId, caseId })).some((pt) => !done.has(pt['id']))) throw invalid();
        }
      }
      break;
    }
    case 'cytology':
      if ((await listSlides(c.tx, { tenantId, caseId })).length < 1 && (await listBlocks(c.tx, { tenantId, caseId })).length < 1) throw invalid();
      break;
    case 'ihc':
      if ((await listBlocks(c.tx, { tenantId, caseId })).length < 1) throw invalid();
      break;
    case 'molecular':
      if ((await listParts(c.tx, { tenantId, caseId })).length < 1) throw invalid();
      break;
    default: throw invalid();
  }
  return moveCase(c, cs, version, {}, 'in_processing');
}

// ---- A10 markAnatomicCaseReady (C4) ----
export async function markReady(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const { c, cs, version } = await loadForTransition(hctx, params, headers);
  if (Number(cs['version']) !== version) throw new LimsError('common.version_conflict');
  assertTransition(cs['status'] as CaseStatus, 'ready_for_reporting');
  const tenantId = c.tenantId, caseId = cs['id'];
  if (cs['case_kind'] === 'molecular') {
    if ((await listMolecularResults(c.tx, { tenantId, caseId, activeOnly: true })).filter((m) => m['is_active'] !== false).length < 1) throw invalid();
  } else if (!(await listSlides(c.tx, { tenantId, caseId })).some((s) => s['status'] === 'ready')) throw invalid();
  return moveCase(c, cs, version, {}, 'ready_for_reporting');
}

// ---- A11 cancelAnatomicCase (C7) ----
export async function cancelCase(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const { c, cs, version } = await loadForTransition(hctx, params, headers);
  const b = strict(body, ['reason_code', 'reason_text']);
  const code = b['reason_code'];
  if (typeof code !== 'string' || code === '') throw bad('/reason_code');
  const reasonText = b['reason_text'] === undefined ? undefined : text(b['reason_text'], '/reason_text', 500);
  const known = [...await listGlobalCancelReasons(c.tx), ...await listCodedCancelReasons(c.tx, { tenantId: c.tenantId, activeOnly: true })]
    .some((r) => r['code'] === code && r['is_active'] !== false && (r['tenant_id'] === undefined || r['tenant_id'] === c.tenantId));
  if (!known) throw bad('/reason_code');

  if (Number(cs['version']) !== version) throw new LimsError('common.version_conflict');
  assertTransition(cs['status'] as CaseStatus, 'cancelled'); // signed_out and cancelled have no edge to cancelled
  if ((await listItemSubmissions(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).length > 0) throw invalid(); // AC-15.2
  return moveCase(c, cs, version, { cancelled_at: c.now().toISOString(), cancel_reason_code: code, cancel_reason_text: reasonText ?? null }, 'cancelled', code);
}
