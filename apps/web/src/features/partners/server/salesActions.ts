'use server';
// T0D-SALES-1 (LD-321): server actions of the sales screens (partners.yaml /v1/partners/admin/sales/**, permission partners.sales.manage).
// POST creates carry the caller's Idempotency-Key; PATCH / deactivate / unassign carry If-Match "<version>". Every value is re-checked here
// (the browser is not trusted) and only a uuid reaches a path. Failures come back as { ok:false, status, code, errors } with the server's
// field messages (path + message, capped), never a raw body.
import 'server-only';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { SALES, isKind, isUuid, type PartyKind } from './sales.server';
import { KEY_RE } from './types';

export type SalesResult = { ok: true } | { ok: false; status: number; code: string; errors?: { path: string; message: string }[] };

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const POINTER = /^\/[a-z_]{1,40}$/;
async function run(f: () => Promise<unknown>): Promise<SalesResult> {
  try {
    await f();
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const raw = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as { path?: unknown; message?: unknown }[]) : [];
    const errors = raw
      .filter((x) => typeof x?.path === 'string' && POINTER.test(x.path) && typeof x.message === 'string')
      .map((x) => ({ path: x.path as string, message: (x.message as string).slice(0, 300) }));
    return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
  }
}

const uuid = (v: unknown) => { if (typeof v !== 'string' || !isUuid(v)) throw bad(); return v; };
const str = (v: unknown, max: number) => { if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw bad(); return v.trim(); };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => { if (typeof v !== 'string' || !DAY.test(v)) throw bad(); return v; };
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const headers = (o: { key?: string; version?: number }) => {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && (!Number.isSafeInteger(o.version) || o.version < 1)) throw bad();
  return {
    'content-type': 'application/json',
    ...(o.key !== undefined ? { 'idempotency-key': o.key } : {}),
    ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}),
  };
};
const send = (method: 'POST' | 'PATCH', path: string, body: unknown, o: { key?: string; version?: number }) =>
  serverFetch<unknown>(path, { method, headers: headers(o), body: JSON.stringify(body) });

/** Keeps only the listed keys that are present; checks each with its rule; `unset` only from `unsetable`. */
function clean(b: Record<string, unknown>, rules: Record<string, (v: unknown) => unknown>, unsetable: readonly string[] = []) {
  const out: Record<string, unknown> = {};
  for (const [k, check] of Object.entries(rules)) if (b[k] !== undefined) out[k] = check(b[k]);
  if (b['unset'] !== undefined) {
    const u = b['unset'];
    if (!Array.isArray(u) || u.length === 0 || u.some((x) => !unsetable.includes(x as string)) || new Set(u).size !== u.length) throw bad();
    out['unset'] = u;
  }
  return out;
}
const nonEmpty = (o: Record<string, unknown>) => { if (Object.keys(o).length === 0) throw bad(); return o; };

// ---- designations (levels 1 to 8) ----
const level = (v: unknown) => { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 8) throw bad(); return v; };
const bool = (v: unknown) => { if (typeof v !== 'boolean') throw bad(); return v; };
export async function createDesignationAction(b: { name: string; level: number }, key: string) {
  return run(() => send('POST', `${SALES}/designations`, { name: str(b.name, 120), level: level(b.level) }, { key }));
}
export async function updateDesignationAction(id: string, version: number, b: { name?: string; level?: number; is_active?: boolean }) {
  return run(() => send('PATCH', `${SALES}/designations/${uuid(id)}`, nonEmpty(clean(b, { name: (v) => str(v, 120), level, is_active: bool })), { version }));
}

// ---- representatives ----
const REP_RULES = {
  name: (v: unknown) => str(v, 200),
  phone: (v: unknown) => { if (typeof v !== 'string' || !PHONE.test(v)) throw bad(); return v; },
  email: (v: unknown) => { if (typeof v !== 'string' || v.length > 254 || !EMAIL.test(v)) throw bad(); return v; },
  designation_id: uuid,
  manager_id: uuid,
  joining_date: day,
};
const REP_UNSET = ['phone', 'email', 'manager_id', 'joining_date'] as const;
export async function createRepresentativeAction(b: Record<string, unknown>, key: string) {
  return run(async () => {
    const body = clean(b, REP_RULES);
    if (!body['name'] || !body['designation_id']) throw bad();
    return send('POST', `${SALES}/representatives`, body, { key });
  });
}
export async function updateRepresentativeAction(id: string, version: number, b: Record<string, unknown>) {
  return run(() => send('PATCH', `${SALES}/representatives/${uuid(id)}`, nonEmpty(clean(b, REP_RULES, REP_UNSET)), { version }));
}
export async function deactivateRepresentativeAction(id: string, version: number) {
  return run(() => send('POST', `${SALES}/representatives/${uuid(id)}/deactivate`, {}, { version }));
}

// ---- client assignment ----
export async function assignPartyAction(b: { party_kind: PartyKind; party_id: string; representative_id: string; effective_from: string; effective_to?: string }, key: string) {
  return run(async () => {
    if (!isKind(b.party_kind)) throw bad();
    const from = day(b.effective_from);
    const to = b.effective_to !== undefined ? day(b.effective_to) : undefined;
    if (to !== undefined && to < from) throw bad();
    return send('POST', `${SALES}/assignments`, { party_kind: b.party_kind, party_id: uuid(b.party_id), representative_id: uuid(b.representative_id), effective_from: from, ...(to ? { effective_to: to } : {}) }, { key });
  });
}
/** If-Match: RepresentativeClient carries no assignment version, and an assignment only ever changes by this call, so it is "1"
 * ([CONV] GAP, CR T0D-SALES-1: add `version` to RepresentativeClient). A stale call answers 409 and the screen says so. */
export async function unassignPartyAction(assignmentId: string, effectiveTo?: string) {
  return run(() => send('POST', `${SALES}/assignments/${uuid(assignmentId)}/unassign`, effectiveTo !== undefined ? { effective_to: day(effectiveTo) } : {}, { version: 1 }));
}

// ---- service areas (free text district and area, not pincodes: LD-321) ----
const AREA_RULES = { name: (v: unknown) => str(v, 200), district: (v: unknown) => str(v, 100), area_text: (v: unknown) => str(v, 500), centre_id: uuid };
export async function createServiceAreaAction(b: Record<string, unknown>, key: string) {
  return run(async () => {
    const body = clean(b, AREA_RULES);
    if (!body['name'] || !body['district']) throw bad();
    return send('POST', `${SALES}/service-areas`, body, { key });
  });
}
export async function updateServiceAreaAction(id: string, version: number, b: Record<string, unknown>) {
  return run(() => send('PATCH', `${SALES}/service-areas/${uuid(id)}`, nonEmpty(clean(b, AREA_RULES, ['area_text', 'centre_id'])), { version }));
}
export async function deactivateServiceAreaAction(id: string, version: number) {
  return run(() => send('POST', `${SALES}/service-areas/${uuid(id)}/deactivate`, {}, { version }));
}
