'use server';
// T0D-PARTYSET-1 (LD-321): server actions of the party settings screens (T0C-PARTYSET-1 writes; online only, never queued offline).
//   setPartyCommercialSetting (PUT, no Idempotency-Key: x-idempotency none; If-Match except on the first save of a default row),
//   decidePartyOnboarding, create / update / deactivate NonCompliancePenalty, raise / waive / charge NonComplianceEvent,
//   revealPartyIdNumber (the full value goes back to the caller's component state only: never logged, stored or put in a URL),
//   create / update / deactivate IcdMasterCode (catalog.yaml).
// POST creates and charge carry the caller's Idempotency-Key; PATCH, deactivate, decision, waive and charge carry If-Match "<version>".
// Every value is re-checked here (the browser is not trusted); only a known party kind (partner, credit_party, doctor, referrer) and a uuid
// reach a path. Failures come back as { ok:false, status, code, errors } with the server's field messages (path + message, capped).
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { isUuid } from './sales.server';
import { KEY_RE } from './types';

export type PartysetResult = { ok: true } | { ok: false; status: number; code: string; errors?: { path: string; message: string }[] };
export type RevealResult = { ok: true; value: string } | { ok: false; status: number; code: string };

const KINDS = ['partner', 'credit_party', 'doctor', 'referrer'] as const;
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const FIELD = /^\/?[a-z_]{1,40}$/;

function fail(e: unknown): { ok: false; status: number; code: string; errors?: { path: string; message: string }[] } {
  if (!(e instanceof ApiError)) throw e;
  const raw = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as { path?: unknown; message?: unknown }[]) : [];
  const errors = raw
    .filter((x) => typeof x?.path === 'string' && FIELD.test(x.path) && typeof x.message === 'string')
    .map((x) => ({ path: `/${(x.path as string).replace(/^\//, '')}`, message: (x.message as string).slice(0, 300) }));
  return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
}
async function run(f: () => Promise<unknown>): Promise<PartysetResult> {
  try { await f(); return { ok: true }; } catch (e) { return fail(e); }
}

const kind = (v: unknown) => { if (!KINDS.includes(v as (typeof KINDS)[number])) throw bad(); return v as string; };
const uuid = (v: unknown) => { if (typeof v !== 'string' || !isUuid(v)) throw bad(); return v; };
const str = (v: unknown, max: number) => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw bad(); return v.trim(); };
const re = (r: RegExp) => (v: unknown) => { if (typeof v !== 'string' || !r.test(v)) throw bad(); return v; };
const int = (min: number, max: number) => (v: unknown) => { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw bad(); return v; };
const bool = (v: unknown) => { if (typeof v !== 'boolean') throw bad(); return v; };
const oneOf = (...xs: string[]) => (v: unknown) => { if (!xs.includes(v as string)) throw bad(); return v; };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAISA = int(0, 100_000_000_000);

const headers = (o: { key?: string | undefined; version?: number | undefined }) => {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && (!Number.isSafeInteger(o.version) || o.version < 1)) throw bad();
  return {
    'content-type': 'application/json',
    ...(o.key !== undefined ? { 'idempotency-key': o.key } : {}),
    ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}),
  };
};
const send = (method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, o: { key?: string; version?: number }) =>
  serverFetch<unknown>(path, { method, headers: headers(o), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Keeps the listed keys that are present, each checked by its rule; `unset` only from `unsetable`; at least one key. */
function clean(b: Record<string, unknown>, rules: Record<string, (v: unknown) => unknown>, unsetable: readonly string[] = []) {
  if (!b || typeof b !== 'object') throw bad();
  const out: Record<string, unknown> = {};
  for (const [k, check] of Object.entries(rules)) if (b[k] !== undefined) out[k] = check(b[k]);
  if (b['unset'] !== undefined) {
    const u = b['unset'];
    if (!Array.isArray(u) || u.length === 0 || u.some((x) => !unsetable.includes(x as string)) || new Set(u).size !== u.length) throw bad();
    out['unset'] = u;
  }
  if (Object.keys(out).length === 0) throw bad();
  return out;
}

// ---- commercial settings (percent in integer basis points, days 0 to 365) ----
const SETTING_RULES = {
  auto_release_reports: bool, whatsapp_enabled: bool, insurance_enabled: bool, print_exception: bool, auto_block_overdue: bool,
  lab_number_scheme_code: re(/^[A-Z0-9_-]{1,20}$/),
  billing_cycle: oneOf('daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'),
  invoice_payment_days: int(0, 365), invoice_blocking_days: int(0, 365), invoice_warning_days: int(0, 365),
  interest_bp_per_day: int(0, 10000), commission_bp: int(0, 10000), tds_bp: int(0, 10000),
  priority: oneOf('P1', 'P2', 'P3', 'P4', 'P5'),
  header_footer_mode: oneOf('with', 'without', 'both'),
};
/** `version` undefined = the first save of a default row (no If-Match: the operation creates the row). */
export async function setPartyCommercialSettingAction(partyKind: string, partyId: string, version: number | undefined, b: Record<string, unknown>) {
  return run(() => send('PUT', `/v1/partners/admin/party-settings/${kind(partyKind)}/${uuid(partyId)}`, clean(b, SETTING_RULES, ['lab_number_scheme_code']), version === undefined ? {} : { version }));
}

// ---- onboarding queue ----
export async function decidePartyOnboardingAction(id: string, version: number, decision: string, reason: string | undefined, key: string) {
  return run(() => {
    const d = oneOf('approve', 'hold', 'reject')(decision);
    if (d !== 'approve' && reason === undefined) throw bad();
    return send('POST', `/v1/partners/admin/onboarding/${uuid(id)}/decision`, { decision: d, ...(reason !== undefined ? { reason: str(reason, 500) } : {}) }, { version, key });
  });
}

// ---- penalty master ----
const PENALTY_RULES = { name: (v: unknown) => str(v, 120), amount_paisa: PAISA };
export async function createPenaltyAction(b: { code: string; name: string; amount_paisa: number }, key: string) {
  return run(() => send('POST', `/v1/partners/admin/penalties`, { code: re(/^[A-Z0-9_-]{1,20}$/)(b?.code), name: str(b?.name, 120), amount_paisa: PAISA(b?.amount_paisa) }, { key }));
}
export async function updatePenaltyAction(id: string, version: number, b: Record<string, unknown>) {
  return run(() => send('PATCH', `/v1/partners/admin/penalties/${uuid(id)}`, clean(b, PENALTY_RULES), { version }));
}
export async function deactivatePenaltyAction(id: string, version: number) {
  return run(() => send('POST', `/v1/partners/admin/penalties/${uuid(id)}/deactivate`, undefined, { version }));
}

// ---- penalty events (charged once: the Idempotency-Key of the dialog makes a repeat answer the same event) ----
export async function raisePenaltyEventAction(b: Record<string, unknown>, key: string) {
  return run(() => {
    const body: Record<string, unknown> = { party_kind: kind(b?.['party_kind']), party_id: uuid(b?.['party_id']), penalty_id: uuid(b?.['penalty_id']), event_date: re(DAY)(b?.['event_date']) };
    if (b['amount_paisa'] !== undefined) body['amount_paisa'] = PAISA(b['amount_paisa']);
    if (b['reason'] !== undefined) body['reason'] = str(b['reason'], 500);
    return send('POST', `/v1/partners/admin/penalty-events`, body, { key });
  });
}
export async function waivePenaltyEventAction(id: string, version: number, reason: string) {
  return run(() => send('POST', `/v1/partners/admin/penalty-events/${uuid(id)}/waive`, { reason: str(reason, 500) }, { version }));
}
export async function chargePenaltyEventAction(id: string, version: number, key: string) {
  return run(() => send('POST', `/v1/partners/admin/penalty-events/${uuid(id)}/charge`, undefined, { version, key }));
}

// ---- masked ID numbers (the server audits every call; 07-SECURITY) ----
export async function revealPartyIdNumberAction(partyKind: string, partyId: string, field: string): Promise<RevealResult> {
  try {
    const r = await serverFetch<{ value: string }>(`/v1/partners/admin/parties/${kind(partyKind)}/${uuid(partyId)}/id-number`, {
      method: 'POST', headers: headers({}), body: JSON.stringify({ field: oneOf('tax_number', 'national_id_number')(field) }), cache: 'no-store',
    });
    return { ok: true, value: r.value };
  } catch (e) {
    const f = fail(e);
    return { ok: false, status: f.status, code: f.code };
  }
}

// ---- ICD master (catalog.yaml) ----
const ICD_CODE = /^[0-9A-Z][0-9A-Z.]{0,15}$/;
export async function createIcdCodeAction(b: { code: string; title: string; chapter?: string }, key: string) {
  return run(() => send('POST', `/v1/catalog/icd-master`, { code: re(ICD_CODE)(b?.code), title: str(b?.title, 500), ...(b?.chapter !== undefined ? { chapter: str(b.chapter, 120) } : {}) }, { key }));
}
export async function updateIcdCodeAction(id: string, version: number, b: Record<string, unknown>) {
  return run(() => send('PATCH', `/v1/catalog/icd-master/${uuid(id)}`, clean(b, { title: (v) => str(v, 500), chapter: (v) => str(v, 120) }), { version }));
}
export async function deactivateIcdCodeAction(id: string, version: number) {
  return run(() => send('POST', `/v1/catalog/icd-master/${uuid(id)}/deactivate`, undefined, { version }));
}
