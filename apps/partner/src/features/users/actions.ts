'use server';
// C13.T19 partner-user write actions (U2 invite, U3 change role, U4 deactivate, U5 reactivate, U6 resend invitation) through the partner BFF. Only { ok, code } reaches the browser.
// 403 auth.mfa_required / identity.mfa_enrolment_required redirect inside partnerApi.
import 'server-only';
import { partnerApi } from '@/core/api';
import { isUuid } from '../common/api';

export type UserResult = { ok: true } | { ok: false; code: string };
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}$/;
const ROLES = new Set(['partner_admin', 'partner_member']);
const DEACTIVATE = new Set(['left_organisation', 'role_changed', 'security_concern', 'other']); // 05-SCHEMA §7 partner_user_deactivate_reasons
const bad: UserResult = { ok: false, code: 'common.validation_failed' };
const out = (r: { ok: boolean; problem?: { code: string } }): UserResult => (r.ok ? { ok: true } : { ok: false, code: r.problem?.code ?? 'common.internal' });
const v = (n: number) => Number.isInteger(n) && n >= 0;

export async function inviteUserAction(i: { email: string; display_name: string; partner_role: string }, idempotencyKey: string): Promise<UserResult> {
  const email = i.email.trim();
  if (!KEY.test(idempotencyKey) || email.length > 254 || !EMAIL.test(email) || i.display_name.trim().length < 1 || i.display_name.length > 120 || !ROLES.has(i.partner_role)) return bad;
  return out(await partnerApi('/v1/partners/users', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: { email, display_name: i.display_name.trim(), partner_role: i.partner_role } }));
}

export async function changeRoleAction(id: string, version: number, role: string): Promise<UserResult> {
  if (!isUuid(id) || !v(version) || !ROLES.has(role)) return bad;
  return out(await partnerApi(`/v1/partners/users/${id}/role`, { method: 'POST', headers: { 'if-match': `"${version}"` }, body: { partner_role: role } }));
}

export async function deactivateUserAction(id: string, version: number, reasonCode: string): Promise<UserResult> {
  if (!isUuid(id) || !v(version) || !DEACTIVATE.has(reasonCode)) return bad;
  return out(await partnerApi(`/v1/partners/users/${id}/deactivate`, { method: 'POST', headers: { 'if-match': `"${version}"` }, body: { reason_code: reasonCode } }));
}

export async function reactivateUserAction(id: string, version: number): Promise<UserResult> {
  if (!isUuid(id) || !v(version)) return bad;
  return out(await partnerApi(`/v1/partners/users/${id}/reactivate`, { method: 'POST', headers: { 'if-match': `"${version}"` }, body: {} }));
}

export async function resendInvitationAction(id: string, idempotencyKey: string): Promise<UserResult> {
  if (!isUuid(id) || !KEY.test(idempotencyKey)) return bad;
  return out(await partnerApi(`/v1/partners/users/${id}/resend-invitation`, { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: {} }));
}
