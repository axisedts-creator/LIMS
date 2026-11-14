// ModuleManifest of module homecollection (02-TRD §3.1) — the only file the core autoloader reads.
// HC-T01: 26 stubs (H1-H21, A1-A5); each later task replaces its own entries. Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production)
// -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
// Produces one event, owns no port, bearerJwt-only (no authResolvers / claimsResolver).
import type { Handler, ModuleManifest } from '../../core/module.js';
import { LimsError } from '../../core/errors.js';
import { handler as assignHomeVisit } from './handlers/assignHomeVisit.js';
import { handler as cancelHomeVisit } from './handlers/cancelHomeVisit.js';
import { handler as createHomeRevisit } from './handlers/createHomeRevisit.js';
import { handler as resequenceHomeRoute } from './handlers/resequenceHomeRoute.js';
import { handler as resolveHomeVisitFlag } from './handlers/resolveHomeVisitFlag.js';
import { handler as reviewHeldCollection } from './handlers/reviewHeldCollection.js';
import { handler as scheduleHomeVisit } from './handlers/scheduleHomeVisit.js';
import { handler as unassignHomeVisit } from './handlers/unassignHomeVisit.js';
import { handler as ackSync } from './handlers/ackSync.js';
import { handler as pushSyncMutations } from './handlers/pushSyncMutations.js';
import { handler as getSyncSnapshot } from './handlers/getSyncSnapshot.js';
import { handler as getHomecollectionSettings } from './handlers/getHomecollectionSettings.js';
import { handler as getHomeVisit } from './handlers/getHomeVisit.js';
import { handler as listEligiblePhlebotomists } from './handlers/listEligiblePhlebotomists.js';
import { handler as listHomeRoutes } from './handlers/listHomeRoutes.js';
import { handler as listHomeVisits } from './handlers/listHomeVisits.js';
import { handler as listHomecollectionReasons } from './handlers/listHomecollectionReasons.js';
import { handler as listPhleboDevices } from './handlers/listPhleboDevices.js';
import { handler as registerPhleboDevice } from './handlers/registerPhleboDevice.js';
import { handler as requestDeviceWipe } from './handlers/requestDeviceWipe.js';
import { handler as revealHomeVisitPhone } from './handlers/revealHomeVisitPhone.js';
import { handler as signOffPhleboDevice } from './handlers/signOffPhleboDevice.js';
import { handler as updateHomecollectionSettings } from './handlers/updateHomecollectionSettings.js';
import { handler as listHandovers } from './handlers/listHandovers.js';
import { handler as getHandover } from './handlers/getHandover.js';
import { handler as confirmHandover } from './handlers/confirmHandover.js';

const OPERATION_IDS = [
  'listHomeVisits', 'getHomeVisit', 'assignHomeVisit', 'unassignHomeVisit', 'scheduleHomeVisit', 'cancelHomeVisit', 'createHomeRevisit',
  'resolveHomeVisitFlag', 'reviewHeldCollection', 'listHomeRoutes', 'resequenceHomeRoute', 'listEligiblePhlebotomists', 'listHandovers',
  'getHandover', 'confirmHandover', 'listPhleboDevices', 'requestDeviceWipe', 'getHomecollectionSettings', 'updateHomecollectionSettings',
  'listHomecollectionReasons', 'revealHomeVisitPhone',
  'registerPhleboDevice', 'getSyncSnapshot', 'pushSyncMutations', 'ackSync', 'signOffPhleboDevice',
] as const;

type HomecollectionOperationId = (typeof OPERATION_IDS)[number];

const stub = (operationId: string): Handler => async () => {
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', `homecollection ${operationId} not implemented`);
};

// HC-T04: H18-H20 are real handlers. HC-T08: H1, H2, H10, H12, H21.
const implemented: Partial<Record<HomecollectionOperationId, Handler>> = {
  getHomecollectionSettings, updateHomecollectionSettings, listHomecollectionReasons,
  listHomeVisits, getHomeVisit, listHomeRoutes, listEligiblePhlebotomists, revealHomeVisitPhone,
  registerPhleboDevice, signOffPhleboDevice,   // HC-T10: A1, A5
  listPhleboDevices, requestDeviceWipe,   // HC-T15: H16, H17
  assignHomeVisit, unassignHomeVisit, scheduleHomeVisit, cancelHomeVisit, createHomeRevisit, resolveHomeVisitFlag, resequenceHomeRoute,   // HC-T09: H3-H8, H11
  getSyncSnapshot, ackSync,   // HC-T11: A2, A4
  pushSyncMutations,   // HC-T12: A3
  reviewHeldCollection,   // HC-T13: H9
  listHandovers, getHandover, confirmHandover,   // HC-T14: H13-H15
};

const handlers = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<HomecollectionOperationId, Handler>,
);

export const manifest: ModuleManifest = {
  name: 'homecollection',
  openapi: 'contracts/openapi/homecollection.yaml',
  handlers,
  produces: ['homecollection.collection.synced.v1'],
};
