// contracts/ports/ReportingPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Page } from './common';
import type { SmartSummary } from './SmartReportPort';            // added by 08 A2.3 (snapshot type only; no SmartReportPort call)
export const REPORTING_PORT_VERSION = 1 as const;

export interface ReleasedReportSummary {
  readonly reportId: Uuidv7; readonly versionNo: number; readonly orderId: Uuidv7; readonly patientId: Uuidv7;
  readonly kind: 'final' | 'partial' | 'preliminary' | 'amended' | 'addendum';   // 'addendum' added by 08 (R1)
  readonly status: 'valid' | 'superseded';
  readonly releasedAt: IsoUtc; readonly panelNames: readonly string[];   // P3 — only for authorised consumers
  readonly smartSummaryAvailable: boolean;   // 08 A4.4: true iff smart_summary_json / smart_summary_id / smart_summary_version are non-null on the version being read
}
export interface ReportsFilter {
  readonly orderId?: Uuidv7; readonly patientId?: Uuidv7; readonly partnerId?: Uuidv7; readonly centreId?: Uuidv7;
  readonly releasedFrom?: IsoUtc; readonly releasedTo?: IsoUtc; readonly includeSuperseded?: boolean;
}

export interface ReportingPortV1 {
  /** Exactly one of orderId | patientId | partnerId | centreId must be set. @throws common.validation_failed */
  getReleasedReports(ctx: RequestContext, input: { filter: ReportsFilter; cursor?: string; limit?: number }): Promise<Page<ReleasedReportSummary>>;
  /** Creates a ≥128-bit random link token (04 A10) bound to report+channel, TTL from tenant settings (30–90 d), OTP-gated (04 A9).
   *  The returned URL is a secret: pass it only to NotificationPort (or, for C13 access slips, render it once into the slip PDF in the
   *  C13 worker — 08 A2.1); never log/store it elsewhere. Write: callers are staff (`user`) or `system` actors only (08 R8, A2.1).
   *  @throws reporting.report_not_released, reporting.report_superseded */
  issuePortalLink(ctx: RequestContext, input: { reportId: Uuidv7; versionNo?: number;
    channel: 'whatsapp' | 'sms' | 'email' | 'print_qr' | 'patient_app'; recipientKind: 'patient' | 'referrer' | 'centre' | 'partner' }): Promise<{ linkId: Uuidv7; url: string; expiresAt: IsoUtc }>;
  // ---- added by 08 (CR-C13-005, C16-008)
  /** Released or superseded versions only. Partner actors: reports.partner_id = app.current_partner_id(); patient actors:
   *  patient_id ∈ app.engagement_patient_ids() (C16 also checks visible_from). @throws common.not_found (indistinguishable) */
  openReleasedReportFile(ctx: RequestContext, input: { reportId: Uuidv7; versionNo: number }): Promise<ReleasedReportFile>;
  /** Patient actor. Valid unexpired unrevoked link, recipient 'patient', channel sms|whatsapp, destination = phoneE164.
   *  Never consumes/extends/reveals the link; 5 failures per token. @throws reporting.link_invalid (identical for every failure) */
  redeemPortalLinkForApp(ctx: RequestContext, input: { linkToken: string; phoneE164: string }): Promise<{ patientId: Uuidv7; reportId: Uuidv7; versionNo: number; releasedAt: IsoUtc }>;
}
export type ReportingPort = ReportingPortV1;

// ---- added by 08
export interface ReleasedReportFile { readonly reportVersionId: Uuidv7; readonly reportId: Uuidv7; readonly versionNo: number;
  readonly status: 'valid' | 'superseded'; readonly contentType: 'application/pdf'; readonly byteSize: number; readonly sha256: string;
  readonly signedUrl: string /* internal Storage URL, TTL ≤ 300 s, never logged or returned to browsers */; readonly expiresAt: IsoUtc;
  /** 08 A2.3/A2.8/A4.4: approved SmartSummary JSON snapshot stored by C6 on this report version — at first assembly and at Regenerate
   *  (reason `smart_summary_added`) alike; absent when none attached. Placement on this result type is [CONV]. */
  readonly smartSummary?: SmartSummary }
