// ModuleManifest of module identity (02-CV §2.2, 02-TRD §6.3) — the only file the core autoloader reads.
// claimsResolver = the sole bearerJwt claims source (02-TRD §6.2, CR-C2-005 / 08 R10).
import type { ModuleManifest } from '../../core/module.js';
import { LimsError } from '../../core/errors.js';
import { createClaimsResolver } from './claims/resolver.js';
import { handlers } from './handlers/index.js';
import { bindIdentityMetrics } from './metrics.js';

// [CONV] core does not yet hand module construction a db (CR-C2-020 open point, C0-0D): until it does,
// identityAuthTx fails closed with common.internal, so bearerJwt never authenticates without the DEFINER.
const db = {
  identityAuthTx(): Promise<never> {
    return Promise.reject(new LimsError('common.internal', 'identity: ctx.db not wired into module construction'));
  },
};

export const manifest: ModuleManifest = {
  name: 'identity',
  openapi: 'contracts/openapi/identity.yaml',
  handlers,
  produces: [],
  claimsResolver: createClaimsResolver({ db }),
  // T28: bind the process metrics sink (metrics.ts) from CoreDeps.metrics (core/pipeline/boot.ts: { setGauge(name, v), inc }).
  // [CONV] that port has no observe and no gauge labels: histograms and labelled gauges are dropped until core passes CoreMetrics.
  createServices(deps: unknown) {
    const m = (deps as { metrics?: { setGauge?(n: string, v: number): void; inc?(n: string, l?: Record<string, string>, by?: number): void } } | undefined)?.metrics;
    if (m) {
      bindIdentityMetrics({
        inc: (n, l, by) => m.inc?.(n, l as Record<string, string> | undefined, by),
        set: (n, v, l) => { if (!l || Object.keys(l).length === 0) m.setGauge?.(n, v); },
      });
    }
    return Object.freeze({});
  },
};
