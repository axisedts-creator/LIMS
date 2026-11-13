// ModuleManifest of module partners (02-TRD §3.4, §9.3) — the only file the core autoloader reads.
// C13 produces no event, owns no port, bearerJwt-only (no authResolvers / claimsResolver).
// T01: every operationId of partners.yaml is a stub; each later task replaces its own entries in `implemented`.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import { join } from 'node:path';
import { LimsError } from '../../core/errors.js';
import { loadSpec, operationIds, REPO_ROOT, type Handler, type ModuleManifest } from '../../core/module.js';
import { loadPartnersConfig } from './config.js';
import { PARTNERS_SYSTEM_PERMISSIONS } from './permissions.js';

/** Read at import, so a bad LIMS_PARTNERS_* value fails API boot. */
export const config = loadPartnersConfig(process.env);

const OPENAPI = 'contracts/openapi/partners.yaml';

const stub = (operationId: string): Handler => async () => {
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', `partners ${operationId} not implemented`);
};

const implemented: Readonly<Record<string, Handler>> = {};

export const manifest: ModuleManifest = Object.freeze({
  name: 'partners',
  openapi: OPENAPI,
  handlers: Object.freeze(Object.fromEntries(operationIds(loadSpec(join(REPO_ROOT, OPENAPI)))
    .map((op) => [op, Object.hasOwn(implemented, op) ? implemented[op]! : stub(op)]))),
  produces: [],
  systemPermissions: PARTNERS_SYSTEM_PERMISSIONS,
});
