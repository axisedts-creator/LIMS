// Report changes and addenda — R4 startAnatomicCaseChange, R5 discardAnatomicCaseChange, R6 listAnatomicReportVersions, R7 getAnatomicReportVersion, R8 createAnatomicAddendum,
// R9 updateAnatomicAddendum, R10 signAnatomicAddendum (02-TRD §4.4 "Change kind decision" + "Addendum signing", §4.7.1/4.7.2, §5.3 R4–R10, §12 access log; 01-PRD AC-10.1–10.8, AC-03.4/03.5;
// 08 A17 D-62 reason codes: format only, D-66 edits after sign-out, 08 R1 `supplementary_report`, 08 A17 P-23 port errors unchanged).
// Order everywhere: load (404) -> IdentityPort.assertRole(case centre) -> actor/state guard -> If-Match -> body (all errors together) -> reads that need ids -> writes. The case row lock of
// getCase({forUpdate:true}) serialises the writers of one case until the request transaction ends. Nothing submitted (reason text, addendum text) is echoed in an error or logged (REQ-SEC-098).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { buildContent, summarise } from '../domain/report-content.js';
import { getAddendum, insertAddendum, listAddenda, updateAddendum } from '../repository/addenda.repo.js';
import { getBlock } from '../repository/blocks.repo.js';
import { getCaseItem, listCaseItems, updateCase } from '../repository/cases.repo.js';
import { getOpenDraft, insertReportDraft, listReportDrafts, updateReportDraft } from '../repository/drafts.repo.js';
import { listImages } from '../repository/images.repo.js';
import { listParts } from '../repository/parts.repo.js';
import { getStainOrder } from '../repository/stainOrders.repo.js';
import { insertItemSubmission, listItemSubmissions } from '../repository/submissions.repo.js';
import { insertReportVersion, listReportVersions } from '../repository/versions.repo.js';
import type { Row } from '../repository/_sql.js';
import { anatomicCtx, assertAt, caseDto, isObj, iso, loadCase, put, strict, UUID } from './case.service.js';
import { ifMatch } from './gross.service.js';
import { labStatusByOrderItem } from './labstatus.service.js';
import type { AnatomicCtx } from './numbering.service.js';
import { diagnosisByCode, displayName, draftDto, dup, fieldError, plain, portError, stainDisplays, type SignCtx } from './report.service.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body?: unknown };

const REASON_CODE = /^[a-z0-9_]{1,64}$/;
/** 02-TRD §5.3 R4 [CONV, 08 R1]: reserved for automatic use, never chosen by a pathologist. */
const SYSTEM_REASON_CODES: readonly string[] = ['module_phase_progression', 'module_preliminary_update', 'supplementary_report'];
const ADDENDUM_KINDS: readonly string[] = ['ihc', 'special_stain', 'molecular', 'other'];
const MAX_VERSIONS = 200;
const byId = (x: Row, y: Row) => (x['id'] < y['id'] ? -1 : x['id'] > y['id'] ? 1 : 0);

/** 02-TRD §3.2 DECISION: a system actor (worker) never signs, starts or discards a change. */
function userOnly(c: AnatomicCtx): void {
  if ((c.actor as { type?: string }).type !== 'user') throw new LimsError('auth.forbidden');
}
const signoutRole = (c: AnatomicCtx, cs: Row) => c.ports.IdentityPort.assertRole(c, { permission: 'anatomic.case.signout', centreId: cs['centre_id'] });

/** newest FULL version (an addendum_only one never counts as the sections of the report) */
async function latestFull(c: AnatomicCtx, caseId: unknown): Promise<Row | undefined> {
  return (await listReportVersions(c.tx, { tenantId: c.tenantId, caseId: String(caseId) })).find((v) => v['scope'] === 'full');
}

// ---- R4 startAnatomicCaseChange ----
export async function startChange(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined, true);
  await signoutRole(c, cs);
  userOnly(c);
  const version = ifMatch(headers, false);
  if (Number(cs['version']) !== version) throw new LimsError('common.version_conflict');

  const b = strict(body, ['reason_code', 'reason_text']);
  const errs: FieldError[] = [];
  const code = b['reason_code'];
  if (typeof code !== 'string' || !REASON_CODE.test(code) || SYSTEM_REASON_CODES.includes(code)) errs.push(fieldError('/reason_code')); // D-62: format only; C5 validates at submission
  const reasonText = plain(b['reason_text'], '/reason_text', 500, errs);
  if (errs.length > 0) throw new LimsError('common.validation_failed', undefined, errs);

  if (cs['status'] !== 'signed_out') throw new LimsError('anatomic.case_invalid_transition');
  if (await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })) throw new LimsError('anatomic.case_invalid_transition'); // one open draft per case

  // kind: any target whose newest module result C5 already approved -> amendment (§4.4); no lab.result.read -> cannot tell -> revision (R3 re-decides at signing, E10)
  const targets = (await listCaseItems(c.tx, { tenantId: c.tenantId, caseId: cs['id'], activeOnly: true })).filter((it) => it['role'] === 'primary' && it['is_active'] !== false);
  const lab = await labStatusByOrderItem(c as never, String(cs['order_id']));
  const kind = targets.some((it) => lab?.get(String(it['order_item_id']))?.status === 'approved') ? 'amendment' : 'revision';

  // prefill from the latest full version (02-TRD §5.3 R4). Its sections come from the consumed draft with the highest consumed_version_no (addendum full versions
  // consume none and copy the earlier sections), which still holds the synoptic instances and ancillary results; reconstruct from the snapshot only when none exists.
  const prior = await latestFull(c, cs['id']);
  if (!prior) throw new LimsError('anatomic.case_invalid_transition');
  const src = (await listReportDrafts(c.tx, { tenantId: c.tenantId, caseId: String(cs['id']) })).filter((d) => d['status'] === 'consumed')
    .reduce<Row | undefined>((best, d) => (!best || Number(d['consumed_version_no']) > Number(best['consumed_version_no']) ? d : best), undefined);
  const active = await listImages(c.tx, { tenantId: c.tenantId, caseId: cs['id'], activeOnly: true });
  let imageIds: string[];
  if (src) {
    const ids = new Set(((src['image_ids'] ?? []) as unknown[]).map(String));
    imageIds = active.filter((m) => ids.has(String(m['id']))).map((m) => String(m['id'])); // an image removed since cannot be signed again
  } else {
    const wanted = new Set(((prior['images'] ?? []) as Obj[]).map((m) => `${String(m['bucket'])}/${String(m['object_path'])}`));
    imageIds = active.filter((m) => wanted.has(`${String(m['bucket'])}/${String(m['object_path'])}`)).map((m) => String(m['id']));
  }
  const codes = ((prior['diagnosis_codes'] ?? []) as Obj[]).map((d) => String(d['code']));
  const text = src ?? prior;

  let saved: Row;
  try {
    saved = await insertReportDraft(c.tx, {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], kind, status: 'open', change_reason_code: code, change_reason_text: reasonText === '' ? undefined : reasonText,
      gross_text: text['gross_text'], microscopy_text: text['microscopy_text'], impression_text: text['impression_text'], comment_text: text['comment_text'], flag: prior['flag'] ?? undefined,
      is_critical: prior['is_critical'] === true, synoptic: src?.['synoptic'] ?? [], ancillary: src?.['ancillary'] ?? [], image_ids: imageIds, diagnosis_codes: codes,
      base_version_no: Number(cs['current_version_no'] ?? 0), created_by: c.actor.id, updated_by: c.actor.id,
    });
  } catch (e) {
    if (dup(e)) throw new LimsError('anatomic.case_invalid_transition'); // lost the one-open-draft race
    throw e;
  }
  return { status: 201, body: await draftDto(c, saved, codes.length > 0 ? await diagnosisByCode(c, false) : new Map()) };
}

// ---- R5 discardAnatomicCaseChange ----
export async function discardChange(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined, true);
  await signoutRole(c, cs);
  userOnly(c);
  const version = ifMatch(headers, false);
  const draft = await getOpenDraft(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  if (!draft || draft['kind'] === 'initial') throw new LimsError('anatomic.case_invalid_transition'); // an initial draft is not a change
  if (Number(draft['version']) !== version) throw new LimsError('common.version_conflict');
  const done = await updateReportDraft(c.tx, { tenantId: c.tenantId, id: draft['id'], expectedVersion: version, actorId: c.actor.id, patch: { status: 'discarded', discarded_at: c.now().toISOString() } });
  if (!done) throw new LimsError('common.version_conflict');
  return { status: 204 };
}

// ---- R6 / R7 ----
async function signerName(c: AnatomicCtx, v: Row, cache: Map<string, string>): Promise<string> {
  const id = String(v['created_by']); // the signer's user id: the actor who inserted the version
  if (!cache.has(id)) cache.set(id, await displayName(c, id));
  return cache.get(id)!;
}
async function submissionsOf(c: AnatomicCtx, caseId: unknown): Promise<(v: Row) => Obj[]> {
  const subs = await listItemSubmissions(c.tx, { tenantId: c.tenantId, caseId: String(caseId) });
  const orderItem = new Map((await listCaseItems(c.tx, { tenantId: c.tenantId, caseId: String(caseId) })).map((it) => [String(it['id']), it['order_item_id']]));
  return (v) => subs.filter((s) => s['report_version_id'] === v['id']).sort((x, y) => (x['case_item_id'] < y['case_item_id'] ? -1 : x['case_item_id'] > y['case_item_id'] ? 1 : 0))
    .map((s) => ({ case_item_id: s['case_item_id'], order_item_id: orderItem.get(String(s['case_item_id'])), item_version_no: Number(s['item_version_no']), lab_status_at_submit: s['lab_status'] }));
}
function summaryDto(v: Row, name: string, submissions: Obj[]): Obj {
  const o: Obj = { version_no: Number(v['version_no']), version_kind: v['version_kind'], scope: v['scope'], signed_at: iso(v['signed_at']), signed_by_display_name: name };
  put(o, 'change_reason_code', v['change_reason_code']);
  o['submissions'] = submissions;
  return o;
}

export async function listVersions(hctx: unknown, params: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined);
  await assertAt(c, 'anatomic.case.read', cs);
  const rows = (await listReportVersions(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).slice(0, MAX_VERSIONS); // newest first
  const subs = rows.length > 0 ? await submissionsOf(c, cs['id']) : () => [];
  const names = new Map<string, string>();
  const data: Obj[] = [];
  for (const v of rows) data.push(summaryDto(v, await signerName(c, v, names), subs(v)));
  return { status: 200, body: { data } };
}

export async function getVersion(hctx: unknown, params: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const p = isObj(params) ? params : {};
  const cs = await loadCase(c, p['case_id']);
  await assertAt(c, 'anatomic.case.read', cs);
  const raw = typeof p['version_no'] === 'number' ? String(p['version_no']) : p['version_no'];
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw new LimsError('common.not_found'); // malformed number: nothing can match
  const v = (await listReportVersions(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).find((x) => Number(x['version_no']) === Number(raw));
  if (!v) throw new LimsError('common.not_found');
  const o = summaryDto(v, await signerName(c, v, new Map()), (await submissionsOf(c, cs['id']))(v));
  for (const k of ['clinical_history_text', 'gross_text', 'microscopy_text', 'impression_text', 'comment_text']) o[k] = v[k] ?? '';
  for (const k of ['synoptic', 'images', 'specimen_parts', 'slides', 'ancillary', 'molecular', 'addenda', 'diagnosis_codes']) o[k] = v[k] ?? [];
  await (c as AnatomicCtx & { audit: { access(entry: Obj): Promise<void> } }).audit.access({ action: 'anatomic_report.view', entityType: 'anatomic_case', entityId: cs['id'], centreId: cs['centre_id'], outcome: 'allowed', detail: { version_no: Number(v['version_no']) } }); // REQ-SEC-096/097
  return { status: 200, body: o };
}

// ---- addenda ----
async function addendumDto(c: AnatomicCtx, a: Row): Promise<Obj> {
  const o: Obj = { id: a['id'], kind: a['kind'], text: a['text'], stain_order_ids: [...((a['stain_order_ids'] ?? []) as string[])], status: a['status'] };
  put(o, 'addon_case_item_id', a['addon_case_item_id']);
  if (a['status'] === 'signed') {
    put(o, 'signed_at', iso(a['signed_at'])); o['signed_by_display_name'] = await displayName(c, String(a['updated_by'])); put(o, 'report_version_no', a['report_version_no']);
  }
  o['version'] = Number(a['version']);
  return o;
}

/** R8/R9 body: closed object; every error together, pointers only (nothing echoed). Ownership of the ids is checked against THIS case (07-SECURITY §5.1). */
async function addendumBody(c: AnatomicCtx, cs: Row, body: unknown): Promise<{ kind: string; text: string; stain_order_ids: string[]; addon_case_item_id?: string }> {
  const b = strict(body, ['kind', 'text', 'stain_order_ids', 'addon_case_item_id']);
  const errs: FieldError[] = [];
  const kind = typeof b['kind'] === 'string' && ADDENDUM_KINDS.includes(b['kind']) ? b['kind'] : (errs.push(fieldError('/kind')), '');
  if (b['text'] === undefined) errs.push(fieldError('/text'));
  const text = plain(b['text'], '/text', 8000, errs, 1);
  const stains: string[] = [];
  if (b['stain_order_ids'] !== undefined) {
    const v = b['stain_order_ids'];
    if (!Array.isArray(v) || v.length > 20) errs.push(fieldError('/stain_order_ids'));
    else {
      const seen = new Set<string>();
      for (const [k, id] of v.entries()) {
        if (typeof id !== 'string' || !UUID.test(id) || seen.has(id.toLowerCase())) { errs.push(fieldError(`/stain_order_ids/${k}`)); continue; }
        seen.add(id.toLowerCase());
        const so = await getStainOrder(c.tx, { tenantId: c.tenantId, id });
        if (!so || so['case_id'] !== cs['id']) errs.push(fieldError(`/stain_order_ids/${k}`)); else stains.push(id);
      }
    }
  }
  let addon: string | undefined;
  if (b['addon_case_item_id'] !== undefined) {
    const id = b['addon_case_item_id'];
    if (typeof id !== 'string' || !UUID.test(id)) errs.push(fieldError('/addon_case_item_id'));
    else {
      const it = await getCaseItem(c.tx, { tenantId: c.tenantId, id });
      if (!it || it['case_id'] !== cs['id'] || it['role'] !== 'addon' || it['is_active'] === false) errs.push(fieldError('/addon_case_item_id')); else addon = id;
    }
  }
  if (errs.length > 0) throw new LimsError('common.validation_failed', undefined, errs);
  return { kind, text, stain_order_ids: stains, ...(addon ? { addon_case_item_id: addon } : {}) };
}

// ---- R8 createAnatomicAddendum ----
export async function createAddendum(hctx: unknown, params: unknown, _headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const cs = await loadCase(c, isObj(params) ? params['case_id'] : undefined, true); // the lock serialises seq
  await assertAt(c, 'anatomic.case.work', cs);
  if (cs['status'] !== 'signed_out') throw new LimsError('anatomic.case_invalid_transition'); // AC-10.6: checked before the body
  const b = await addendumBody(c, cs, body);
  const seq = 1 + (await listAddenda(c.tx, { tenantId: c.tenantId, caseId: cs['id'] })).reduce((m, a) => Math.max(m, Number(a['seq'])), 0);
  let row: Row;
  try {
    row = await insertAddendum(c.tx, { id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], seq, ...b, created_by: c.actor.id, updated_by: c.actor.id });
  } catch (e) {
    if (dup(e)) throw new LimsError('common.version_conflict');
    throw e;
  }
  return { status: 201, body: await addendumDto(c, row) };
}

/** addendum by id -> its case locked (so R9 / R10 / R8 of one case never interleave) -> the addendum re-read under the lock */
async function loadAddendum(c: AnatomicCtx, id: unknown): Promise<{ a: Row; cs: Row }> {
  if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
  const first = await getAddendum(c.tx, { tenantId: c.tenantId, id });
  if (!first) throw new LimsError('common.not_found');
  const cs = await loadCase(c, first['case_id'], true);
  const a = await getAddendum(c.tx, { tenantId: c.tenantId, id });
  if (!a) throw new LimsError('common.not_found');
  return { a, cs };
}

// ---- R9 updateAnatomicAddendum ----
export async function updateAddendumDraft(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const { a, cs } = await loadAddendum(c, isObj(params) ? params['addendum_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  if (a['status'] === 'signed') throw new LimsError('anatomic.signout_locked'); // before If-Match
  const version = ifMatch(headers, false);
  if (Number(a['version']) !== version) throw new LimsError('common.version_conflict');
  const b = await addendumBody(c, cs, body);
  const errs: FieldError[] = [];
  if (b.kind !== a['kind']) errs.push(fieldError('/kind')); // kind and add-on link are fixed at creation (the repository cannot change them)
  if (b.addon_case_item_id !== undefined && b.addon_case_item_id !== a['addon_case_item_id']) errs.push(fieldError('/addon_case_item_id'));
  if (errs.length > 0) throw new LimsError('common.validation_failed', undefined, errs);
  const saved = await updateAddendum(c.tx, { tenantId: c.tenantId, id: a['id'], expectedVersion: version, actorId: c.actor.id, patch: { text: b.text, stain_order_ids: b.stain_order_ids } });
  if (!saved) throw new LimsError('common.version_conflict');
  return { status: 200, body: await addendumDto(c, saved) };
}

// ---- R10 signAnatomicAddendum (02-TRD §4.4 "Addendum signing", §4.7.1/4.7.2) ----
export async function signAddendum(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx) as SignCtx;
  const { a, cs } = await loadAddendum(c, isObj(params) ? params['addendum_id'] : undefined);
  await signoutRole(c, cs); // REQ-SEC-062/067 (aal2 enforced by IdentityPort), before anything else
  userOnly(c);
  const b = strict(body, ['attest']);
  if (b['attest'] !== true) throw new LimsError('common.validation_failed', undefined, [fieldError('/attest')]);
  if (a['status'] !== 'draft') throw new LimsError('anatomic.case_invalid_transition'); // replay after success
  const version = ifMatch(headers, false);
  if (Number(a['version']) !== version) throw new LimsError('common.version_conflict');
  if (cs['status'] !== 'signed_out') throw new LimsError('anatomic.case_invalid_transition');

  // every referenced stain order must be completed (all errors together)
  const errs: FieldError[] = [];
  for (const [k, id] of ((a['stain_order_ids'] ?? []) as string[]).entries()) {
    const so = await getStainOrder(c.tx, { tenantId: c.tenantId, id });
    if (!so || so['case_id'] !== cs['id'] || so['status'] !== 'completed') errs.push(fieldError(`/stain_order_ids/${k}`));
  }
  if (errs.length > 0) throw new LimsError('anatomic.report_incomplete', undefined, errs);

  // targets: the add-on item, or the active primary items (case_item id order); each must be active at the front desk (AC-09.9)
  const items = await listCaseItems(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  const addonId = a['addon_case_item_id'] as string | null | undefined;
  const targets = addonId
    ? items.filter((it) => it['id'] === addonId && it['role'] === 'addon' && it['is_active'] !== false)
    : items.filter((it) => it['role'] === 'primary' && it['is_active'] !== false).sort(byId);
  if (targets.length === 0) throw new LimsError('anatomic.case_invalid_transition');
  const order = await c.ports.FrontdeskPort.getOrderSummary(c, { orderId: cs['order_id'] });
  for (const it of targets) {
    if (order.items.find((x) => x.orderItemId === it['order_item_id'])?.status !== 'active') throw new LimsError('anatomic.order_item_inactive', `order item ${String(it['order_item_id'])} is not active`);
  }

  // content (in memory): the addenda of this scope incl. this one, and the ancillary of their stain orders
  const n = Number(cs['current_version_no'] ?? 0) + 1;
  const now = c.now(), signedAt = now.toISOString();
  const signedBy = c.actor.membershipId;
  const mine = (await listAddenda(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }))
    .filter((x) => x['id'] !== a['id'] && x['status'] === 'signed' && (addonId ? x['addon_case_item_id'] === addonId : x['addon_case_item_id'] == null));
  const addenda = [...mine, { ...a, status: 'signed', signed_at: signedAt, signed_by_membership_id: signedBy }].sort((x, y) => Number(x['seq']) - Number(y['seq']));
  const ancillary: Obj[] = [];
  const stains = addenda.some((x) => ((x['stain_order_ids'] ?? []) as string[]).length > 0) ? await stainDisplays(c) : new Map<string, string>();
  for (const ad of addenda) {
    for (const id of (ad['stain_order_ids'] ?? []) as string[]) {
      const so = await getStainOrder(c.tx, { tenantId: c.tenantId, id });
      if (!so || so['case_id'] !== cs['id']) continue;
      const block = so['block_id'] ? await getBlock(c.tx, { tenantId: c.tenantId, id: String(so['block_id']) }) : undefined;
      ancillary.push({ stain_kind: so['stain_kind'], stain_code: so['stain_code'], stain_display: stains.get(so['stain_code']) ?? so['stain_code'], block_label: block?.['label'], result_text: String(ad['text']).slice(0, 2000) }); // [CONV] result = the addendum text (≤ 2000 in the ancillary shape; the full text is in addenda)
    }
  }
  const prior = addonId ? undefined : await latestFull(c, cs['id']);
  if (!addonId && !prior) throw new LimsError('anatomic.case_invalid_transition');
  const parts = await listParts(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  const scope = addonId ? 'addendum_only' : 'full';
  const built = buildContent({ scope: 'addendum_only', clinical_history_text: cs['clinical_history_text'], draft: {}, parts, synoptic: [], images: [], slides: [], ancillary, molecular: [], addenda, diagnosis_codes: [] });
  let content: Obj = { ...built };
  if (prior) { // full scope: the previous full version's sections (never an addendum_only one) + addenda; its ancillary plus the addenda stains, once each
    const seen = new Set<string>(), merged: Obj[] = [];
    for (const x of [...((prior['ancillary'] ?? []) as Obj[]), ...built.ancillary]) { const k = JSON.stringify(x); if (!seen.has(k)) { seen.add(k); merged.push(x); } }
    content = {
      clinical_history_text: prior['clinical_history_text'], gross_text: prior['gross_text'], microscopy_text: prior['microscopy_text'], impression_text: prior['impression_text'], comment_text: prior['comment_text'],
      flag: prior['flag'] ?? null, is_critical: prior['is_critical'] === true, synoptic: prior['synoptic'], images: prior['images'], specimen_parts: prior['specimen_parts'], slides: prior['slides'],
      ancillary: merged, molecular: prior['molecular'], addenda: built.addenda, diagnosis_codes: prior['diagnosis_codes'],
    };
  }

  // port calls FIRST, every target; a port error is rethrown unchanged (08 A17 P-23) and the request transaction rolls back
  const priorSubs = await listItemSubmissions(c.tx, { tenantId: c.tenantId, caseId: cs['id'] });
  const summaryText = summarise(prior ? `${String(prior['impression_text'])}\n\n${String(a['text'])}`.trim() : String(a['text'])); // [CONV] C5 summary = impression + addendum (add-on: addendum)
  const outs: { it: Row; v: number; key: string; out: Awaited<ReturnType<SignCtx['ports']['LabPort']['submitModuleResult']>> }[] = [];
  for (const it of targets) {
    const v = 1 + priorSubs.filter((s) => s['case_item_id'] === it['id']).reduce((m, s) => Math.max(m, Number(s['item_version_no'])), 0);
    const key = `anatomic:${String(it['id'])}:${v}`;
    const input: Obj = {
      orderItemId: it['order_item_id'], kind: cs['case_kind'] === 'molecular' ? 'structured' : 'narrative', reportPhase: 'final',
      payloadRef: { module: 'anatomic', entityId: it['id'], versionNo: v }, summaryText, submittedAt: signedAt, idempotencyKey: key,
      amendment: { reasonCode: 'supplementary_report' }, // 08 R1: both scopes; C5 uses it only when the target is approved
    };
    put(input, 'flag', content['flag']);
    if (content['is_critical'] === true) input['isCritical'] = true;
    try {
      outs.push({ it, v, key, out: await c.ports.LabPort.submitModuleResult(c, input) });
    } catch (e) {
      throw portError(e);
    }
  }

  // report_versions, then item_submissions, then the addendum and the case
  let ver: Row;
  try {
    ver = await insertReportVersion(c.tx, {
      id: uuidv7(), tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], version_no: n, version_kind: 'addendum', scope, addon_case_item_id: addonId ?? undefined, addendum_id: a['id'], ...content,
      signed_by_membership_id: signedBy, signed_at: signedAt, created_by: c.actor.id, // an addendum keeps version_kind 'addendum' whatever C5 answered (§4.4)
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
  const signed = await updateAddendum(c.tx, { tenantId: c.tenantId, id: a['id'], expectedVersion: version, actorId: c.actor.id,
    patch: { status: 'signed', signed_at: signedAt, signed_by_membership_id: signedBy, report_version_no: n } });
  if (!signed) throw new LimsError('common.version_conflict');
  const updated = await updateCase(c.tx, { tenantId: c.tenantId, id: cs['id'], expectedVersion: Number(cs['version']), actorId: c.actor.id, patch: { current_version_no: n } }); // status and signed_out_at stay
  if (!updated) throw new LimsError('common.version_conflict');

  await c.audit.access({ action: 'anatomic_report.sign_out', entityType: 'anatomic_case', entityId: cs['id'], centreId: cs['centre_id'], outcome: 'allowed', detail: { version_no: n } }); // REQ-SEC-096/097

  const caseBody = caseDto(updated, parts);
  caseBody['current_version_no'] = n;
  const rv = summaryDto({ version_no: n, version_kind: 'addendum', scope, signed_at: signedAt }, await displayName(c, c.actor.id),
    outs.map((o) => ({ case_item_id: o.it['id'], order_item_id: o.it['order_item_id'], item_version_no: o.v, lab_status_at_submit: o.out.status })));
  return { status: 200, body: { case: caseBody, report_version: rv } };
}
