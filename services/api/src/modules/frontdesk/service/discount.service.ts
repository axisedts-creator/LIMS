// Discount approvals F15-F19 + the F9 consumption helpers (02-TRD §5.2 F15-F19; 03-APP-FLOW §1.3, §2.7; PRD US-FD-07.1-07.5; 07-SECURITY §6.1, §6.4, A2, REQ-SEC-024/062/067).
// Same assumed ctx shape as patient.service (+ ctx.core.membership/centre for names and tenant-bound centre existence). One request = ctx.tx; time only from ctx.now().
// Never logs reasons, notes or discounts (07-SECURITY §6.2). Errors carry fixed text: no submitted value is echoed.
// [CONV] gross is NOT part of F15 (base_fingerprint + discounts only): gross_paisa is stored as 0, computed_discount = the sum of amount-kind discounts (percent-kind count 0),
//   percent_of_gross_bp = the summed percent-kind bp (cap 10000). Informational for the approver; the binding is base_fingerprint/discounts/patient/centre (.orchestra/notes/FD-T07-impl.md).
//   No F15 absolute-max 422 until CR-C4-FD-T07-001 (.orchestra/cr/FD-T07-approval-gaps.md) is decided.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { loadFrontdeskConfig } from '../config.js';
import { checkApprove, checkConsume, effectiveStatus, APPROVAL_STATUSES, type ApprovalStatus } from '../domain/discountApproval.state.js';
import type { Discount } from '../domain/discount.js';
import { decodeCursor, encodeCursor, isoUtc } from '../mappers/patient.dto.js';
import { consumeDiscountApproval, decideDiscountApproval, getDiscountApprovalById, insertDiscountApproval, lockDiscountApproval, pageDiscountApprovals } from '../repository/discountApprovals.repo.js';
import { getPatientById } from '../repository/patients.repo.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { bad, expectedVersion, isObj, patientCtx, strict, type PatientCtx, type Result } from './patient.service.js';

type Obj = Record<string, any>;
type DCtx = PatientCtx & { readonly core: { membership(ctx: unknown, i: { membershipId: string }): Promise<{ displayName: string }>; centre(ctx: unknown, i: { centreId: string }): Promise<unknown> } };
/** A discount as stored / echoed (API shape): the unit of the approval binding. */
export interface ApiDiscount { scope: 'bill' | 'line'; orderable_id?: string; kind: 'amount' | 'percent'; amount_paisa?: number; percent_bp?: number; reason_code: string; reason_text?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED = 'frontdesk.discount_approval_required';
const APPROVE = 'frontdesk.discount.approve';       // == P.discountApprove (permissions.ts)
const uuid = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };
const int = (v: unknown): v is number => Number.isSafeInteger(v);

function dctx(c: unknown): DCtx {
  const x = patientCtx(c) as DCtx;
  if (typeof x.core?.membership !== 'function' || typeof x.core?.centre !== 'function') throw new LimsError('common.service_unavailable');
  return x;
}
/** The caller's membership: the self-approval guard compares membership ids, so a missing one fails closed. */
function me(c: DCtx): string {
  if (typeof c.actor.membershipId !== 'string') throw new LimsError('auth.forbidden');
  return c.actor.membershipId;
}
interface Who { permissions: readonly string[]; scope: { all: boolean; centreIds: readonly string[] }; aal: string | undefined }
async function who(c: DCtx): Promise<Who> {
  const a = (await c.ports.IdentityPort.getActor(c)) as unknown as Obj;
  const s = a['centreScope'] as { all?: boolean; centreIds?: readonly string[] } | undefined;
  return { permissions: a['permissions'] ?? [], scope: { all: s?.all === true, centreIds: s?.centreIds ?? [] }, aal: a['mfa']?.level };     // no scope = no centre (fail closed)
}
const covers = (w: Who, centreId: string): boolean => w.scope.all || w.scope.centreIds.includes(centreId);

// ---- parsing (fixed messages, JSON-pointer paths) ----
function parseDiscounts(raw: unknown): ApiDiscount[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw bad('/discounts');
  return raw.map((v: unknown, i): ApiDiscount => {
    const at = `/discounts/${i}`;
    const d = strict(v, ['scope', 'orderable_id', 'kind', 'amount_paisa', 'percent_bp', 'reason_code', 'reason_text'], at);
    if (d['scope'] !== 'bill' && d['scope'] !== 'line') throw bad(`${at}/scope`);
    if (d['kind'] !== 'amount' && d['kind'] !== 'percent') throw bad(`${at}/kind`);
    if (typeof d['reason_code'] !== 'string' || d['reason_code'].length < 1 || d['reason_code'].length > 64) throw bad(`${at}/reason_code`);
    if (d['reason_text'] !== undefined && (typeof d['reason_text'] !== 'string' || d['reason_text'].length > 500 || d['reason_text'].includes('\u0000'))) throw bad(`${at}/reason_text`);
    if (d['scope'] === 'line') uuid(d['orderable_id'], `${at}/orderable_id`); else if (d['orderable_id'] !== undefined) throw bad(`${at}/orderable_id`);
    const base = { scope: d['scope'], ...(d['scope'] === 'line' ? { orderable_id: d['orderable_id'] } : {}), kind: d['kind'], reason_code: d['reason_code'],
      ...(d['reason_text'] !== undefined ? { reason_text: d['reason_text'] } : {}) };
    if (d['kind'] === 'percent') {
      if (!int(d['percent_bp']) || d['percent_bp'] < 1 || d['percent_bp'] > 10000) throw bad(`${at}/percent_bp`);
      if (d['amount_paisa'] !== undefined) throw bad(`${at}/amount_paisa`);
      return { ...base, percent_bp: d['percent_bp'] } as ApiDiscount;
    }
    if (!int(d['amount_paisa']) || d['amount_paisa'] < 1) throw bad(`${at}/amount_paisa`);
    if (d['percent_bp'] !== undefined) throw bad(`${at}/percent_bp`);
    return { ...base, amount_paisa: d['amount_paisa'] } as ApiDiscount;
  });
}

function parseRequest(body: unknown) {
  const b = strict(body, ['centre_id', 'base_fingerprint', 'discounts', 'reason_code', 'reason_text', 'patient_ref']);
  const centreId = uuid(b['centre_id'], '/centre_id');
  if (typeof b['base_fingerprint'] !== 'string' || !HEX64.test(b['base_fingerprint'])) throw bad('/base_fingerprint');
  const discounts = parseDiscounts(b['discounts']);
  if (typeof b['reason_code'] !== 'string' || b['reason_code'].length < 1 || b['reason_code'].length > 64) throw bad('/reason_code');
  if (b['reason_text'] !== undefined && (typeof b['reason_text'] !== 'string' || b['reason_text'].length > 500 || b['reason_text'].includes('\u0000'))) throw bad('/reason_text');
  const ref = b['patient_ref'];
  if (!isObj(ref)) throw bad('/patient_ref');
  const hasP = ref['patient_id'] !== undefined, hasH = ref['draft_hash'] !== undefined;
  if (hasP === hasH || Object.keys(ref).length !== 1) throw bad('/patient_ref');             // exactly one of the two
  const patientId = hasP ? uuid(ref['patient_id'], '/patient_ref/patient_id') : undefined;
  const draftHash = hasH ? (typeof ref['draft_hash'] === 'string' && HEX64.test(ref['draft_hash']) ? ref['draft_hash'] : (() => { throw bad('/patient_ref/draft_hash'); })()) : undefined;
  const amount = discounts.reduce((a, d) => a + (d.kind === 'amount' ? d.amount_paisa! : 0), 0);
  if (!Number.isSafeInteger(amount)) throw bad('/discounts');
  const bp = Math.min(10000, discounts.reduce((a, d) => a + (d.kind === 'percent' ? d.percent_bp! : 0), 0));
  return { centreId, baseFingerprint: b['base_fingerprint'], discounts, reasonCode: b['reason_code'], reasonText: b['reason_text'] as string | undefined, patientId, draftHash, amount, bp };
}

// ---- DTO ----
const money = (v: unknown) => ({ amount_paisa: Number(v), currency: 'NPR' });
const rowStatus = (r: Obj, now: Date): ApprovalStatus => effectiveStatus({ status: r['status'], expiresAt: new Date(r['expires_at']) }, now);

/** Display names come from ctx.core (tenant-bound); a vanished membership shows as '' rather than failing the read. */
function nameResolver(c: DCtx) {
  const seen = new Map<string, Promise<string>>();
  return (membershipId: string): Promise<string> => {
    let p = seen.get(membershipId);
    if (!p) {
      p = c.core.membership(c, { membershipId }).then((m) => m.displayName, (e) => { if (e instanceof LimsError && e.code === 'common.not_found') return ''; throw e; });
      seen.set(membershipId, p);
    }
    return p;
  };
}
async function dto(r: Obj, now: Date, name: (id: string) => Promise<string>) {
  const decider = r['decided_by_membership_id'] as string | null;
  return {
    id: r['id'], status: rowStatus(r, now), centre_id: r['centre_id'],
    requested_by: { membership_id: r['requested_by_membership_id'], display_name: await name(r['requested_by_membership_id']) },
    discounts: r['discounts'], computed_discount: money(r['computed_discount_paisa']), gross: money(r['gross_paisa']), percent_of_gross_bp: Number(r['percent_of_gross_bp']),
    reason_code: r['reason_code'], ...(r['reason_text'] != null ? { reason_text: r['reason_text'] } : {}),
    ...(decider ? { decided_by: { membership_id: decider, display_name: await name(decider) } } : {}),
    ...(r['decided_at'] != null ? { decided_at: isoUtc(r['decided_at']) } : {}), ...(r['decision_note'] != null ? { note: r['decision_note'] } : {}),
    expires_at: isoUtc(r['expires_at']), ...(r['consumed_order_id'] != null ? { consumed_order_id: r['consumed_order_id'] } : {}), version: Number(r['version']),
  };
}

// ======================= F15 requestDiscountApproval =======================
export async function request(hctx: unknown, body: unknown): Promise<Result> {
  const c = dctx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: P.discountApply });
  const r = parseRequest(body);
  const w = await who(c);
  if (!covers(w, r.centreId)) throw new LimsError('common.not_found');           // 404, not 403: the centre's existence is not confirmed
  await c.core.centre(c, { centreId: r.centreId });                                // tenant-bound: another tenant's centre is not_found
  if (r.patientId) {
    const p = await getPatientById(c.tx, c.tenantId, r.patientId);
    if (!p || p['anonymised_at'] != null) throw new LimsError('common.not_found');
  }
  const ttlMs = loadFrontdeskConfig().approvalTtlMinutes * 60_000;
  const row = await insertDiscountApproval(c.tx, c.tenantId, {
    id: uuidv7(), centre_id: r.centreId, requested_by_membership_id: me(c), patient_id: r.patientId, draft_hash: r.draftHash, base_fingerprint: r.baseFingerprint,
    discounts: r.discounts, gross_paisa: 0, computed_discount_paisa: r.amount, percent_of_gross_bp: r.bp, reason_code: r.reasonCode, reason_text: r.reasonText,
    status: 'pending', expires_at: new Date(c.now().getTime() + ttlMs),
  });
  return { status: 201, body: await dto(row, c.now(), nameResolver(c)) };
}

// ======================= F16 listDiscountApprovals (approver inbox) =======================
export async function list(hctx: unknown, query: unknown): Promise<Result> {
  const c = dctx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: APPROVE });      // aal2 re-validation lives in the port (07-SECURITY §6.4)
  const q = strict(query ?? {}, ['status', 'centre_id', 'cursor', 'limit']);
  const status = q['status'] ?? 'pending';
  if (!APPROVAL_STATUSES.includes(status)) throw bad('/status');
  const filter = q['centre_id'] === undefined ? undefined : uuid(q['centre_id'], '/centre_id');
  const raw = q['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('/limit');
  const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'created_at');
  const w = await who(c);
  const centreIds: readonly string[] | null = w.scope.all ? (filter ? [filter] : null) : (filter ? w.scope.centreIds.filter((x) => x === filter) : w.scope.centreIds);
  const empty = { status: 200, body: { data: [], page: { limit } } };
  if (centreIds && centreIds.length === 0) return empty;
  const rows = await pageDiscountApprovals(c.tx, c.tenantId, { status, now: c.now(), centreIds, limit, ...(after ? { after } : {}) });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const name = nameResolver(c);
  const data = [];
  for (const r of page) data.push(await dto(r, c.now(), name));
  return { status: 200, body: { data, page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor('created_at', last['sort_key'], last['id']) } : {}) } } };
}

// ======================= F17 getDiscountApproval =======================
export async function get(hctx: unknown, params: unknown): Promise<Result> {
  const c = dctx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: P.discountApply });
  const id = uuid(isObj(params) ? params['approval_id'] : undefined, '/approval_id');
  const row = await getDiscountApprovalById(c.tx, c.tenantId, id);
  if (!row) throw new LimsError('common.not_found');
  // the requester sees only own; an approver may open any request of a centre in scope (03-APP-FLOW §2.7 step 2). Everything else is a 404: existence is not confirmed.
  if (row['requested_by_membership_id'] !== c.actor.membershipId) {
    const w = await who(c);
    if (!(w.permissions.includes(APPROVE) && covers(w, row['centre_id']))) throw new LimsError('common.not_found');
  }
  return { status: 200, body: await dto(row, c.now(), nameResolver(c)) };
}

// ======================= F18 approveDiscount / F19 rejectDiscount =======================
export async function decide(hctx: unknown, params: unknown, headers: unknown, body: unknown, to: 'approved' | 'rejected'): Promise<Result> {
  const c = dctx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: APPROVE });      // no grant -> auth.forbidden; privileged at aal1 -> auth.mfa_required
  const id = uuid(isObj(params) ? params['approval_id'] : undefined, '/approval_id');
  const version = expectedVersion(headers);
  const b = strict(body, ['note']);
  const n = b['note'];
  if (n !== undefined && (typeof n !== 'string' || n.length > 500 || n.includes('\u0000'))) throw bad('/note');
  if (to === 'rejected' && (typeof n !== 'string' || n.length < 1)) throw bad('/note');          // F19: the note is required
  const note = typeof n === 'string' && n.length > 0 ? n : null;

  const mine = me(c);
  const row = await lockDiscountApproval(c.tx, c.tenantId, id);
  if (!row) throw new LimsError('common.not_found');
  if (row['requested_by_membership_id'] === mine) throw new LimsError('frontdesk.discount_self_approval_forbidden');     // CR-C4-007; the DB CHECK discount_approvals__decider__ck is the backstop
  const w = await who(c);
  const verdict = checkApprove({
    approval: { status: row['status'], requestedByMembershipId: row['requested_by_membership_id'], expiresAt: new Date(row['expires_at']) },
    approverMembershipId: mine, approverAal: w.aal === 'aal2' ? 'aal2' : 'aal1', approverCoversCentre: covers(w, row['centre_id']), now: c.now(),
  });
  if (!verdict.ok) throw new LimsError(verdict.code);                              // self-approval (CR-C4-007) | mfa | centre not covered (404) | not pending (409 immutable_record)
  if (Number(row['version']) !== version) throw new LimsError('common.version_conflict');
  const next = await decideDiscountApproval(c.tx, c.tenantId, id, { expectedVersion: version, status: to, membershipId: mine, decidedAt: c.now(), note });
  if (!next) throw new LimsError('common.version_conflict');                       // moved under us (cannot happen under the row lock)
  return { status: 200, body: await dto(next, c.now(), nameResolver(c)) };
}

// ======================= F9 consumption (called by registration.service inside the F9 tx) =======================
/** A draft discount (registration.service) in the API shape the approval stores. */
export const toApiDiscount = (d: { scope: 'bill' | 'line'; orderableId?: string; kind: 'amount' | 'percent'; amountPaisa?: number; percentBp?: number; reasonCode: string; reasonText?: string }): ApiDiscount => ({
  scope: d.scope, ...(d.orderableId ? { orderable_id: d.orderableId } : {}), kind: d.kind, ...(d.amountPaisa !== undefined ? { amount_paisa: d.amountPaisa } : {}),
  ...(d.percentBp !== undefined ? { percent_bp: d.percentBp } : {}), reason_code: d.reasonCode, ...(d.reasonText !== undefined ? { reason_text: d.reasonText } : {}),
});

/**
 * US-FD-07.1/07.5: lock the approval row (a concurrent registration waits and then sees it consumed) and check it is approved, unexpired and bound to exactly this
 * base_fingerprint + patient + centre + discounts. Anything else -> 403 frontdesk.discount_approval_required (an unknown / other tenant's id looks the same).
 * `patientId` undefined = a new patient (no draft_hash normalisation is specified: refuse, fail closed; CR-C4-FD-T07-002 in .orchestra/cr/FD-T07-approval-gaps.md). Returns the locked row; `markConsumed` follows once the order exists.
 */
export async function lockApprovalForRegistration(c: { tx: PatientCtx['tx']; tenantId: string; now(): Date },
  i: { approvalId: string; baseFingerprint: string; patientId: string | undefined; centreId: string; discounts: readonly ApiDiscount[] }): Promise<Obj> {
  if (i.patientId === undefined) throw new LimsError(REQUIRED);
  const row = await lockDiscountApproval(c.tx, c.tenantId, i.approvalId);
  if (!row || row['patient_id'] == null) throw new LimsError(REQUIRED);
  const stored = row['discounts'] as readonly ApiDiscount[];
  const ok = checkConsume({
    approval: { status: row['status'], expiresAt: new Date(row['expires_at']), baseFingerprint: row['base_fingerprint'], patientRef: { patientId: row['patient_id'] }, centreId: row['centre_id'], discounts: stored as unknown as readonly Discount[] },
    now: c.now(), baseFingerprint: i.baseFingerprint, patientRef: { patientId: i.patientId }, centreId: i.centreId, discounts: i.discounts as unknown as readonly Discount[],
  });
  if (!ok.ok) throw new LimsError(REQUIRED);
  return row;
}
export async function markConsumed(c: { tx: PatientCtx['tx']; tenantId: string; now(): Date }, approvalId: string, orderId: string): Promise<void> {
  if (!(await consumeDiscountApproval(c.tx, c.tenantId, approvalId, orderId, c.now()))) throw new LimsError(REQUIRED);
}
