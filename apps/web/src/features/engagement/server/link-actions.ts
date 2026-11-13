'use server';
// C16.T-L1 server actions behind W8. Server actions are public endpoints: permission, ids and body shapes are re-checked here before
// anything reaches the API (which checks the permission again). Only ApiError maps to { ok:false }; anything else rethrows.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { UUID_RE, has } from './queue.server';
import * as api from './link.server';
import { PERM } from './link.server';
import type { IssueBody } from '../components/AppAccess';

export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; code: string };

const bad = (): ActionResult<never> => ({ ok: false, status: 400, code: 'common.validation_failed' });
const uuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
const obj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => list.includes(v as T);
const E164 = /^\+[1-9][0-9]{7,14}$/;
const RELATIONSHIPS = ['self', 'child', 'parent', 'spouse', 'sibling', 'other'] as const;
const LINK_REVOKE_REASONS = ['patient_request', 'suspected_misuse', 'staff_error', 'other'] as const;

async function run<T>(perm: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  if (!(await has(perm))) return { ok: false, status: 403, code: 'auth.forbidden' };
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { ok: false, status: e.status, code: e.problem.code };
  }
}

/** L1. The plaintext code goes back to the browser once, in this response only; it is never logged or stored here. */
export async function issueLinkCodeAction(body: unknown) {
  if (!obj(body) || !uuid(body['patient_id']) || !oneOf(body['relationship'], RELATIONSHIPS) || !oneOf(body['consented_by'], ['patient', 'guardian'] as const)
    || !oneOf(body['identity_check_method'], ['photo_id', 'guardian_photo_id', 'known_patient'] as const) || !oneOf(body['bind_phone'], ['record', 'other'] as const)) return bad();
  const other = body['bind_phone'] === 'other';
  if (other ? typeof body['phone_e164'] !== 'string' || !E164.test(body['phone_e164']) : body['phone_e164'] !== undefined) return bad();
  const b: IssueBody = {
    patient_id: body['patient_id'], relationship: body['relationship'], consented_by: body['consented_by'], identity_check_method: body['identity_check_method'],
    bind_phone: body['bind_phone'], ...(other ? { phone_e164: body['phone_e164'] as string } : {}),
  };
  return run(PERM.issue, () => api.issueLinkCode(b));
}

/** L2 */
export async function revokeLinkCodeAction(linkCodeId: string) {
  return uuid(linkCodeId) ? run(PERM.revoke, async () => { await api.revokeLinkCode(linkCodeId); }) : bad();
}

/** L4 */
export async function revokeAppLinkAction(linkId: string, version: number, body: unknown) {
  if (!uuid(linkId) || !Number.isInteger(version) || version < 1 || !obj(body) || !oneOf(body['reason_code'], LINK_REVOKE_REASONS)) return bad();
  const reason = body['reason_code'];
  return run(PERM.revoke, async () => { await api.revokeAppLink(linkId, version, { reason_code: reason }); });
}
