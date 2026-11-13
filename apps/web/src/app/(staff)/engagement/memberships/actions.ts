'use server';
// Server actions for W10. Only ApiError is mapped to { ok:false, status, code, fields } (a thrown ApiError loses its code across the action boundary in
// production); anything else rethrows to the error boundary. The API re-checks every permission (plan writes at aal2). The card token never leaves the
// server: results are stripped to CardView (the desk reads the card number, not the secret).
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { searchPatients } from '@/features/frontdesk/server/read.server';
import { UUID_RE, cancel, createPlan, enrol, lookupCard, updatePlan, type Membership, type MembershipPlan, type PlanInput } from './memberships.server';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; fields?: string[] };
export interface CardView { id: string; plan_display_name: string; card_no: string; valid_from: string; valid_to: string; status: string; version: number }

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[0-9A-Z]{26}$/;
const CARD_NO = /^MB[0-9]{8}$/;
const PLAN_CODE = /^[A-Z0-9_]{2,20}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASONS = ['patient_request', 'staff_error', 'other'];
const reject = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
const view = (m: Membership): CardView => ({ id: m.id, plan_display_name: m.plan_display_name, card_no: m.card_no, valid_from: m.valid_from, valid_to: m.valid_to, status: m.status, version: m.version });

async function api<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errs = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as { path?: unknown }[]) : [];
      const fields = errs.map((f) => String(f?.path)).slice(0, 10); // paths only: no server text is echoed back
      return { ok: false, status: e.status, code: e.problem.code, ...(fields.length ? { fields } : {}) };
    }
    throw e;
  }
}

/** M4. `value` is a scanned/typed card token (26 chars) or card number (MB + 8 digits); anything else is refused before the API. */
export async function lookupCardAction(value: string): Promise<ActionResult<CardView>> {
  const v = String(value ?? '');
  const body = TOKEN.test(v) ? { card_token: v } : CARD_NO.test(v) ? { card_no: v } : undefined;
  if (!body) return reject();
  return api(async () => view(await lookupCard(body)));
}

/** M2. valid_from = YYYY-MM-DD; the today … +30 d window is checked by the form and by the API. */
export async function enrolAction(input: { patient_id: string; plan_id: string; valid_from: string }, key: string): Promise<ActionResult<CardView>> {
  if (!KEY.test(key) || !UUID_RE.test(String(input?.patient_id)) || !UUID_RE.test(String(input?.plan_id)) || !ISO_DATE.test(String(input?.valid_from))) return reject();
  return api(async () => view(await enrol(input, key)));
}

/** M5. `version` is the one the card was read at (If-Match). */
export async function cancelMembershipAction(id: string, version: number, reason: string): Promise<ActionResult<CardView>> {
  if (!UUID_RE.test(String(id)) || !Number.isInteger(version) || !REASONS.includes(String(reason))) return reject();
  return api(async () => view(await cancel(id, version, reason)));
}

const validPlan = (i: PlanInput) => PLAN_CODE.test(String(i?.code)) && typeof i.display_name === 'string' && i.display_name.length >= 1 && i.display_name.length <= 60
  && (i.description === undefined || (typeof i.description === 'string' && i.description.length <= 300)) && UUID_RE.test(String(i.price_list_id))
  && Number.isInteger(i.validity_days) && i.validity_days >= 30 && i.validity_days <= 1095 && typeof i.is_active === 'boolean';

/** M1b create (Idempotency-Key). */
export async function createPlanAction(input: PlanInput, key: string): Promise<ActionResult<MembershipPlan>> {
  if (!KEY.test(key) || !validPlan(input)) return reject();
  return api(() => createPlan(input, key));
}

/** M1b update (If-Match = the version the row was read at). */
export async function updatePlanAction(id: string, version: number, input: PlanInput): Promise<ActionResult<MembershipPlan>> {
  if (!UUID_RE.test(String(id)) || !Number.isInteger(version) || !validPlan(input)) return reject();
  return api(() => updatePlan(id, version, input));
}

/** C4 patient lookup for the Combobox: 2..100 chars, max 20 rows, only id + display label leave the server. */
export async function searchPatientsAction(query: string): Promise<{ id: string; display: string }[]> {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 2 || q.length > 100) return [];
  try {
    return (await searchPatients(q)).slice(0, 20).map((p) => ({ id: p.id, display: `${p.full_name} (${p.patient_code})` }));
  } catch (e) {
    if (e instanceof ApiError) return [];
    throw e;
  }
}
