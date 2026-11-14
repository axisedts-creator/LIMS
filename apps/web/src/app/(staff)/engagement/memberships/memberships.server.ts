import 'server-only';
// W10 BFF: M1a listMembershipPlans, M1b create/updateMembershipPlan (aal2 on the API), M2 enrolMembership (Idempotency-Key), M4 lookupMembershipCard (POST body only:
// the scanned value never goes into a URL), M5 cancelMembership (If-Match "<version>"). The JWT stays server-side (serverFetch). Only uuids reach a path.
import { serverFetch } from '@/core/api/server-fetch';

export interface MembershipPlan {
  id: string; code: string; display_name: string; description?: string; price_list_id: string; validity_days: number; is_active: boolean; version: number;
}
export interface PlanInput { code: string; display_name: string; description?: string; price_list_id: string; validity_days: number; is_active: boolean }
export interface Membership {
  id: string; patient_id: string; plan_id: string; plan_display_name: string; card_no: string; card_token: string;
  valid_from: string; valid_to: string; status: string; cancelled_at?: string; cancel_reason_code?: string; version: number;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLANS = '/v1/engagement/membership-plans';
const CARDS = '/v1/engagement/memberships';
const json = { 'content-type': 'application/json' };
const planBody = (i: PlanInput) => JSON.stringify({
  code: i.code, display_name: i.display_name, ...(i.description ? { description: i.description } : {}),
  price_list_id: i.price_list_id, validity_days: i.validity_days, is_active: i.is_active,
});
const uuid = (id: string) => { if (!UUID_RE.test(id)) throw new Error('invalid id'); return id; }; // last line of defence against path injection

export const listPlans = () => serverFetch<{ data: MembershipPlan[] }>(PLANS);
export const createPlan = (input: PlanInput, key: string) => serverFetch<MembershipPlan>(PLANS, { method: 'POST', headers: { ...json, 'idempotency-key': key }, body: planBody(input) });
export const updatePlan = (id: string, version: number, input: PlanInput) =>
  serverFetch<MembershipPlan>(`${PLANS}/${uuid(id)}`, { method: 'PUT', headers: { ...json, 'if-match': `"${Math.trunc(version)}"` }, body: planBody(input) });

export const lookupCard = (body: { card_token: string } | { card_no: string }) => serverFetch<Membership>('/v1/engagement/memberships/lookup',{ method: 'POST', headers: json, body: JSON.stringify(body) });
export const enrol = (input: { patient_id: string; plan_id: string; valid_from: string }, key: string) =>
  serverFetch<Membership>(CARDS, { method: 'POST', headers: { ...json, 'idempotency-key': key }, body: JSON.stringify({ patient_id: input.patient_id, plan_id: input.plan_id, valid_from: input.valid_from }) });
export const cancel = (id: string, version: number, reason: string) =>
  serverFetch<Membership>(`${CARDS}/${uuid(id)}/cancel`, { method: 'POST', headers: { ...json, 'if-match': `"${Math.trunc(version)}"` }, body: JSON.stringify({ reason_code: reason }) });
