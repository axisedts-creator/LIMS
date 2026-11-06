// contracts/ports/QualityPort.ts
import type { RequestContext, Uuidv7, IsoUtc, DecimalString, Code } from './common';
export const QUALITY_PORT_VERSION = 1 as const;

export interface ResultContext {
  readonly resultId: Uuidv7; readonly analyteId: Uuidv7; readonly instrumentId?: Uuidv7;
  readonly valueNumeric?: DecimalString; readonly instrumentFlags: readonly string[];
  readonly rangeFlag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A'; readonly deltaCheckFailed: boolean; readonly isCritical: boolean;
  readonly resultedAt: IsoUtc;
}
export type AutoVerifyReason = 'feature_disabled' | 'instrument_flag' | 'outside_autoverify_limits' | 'critical' | 'delta_failure'
  | 'qc_out_of_control' | 'qc_no_data' | 'manual_origin' | 'rule_missing'
  | 'qc_warning';                                                 // added by 08 (CR-C9-003)

export interface QualityPortV1 {
  /** Phase 2 (04 R2). Criteria per 01 §2.2 (no instrument error flag, within auto-verify limits, not critical, no delta failure, QC in control). */
  canAutoVerify(ctx: RequestContext, resultContext: ResultContext): Promise<{ decision: 'allow' | 'deny'; reasons: readonly AutoVerifyReason[]; ruleSetVersion?: string }>;
  /** Returns out_of_control while a rejected run is not closed; no_qc_data when the last in-control run is older than the
   *  plan's validity; violatedRules may contain 'incomplete_run' (CR-C9-003). */
  qcStatusFor(ctx: RequestContext, input: { instrumentId: Uuidv7; analyteId: Uuidv7; at: IsoUtc }): Promise<{
    status: 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data'; lastInControlRunAt?: IsoUtc; currentRunId?: Uuidv7; violatedRules?: readonly Code[] }>;
}
export type QualityPort = QualityPortV1;
