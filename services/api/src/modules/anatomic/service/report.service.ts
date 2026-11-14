// Report draft — R1 getAnatomicReportDraft, R2 saveAnatomicReportDraft (02-TRD §5.3 R1/R2, §4.5.2 instance values, §4.6 plain text, §5 D-66 (b), §10.2 max_report_images;
// 01-PRD AC-07.1, 07.3–07.6, AC-08.5/08.6 draft side). Order: load case (404) -> IdentityPort.assertRole(case centre) -> state guard -> If-Match -> body (all errors together)
// -> version check -> write. Nothing submitted (texts, codes, captions) is echoed in an error or logged (REQ-SEC-098); a throw rolls the caller's transaction back.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { CaseStatus } from '../domain/case.state.js';
import { validateMolecularResult } from '../domain/molecular.js';
import { normalizePlainText } from '../domain/plaintext.js';
import { buildContent, summarise } from '../domain/report-content.js';
import { missingRequiredFields, validateSynopticValues } from '../domain/synoptic.js';
import { listAddenda } from '../repository/addenda.repo.js';
import { getBatch } from '../repository/batches.repo.js';
import { getBlock } from '../repository/blocks.repo.js';
import { insertCaseTransition, listCaseItems, updateCase } from '../repository/cases.repo.js';
import { listCodedCytologyAdequacies, listCodedDiagnoses } from '../repository/codedValues.repo.js';
import { getSettings, listStains } from '../repository/config.repo.js';
import { getOpenDraft, insertReportDraft, updateReportDraft } from '../repository/drafts.repo.js';
import { getImage } from '../repository/images.repo.js';
import { listMolecularResults } from '../repository/molecular.repo.js';
import { listParts } from '../repository/parts.repo.js';
import { listSlides } from '../repository/slides.repo.js';
import { getStainOrder } from '../repository/stainOrders.repo.js';
import { insertItemSubmission, listItemSubmissions } from '../repository/submissions.repo.js';
import { getSynopticTemplate } from '../repository/templates.repo.js';
import { insertReportVersion } from '../repository/versions.repo.js';
import type { Row } from '../repository/_sql.js';
import { anatomicCtx, assertAt, caseDto, isObj, iso, loadCase, put, strict, UUID } from './case.service.js';
import { ifMatch } from './gross.service.js';
import { loadAssay } from './molecular.service.js';
import type { AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };

const DEFAULT_MAX_REPORT_IMAGES = 12; // 05-SCHEMA settings.max_report_images DEFAULT 12
const MAX_DIAGNOSIS_PAGE = 500;
const BODY_KEYS = ['gross_text', 'microscopy_text', 'impression_text', 'comment_text', 'flag', 'is_critical', 'synoptic', 'image_ids', 'ancillary', 'diagnosis_codes'] as const;
const TEXT_LIMITS = { gross_text: 20000, microscopy_text: 20000, impression_text: 8000, comment_text: 8000 } as const;

export const fieldError = (path: string, code = 'common.field_invalid', message = 'Field invalid'): FieldError => ({ path, code, message });
const denied = (code: string): LimsError => new LimsError(code);

/** Closed object: unknown keys are collected (never echoed); false = not an object. */
export function closed(v: unknown, allowed: readonly string[], path: string, errs: FieldError[]): v is Obj {
  if (!isObj(v)) { errs.push(fieldError(path)); return false; }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errs.push(fieldError(`${path}/${k}`, 'common.unknown_field', 'Unknown field'));
  return true;
}

/** Plain text field (02-TRD §4.6): string without NUL, normalised, then length-checked on the stored form. */
export function plain(v: unknown, path: string, max: number, errs: FieldError[], min = 0): string {
  if (v === undefined) return '';
  if (typeof v !== 'string' || v.includes('\u0000')) { errs.push(fieldError(path)); return ''; }
  const n = normalizePlainText(v);
  if (n.length > max || n.length < min) errs.push(fieldError(path));
  return n;
}

/** [CONV] AC-07.3 has no endpoint (UI button): one line per part in letter order, "A. <site>: <gross text>"; only parts with a completed gross record. */
export function composeGrossFromParts(i: { parts: ReadonlyArray<Row>; gross: ReadonlyArray<Row> }): string {
  const done = new Map(i.gross.filter((g) => g['is_complete'] === true).map((g) => [g['part_id'], g]));
  return [...i.parts]
    .sort((a, b) => String(a['letter']).length - String(b['letter']).length || (String(a['letter']) < String(b['letter']) ? -1 : String(a['letter']) > String(b['letter']) ? 1 : 0))
    .filter((p) => done.has(p['id']))
    .map((p) => `${String(p['letter'])}. ${String(p['site_text'])}: ${normalizePlainText(String(done.get(p['id'])!['gross_text'] ?? ''))}`)
    .join('\n');
}

/** Tenant diagnoses by code (all pages). activeOnly = validation of new input (AC-07.6); false = display lookup of stored codes. */
export async function diagnosisByCode(c: AnatomicCtx, activeOnly: boolean): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (let offset = 0; ; offset += MAX_DIAGNOSIS_PAGE) {
    const rows = await listCodedDiagnoses(c.tx, { tenantId: c.tenantId, activeOnly, limit: MAX_DIAGNOSIS_PAGE, offset });
    for (const r of rows) out.set(r['code'], r);
    if (rows.length < MAX_DIAGNOSIS_PAGE) return out;
  }
}

export async function draftDto(c: AnatomicCtx, d: Row, diagnoses: Map<string, Row>): Promise<Obj> {
  let by = '';
  try { by = String((await (c.core as unknown as { user(ctx: unknown, i: { userId: string }): Promise<{ displayName: string }> }).user(c, { userId: d['updated_by'] })).displayName); } catch (e) { if (!(e instanceof LimsError)) throw e; }
  const synoptic: Obj[] = [];
  for (const s of (d['synoptic'] ?? []) as Obj[]) {
    const o: Obj = { template_id: s['template_id'], template_key: s['template_key'], template_version: s['template_version'] };
    let title = s['title'];
    if (typeof title !== 'string') title = (await getSynopticTemplate(c.tx, { tenantId: c.tenantId, id: String(s['template_id']) }))?.['title'];
    put(o, 'title', title); // [CONV] instances saved without a title snapshot take it from the template row
    o['values'] = s['values'] ?? {};
    synoptic.push(o);
  }
  const o: Obj = { case_id: d['case_id'], kind: d['kind'] };
  put(o, 'change_reason_code', d['change_reason_code']); put(o, 'change_reason_text', d['change_reason_text']);
  o['gross_text'] = d['gross_text'] ?? ''; o['microscopy_text'] = d['microscopy_text'] ?? ''; o['impression_text'] = d['impression_text'] ?? ''; o['comment_text'] = d['comment_text'] ?? '';
  put(o, 'flag', d['flag']);
  o['is_critical'] = d['is_critical'] === true;
  o['synoptic'] = synoptic;
  o['image_ids'] = [...((d['image_ids'] ?? []) as string[])];
  o['ancillary'] = ((d['ancillary'] ?? []) as Obj[]).map((a) => ({ stain_order_id: a['stain_order_id'], result_text: a['result_text'] }));
  o['diagnosis_codes'] = ((d['diagnosis_codes'] ?? []) as string[]).map((code) => {
    const r = diagnoses.get(code);
    const e: Obj = { code, display: r?.['display'] ?? code, system: r?.['system'] ?? 'local' }; // a code is never deleted; fallback only keeps the answer well-formed
    put(e, 'system_version', r?.['system_version']);
    return e;
  });
  o['updated_at'] = iso(d['updated_at']); o['updated_by_display_name'] = by; o['version'] = Number(d['version']);
  return o;
}

// ---- R1 getAnatomicReportDraft ----
export async function getReportDraft(hctx: unknown, params: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.read', cs);
  const d = await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  if (!d) throw new LimsError('common.not_found');
  const wants = ((d['diagnosis_codes'] ?? []) as string[]).length > 0;
  return { status: 200, body: await draftDto(c, d, wants ? await diagnosisByCode(c, false) : new Map()) };
}

// ---- R2 saveAnatomicReportDraft ----
export async function saveReportDraft(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);

  const status = cs['status'] as CaseStatus;
  if (status === 'received' || status === 'cancelled') throw new LimsError('anatomic.case_invalid_transition'); // drafts start at accessioned (§7)
  const open = await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  if (status === 'signed_out' && !open) throw new LimsError('anatomic.signout_locked'); // D-66 (b): only an open revision/amendment draft is editable

  const version = ifMatch(headers, true);
  const b = strict(body, BODY_KEYS);
  const errs: FieldError[] = [];

  const texts = {
    gross_text: plain(b['gross_text'], '/gross_text', TEXT_LIMITS.gross_text, errs),
    microscopy_text: plain(b['microscopy_text'], '/microscopy_text', TEXT_LIMITS.microscopy_text, errs),
    impression_text: plain(b['impression_text'], '/impression_text', TEXT_LIMITS.impression_text, errs),
    comment_text: plain(b['comment_text'], '/comment_text', TEXT_LIMITS.comment_text, errs),
  };
  let flag: string | null = null;
  if (b['flag'] !== undefined) { if (b['flag'] === 'N' || b['flag'] === 'A') flag = b['flag']; else errs.push(fieldError('/flag')); }
  let critical = false;
  if (b['is_critical'] !== undefined) { if (typeof b['is_critical'] === 'boolean') critical = b['is_critical']; else errs.push(fieldError('/is_critical')); }

  // images: shape here, ownership + limit below
  const imageIds: string[] = [];
  const imageChecks: [number, string][] = [];
  if (b['image_ids'] !== undefined) {
    const v = b['image_ids'];
    if (!Array.isArray(v) || v.length > 24) errs.push(fieldError('/image_ids'));
    else {
      const seen = new Set<string>();
      v.forEach((id, k) => {
        if (typeof id !== 'string' || !UUID.test(id) || seen.has(id.toLowerCase())) { errs.push(fieldError(`/image_ids/${k}`)); return; } // [CONV] duplicates would print twice
        seen.add(id.toLowerCase()); imageIds.push(id); imageChecks.push([k, id]);
      });
    }
  }

  // diagnosis codes: shape here, activeness below
  const codes: string[] = [];
  const codeChecks: [number, string][] = [];
  if (b['diagnosis_codes'] !== undefined) {
    const v = b['diagnosis_codes'];
    if (!Array.isArray(v) || v.length > 20) errs.push(fieldError('/diagnosis_codes'));
    else v.forEach((row, k) => {
      const ok = closed(row, ['code'], `/diagnosis_codes/${k}`, errs);
      const code = ok ? (row as Obj)['code'] : undefined;
      if (!ok) return;
      if (typeof code !== 'string' || code === '' || code.length > 64 || code.includes('\u0000')) { errs.push(fieldError(`/diagnosis_codes/${k}/code`)); return; }
      if (codes.includes(code)) { errs.push(fieldError(`/diagnosis_codes/${k}/code`)); return; } // [CONV] a code once
      codes.push(code); codeChecks.push([k, code]);
    });
  }

  // ancillary
  const ancillary: { stain_order_id: string; result_text: string }[] = [];
  const stainChecks: [number, string][] = [];
  if (b['ancillary'] !== undefined) {
    const v = b['ancillary'];
    if (!Array.isArray(v) || v.length > 50) errs.push(fieldError('/ancillary'));
    else v.forEach((row, k) => {
      if (!closed(row, ['stain_order_id', 'result_text'], `/ancillary/${k}`, errs)) return;
      const id = row['stain_order_id'];
      const idOk = typeof id === 'string' && UUID.test(id);
      if (!idOk) errs.push(fieldError(`/ancillary/${k}/stain_order_id`));
      const result = plain(row['result_text'], `/ancillary/${k}/result_text`, 2000, errs, 1);
      if (row['result_text'] === undefined) errs.push(fieldError(`/ancillary/${k}/result_text`));
      if (idOk) { ancillary.push({ stain_order_id: id, result_text: result }); stainChecks.push([k, id]); }
    });
  }

  // synoptic instances
  const synoptic: Obj[] = [];
  const unpublished: boolean[] = [];
  if (b['synoptic'] !== undefined) {
    const v = b['synoptic'];
    if (!Array.isArray(v) || v.length > 5) errs.push(fieldError('/synoptic'));
    else {
      const kept = new Set(((open?.['synoptic'] ?? []) as Obj[]).map((s) => s['template_id'])); // AC-08.4: an instance already in the draft keeps its version
      for (const [k, row] of v.entries()) {
        const p = `/synoptic/${k}`;
        if (!closed(row, ['template_id', 'values'], p, errs)) continue;
        const id = row['template_id'];
        if (typeof id !== 'string' || !UUID.test(id)) { errs.push(fieldError(`${p}/template_id`)); continue; }
        const t = await getSynopticTemplate(c.tx, { tenantId: c.tenantId, id });
        if (!t || (Array.isArray(t['applies_to_case_kinds']) && !t['applies_to_case_kinds'].includes(cs['case_kind']))) { errs.push(fieldError(`${p}/template_id`)); continue; }
        const checked = validateSynopticValues(t['definition'], row['values'] ?? {});
        if (!checked.ok) for (const e of checked.errors) errs.push(fieldError(`${p}${e.path}`));
        else if (t['status'] !== 'published' && !kept.has(id)) unpublished.push(true);
        else synoptic.push({ template_id: id, template_key: t['template_key'], template_version: Number(t['version_no']), title: t['title'], values: row['values'] ?? {} });
      }
    }
  }

  // reads that need ids: still before any write, still reported together
  if (stainChecks.length > 0) {
    for (const [k, id] of stainChecks) {
      const so = await getStainOrder(c.tx, { tenantId: c.tenantId, id });
      if (!so || so['case_id'] !== cs['id']) errs.push(fieldError(`/ancillary/${k}/stain_order_id`));
    }
  }
  for (const [k, id] of imageChecks) {
    const img = await getImage(c.tx, { tenantId: c.tenantId, id });
    if (!img || img['case_id'] !== cs['id'] || img['is_active'] === false) errs.push(fieldError(`/image_ids/${k}`)); // [CONV] a deactivated image cannot be placed on the report
  }
  const active = codeChecks.length > 0 ? await diagnosisByCode(c, true) : new Map<string, Row>();
  for (const [k, code] of codeChecks) if (!active.has(code)) errs.push(fieldError(`/diagnosis_codes/${k}/code`)); // AC-07.6
  if (errs.length > 0) throw new LimsError('common.validation_failed', undefined, errs);

  if (unpublished.length > 0) throw denied('anatomic.template_not_published'); // AC-08.6
  const settings = await getSettings(c.tx, { tenantId: c.tenantId });
  const maxImages = Number(settings?.['max_report_images'] ?? DEFAULT_MAX_REPORT_IMAGES);
  if (imageIds.length > maxImages) throw denied('anatomic.image_limit_reached'); // AC-07.5

  const content: Row = { ...texts, flag, is_critical: critical, synoptic, ancillary, image_ids: imageIds, diagnosis_codes: codes };
  let saved: Row | undefined;
  if (version === 0) {
    if (open) throw new LimsError('common.version_conflict');
    try {
      saved = await insertReportDraft(c.tx, { id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], kind: 'initial', ...content, created_by: c.actor.id, updated_by: c.actor.id });
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === '23505') throw new LimsError('common.version_conflict'); // lost the open/initial unique-index race
      throw e;
    }
  } else {
    if (!open || Number(open['version']) !== version) throw new LimsError('common.version_conflict');
    saved = await updateReportDraft(c.tx, { tenantId: c.tenantId, id: open['id'], expectedVersion: version, actorId: c.actor.id, patch: content }); // PUT: omitted = reset
  }
  if (!saved) throw new LimsError('common.version_conflict');
  return { status: 200, body: await draftDto(c, saved, active) };
}

// ---- R3 signOutAnatomicCase (02-TRD §4.4 steps 1–10) ----
export interface SignCtx extends AnatomicCtx {
  readonly actor: { readonly id: string; readonly membershipId?: string; readonly type?: string };
  readonly audit: { access(entry: Record<string, unknown>): Promise<void> };
  readonly ports: AnatomicCtx['ports'] & {
    readonly LabPort: { submitModuleResult(ctx: unknown, i: Obj): Promise<{ resultId: string; versionNo: number; status: string; replayed: boolean }> };
    readonly FrontdeskPort: { getOrderSummary(ctx: unknown, i: { orderId: string }): Promise<{ items: ReadonlyArray<{ orderItemId: string; status: string }> }> };
  };
}

export const dup = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === '23505';
/** [CONV] AC-09.4 / 08 A17 P-23: the port's code passes through unchanged. A port built on contracts/ports/common.ts throws that file's LimsError class, which the core
 *  problem renderer would turn into 500 common.internal; it is re-raised as the core LimsError with the SAME code (no detail: never echo port text). Anything else is rethrown as is. */
export function portError(e: unknown): unknown {
  if (e instanceof LimsError) return e;
  const x = e as { name?: unknown; code?: unknown } | null;
  if (e instanceof Error && x?.constructor?.name === 'LimsError' && typeof x.code === 'string') return new LimsError(x.code);
  return e;
}
const blank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';

export async function displayName(c: AnatomicCtx, userId: string): Promise<string> {
  try { return String((await (c.core as unknown as { user(ctx: unknown, i: { userId: string }): Promise<{ displayName: string }> }).user(c, { userId })).displayName ?? ''); } catch (e) { if (!(e instanceof LimsError)) throw e; return ''; }
}
export async function stainDisplays(c: AnatomicCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += 500) {
    const rows = await listStains(c.tx, { tenantId: c.tenantId, limit: 500, offset });
    for (const r of rows) out.set(r['code'], r['display']);
    if (rows.length < 500) return out;
  }
}
async function adequacyDisplays(c: AnatomicCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += 500) {
    const rows = await listCodedCytologyAdequacies(c.tx, { tenantId: c.tenantId, limit: 500, offset });
    for (const r of rows) out.set(r['code'], r['display']);
    if (rows.length < 500) return out;
  }
}

export async function signOut(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx) as SignCtx;
  // 1. load + lock (the row lock serialises a double click until the request transaction ends)
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined, true);
  await c.ports.IdentityPort.assertRole(c, { permission: 'anatomic.case.signout', centreId: cs['centre_id'] }); // REQ-SEC-062/067 (aal2 enforced by IdentityPort)
  if (c.actor.type !== 'user') throw new LimsError('auth.forbidden'); // 02-TRD §3.2 DECISION: a system actor never signs
  const b = strict(body, ['attest']);
  if (b['attest'] !== true) throw new LimsError('common.validation_failed', undefined, [fieldError('/attest')]);

  // 2. open draft + If-Match (draft version)
  const draft = await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  if (!draft) throw new LimsError('anatomic.case_invalid_transition');
  const version = ifMatch(headers, false);
  if (Number(draft['version']) !== version) throw new LimsError('common.version_conflict');

  // 3. state guard (§7)
  const initial = draft['kind'] === 'initial';
  if (cs['status'] !== (initial ? 'ready_for_reporting' : 'signed_out')) throw new LimsError('anatomic.case_invalid_transition');

  // 4. completeness (§4.5.3) — every error together
  const errs: FieldError[] = [];
  if (cs['case_kind'] === 'histology' && blank(draft['gross_text'])) errs.push(fieldError('/gross_text'));
  if (blank(draft['impression_text'])) errs.push(fieldError('/impression_text'));
  const synoptic: { template_key: string; template_version: number; definition: unknown; values: unknown }[] = [];
  for (const [k, s] of ((draft['synoptic'] ?? []) as Obj[]).entries()) {
    const t = await getSynopticTemplate(c.tx, { tenantId: c.tenantId, id: String(s['template_id']) });
    if (!t) { errs.push(fieldError(`/synoptic/${k}/template_id`)); continue; }
    for (const p of missingRequiredFields(t['definition'], s['values'])) errs.push(fieldError(`/synoptic/${k}${p}`));
    synoptic.push({ template_key: String(s['template_key'] ?? t['template_key']), template_version: Number(s['template_version'] ?? t['version_no']), definition: t['definition'], values: s['values'] ?? {} });
  }
  const images: Row[] = [];
  for (const [k, id] of ((draft['image_ids'] ?? []) as string[]).entries()) {
    const img = await getImage(c.tx, { tenantId: c.tenantId, id });
    if (!img || img['case_id'] !== cs['id'] || img['is_active'] === false || img['state'] !== 'ready') errs.push(fieldError(`/image_ids/${k}`));
    else images.push(img);
  }
  const ancillaryIn: { so: Row; result_text: unknown }[] = [];
  for (const [k, a] of ((draft['ancillary'] ?? []) as Obj[]).entries()) {
    const so = await getStainOrder(c.tx, { tenantId: c.tenantId, id: String(a['stain_order_id']) });
    if (!so || so['case_id'] !== cs['id'] || so['status'] !== 'completed') errs.push(fieldError(`/ancillary/${k}/stain_order_id`));
    else ancillaryIn.push({ so, result_text: a['result_text'] });
  }
  const molecular: Obj[] = [];
  if (cs['case_kind'] === 'molecular') {
    const rows = (await listMolecularResults(c.tx, { tenantId: c.tenantId, caseId: cs['id'], activeOnly: true })).filter((r) => r['is_active'] !== false);
    if (rows.length === 0) errs.push(fieldError('/molecular'));
    const assays = new Map<string, Awaited<ReturnType<typeof loadAssay>>>();
    for (const [k, r] of rows.entries()) {
      const code = String(r['assay_code']);
      if (!assays.has(code)) assays.set(code, await loadAssay(c, code));
      const a = assays.get(code);
      if (!a) { errs.push(fieldError(`/molecular/${k}/assay_code`)); continue; }
      const input = { assay_code: code, target_code: String(r['target_code']), result_code: String(r['result_code']),
        ...(r['value_decimal'] != null ? { value_decimal: String(r['value_decimal']) } : {}), ...(r['unit_code'] != null ? { unit_code: String(r['unit_code']) } : {}) };
      const checked = validateMolecularResult(a.def, input);
      if (!checked.ok) { for (const e of checked.errors) errs.push(fieldError(`/molecular/${k}${e.path}`)); continue; }
      const t = a.targets.get(input.target_code)!, v = t.values.get(input.result_code)!;
      const batch = r['batch_id'] ? await getBatch(c.tx, { tenantId: c.tenantId, id: String(r['batch_id']) }) : undefined;
      molecular.push({ ...r, assay_display: a.row['display'], target_display: t.row['display'], result_display: v['display'], is_abnormal: !!v['is_abnormal'],
        kit_expiry_on: r['kit_expiry_on'] instanceof Date ? iso(r['kit_expiry_on'])!.slice(0, 10) : r['kit_expiry_on'], batch_no: batch?.['batch_no'] });
    }
  }
  if (errs.length > 0) throw new LimsError('anatomic.report_incomplete', undefined, errs);

  // 5. targets = active primary items (case_item id order); each must still be active at the front desk (AC-09.9)
  const targets = (await listCaseItems(c.tx, { tenantId: c.tenantId, caseId: cs['id'], activeOnly: true }))
    .filter((it) => it['role'] === 'primary' && it['is_active'] !== false).sort((x, y) => (x['id'] < y['id'] ? -1 : x['id'] > y['id'] ? 1 : 0));
  if (targets.length === 0) throw new LimsError('anatomic.case_invalid_transition'); // [CONV] nothing to hand to C5
  const order = await c.ports.FrontdeskPort.getOrderSummary(c, { orderId: cs['order_id'] });
  for (const it of targets) {
    const fd = order.items.find((x) => x.orderItemId === it['order_item_id']);
    if (fd?.status !== 'active') throw new LimsError('anatomic.order_item_inactive', `order item ${String(it['order_item_id'])} is not active`);
  }

  // 6. content (in memory) + amendment
  const n = Number(cs['current_version_no'] ?? 0) + 1;
  const now = c.now();
  const parts = await listParts(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  const slides = (await listSlides(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).filter((s) => s['include_in_report'] === true);
  const stains = slides.length || ancillaryIn.length ? await stainDisplays(c) : new Map<string, string>();
  const adequacy = slides.some((s) => s['adequacy_code']) ? await adequacyDisplays(c) : new Map<string, string>();
  const ancillary: Obj[] = [];
  for (const { so, result_text } of ancillaryIn) {
    const block = so['block_id'] ? await getBlock(c.tx, { tenantId: c.tenantId, id: String(so['block_id']) }) : undefined;
    ancillary.push({ stain_kind: so['stain_kind'], stain_code: so['stain_code'], stain_display: stains.get(so['stain_code']) ?? so['stain_code'], block_label: block?.['label'], result_text });
  }
  const codes = (draft['diagnosis_codes'] ?? []) as string[];
  const diagnoses = codes.length ? await diagnosisByCode(c, false) : new Map<string, Row>();
  const addenda = initial ? [] : (await listAddenda(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).filter((a) => a['status'] === 'signed' && a['addon_case_item_id'] == null); // §4.4: full versions carry the case addenda
  const content = buildContent({
    scope: 'full', clinical_history_text: cs['clinical_history_text'],
    draft: { gross_text: draft['gross_text'], microscopy_text: draft['microscopy_text'], impression_text: draft['impression_text'], comment_text: draft['comment_text'], flag: draft['flag'], is_critical: draft['is_critical'] === true },
    parts, synoptic, images, molecular, addenda, ancillary,
    slides: slides.map((s) => ({ label: s['label'], stain_display: stains.get(s['stain_code']) ?? s['stain_code'], adequacy_display: s['adequacy_code'] ? adequacy.get(s['adequacy_code']) ?? s['adequacy_code'] : undefined, finding_text: s['finding_text'], include_in_report: true })),
    diagnosis_codes: codes.map((code) => { const r = diagnoses.get(code); return { code, display: r?.['display'] ?? code, system: r?.['system'] ?? 'local', system_version: r?.['system_version'] }; }),
  });
  const amendment = initial ? undefined : { reasonCode: draft['change_reason_code'], ...(draft['change_reason_text'] ? { reasonText: draft['change_reason_text'] } : {}) };

  // 7. port calls FIRST, every target; a port error is rethrown unchanged (08 A17 P-23) and the request transaction rolls back
  const prior = await listItemSubmissions(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  const summaryText = summarise(content.impression_text);
  const outs: { it: Row; v: number; key: string; out: Awaited<ReturnType<SignCtx['ports']['LabPort']['submitModuleResult']>> }[] = [];
  for (const it of targets) {
    const v = 1 + prior.filter((s) => s['case_item_id'] === it['id']).reduce((m, s) => Math.max(m, Number(s['item_version_no'])), 0);
    const key = `anatomic:${String(it['id'])}:${v}`;
    const input: Obj = {
      orderItemId: it['order_item_id'], kind: cs['case_kind'] === 'molecular' ? 'structured' : 'narrative', reportPhase: 'final',
      payloadRef: { module: 'anatomic', entityId: it['id'], versionNo: v }, summaryText, submittedAt: now.toISOString(), idempotencyKey: key,
    };
    put(input, 'flag', draft['flag']);
    if (draft['is_critical'] === true) input['isCritical'] = true;
    if (amendment) input['amendment'] = amendment;
    try {
      outs.push({ it, v, key, out: await c.ports.LabPort.submitModuleResult(c, input) });
    } catch (e) {
      throw portError(e);
    }
  }

  // 8. version_kind decided once, after every port call; then report_versions, then item_submissions
  const versionKind = initial ? 'original' : outs.some((o) => o.out.status === 'approved') ? 'amendment' : String(draft['kind']);
  const signedAt = now.toISOString();
  let ver: Row;
  try {
    ver = await insertReportVersion(c.tx, {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], version_no: n, version_kind: versionKind, scope: 'full',
      change_reason_code: initial ? null : draft['change_reason_code'], change_reason_text: initial ? null : draft['change_reason_text'], ...content,
      signed_by_membership_id: c.actor.membershipId, signed_at: signedAt, created_by: c.actor.id,
    });
    for (const o of outs) {
      await insertItemSubmission(c.tx, {
        id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], case_item_id: o.it['id'], item_version_no: o.v, report_version_id: ver['id'], idempotency_key: o.key,
        lab_result_id: o.out.resultId, lab_version_no: o.out.versionNo, lab_status: o.out.status, replayed: o.out.replayed === true, submitted_at: signedAt, created_by: c.actor.id,
      });
    }
  } catch (e) {
    if (dup(e)) throw new LimsError('common.version_conflict'); // a parallel sign-out won
    throw e;
  }

  // 9. case + draft
  const updated = await updateCase(c.tx, { tenantId: c.tenantId, id: cs['id'], expectedVersion: Number(cs['version']), actorId: c.actor.id,
    patch: { status: 'signed_out', current_version_no: n, signed_out_at: cs['signed_out_at'] ? undefined : signedAt } }); // signed_out_at: first time only
  if (!updated) throw new LimsError('common.version_conflict');
  if (cs['status'] !== 'signed_out') {
    await insertCaseTransition(c.tx, { id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], from_status: cs['status'], to_status: 'signed_out', created_by: c.actor.id });
  }
  const consumed = await updateReportDraft(c.tx, { tenantId: c.tenantId, id: draft['id'], expectedVersion: version, actorId: c.actor.id,
    patch: { status: 'consumed', consumed_version_no: n, consumed_at: signedAt } });
  if (!consumed) throw new LimsError('common.version_conflict');

  await c.audit.access({ action: 'anatomic_report.sign_out', entityType: 'anatomic_case', entityId: cs['id'], centreId: cs['centre_id'], outcome: 'allowed', detail: { version_no: n } }); // REQ-SEC-096/097

  // 10. SignOutResult { case: CaseDetail, report_version: ReportVersionSummary }
  const caseBody = caseDto(updated, parts);
  caseBody['current_version_no'] = n;
  const rv: Obj = { version_no: n, version_kind: versionKind, scope: 'full', signed_at: signedAt, signed_by_display_name: await displayName(c, c.actor.id) };
  put(rv, 'change_reason_code', initial ? undefined : draft['change_reason_code']);
  rv['submissions'] = outs.map((o) => ({ case_item_id: o.it['id'], order_item_id: o.it['order_item_id'], item_version_no: o.v, lab_status_at_submit: o.out.status }));
  return { status: 200, body: { case: caseBody, report_version: rv } };
}
