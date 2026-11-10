// reporting API module manifest (02-TRD §3.2, §6.3). T01 scaffold: every operationId is a 501 stub until its task lands.
import { join } from 'node:path';
import { loadSpec, operationIds, REPO_ROOT, type Handler, type ModuleManifest } from '../../core/module.js';
import { loadReportingConfig } from './config.js';
import { callbackHandlers } from './handlers/callbacks.handlers.js';
import { deliveryHandlers } from './handlers/delivery.handlers.js';
import { messagingAdminHandlers } from './handlers/messaging-admin.handlers.js';
import { narrativeHandlers } from './handlers/narrative.handlers.js';
import { narrativeImageHandlers } from './handlers/narrative-image.handlers.js';
import { outsourcedHandlers } from './handlers/outsourced.handlers.js';
import { regenerateHandlers } from './handlers/regenerate.handlers.js';
import { releaseHandlers } from './handlers/release.handlers.js';
import { reportsReadHandlers } from './handlers/reports-read.handlers.js';
import { printHandlers } from './handlers/print.handlers.js';
import { retryRenderHandlers } from './handlers/retry-render.handlers.js';
import { settingsHandlers } from './handlers/settings.handlers.js';
import { templatesHandlers } from './handlers/templates.handlers.js';
import { portalHandlers } from './handlers/portal.handlers.js';
import { verifyHandlers } from './handlers/verify.handlers.js';
import { portalSessionResolver } from './auth/portal.resolver.js';
import { REPORTING_SYSTEM_PERMISSIONS } from './permissions.js';

/** Read at import, so a bad LIMS_REPORTING_* value fails API boot. */
export const config = loadReportingConfig(process.env);

// Never echoes request input (no PHI / token reflection).
const notImplemented: Handler = async () => ({ status: 501 });

const OPENAPI = 'contracts/openapi/reporting.yaml';
const implemented: Readonly<Record<string, Handler>> = { ...settingsHandlers, ...outsourcedHandlers, ...narrativeImageHandlers, ...narrativeHandlers, ...templatesHandlers, ...retryRenderHandlers, ...printHandlers, ...regenerateHandlers, ...releaseHandlers, ...reportsReadHandlers, ...portalHandlers, ...verifyHandlers, ...deliveryHandlers, ...messagingAdminHandlers, ...callbackHandlers };

export const manifest: ModuleManifest = Object.freeze({
  name: 'reporting',
  openapi: OPENAPI,
  handlers: Object.freeze(Object.fromEntries(operationIds(loadSpec(join(REPO_ROOT, OPENAPI)))
    .map((op) => [op, Object.hasOwn(implemented, op) ? implemented[op]! : notImplemented]))),
  produces: Object.freeze(['reporting.report.released.v1', 'reporting.delivery.status_changed.v1']),
  systemPermissions: REPORTING_SYSTEM_PERMISSIONS,
  authResolvers: Object.freeze({ portalSession: portalSessionResolver }),   // CR-C6-001
});
