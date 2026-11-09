// E01/E02/E03/E07/E08 device handlers (02-TRD §7.2). deviceToken auth, x-permission, schema and Idempotency-Key are enforced by the core
// pipeline from contracts/openapi/instruments.yaml; these map request -> service and fail closed without a request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createEnrolmentService, type DeviceCtx, type DeviceResult } from '../service/enrolment.service.js';
import { createHeartbeatService } from '../service/heartbeat.service.js';
import { createReleasesService } from '../service/releases.service.js';

const enrolment = createEnrolmentService();
const heartbeat = createHeartbeatService();
const releases = createReleasesService();
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});

function bind(fn: (ctx: DeviceCtx, req: HandlerRequest) => Promise<DeviceResult>, extra?: Record<string, string>): Handler {
  return async (req, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<DeviceCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(c as DeviceCtx, req);
    const headers = { ...(out.headers ?? {}), ...(extra ?? {}) };
    return { status: out.status, body: out.body, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}

export const deviceHandlers = Object.freeze({
  // secret shown once: never cached, never an ETag (02-TRD E01)
  enrolAgent: bind((ctx, req) => {
    const b = obj(req.body);
    return enrolment.enrolAgent(ctx, { hostFingerprintSha256: b['host_fingerprint_sha256'], agentVersion: b['agent_version'], launcherVersion: b['launcher_version'], osVersion: b['os_version'] });
  }, { 'cache-control': 'no-store' }),
  getAgentConfig: bind((ctx) => releases.getAgentConfig(ctx)),
  submitAgentHeartbeat: bind((ctx, req) => heartbeat.submitAgentHeartbeat(ctx, { body: req.body })),
  submitAgentLogBundle: bind((ctx, req) => heartbeat.submitAgentLogBundle(ctx, { body: req.body })),
  downloadAgentRelease: bind((ctx, req) => releases.downloadAgentRelease(ctx, { releaseId: obj(req.params)['release_id'] })),
} satisfies Record<string, Handler>);
