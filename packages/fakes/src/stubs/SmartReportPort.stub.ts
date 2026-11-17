// packages/fakes/src/stubs/SmartReportPort.stub.ts — phase stub (C0 TRD §9; 08 R9): smart reports are off (D-111).
import { LimsError } from "@lims/contracts/ports/common";
import type { SmartReportPort } from "@lims/contracts/ports/SmartReportPort";

export function createSmartReportPortStub(): SmartReportPort {
  return {
    async buildSummary() { throw new LimsError("smartreport.feature_disabled"); },
  };
}
