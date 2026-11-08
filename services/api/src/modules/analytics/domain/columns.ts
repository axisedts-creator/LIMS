// Measure column names of the AN-T11 rollup families (02-TRD §6.5, §6.8; 05-SCHEMA daily_*). Pure constants: shared by repo, service, mapper.
export const RESULT_COLS = ['results_resulted', 'results_verified', 'results_approved', 'results_amended', 'auto_verified', 'critical_count', 'abnormal_count', 'tests_approved'] as const;
export const DELIVERY_COLS = ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'] as const;
export const RELEASE_COLS = ['released', 'final', 'partial', 'preliminary', 'amended', 'overrides'] as const;
export const TAT_SEGMENTS = ['pre_analytical', 'transport', 'within_lab', 'total_first_release', 'total_final_release'] as const; // canonical order (TRD §5.1 TatRow)
export const MESSAGE_COLS = ['messages', 'patient_records', 'qc_records', 'unmatched', 'quarantined', 'duplicates'] as const;
