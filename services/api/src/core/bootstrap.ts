// Builds the Fastify instance (02-TRD §6.1/§6.2). Resolves after app.ready(); any autoload/spec/handler problem rejects.
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { genReqId, installErrorHandlers, sendProblem } from './errors.js';
import { autoload, checkHandlers, DEFAULT_MODULES_DIR, loadSpec, REPO_ROOT } from './module.js';
import { createBffKeyVerifier } from './auth/bff-key.js';
import type { ClaimsResolver } from './auth/claims-resolver.js';
import { createClientIpResolver } from './auth/client-ip.js';
import { createJwtVerifier } from './auth/jwt.js';
import { installRouteHooks, mountSpec, schemaController, type CoreAuth } from './openapi.js';

export interface BootstrapOptions {
  readonly config: CoreConfig;
  /** Directory holding contracts/openapi/<m>.yaml. Default: the repo root. */
  readonly repoRoot?: string;
  /** Directory scanned for <m>/index.ts. Default: services/api/src/modules. */
  readonly modulesDir?: string;
}

const SAMPLE_DIR = join(import.meta.dirname, '__fixtures__');

export async function bootstrap(opts: BootstrapOptions): Promise<FastifyInstance> {
  const { config, repoRoot = REPO_ROOT, modulesDir = DEFAULT_MODULES_DIR } = opts;
  const app = Fastify({
    logger: { level: config.logLevel },
    // stage 13 onResponse log is T0D-10 (route template only, no raw URL)
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    schemaController,
    genReqId, // stage 1
    frameworkErrors: (err, req, reply) => { sendProblem(err, req, reply); },
  });
  installErrorHandlers(app);
  try {
    const modules = await autoload(modulesDir, repoRoot);
    // 02-TRD §6.5: key files are read now, so a missing/garbage key or CIDR fails boot (no lazy / network fallback).
    const auth: CoreAuth = {
      ...(config.jwt ? { verifier: createJwtVerifier(config.jwt) } : {}),
      claimsResolver: modules.find((m) => m.manifest.name === 'identity')?.manifest.claimsResolver as ClaimsResolver | undefined,
      bff: createBffKeyVerifier(config.bffKeyFiles),
      clientIp: createClientIpResolver(config.trustedProxyCidrs),
    };
    installRouteHooks(app, { responseValidation: config.responseValidation, auth });
    for (const m of modules) await mountSpec(app, m.manifest.name, m.spec, m.manifest.handlers, auth);
    if (config.loadSampleModule) {
      // 02-TRD §14: core-owned, ci only, never deployed; its spec lives next to it, not in contracts/openapi.
      const { manifest } = await import('./__fixtures__/module-sample/index.js');
      const spec = loadSpec(join(SAMPLE_DIR, 'sample.yaml'));
      checkHandlers(manifest.name, spec, manifest.handlers);
      await mountSpec(app, manifest.name, spec, manifest.handlers, auth);
    }
    // ponytail: contracts/openapi/core.yaml is mounted once its handlers exist (health, T0D-10).
    await app.ready();
    return app;
  } catch (e) {
    await app.close().catch(() => undefined);
    throw e;
  }
}
