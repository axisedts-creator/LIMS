// SmartReportPort (03-IC §4.10, 02-TRD §7). T01: registered replacement of the phase stub (08 A17 P-20, D-111) — always
// smartreport.feature_disabled, pure (no DB, no input echo). A later task replaces buildSummary with summary.service.buildOrGet.
import { LimsError } from '../../../core/errors.js';

export const smartReportPort = {
  async buildSummary(): Promise<never> {
    throw new LimsError('smartreport.feature_disabled');
  },
};
