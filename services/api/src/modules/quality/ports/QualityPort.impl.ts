// QualityPort (03-IC §4.11, 02-TRD §11.1). C9 T-01 returns the Phase-1 stub results (08 A17 P-20, D-56): auto-verification off, no QC data.
// Pure: no DB, no ctx.tx, no quality.settings read, independent of LIMS_QUALITY_ENABLED (the port always answers; only HTTP routes are gated).
// T-13 replaces canAutoVerify, T-16 qcStatusFor.
export const qualityPort = {
  async canAutoVerify(_ctx: unknown, _input: unknown): Promise<{ decision: 'deny'; reasons: string[] }> {
    return { decision: 'deny', reasons: ['feature_disabled'] };
  },
  async qcStatusFor(_ctx: unknown, _input: unknown): Promise<{ status: 'no_qc_data' }> {
    return { status: 'no_qc_data' };
  },
};
