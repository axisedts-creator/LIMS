'use server';
// Server actions for W9. Only ApiError is mapped to { ok:false, code } (a thrown ApiError loses its code across the action boundary in production);
// anything else rethrows to the error boundary. The API re-checks engagement.reminder.manage on every call.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { searchPatients } from '@/features/frontdesk/server/read.server';
import { UUID_RE, cancelReminder, createReminder } from './reminders.server';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const REASON = /^[a-z0-9_]{1,64}$/;
const reject = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
async function api<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

/** R2. due_at must be an ISO-8601 UTC instant; the ≥ now + 1 h rule is checked by the form and by the API. */
export async function createReminderAction(input: { patient_id: string; reason_code: string; due_at: string }, key: string): Promise<ActionResult<{ id: string }>> {
  if (!KEY.test(key) || !UUID_RE.test(String(input?.patient_id)) || !REASON.test(String(input?.reason_code)) || !/Z$/.test(String(input?.due_at)) || Number.isNaN(Date.parse(String(input?.due_at)))) return reject();
  return api(async () => ({ id: (await createReminder(input, key)).id }));
}

/** R3. `version` is the one the row was read at (If-Match). */
export async function cancelReminderAction(id: string, version: number): Promise<ActionResult<{ id: string }>> {
  if (!UUID_RE.test(String(id)) || !Number.isInteger(version)) return reject();
  return api(async () => ({ id: (await cancelReminder(id, version)).id }));
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
