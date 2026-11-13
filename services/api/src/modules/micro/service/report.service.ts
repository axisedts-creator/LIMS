// M14 submitCultureReport (02-TRD §4.6, §4.7, §5 M14, §13; 03-APP-FLOW §2.1 C4–C7; PRD AC-09.1–09.7, AC-10.1–10.7, AC-15.2, AC-16.1; 07-SECURITY T-A5, T-A6, S-05; 08 R1, A17 D-61/D-62).
// Same shape as T-08/T-09: the culture is read FOR UPDATE first (RLS + tenant; absent = 404, same as another tenant's), THEN IdentityPort.assertRole(micro.culture.work, culture.centre_id).
// Order: 404 -> 403 -> 400 body -> 409 state (C4–C7) -> 422 completeness -> snapshot + size guard -> LabPort.getOrderResults -> LabPort.submitModuleResult -> INSERT report_versions -> UPDATE cultures
// (+ INSERT culture_transitions on a status change). Nothing is written before the port answers; a port LimsError propagates unchanged and the request transaction rolls back (AC-09.2, 02-CV §8.1).
// The order item sent to C5 is the culture row's, never a client value (T-A5); the amendment is decided here from the culture and C5's state, never from the body (S-05, T-A6).
// [CONV] unknown / inactive outcome_code = 400 /outcome_code; final without outcome_code = 422 /outcome_code; early reason applies to outcome code `no_growth` before final_due_at (no settings row = default true);
//   a preliminary leaves incomplete AST rows out of the snapshot, a final refuses them (422; ast_standard_required only when standard/version is the sole problem); an `outcome_code` on a preliminary is ignored.
// Error bodies are fixed text; no submitted value, summary or snapshot content is logged.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { nextCultureStatus, type CultureStatus } from '../domain/culture.state.js';
import { astComplete, buildSnapshot, candidateAst, snapshotIsolates, validateSnapshot } from '../domain/snapshot.js';
import * as dto from '../mappers/culture.dto.js';
import * as cfg from '../repository/config.repo.js';
import * as cultureRepo from '../repository/cultures.repo.js';
import * as repo from '../repository/reports.repo.js';
import * as sets from '../repository/codedsets.repo.js';
import { cultureDetail, memberNames, testLookup } from './chain.service.js';
import { bad, code, conflict, guarded, isObj, needVersion, nowOf, str, strictKeys, uuid, WORK, type WriteCtx } from './culture.service.js';

type Row = Record<string, any>;
type Lab = { getOrderResults(c: unknown, i: Row): Promise<Row>; submitModuleResult(c: unknown, i: Row): Promise<Row> };

/** Object first: the culture FOR UPDATE with the columns M14 needs (404 when absent / not visible), then the permission with the object's centre (02-CV §10.1). */
async function loadReportCulture(c: WriteCtx, params: unknown): Promise<{ tx: any; tenantId: string; userId: string; row: Row }> {
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  const id = uuid(isObj(params) ? params['culture_id'] : undefined, '/culture_id').toLowerCase();
  const row = await repo.lockCulture(c.tx as any, { tenantId: c.tenantId, id });
  if (!row) throw new LimsError('common.not_found');
  const identity = c.ports?.IdentityPort;
  if (!identity) throw new LimsError('auth.forbidden');   // fail closed
  await identity.assertRole(c, { permission: WORK, centreId: row['centre_id'] });
  return { tx: c.tx, tenantId: c.tenantId, userId: c.actor.id, row };
}

const err =(path: string, message: string, code_ = 'common.field_invalid'): FieldError => ({ path, code: code_, message });

/** The C5 line of this culture's order item; prefers the line whose moduleRef points at this culture (same rule as M2). */
function labLine(order: Row | undefined, culture: Row): Row | undefined {
  const item = (order?.['items'] ?? []).find((i: Row) => i?.['orderItemId'] === culture['order_item_id']);
  const lines: Row[] = Array.isArray(item?.['results']) ? item['results'] : [];
  return lines.find((l) => l?.['moduleRef']?.['module'] === 'micro' && l['moduleRef']['entityId'] === culture['id']) ?? lines[0];
}

export async function submitCultureReport(c: WriteCtx, input: { params: unknown; body: unknown }): Promise<Record<string, unknown>> {
  const { tx, tenantId, userId, row } = await loadReportCulture(c, input.params);   // culture FOR UPDATE, then micro.culture.work
  const membershipId = c.actor.membershipId;
  if (typeof membershipId !== 'string') throw new LimsError('auth.forbidden');       // signed_by_membership_id is NOT NULL: only a membership signs
  const cultureId = row['id'] as string;

  // ---- 400: strict body (S-05: no amendment / isolates / ast / flag / version / ids)
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['report_phase', 'outcome_code', 'culture_summary_text', 'comments_text', 'is_critical', 'early_final_reason']);
  const phase = b['report_phase'] === 'preliminary' || b['report_phase'] === 'final' ? b['report_phase'] : bad('/report_phase');
  const isCritical = typeof b['is_critical'] === 'boolean' ? b['is_critical'] : bad('/is_critical');
  const summary = b['culture_summary_text'] === undefined ? undefined : str(b['culture_summary_text'], '/culture_summary_text', 4000);
  const comments = b['comments_text'] === undefined ? null : str(b['comments_text'], '/comments_text', 4000);
  const earlyReason = b['early_final_reason'] === undefined ? null : str(b['early_final_reason'], '/early_final_reason', 500);
  const outcomeCode = phase === 'final' && b['outcome_code'] !== undefined ? code(b['outcome_code'], '/outcome_code') : undefined;
  let outcome: Row | undefined;
  if (outcomeCode !== undefined) {
    outcome = (await repo.viewRows(tx, { view: 'v_culture_outcomes', tenantId, codes: [outcomeCode] })).get(outcomeCode);
    if (outcome?.['is_active'] !== true) bad('/outcome_code');
  }

  // ---- 409: state (C4–C7; amending -> preliminary stays forbidden)
  const status = row['status'] as CultureStatus;
  const toStatus = nextCultureStatus(status, phase === 'final' ? 'submit_final' : 'submit_preliminary');

  // ---- 422: completeness (AC-09.4, AC-10.1–10.3)
  const k = { tenantId, cultureId };
  const [isolateRows, astRows, observations] = [await repo.listIsolates(tx, k), await repo.listAst(tx, k), await repo.listObservations(tx, k)];
  const shown = snapshotIsolates(isolateRows);
  const errs: FieldError[] = [];
  const standardOnly = new Set<FieldError>();
  if (isolateRows.length === 0 && observations.length === 0) errs.push(err('/observations', 'Nothing recorded yet', 'common.field_required'));
  if (phase === 'final') {
    if (outcome === undefined) errs.push(err('/outcome_code', 'Outcome required', 'common.field_required'));
    else if (outcome['requires_isolate'] === true && shown.length === 0) errs.push(err('/isolates', 'An identified reportable isolate is required'));
    const seqOf = new Map(shown.map((i) => [i['id'], i['isolate_seq']]));
    for (const a of candidateAst(astRows, shown)) {
      if (astComplete(a)) continue;
      const path = `/isolates/${seqOf.get(a['isolate_id'])}/ast/${a['antibiotic_code']}`;
      const hasValue = typeof a['raw_value'] === 'string' && a['raw_value'].length > 0 && typeof a['category_code'] === 'string' && a['category_code'].length > 0;
      const e = err(path, hasValue ? 'Standard and version required' : 'Value and category required');
      errs.push(e); if (hasValue) standardOnly.add(e);
    }
    if (outcomeCode === 'no_growth' && earlyReason === null && row['final_due_at'] != null && nowOf(c).getTime() < new Date(row['final_due_at']).getTime()) {
      const settings = await cfg.getSettings(tx, { tenantId });
      if (settings?.['early_final_requires_reason'] !== false) errs.push(err('/early_final_reason', 'Reason required for a final before the due time', 'common.field_required'));   // AC-10.3
    }
  }
  if (errs.length > 0) throw new LimsError(errs.every((e) => standardOnly.has(e)) ? 'micro.ast_standard_required' : 'micro.report_incomplete', undefined, errs);

  // ---- snapshot (+ size guard, then ajv: a failure there is a programming error)
  const growthCodes = new Map<string, Row>(), organisms = new Map<string, Row>(), antibiotics = new Map<string, Row>();
  const uniq = (xs: unknown[]): string[] => [...new Set(xs.filter((x): x is string => typeof x === 'string'))];
  for (const [m, view, codes] of [[growthCodes, 'v_growth_codes', observations.map((o) => o['growth_code'])], [organisms, 'v_organisms', shown.map((i) => i['organism_code'])],
    [antibiotics, 'v_antibiotics', astRows.map((a) => a['antibiotic_code'])]] as const) {
    for (const [key, r] of await repo.viewRows(tx, { view, tenantId, codes: uniq(codes as unknown[]) })) m.set(key, r);
  }
  const pick = (m: Map<string, Row>): Record<string, string> => Object.fromEntries([...m].map(([key, r]) => [key, String(r['display'])]));
  const snap = buildSnapshot({
    phase, isolates: isolateRows, ast: astRows, observations, organisms: pick(organisms), antibiotics: pick(antibiotics), summaryText: summary, isCritical,
    growthCodes: Object.fromEntries([...growthCodes].map(([key, r]) => [key, { display: String(r['display']), indicates_growth: r['indicates_growth'] === true }])),
    outcome: outcome === undefined ? undefined : { code: String(outcome['code']), display: String(outcome['display']), result_flag: outcome['result_flag'] === 'A' ? 'A' : 'N' },
  });
  validateSnapshot(snap);

  // ---- C5 chain state -> amendment (02-TRD §4.7, 08 A17 D-61/D-62)
  const lab = c.ports?.LabPort as Lab | undefined;
  if (!lab) throw new LimsError('common.internal');
  const line = labLine(await lab.getOrderResults(c, { orderId: row['order_id'], scope: 'all_visible' }), row);
  let amendment: { reasonCode: string; reasonText?: string } | undefined;
  if (status === 'amending') {
    if (typeof row['amendment_reason_code'] !== 'string' || row['amendment_reason_code'] === '') throw new LimsError('micro.amendment_reason_required');
    amendment = { reasonCode: row['amendment_reason_code'], ...(row['amendment_reason_text'] == null ? {} : { reasonText: String(row['amendment_reason_text']) }) };
  } else if (line?.['status'] === 'approved' && line['moduleRef']?.['module'] === 'micro' && line['moduleRef']['entityId'] === cultureId
    && await repo.versionPhase(tx, { ...k, versionNo: Number(line['moduleRef']['versionNo']) }) === 'preliminary') {
    amendment = { reasonCode: phase === 'final' ? 'module_phase_progression' : 'module_preliminary_update' };   // D-61: automatic, never client-chosen
  }

  const versionNo = Number(row['current_report_version_no']) + 1;
  const now = nowOf(c);
  const out = await lab.submitModuleResult(c, {
    orderItemId: row['order_item_id'], kind: snap.submission_kind, reportPhase: phase, payloadRef: { module: 'micro', entityId: cultureId, versionNo },
    summaryText: snap.culture_summary_text, flag: snap.flag, isCritical: snap.is_critical, submittedAt: now.toISOString(), idempotencyKey: `micro:${cultureId}:${versionNo}`,
    ...(amendment ? { amendment } : {}),
  });

  // ---- writes (after the port: AC-09.2)
  const kind = amendment ? 'amendment' : versionNo === 1 ? 'initial' : 'update';
  const stored = {
    version_no: versionNo, report_phase: phase, version_kind: kind, outcome_code: phase === 'final' ? outcomeCode : null, flag: snap.flag, is_critical: snap.is_critical,
    signed_by_membership_id: membershipId, signed_at: now, lab_status_at_submit: out['status'], amendment_reason_code: amendment?.reasonCode ?? null,
    culture_summary_text: snap.culture_summary_text, isolates: snap.isolates, ast: snap.ast, comments_text: comments, early_final_reason: earlyReason,
    amendment_reason_text: amendment?.reasonText ?? null, lab_result_id: out['resultId'], lab_result_version_no: out['versionNo'],
  };
  await guarded(async () => {
    await repo.insertVersion(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, orderItemId: row['order_item_id'], versionNo, phase, kind, submissionKind: snap.submission_kind,
      outcomeCode: stored.outcome_code ?? null, earlyFinalReason: earlyReason, amendmentReasonCode: stored.amendment_reason_code, amendmentReasonText: stored.amendment_reason_text,
      summary: snap.culture_summary_text, isolates: snap.isolates, ast: snap.ast, comments, isCritical: snap.is_critical, flag: snap.flag, membershipId, signedAt: now,
      labResultId: out['resultId'], labResultVersionNo: out['versionNo'], labStatus: out['status'], labReplayed: out['replayed'] === true, userId });
    await repo.updateAfterSubmit(tx, { tenantId, id: cultureId, versionNo, phase, status: toStatus, outcomeCode: stored.outcome_code ?? null, userId });
    if (toStatus !== status) await cultureRepo.insertTransition(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, from: status, to: toStatus, reason: null, occurredAt: now.toISOString(), userId });
  });
  const name = await memberNames(c, [membershipId]);
  return dto.versionDto(stored, name(membershipId));
}

// ================================================================ T-16: M17 reopenCulture (C8), M18 cancelCulture (C9)
// (02-TRD §4.7, §5 M17/M18; 03-APP-FLOW §2.1; PRD AC-11.1–11.6, AC-01.6; 07-SECURITY S-05, S-30; 08 R1 / CR-C10-001, A17 D-62). Order: culture FOR UPDATE (404) -> micro.culture.work with its centre (403)
// -> body (400; M17 without a code = 422) -> If-Match (428 / 409) -> state (409). The request transaction rolls back on any throw; nothing is logged.
// [CONV] M17 checks the reason code's FORMAT only (the micro.yaml pattern); whether C5 accepts it is decided at M14 and surfaces there as lab.module_result_invalid (D-62).
// [CONV] M18 on a culture with a submitted version needs the C5 line `cancelled` (getOrderResults all_visible; a port error propagates), else micro.culture_invalid_transition.
// [CONV] system cancel codes are written by the consumer / reconciliation only; a person cannot send them.
type Out = { body: Row; version: number };
const AMENDMENT_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const SYSTEM_CANCEL_CODES = ['specimen_rejected', 'order_item_cancelled'];

export async function reopenCulture(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row } = await loadReportCulture(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['amendment_reason_code', 'amendment_reason_text']);
  const raw = b['amendment_reason_code'];
  if (raw === undefined || raw === '') throw new LimsError('micro.amendment_reason_required');           // AC-11.4
  const reasonCode = typeof raw === 'string' && AMENDMENT_CODE.test(raw) ? raw : bad('/amendment_reason_code');
  const reasonText = b['amendment_reason_text'] === undefined ? null : str(b['amendment_reason_text'], '/amendment_reason_text', 500);
  const expected = needVersion(input.ifMatch);
  if (Number(row['version']) !== expected) conflict();
  nextCultureStatus(row['status'] as CultureStatus, 'reopen', { reasonCode });                           // C8: only final_submitted

  const cultureId = row['id'] as string;
  await guarded(async () => {
    if (!await cultureRepo.reopenCulture(tx, { tenantId, id: cultureId, expectedVersion: expected, userId, reasonCode, reasonText })) conflict();
    await cultureRepo.insertTransition(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, from: 'final_submitted', to: 'amending', reason: reasonCode, occurredAt: nowOf(c).toISOString(), userId });
  });
  const fresh = (await cultureRepo.reloadCulture(tx, { tenantId, id: cultureId }))!;
  return { body: await cultureDetail(c, tx, tenantId, fresh), version: Number(fresh['version']) };
}

export async function cancelCulture(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row } = await loadReportCulture(c, input.params);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['reason_code', 'comment']);
  const reasonCode = code(b['reason_code'], '/reason_code');
  const comment = b['comment'] === undefined ? null : str(b['comment'], '/comment', 500);
  const reason = (await sets.codeRows(tx, { view: 'culture_cancel_reasons', tenantId, codes: [reasonCode] })).get(reasonCode);
  if (reason?.['is_active'] !== true || SYSTEM_CANCEL_CODES.includes(reasonCode)) bad('/reason_code');
  const expected = needVersion(input.ifMatch);
  if (Number(row['version']) !== expected) conflict();
  const status = row['status'] as CultureStatus;
  nextCultureStatus(status, 'cancel');                                                                    // C9: open states only

  if (Number(row['current_report_version_no']) > 0) {                                                     // a submitted version: only a cancelled C5 line releases it
    const lab = c.ports?.LabPort as Lab | undefined;
    if (!lab) throw new LimsError('common.internal');
    if (labLine(await lab.getOrderResults(c, { orderId: row['order_id'], scope: 'all_visible' }), row)?.['status'] !== 'cancelled') throw new LimsError('micro.culture_invalid_transition');
  }
  const cultureId = row['id'] as string;
  await guarded(async () => {
    if (!await cultureRepo.cancelCulture(tx, { tenantId, id: cultureId, expectedVersion: expected, userId, reasonCode, comment })) conflict();
    await cultureRepo.insertTransition(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, from: status, to: 'cancelled', reason: reasonCode, occurredAt: nowOf(c).toISOString(), userId });
    await cultureRepo.releaseOpenRecords(tx, { tenantId, cultureId, userId });
  });
  const fresh = (await cultureRepo.reloadCulture(tx, { tenantId, id: cultureId }))!;
  return { body: dto.cultureSummaryDto(fresh, await testLookup(c)(fresh['test_id']), nowOf(c)), version: Number(fresh['version']) };
}
