// C6-T21 — 03-IC §4.7 contract cases (1)-(8) against the REAL implementation (AC-15.1: "the real implementation passes them all").
// The C0 suite is reused unchanged; only the harness is ours (reportingport.helpers.ts). NOTE: cases (4) and (7) also call openReleasedReportFile (plan row T37
// owns its full behaviour; AC-15.1 needs a working minimal version now: released/superseded of the caller's tenant/partner, else common.not_found).
import { runReportingPortContract } from '../../../../../../packages/fakes/contract-tests/ReportingPort.contract.js';
import { makeReportingWorld } from './reportingport.helpers.js';

runReportingPortContract(async () => (await makeReportingWorld()).harness as any);
