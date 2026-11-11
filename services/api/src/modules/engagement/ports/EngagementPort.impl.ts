// EngagementPort module implementation (08 A17 P-20, 06-PLAN T-01; IC §4.17). Replaces the phase stub (removed from phase-stubs.ts in the same PR).
// T-01 returns exactly the stub results and needs no database: getHomeAddress -> common.not_found, getActiveMembership -> undefined.
// T-EP1 replaces both methods with the real tenant-scoped reads.
import { LimsError } from '../../../core/errors.js';

export const engagementPort = Object.freeze({
  async getHomeAddress(): Promise<never> { throw new LimsError('common.not_found'); },
  async getActiveMembership(): Promise<undefined> { return undefined; },
});
