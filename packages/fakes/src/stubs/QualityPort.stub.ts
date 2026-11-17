// packages/fakes/src/stubs/QualityPort.stub.ts — phase stub (C0 TRD §9; 08 R9): auto-verification is off, no QC data.
import type { QualityPort } from "@lims/contracts/ports/QualityPort";

export function createQualityPortStub(): QualityPort {
  return {
    async canAutoVerify() { return { decision: "deny", reasons: ["feature_disabled"] }; },
    async qcStatusFor() { return { status: "no_qc_data" }; },
  };
}
