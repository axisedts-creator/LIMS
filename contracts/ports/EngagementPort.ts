// contracts/ports/EngagementPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Code, DecimalString } from './common';
export const ENGAGEMENT_PORT_VERSION = 1 as const;
export interface EngagementPortV1 {
  /** System actors, or staff holding homecollection.visit.assign / homecollection.visit.read (C17 checks the assignment). P2.
   *  Callers write access_log 'home_visit.view'. @throws common.not_found */
  getHomeAddress(ctx: RequestContext, input: { homeAddressId: Uuidv7; purpose: 'home_visit' }):
    Promise<{ addressText: string; landmark?: string; latitude?: DecimalString; longitude?: DecimalString }>;
  /** Registration (C4, frontdesk.registration.create holders). Returns undefined when no active membership. */
  getActiveMembership(ctx: RequestContext, input: { patientId: Uuidv7; at?: IsoUtc }):
    Promise<{ membershipId: Uuidv7; planCode: Code; planName: string; priceListId?: Uuidv7; validTo: IsoUtc } | undefined>;
}
export type EngagementPort = EngagementPortV1;
