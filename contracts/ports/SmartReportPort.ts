// contracts/ports/SmartReportPort.ts
import type { RequestContext, Uuidv7, Code, IsoUtc, DecimalString } from './common';
export const SMART_REPORT_PORT_VERSION = 1 as const;

export type BandStatus = 'in_range' | 'borderline' | 'out_of_range' | 'critical';
export interface SmartSummary {
  readonly summaryId: Uuidv7; readonly orderId: Uuidv7; readonly reportVersionNo: number;
  readonly templateLibraryVersion: string; readonly status: 'draft' | 'approved';
  readonly approvedByMembershipId?: Uuidv7; readonly approvedAt?: IsoUtc;
  readonly healthScore?: { readonly value: number /* 0–100 */; readonly band: 'good' | 'fair' | 'needs_attention'; readonly formulaVersion: string; readonly panelsScored: number;
                           readonly explanationText?: string /* added by 08 */ };
  readonly panels: readonly { readonly panelCode: Code; readonly status: BandStatus; readonly resultIds: readonly Uuidv7[]; readonly displayName?: string /* added by 08 */ }[];
  readonly deranged: readonly { readonly resultId: Uuidv7; readonly analyteId: Uuidv7; readonly direction: 'low' | 'high' | 'abnormal'; readonly severity: BandStatus; readonly templateBlockId: Uuidv7; readonly text: string;
                                readonly analyteName?: string /* added by 08 */ }[];
  readonly advice: readonly { readonly templateBlockId: Uuidv7; readonly text: string }[];
  readonly followUps: readonly { readonly ruleId: Uuidv7; readonly suggestedTestCode: Code; readonly intervalDays: number; readonly text: string;
                                 readonly suggestedTestName?: string /* added by 08 */ }[];
  readonly trends: readonly { readonly analyteId: Uuidv7; readonly direction: 'improved' | 'worsened' | 'stable'; readonly pointResultIds: readonly Uuidv7[];
                              readonly analyteName?: string; readonly unitCode?: Code;                       // added by 08
                              readonly points?: readonly { readonly resultId: Uuidv7; readonly approvedAt: IsoUtc; readonly valueNumeric: DecimalString }[] }[];
  readonly disclaimerBlockId: Uuidv7;
  // added by 08 (CR-C14-001 + C16-015): display fields
  readonly language?: 'en' | 'ne'; readonly builtAt?: IsoUtc; readonly disclaimerText?: string;
  // also optional: healthScore.explanationText?; panels[].displayName?; deranged[].analyteName?; followUps[].suggestedTestName?;
  // trends[].analyteName?, trends[].unitCode?, trends[].points?: { resultId; approvedAt; valueNumeric }[] — added to the element types above
}
export interface SmartReportPortV1 {
  /** Builds (or returns the cached) rules-based summary from approved results only (01 §5.2; 04 R8).
   *  @throws smartreport.no_eligible_results, smartreport.template_not_approved, smartreport.feature_disabled
   *  Never throws `smartreport.summary_not_ready` (08 A19 D-111): a summary not yet approved is returned with `status: 'draft'`
   *  (contract case 10); the code stays registered but unused by the port.
   *  Callers: staff (`user`) and `system` actors only (08 A2.3); patient/portal/partner actors read the C6 snapshot via ReportingPort. */
  buildSummary(ctx: RequestContext, input: { orderId: Uuidv7; version: number }): Promise<SmartSummary>;  // `version` = report version number
}
export type SmartReportPort = SmartReportPortV1;
