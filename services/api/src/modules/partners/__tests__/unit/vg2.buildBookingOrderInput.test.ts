// VERIFY-GREEN-2 (LD-268): characterisation of buildBookingOrderInput (conversion.service.ts lines 36 and 44 carry TS2322 / TS2375).
// Pins the EXACT emitted value today so a types-only fix (narrow cast, conditional spread) provably changes nothing: strict deep equality
// (toStrictEqual distinguishes an absent key from `key: undefined`), key sets, no aliasing of the input array. GREEN before and after the fix.
import { describe, expect, it } from 'vitest';
import { buildBookingOrderInput } from '../../service/conversion.service.js';

const ID = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const line = (o: Record<string, unknown> = {}) => ({
  id: ID(1), conversion_attempt: 2, orderable_ids: [ID(10), ID(11)], priority: 'routine', resolved_patient_id: null,
  patient_full_name: 'Synthetic Patient One', patient_sex: 'female', patient_birth_on: '1990-02-03', patient_age_years: null, patient_phone_e164: '+15555550101',
  consent_sms: true, consent_whatsapp: false, consent_email: true, consent_share_with_referrer: false, consent_text_version: 'v3', ...o,
});
const partner = { id: ID(2), credit_party_id: ID(3) };
const manifest = { receiving_branch_id: ID(4), receiving_centre_id: ID(5) };

describe('VERIFY-GREEN-2: buildBookingOrderInput emits identical values (types-only change)', () => {
  it('new patient with birth date + phone + referrer: exact object', () => {
    expect(buildBookingOrderInput(line(), partner, manifest, ID(6))).toStrictEqual({
      source: 'partner_manifest', sourceRefId: ID(1),
      patient: { newPatient: { fullName: 'Synthetic Patient One', sex: 'female', birthOn: '1990-02-03', phoneE164: '+15555550101',
        consents: { sms: true, whatsapp: false, email: true, shareWithReferrer: false, consentTextVersion: 'v3' } } },
      branchId: ID(4), centreId: ID(5), referrerId: ID(6), creditPartyId: ID(3), partnerId: ID(2),
      orderableIds: [ID(10), ID(11)], priority: 'routine', confirmImmediately: true, idempotencyKey: `partners:${ID(1)}:v2`,
    });
  });

  it('existing patient: patient is exactly { patientId }, no newPatient key', () => {
    const r = buildBookingOrderInput(line({ resolved_patient_id: ID(7) }), partner, manifest);
    expect(r.patient).toStrictEqual({ patientId: ID(7) });
    expect(r).not.toHaveProperty('referrerId');
  });

  it('age instead of birth date: ageYears is a Number, birthOn key absent (never undefined-valued); no phone -> phoneE164 key absent', () => {
    const r = buildBookingOrderInput(line({ patient_birth_on: null, patient_age_years: '41', patient_phone_e164: undefined }), partner, manifest, null);
    const p = (r.patient as { newPatient: Record<string, unknown> }).newPatient;
    expect(Object.keys(p).sort()).toEqual(['ageYears', 'consents', 'fullName', 'sex']);
    expect(p['ageYears']).toBe(41);
    expect(Object.keys(r).sort()).toEqual(['branchId', 'centreId', 'confirmImmediately', 'creditPartyId', 'idempotencyKey', 'orderableIds', 'partnerId', 'patient', 'priority', 'source', 'sourceRefId']);
  });

  it('pg date as a Date -> local-midnight calendar day string (same as day() today)', () => {
    const r = buildBookingOrderInput(line({ patient_birth_on: new Date(2001, 8, 9) }), partner, manifest);
    expect((r.patient as { newPatient: { birthOn: string } }).newPatient.birthOn).toBe('2001-09-09');
    const s = buildBookingOrderInput(line({ patient_birth_on: '2001-09-09T00:00:00.000Z' }), partner, manifest);
    expect((s.patient as { newPatient: { birthOn: string } }).newPatient.birthOn).toBe('2001-09-09');
  });

  it('consents are strict booleans (=== true) and the version is passed through; the orderableIds array is a copy; attempt in the key is Number()', () => {
    const l = line({ consent_sms: 'true', consent_email: 1, consent_whatsapp: true, consent_share_with_referrer: true, conversion_attempt: '3' });
    const r = buildBookingOrderInput(l, partner, manifest);
    expect((r.patient as { newPatient: { consents: unknown } }).newPatient.consents).toStrictEqual({ sms: false, whatsapp: true, email: false, shareWithReferrer: true, consentTextVersion: 'v3' });
    expect(r.idempotencyKey).toBe(`partners:${ID(1)}:v3`);
    expect(r.orderableIds).toStrictEqual(l.orderable_ids);
    expect(r.orderableIds).not.toBe(l.orderable_ids);
  });

  it('no clinical_note / collected_at / manifest notes leak into the input (D-102)', () => {
    const r = buildBookingOrderInput(line({ clinical_note: 'x', collected_at: new Date() }), partner, { ...manifest, notes: 'n' });
    expect(JSON.stringify(r)).not.toMatch(/clinical|collected|notes/);
  });
});
