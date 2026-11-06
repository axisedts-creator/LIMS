// contracts/ports/NotificationPort.ts
import type { RequestContext, Uuidv7, Code } from './common';
import type { PermissionCode } from './IdentityPort';               // added by 08 A4.2 (staff recipient)
export const NOTIFICATION_PORT_VERSION = 1 as const;

export type Recipient =
  | { kind: 'patient'; patientId: Uuidv7 } | { kind: 'referrer'; referrerId: Uuidv7 }
  | { kind: 'centre'; centreId: Uuidv7 } | { kind: 'partner'; partnerId: Uuidv7 }
  | { kind: 'staff'; membershipId: Uuidv7; requiredPermission?: PermissionCode }   // 08 A4.2: C8 sets it for purpose 'scheduled_report_ready'; optional (other purposes keep Phase-1 suppression) [CONV]
  | { kind: 'phone_otp'; phoneE164: string };                    // OTP flows only, before a patient id is known
export type NotificationPurpose = 'registration_confirmation' | 'report_ready' | 'otp' | 'dues_reminder'
  | 'recollection_request' | 'critical_value_alert' | 'booking_confirmation' | 'visit_assignment' | 'follow_up_reminder'
  | 'scheduled_report_ready' | 'booking_cancelled' | 'booking_reminder';          // added by 08 (CR-C8-007, C16-009)
export interface SendBase {
  readonly recipient: Recipient; readonly templateCode: Code; readonly purpose: NotificationPurpose;
  readonly params: Readonly<Record<string, string>>;             // validated against the template's declared non-PHI params
  readonly idempotencyKey: string;
  readonly related?: { readonly entityType: 'order' | 'report' | 'specimen' | 'booking' | 'visit' | 'critical_event'
                                           | 'report_run' /* added by 08 */; readonly entityId: Uuidv7 };
}
export interface SendResult { readonly deliveryId: Uuidv7; readonly status: 'queued' | 'suppressed_no_consent' | 'suppressed_no_contact' | 'suppressed_channel_disabled'; readonly replayed: boolean }

export interface NotificationPortV1 {
  /** @throws reporting.notification_template_unknown, reporting.notification_params_invalid */
  sendSms(ctx: RequestContext, input: SendBase): Promise<SendResult>;
  /** Utility template carrying a link only, no PHI (04 R4). @throws as sendSms */
  sendWhatsAppTemplate(ctx: RequestContext, input: SendBase & { linkUrl?: string }): Promise<SendResult>;
  /** Link-only email via relay (04 R5, S20). @throws as sendSms */
  sendEmailLink(ctx: RequestContext, input: SendBase & { linkUrl: string }): Promise<SendResult>;
}
export type NotificationPort = NotificationPortV1;
