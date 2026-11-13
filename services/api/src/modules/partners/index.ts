// ModuleManifest of module partners (02-TRD §3.4, §9.3) — the only file the core autoloader reads.
// C13 produces no event, owns no port, bearerJwt-only (no authResolvers / claimsResolver).
// T01: every operationId of partners.yaml is a stub; each later task replaces its own entries in `implemented`.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import { join } from 'node:path';
import { LimsError } from '../../core/errors.js';
import { loadSpec, operationIds, REPO_ROOT, type Handler, type ModuleManifest } from '../../core/module.js';
import { loadPartnersConfig } from './config.js';
import { addManifestLine } from './handlers/addManifestLine.js';
import { createManifest } from './handlers/createManifest.js';
import { createPartner } from './handlers/createPartner.js';
import { deleteManifestLine } from './handlers/deleteManifestLine.js';
import { discardManifest } from './handlers/discardManifest.js';
import { getManifest } from './handlers/getManifest.js';
import { getPartner } from './handlers/getPartner.js';
import { getPartnerContext } from './handlers/getPartnerContext.js';
import { listManifests } from './handlers/listManifests.js';
import { listPartners } from './handlers/listPartners.js';
import * as partnerUserHandlers from './handlers/partnerUsers.js';
import { reactivatePartner } from './handlers/reactivatePartner.js';
import { replaceManifestLine } from './handlers/replaceManifestLine.js';
import { resyncPartnerProjections } from './handlers/resyncPartnerProjections.js';
import { searchPartnerOrderables } from './handlers/searchPartnerOrderables.js';
import { suspendPartner } from './handlers/suspendPartner.js';
import { updateManifest } from './handlers/updateManifest.js';
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
  createManifest, listManifests, getManifest, updateManifest, addManifestLine, replaceManifestLine, deleteManifestLine, discardManifest, searchPartnerOrderables, // T08 M1–M7, M10, P2
};

export const manifest: ModuleManifest = Object.freeze({
  name: 'partners',
  openapi: OPENAPI,
  handlers: Object.freeze(Object.fromEntries(operationIds(loadSpec(join(REPO_ROOT, OPENAPI)))
    .map((op) => [op, Object.hasOwn(implemented, op) ? implemented[op]! : stub(op)]))),
  produces: [],
  systemPermissions: PARTNERS_SYSTEM_PERMISSIONS,
});
