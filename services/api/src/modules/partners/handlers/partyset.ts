// T0B-PARTYSET-1 (LD-321, LD-325 b): the 13 party settings / onboarding / penalty / ID reveal operations of partners.yaml (/v1/partners/admin/...).
// Logic in service/partyset.service.ts.
import type { Handler } from '../../../core/module.js';
import * as s from '../service/partyset.service.js';

export const getPartyCommercialSetting: Handler = (req, ctx) => s.getSetting(req, ctx);
export const setPartyCommercialSetting: Handler = (req, ctx) => s.setSetting(req, ctx);
export const listPartyOnboarding: Handler = (req, ctx) => s.listOnboarding(req, ctx);
export const decidePartyOnboarding: Handler = (req, ctx) => s.decideOnboarding(req, ctx);
export const listNonCompliancePenalties: Handler = (req, ctx) => s.listPenalties(req, ctx);
export const createNonCompliancePenalty: Handler = (req, ctx) => s.createPenalty(req, ctx);
export const updateNonCompliancePenalty: Handler = (req, ctx) => s.updatePenalty(req, ctx);
export const deactivateNonCompliancePenalty: Handler = (req, ctx) => s.deactivatePenalty(req, ctx);
export const listNonComplianceEvents: Handler = (req, ctx) => s.listEvents(req, ctx);
export const raiseNonComplianceEvent: Handler = (req, ctx) => s.raiseEvent(req, ctx);
export const waiveNonComplianceEvent: Handler = (req, ctx) => s.waiveEvent(req, ctx);
export const chargeNonComplianceEvent: Handler = (req, ctx) => s.chargeEvent(req, ctx);
export const revealPartyIdNumber: Handler = (req, ctx) => s.revealIdNumber(req, ctx);
