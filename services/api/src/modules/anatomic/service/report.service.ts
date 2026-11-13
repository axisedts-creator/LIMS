// Report draft — R1 getAnatomicReportDraft, R2 saveAnatomicReportDraft (02-TRD §5.3 R1/R2, §4.5.2 instance values, §4.6 plain text, §5 D-66 (b), §10.2 max_report_images;
// 01-PRD AC-07.1, 07.3–07.6, AC-08.5/08.6 draft side). Order: load case (404) -> IdentityPort.assertRole(case centre) -> state guard -> If-Match -> body (all errors together)
// -> version check -> write. Nothing submitted (texts, codes, captions) is echoed in an error or logged (REQ-SEC-098); a throw rolls the caller's transaction back.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { CaseStatus } from '../domain/case.state.js';
import { normalizePlainText } from '../domain/plaintext.js';
import { validateSynopticValues } from '../domain/synoptic.js';
import { listCodedDiagnoses } from '../repository/codedValues.repo.js';
import { getSettings } from '../repository/config.repo.js';
import { getOpenDraft, insertReportDraft, updateReportDraft } from '../repository/drafts.repo.js';
import { getImage } from '../repository/images.repo.js';
import { getStainOrder } from '../repository/stainOrders.repo.js';
import { getSynopticTemplate } from '../repository/templates.repo.js';
import type { Row } from '../repository/_sql.js';
import { anatomicCtx, assertAt, isObj, iso, loadCase, put, strict, UUID } from './case.service.js';
import { ifMatch } from './gross.service.js';
import type { AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };

const DEFAULT_MAX_REPORT_IMAGES = 12; // 05-SCHEMA settings.max_report_images DEFAULT 12
const MAX_DIAGNOSIS_PAGE = 500;
const BODY_KEYS = ['gross_text', 'microscopy_text', 'impression_text', 'comment_text', 'flag', 'is_critical', 'synoptic', 'image_ids', 'ancillary', 'diagnosis_codes'] as const;
const TEXT_LIMITS = { gross_text: 20000, microscopy_text: 20000, impression_text: 8000, comment_text: 8000 } as const;

const fieldError = (path: string, code = 'common.field_invalid', message = 'Field invalid'): FieldError => ({ path, code, message });
const denied = (code: string): LimsError => new LimsError(code);

/** Closed object: unknown keys are collected (never echoed); false = not an object. */
function closed(v: unknown, allowed: readonly string[], path: string, errs: FieldError[]): v is Obj {
  if (!isObj(v)) { errs.push(fieldError(path)); return false; }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errs.push(fieldError(`${path}/${k}`, 'common.unknown_field', 'Unknown field'));
  return true;
}

/** Plain text field (02-TRD §4.6): string without NUL, normalised, then length-checked on the stored form. */
function plain(v: unknown, path: string, max: number, errs: FieldError[], min = 0): string {
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
async function diagnosisByCode(c: AnatomicCtx, activeOnly: boolean): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (let offset = 0; ; offset += MAX_DIAGNOSIS_PAGE) {
    const rows = await listCodedDiagnoses(c.tx, { tenantId: c.tenantId, activeOnly, limit: MAX_DIAGNOSIS_PAGE, offset });
    for (const r of rows) out.set(r['code'], r);
    if (rows.length < MAX_DIAGNOSIS_PAGE) return out;
  }
}

async function draftDto(c: AnatomicCtx, d: Row, diagnoses: Map<string, Row>): Promise<Obj> {
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
