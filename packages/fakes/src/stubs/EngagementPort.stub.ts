// packages/fakes/src/stubs/EngagementPort.stub.ts — phase stub (C0 TRD §9; 08 R9; IC §4.17): no data, feature-off outcomes only.
import { LimsError } from "@lims/contracts/ports/common";
import type { EngagementPort } from "@lims/contracts/ports/EngagementPort";

export function createEngagementPortStub(): EngagementPort {
  return {
    async getHomeAddress() { throw new LimsError("common.not_found"); },
    async getActiveMembership() { return undefined; },
  };
}
