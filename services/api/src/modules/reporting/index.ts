// reporting API module manifest (02-TRD §3.2, §6.3). T01 scaffold: every operationId is a 501 stub until its task lands.
import { join } from 'node:path';
import { loadSpec, operationIds, REPO_ROOT, type Handler, type ModuleManifest } from '../../core/module.js';
import { loadReportingConfig } from './config.js';
import { settingsHandlers } from './handlers/settings.handlers.js';
import { REPORTING_SYSTEM_PERMISSIONS } from './permissions.js';

/** Read at import, so a bad LIMS_REPORTING_* value fails API boot. */
export const config = loadReportingConfig(process.env);

// Never echoes request input (no PHI / token reflection).
const notImplemented: Handler = async () => ({ status: 501 });

const OPENAPI = 'contracts/openapi/reporting.yaml';

export const manifest: ModuleManifest = Object.freeze({
  name: 'reporting',
  openapi: OPENAPI,
  handlers: Object.freeze(Object.fromEntries(operationIds(loadSpec(join(REPO_ROOT, OPENAPI)))
    .map((op) => [op, Object.hasOwn(settingsHandlers, op) ? settingsHandlers[op]! : notImplemented]))),
  produces: Object.freeze(['reporting.report.released.v1', 'reporting.delivery.status_changed.v1']),
  systemPermissions: REPORTING_SYSTEM_PERMISSIONS,
  authResolvers: Object.freeze({
    // CR-C6-001 stub: fails closed (not an ok result -> unauthenticated) until the portal resolver task.
    portalSession: { resolve: async () => ({ ok: false }) },
  }),
});
