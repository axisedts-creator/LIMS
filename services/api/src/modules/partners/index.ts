// ModuleManifest of module partners (02-TRD §3.4, §9.3) — the only file the core autoloader reads.
// C13 produces no event, owns no port, bearerJwt-only (no authResolvers / claimsResolver).
// T01: every operationId of partners.yaml is a stub; each later task replaces its own entries in `implemented`.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import { join } from 'node:path';
import { LimsError } from '../../core/errors.js';
import { loadSpec, operationIds, REPO_ROOT, type Handler, type ModuleManifest } from '../../core/module.js';
import { loadPartnersConfig } from './config.js';
import { createPartner } from './handlers/createPartner.js';
import { getPartner } from './handlers/getPartner.js';
import { getPartnerContext } from './handlers/getPartnerContext.js';
import { getPartnerStatement } from './handlers/getPartnerStatement.js';
import { listPartnerPriceList } from './handlers/listPartnerPriceList.js';
import { listPartnerStatements } from './handlers/listPartnerStatements.js';
import { listPartners } from './handlers/listPartners.js';
import * as partnerUserHandlers from './handlers/partnerUsers.js';
import * as pickupHandlers from './handlers/pickups.js';
import * as referrerHandlers from './handlers/referrers.js';
import { reactivatePartner } from './handlers/reactivatePartner.js';
import { resyncPartnerProjections } from './handlers/resyncPartnerProjections.js';
import { suspendPartner } from './handlers/suspendPartner.js';
import { updatePartner } from './handlers/updatePartner.js';
import { PARTNERS_SYSTEM_PERMISSIONS } from './permissions.js';

/** Read at import, so a bad LIMS_PARTNERS_* value fails API boot. */
export const config = loadPartnersConfig(process.env);

const OPENAPI = 'contracts/openapi/partners.yaml';

const stub = (operationId: string): Handler => async () => {
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', `partners ${operationId} not implemented`);
};

const implemented: Readonly<Record<string, Handler>> = {
  getPartnerContext, // T03
  ...partnerUserHandlers, // T06 U1-U6, SA8-SA10
  listPartners, createPartner, getPartner, updatePartner, suspendPartner, reactivatePartner, resyncPartnerProjections, // T07 SA1–SA7
  listPartnerPriceList, listPartnerStatements, getPartnerStatement, // T17 P1, S1, S2
  ...referrerHandlers, // T11 F1–F5, SR1–SR3
  ...pickupHandlers, // T15 K1–K4, SP1–SP4
};

export const manifest: ModuleManifest = Object.freeze({
  name: 'partners',
  openapi: OPENAPI,
  handlers: Object.freeze(Object.fromEntries(operationIds(loadSpec(join(REPO_ROOT, OPENAPI)))
    .map((op) => [op, Object.hasOwn(implemented, op) ? implemented[op]! : stub(op)]))),
  produces: [],
  systemPermissions: PARTNERS_SYSTEM_PERMISSIONS,
});
