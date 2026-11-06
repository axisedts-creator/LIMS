// contracts/ports/LabPort.ts
import type { RequestContext, Uuidv7, IsoUtc, DecimalString, Code, Priority, Sex, ResultStatus, SpecimenStatus, Page } from './common';
export const LAB_PORT_VERSION = 1 as const;

export interface ResultView {
  readonly resultId: Uuidv7; readonly orderItemId: Uuidv7; readonly testId: Uuidv7; readonly analyteId: Uuidv7;
  readonly versionNo: number; readonly status: ResultStatus;
  readonly valueText?: string; readonly valueNumeric?: DecimalString; readonly ordinalCode?: Code; readonly unitCode?: Code;
  readonly flag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';          // HH/LL = critical; A = abnormal non-numeric [CONV]
  // (C5 result marker `range_unavailable_age_unknown` — 08 A17.1, §4.2 — is a C5 column/HTTP field, not a `flag` value and not a ResultView v1 field)
  readonly referenceRangeSnapshot?: { readonly referenceRangeId: Uuidv7; readonly version: number; readonly low?: DecimalString; readonly high?: DecimalString; readonly text?: string };
  readonly methodName?: string; readonly origin: 'instrument' | 'manual' | 'calculated' | 'module';
  readonly instrumentId?: Uuidv7;
  readonly commentCodes: readonly Code[]; readonly commentText?: string;
  readonly attachments: readonly { readonly bucket: string; readonly objectPath: string; readonly sha256: string; readonly mimeType: string }[];
  readonly onHold: boolean; readonly qcReviewRequired: boolean;
  readonly verifiedAt?: IsoUtc; readonly verifiedByMembershipId?: Uuidv7;
  readonly approvedAt?: IsoUtc; readonly approvedByMembershipId?: Uuidv7;
  readonly amendment?: { readonly previousVersionNo: number; readonly reasonCode: Code; readonly reasonText?: string; readonly amendedAt: IsoUtc };
  readonly moduleRef?: { readonly module: 'micro' | 'anatomic'; readonly entityId: Uuidv7; readonly versionNo: number };   // added by 08 (CR-C6-006)
}
export interface OrderResults {
  readonly orderId: Uuidv7;
  readonly specimens: readonly { readonly specimenId: Uuidv7; readonly specimenTypeCode: Code; readonly status: import('./common').SpecimenStatus;
                                 readonly collectedAt?: IsoUtc; readonly receivedAt?: IsoUtc;
                                 readonly barcode?: string /* added by 08 (CR-C6-006): P2, scope 'approved' only */ }[];
  readonly items: readonly { readonly orderItemId: Uuidv7; readonly testId: Uuidv7; readonly departmentId: Uuidv7; readonly results: readonly ResultView[] }[];
  readonly approvedSetHash: string;                              // same hash as lab.order.ready_for_report.v1
}
export interface InstrumentResultInput {                         // = instruments.result.received.v1 payload, camelCased field for field (08 A13 D-10)
  readonly instrumentMessageId: Uuidv7; readonly instrumentId: Uuidv7; readonly agentId: Uuidv7; readonly centreId: Uuidv7;
  readonly protocol: 'astm' | 'hl7v2' | 'file_drop';
  readonly sampleBarcode: string; readonly recordKind: 'quantitative' | 'qualitative' | 'ordinal' | 'text' | 'organism_id' | 'ast' | 'attachment';
  readonly instrumentAnalyteCode: string; readonly mappingStatus: 'mapped' | 'unmapped'; readonly analyteId?: Uuidv7; readonly testId?: Uuidv7;
  readonly valueRaw?: string; readonly valueNumeric?: DecimalString; readonly unitRaw?: string; readonly unitCode?: Code;
  readonly instrumentFlags?: readonly string[];                  // absent = []
  readonly instrumentResultTime?: IsoUtc; readonly instrumentClockOffsetSeconds?: number; readonly receivedAt: IsoUtc;
  readonly isRerun?: boolean;                                    // absent = false
  readonly capturedAt?: IsoUtc; readonly processingKind?: 'live' | 'reprocess' | 'rematch'; readonly sourceRecordId?: Uuidv7;
  readonly organism?: { readonly organismCodeRaw: string; readonly organismCode?: Code; readonly isolateSeq?: number };   // shape as §3.14 `organism`
  readonly ast?: { readonly antibioticCodeRaw: string; readonly antibioticCode?: Code; readonly isolateSeq?: number;
                   readonly method: 'mic' | 'zone_diameter' | 'other'; readonly rawValue: string; readonly interpretationRaw?: string;
                   readonly standard?: 'CLSI' | 'EUCAST' | 'ECOFF' | 'unknown'; readonly standardVersion?: string };    // shape as §3.14 `ast`
  readonly attachment?: { readonly bucket: string; readonly objectPath: string; readonly sha256: string; readonly mimeType: string };   // port only (unchanged)
}

export interface LabPortV1 {
  /** scope 'approved' = only approved (latest version) results — what reports/smart report may use.
   *  scope 'all_visible' = every status, for staff UIs of consumer modules with lab.result.read permission. */
  getOrderResults(ctx: RequestContext, input: { orderId: Uuidv7; scope: 'approved' | 'all_visible' }): Promise<OrderResults>;
  /** Host query (bi-directional instruments, 01 §3.1). @throws lab.specimen_not_found (unknown barcode in tenant),
   *  lab.specimen_not_receivable (rejected/discarded/not yet received per tenant rule) */
  getPendingTestsForBarcode(ctx: RequestContext, input: { instrumentId: Uuidv7; barcode: string }): Promise<{
    specimenId: Uuidv7; priority: Priority; patient: { sex: Sex; ageDays?: number };
    tests: readonly { orderItemId: Uuidv7; testId: Uuidv7; analyteIds: readonly Uuidv7[] }[] }>;
  /** Synchronous apply of one instrument result (manual re-match / replay from the C7 UI). The bulk path is the
   *  instruments.result.received.v1 consumer; both are idempotent on the 04 N10 result-level key.
   *  Never throws for an approved target: returns outcome `rejected_state` with `reasonCode: 'result_locked'` (CR-C5-008). A key stored as `unmatched`/`rejected_state` with an open C5 exception is re-evaluated on replay (CR-C7-011). */
  ingestInstrumentResult(ctx: RequestContext, input: InstrumentResultInput): Promise<{
    outcome: 'applied' | 'duplicate' | 'unmatched' | 'rejected_state' | 'held'; resultId?: Uuidv7; specimenId?: Uuidv7; reasonCode?: Code }>;
  /** QC failure hold (01 §2.5): marks matching non-approved results on_hold; approved ones get qcReviewRequired. Idempotent on qcRunId. */
  holdResultsSince(ctx: RequestContext, input: { instrumentId: Uuidv7; analyteIds: readonly Uuidv7[]; since: IsoUtc; qcRunId: Uuidv7; reasonCode: Code }): Promise<{ heldResultIds: readonly Uuidv7[]; reviewFlaggedResultIds: readonly Uuidv7[] }>;
  /** Accepted addition A1. Hands a finished micro (C10) or anatomic (C11) result into the common result chain so that
   *  verification → approval → lab.order.ready_for_report.v1 → report release work identically for every department.
   *  The module keeps its detailed data in its own schema; C5 stores a reference + a reportable summary.
   *  @throws lab.module_result_invalid, lab.result_locked, lab.result_invalid_transition, lab.module_result_stale */
  submitModuleResult(ctx: RequestContext, input: SubmitModuleResultInput): Promise<SubmitModuleResultOutput>;
  // ---- added by 08
  /** Callers holding frontdesk.order.read or frontdesk.order.edit, or system. No PHI. (08 A13 D-5) */
  getOrderItemProcessingState(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<readonly { orderItemId: Uuidv7; removable: boolean; reasonCode?: Code;
    processingStatus: 'not_started' | 'in_progress' | 'reported' | 'cancelled' }[]>;
  /** Worklist download (BLOCKED B2 per instrument). Received specimens of the device's centre with ≥ 1 pending result mapped outbound for instrumentId. */
  listPendingForInstrument(ctx: RequestContext, input: { instrumentId: Uuidv7; receivedSince?: IsoUtc; limit?: number /* ≤ 200 */; cursor?: string }):
    Promise<Page<{ specimenId: Uuidv7; barcode: string; priority: Priority; patient: { sex: Sex; ageDays?: number };
                   tests: readonly { orderItemId: Uuidv7; testId: Uuidv7; analyteIds: readonly Uuidv7[] }[] }>>;
  /** No side effects; caller RLS. Users: lab.specimen.read; the {orderId} form also with homecollection.visit.read (C17 checks assignment);
   *  system: tenant-wide; device: refused. Unknown/invisible → omitted. An old barcode of a recollected specimen resolves only to the old specimen. */
  lookupSpecimens(ctx: RequestContext, input: SpecimenSelector): Promise<readonly SpecimenRef[]>;
  /** Approved results only, latest version, approvedAt in [since, before), newest first, RLS-scoped; unknown patient → empty series. */
  getAnalyteHistory(ctx: RequestContext, input: { patientId: Uuidv7; analyteIds: readonly Uuidv7[] /* 1..100 */; before: IsoUtc; since?: IsoUtc;
    limitPerAnalyte: number /* 1..10 */; excludeOrderId?: Uuidv7; includeLegacy?: boolean /* default false */ }):
    Promise<{ series: readonly { analyteId: Uuidv7; points: readonly AnalyteHistoryPoint[] }[] }>;
}
export type LabPort = LabPortV1;

// ---- added by 08 (CR-C10-003 + C17-002, CR-C14-002)
export type SpecimenSelector =
  | { readonly barcode: string }
  | { readonly specimenIds: readonly Uuidv7[] }                                  // 1..200
  | { readonly orderId: Uuidv7; readonly statuses?: readonly SpecimenStatus[] };
export interface SpecimenRef {
  readonly specimenId: Uuidv7; readonly barcode: string; readonly orderId: Uuidv7; readonly patientId: Uuidv7; readonly centreId: Uuidv7;
  readonly processingCentreId?: Uuidv7; readonly specimenTypeCode: Code; readonly containerCode?: Code; readonly status: SpecimenStatus;
  readonly isActive: boolean; readonly replacesSpecimenId?: Uuidv7; readonly parentSpecimenId?: Uuidv7; readonly version: number }
export interface AnalyteHistoryPoint {
  readonly source: 'lis' | 'legacy';                 // 'legacy' only when includeLegacy and C18 data exist (DEFER B4)
  readonly resultId: Uuidv7;                         // lab.results id, or lab.legacy_results id when source = 'legacy'
  readonly orderId?: Uuidv7; readonly versionNo?: number; readonly approvedAt: IsoUtc;
  readonly valueNumeric?: DecimalString; readonly unitCode?: Code; readonly flag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A' }

/** A1 input. Exactly one submission per (payloadRef.module, payloadRef.entityId, payloadRef.versionNo). */
export interface SubmitModuleResultInput {
  readonly orderItemId: Uuidv7;
  readonly analyteId?: Uuidv7;                 // omitted → the test's single reportable "module result" analyte (C3 seeds one per micro/anatomic test)
  readonly kind: 'structured' | 'narrative' | 'ast_panel' | 'organism';
  readonly reportPhase: 'preliminary' | 'final';   // micro prelim/final (01 research §2.3); anatomic always 'final' at sign-out
  readonly payloadRef: { readonly module: 'micro' | 'anatomic'; readonly entityId: Uuidv7; readonly versionNo: number };
  readonly summaryText?: string;               // ≤ 4,000 chars, plain text, shown in worklists; full content rendered from the module (see below)
  readonly flag?: 'N' | 'A';                   // abnormal marker for the result list
  readonly isCritical?: boolean;               // module-determined critical finding → C5 emits lab.critical_value.detected.v1 (direction 'abnormal')
  readonly submittedAt: IsoUtc;
  readonly idempotencyKey: string;             // `${module}:${entityId}:${versionNo}`
  readonly amendment?: { readonly reasonCode: Code; readonly reasonText?: string /* ≤ 500 chars, P3 */ };   // added by 08 (R1)
}
export interface SubmitModuleResultOutput {
  readonly resultId: Uuidv7;
  readonly versionNo: number;                  // results.current_version_no after the call (1 until first approval; n+1 for an amendment) — 08 A13 D-7
  readonly status: ResultStatus;               // 'resulted' for a new prelim/final; 'approved' only when amendmentOf an approved final (see semantics)
  readonly replayed: boolean;
}
