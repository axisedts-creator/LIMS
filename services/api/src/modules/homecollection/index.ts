// ModuleManifest of module homecollection (02-TRD §3.1) — the only file the core autoloader reads.
// HC-T01: 26 stubs (H1-H21, A1-A5); each later task replaces its own entries. Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production)
// -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
// Produces one event, owns no port, bearerJwt-only (no authResolvers / claimsResolver).
import type { Handler, ModuleManifest } from '../../core/module.js';
import { LimsError } from '../../core/errors.js';

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

const implemented: Partial<Record<HomecollectionOperationId, Handler>> = {};

const handlers = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<HomecollectionOperationId, Handler>,
);

export const manifest: ModuleManifest = {
  name: 'homecollection',
  openapi: 'contracts/openapi/homecollection.yaml',
  handlers,
  produces: ['homecollection.collection.synced.v1'],
};
