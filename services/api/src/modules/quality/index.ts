// ModuleManifest of module quality (02-TRD §1, 02-CV §2.2) — the only file the core autoloader reads.
// Produces quality.qc_run.rejected.v1; owns QualityPort (its phase stub is removed from core/ports/phase-stubs.ts in the same PR, C0 AC-0D-6.3);
// bearerJwt-only (no authResolvers / claimsResolver).
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';
import { qualityPort } from './ports/QualityPort.impl.js';

export const manifest: ModuleManifest = {
  name: 'quality',
  openapi: 'contracts/openapi/quality.yaml',
  handlers,
  ports: { QualityPort: qualityPort },
  produces: ['quality.qc_run.rejected.v1'],
};
