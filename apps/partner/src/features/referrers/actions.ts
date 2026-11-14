'use server';
// C13.T19 referring-doctor write actions (F2 create, F3 update, F4 deactivate, F5 reactivate) through the partner BFF. Only { ok, code } reaches the browser.
import 'server-only';
import { partnerApi } from '@/core/api';
import { isUuid } from '../common/api';

export interface DoctorInput { display_name: string; qualification: string; registration_council: string; registration_no: string }
export type DoctorResult = { ok: true } | { ok: false; code: string };

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const bad: DoctorResult = { ok: false, code: 'common.validation_failed' };
const valid = (d: DoctorInput) =>
  d.display_name.trim().length >= 1 && d.display_name.length <= 120 && d.qualification.length <= 120 && d.registration_council.length <= 20 && d.registration_no.length <= 30;
const out = (r: { ok: boolean; problem?: { code: string } }): DoctorResult => (r.ok ? { ok: true } : { ok: false, code: r.problem?.code ?? 'common.internal' });

export async function createDoctorAction(d: DoctorInput, idempotencyKey: string): Promise<DoctorResult> {
  if (!valid(d) || !KEY.test(idempotencyKey)) return bad;
  return out(await partnerApi('/v1/partners/referrers', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey },
    body: { display_name: d.display_name.trim(), ...(d.qualification ? { qualification: d.qualification } : {}), ...(d.registration_council ? { registration_council: d.registration_council } : {}), ...(d.registration_no ? { registration_no: d.registration_no } : {}) },
  }));
}

/** F3: emptied optional fields are sent as unset[]. */
export async function updateDoctorAction(id: string, version: number, d: DoctorInput): Promise<DoctorResult> {
  if (!isUuid(id) || !Number.isInteger(version) || version < 0 || !valid(d)) return bad;
  const opt = { qualification: d.qualification, registration_council: d.registration_council, registration_no: d.registration_no } as const;
  const unset = Object.entries(opt).filter(([, v]) => v === '').map(([k]) => k);
  return out(await partnerApi(`/v1/partners/referrers/${id}`, {
    method: 'PATCH', headers: { 'if-match': `"${version}"` },
    body: { display_name: d.display_name.trim(), ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== '')), ...(unset.length ? { unset } : {}) },
  }));
}

export async function setDoctorActiveAction(id: string, version: number, active: boolean): Promise<DoctorResult> {
  if (!isUuid(id) || !Number.isInteger(version) || version < 0) return bad;
  return out(await partnerApi(`/v1/partners/referrers/${id}/${active ? 'reactivate' : 'deactivate'}`, { method: 'POST', headers: { 'if-match': `"${version}"` }, body: {} }));
}
