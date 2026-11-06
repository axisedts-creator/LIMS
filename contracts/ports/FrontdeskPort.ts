// contracts/ports/FrontdeskPort.ts
import type { RequestContext, Uuidv7, IsoUtc, IsoDate, Priority, Sex } from './common';
export const FRONTDESK_PORT_VERSION = 1 as const;

export type OrderStatus = 'pre_registered' | 'registered' | 'in_progress' | 'completed' | 'cancelled';
export interface OrderSummary {
  readonly orderId: Uuidv7; readonly registrationNo: string; readonly patientId: Uuidv7;
  readonly branchId: Uuidv7; readonly centreId: Uuidv7;
  readonly visitType: 'opd' | 'ipd'; readonly billingMode: 'cash' | 'credit';
  readonly creditPartyId?: Uuidv7; readonly referrerId?: Uuidv7;
  readonly priority: Priority; readonly status: OrderStatus;
  readonly source: 'front_desk' | 'engagement_booking' | 'home_collection' | 'partner_manifest';
  readonly sourceRefId?: Uuidv7;
  readonly items: readonly { readonly orderItemId: Uuidv7; readonly orderableId: Uuidv7; readonly orderableKind: 'test' | 'panel';
                             readonly testIds: readonly Uuidv7[]; readonly priority: Priority; readonly status: 'active' | 'removed' | 'cancelled';
                             readonly outsourced: boolean }[];
  readonly registeredAt?: IsoUtc; readonly version: number;
  readonly partnerId?: Uuidv7;                                   // added by 08 (R25, CR-C4-006)
}
export type DemographicsPurpose = 'report_render' | 'label_print' | 'notification' | 'instrument_host_query'
  | 'portal_display' | 'partner_display' | 'smart_report' | 'home_visit'
  | 'result_evaluation' | 'lab_display' | 'patient_app_link';   // added by 08 (CR-C5-003, C16-007)
export interface PatientDemographics {
  readonly patientId: Uuidv7; readonly patientCode: string;     // per-tenant patient code ("lab code", 00 A2)
  readonly fullName?: string; readonly sex: Sex;
  readonly birthOn?: IsoDate; readonly ageAtOrder?: { readonly years: number; readonly months: number; readonly days: number };
  readonly phoneE164?: string; readonly email?: string;
  readonly consents: { readonly sms: boolean; readonly whatsapp: boolean; readonly email: boolean; readonly shareWithReferrer: boolean; readonly consentTextVersion: string };
  readonly status: 'active' | 'merged' | 'anonymised';           // added by 08: all purposes (CR-C16-007)
  readonly contactPresence?: { readonly phone: boolean; readonly email: boolean };   // added by 08: purpose 'notification' for non-system actors (CR-C6-015)
}
export interface BookingOrderInput {
  readonly source: 'engagement_booking' | 'home_collection' | 'partner_manifest';
  readonly sourceRefId: Uuidv7;                                  // booking id / visit id / manifest line id
  readonly patient: { readonly patientId: Uuidv7 } | { readonly newPatient: { readonly fullName: string; readonly sex: Sex; readonly birthOn?: IsoDate; readonly ageYears?: number; readonly phoneE164?: string; readonly consents: PatientDemographics['consents'] } };
  readonly branchId: Uuidv7; readonly centreId: Uuidv7;
  readonly referrerId?: Uuidv7; readonly creditPartyId?: Uuidv7;
  readonly orderableIds: readonly Uuidv7[]; readonly priority: Priority;
  readonly scheduledAt?: IsoUtc;
  readonly confirmImmediately: boolean;                          // true → 'registered' (emits order.created); false → 'pre_registered'
  readonly idempotencyKey: string;
  readonly partnerId?: Uuidv7;                                   // added by 08: required iff source = 'partner_manifest'; immutable on the order
}

export interface FrontdeskPortV1 {
  getOrderSummary(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<OrderSummary>;
  /** Field set depends on purpose (REQ-SEC-081). @throws auth.forbidden if the actor's permissions do not cover the purpose */
  getPatientDemographics(ctx: RequestContext, input: { patientId: Uuidv7; purpose: DemographicsPurpose }): Promise<PatientDemographics>;
  /** @throws frontdesk.booking_already_converted (same sourceRefId, different idempotencyKey), frontdesk.consent_required,
   *          catalog.test_inactive, catalog.no_price, frontdesk.patient_duplicate_suspected */
  createOrderFromBooking(ctx: RequestContext, input: BookingOrderInput): Promise<{ orderId: Uuidv7; registrationNo: string; status: 'pre_registered' | 'registered'; replayed: boolean }>;
  // ---- added by 08
  /** Missing/invisible ids omitted. ≤ 200 ids. @throws auth.forbidden (purpose not covered) */
  getPatientDemographicsBatch(ctx: RequestContext, input: { patientIds: readonly Uuidv7[]; purpose: DemographicsPurpose }): Promise<readonly PatientDemographics[]>;
  /** Engagement system actor only. Always creates a NEW patient (source 'self_service'); never returns an existing id.
   *  @throws frontdesk.consent_required, auth.forbidden */
  createSelfRegisteredPatient(ctx: RequestContext, input: { fullName: string; sex: Sex; birthOn?: IsoDate; ageYears?: number; phoneE164: string;
    consents: PatientDemographics['consents']; idempotencyKey: string }): Promise<{ patientId: Uuidv7; patientCode: string; duplicateSuspected: boolean; replayed: boolean }>;
}
export type FrontdeskPort = FrontdeskPortV1;
