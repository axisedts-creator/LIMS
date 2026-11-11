// E10-E21 handlers (02-TRD §6.4/§7.3). Schema, auth, x-permission (+aal2 for privileged) and Idempotency-Key are enforced by the core
// pipeline from contracts/openapi/instruments.yaml; these map request -> service, set ETag, and fail closed without a request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAgentsService, type AgentsCtx, type Result } from '../service/agents.service.js';

type Svc = ReturnType<typeof createAgentsService>;
const svc = createAgentsService();
const NO_STORE = { headers: { 'cache-control': 'no-store' } };
const ETAG = { etag: true };

/** etag: single-object responses only (lists and the E14/E17/E20 bodies carry no version). */
function bind(fn: (s: Svc, ctx: AgentsCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean; headers?: Record<string, string> } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<AgentsCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as AgentsCtx, req);
    const headers = { ...(o.headers ?? {}), ...(o.etag && out.version !== undefined ? { etag: `"${out.version}"` } : {}) };
    return { status: out.status, body: out.body, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});
/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (service answers 428); malformed -> 400 here. */
function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const v = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(v) || v > 2147483647) {
    throw new LimsError('common.validation_failed', undefined, [{ path: '/If-Match', code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  return v;
}
const agentId = (req: HandlerRequest) => obj(req.params)['agent_id'];

export const agentsHandlers = Object.freeze({
  listAgents: bind((s, ctx, req) => {
    const q = obj(req.query);
    return s.listAgents(ctx, { centreId: q['centre_id'], status: q['status'], healthState: q['health_state'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'] });
  }),
  createAgent: bind((s, ctx, req) => {
    const b = obj(req.body);
    return s.createAgent(ctx, { agentCode: b['agent_code'], displayName: b['display_name'], centreId: b['centre_id'], updateChannel: b['update_channel'], backlogThreshold: b['backlog_threshold'] });
  }, ETAG),
  getAgent: bind((s, ctx, req) => s.getAgent(ctx, { agentId: agentId(req) }), ETAG),
  updateAgent: bind((s, ctx, req) => s.updateAgent(ctx, { agentId: agentId(req), expectedVersion: ifMatch(req), patch: obj(req.body) }), ETAG),
  // secret shown once: never cached, never an ETag (02-TRD E14)
  issueEnrolmentCode: bind((s, ctx, req) => s.issueEnrolmentCode(ctx, { agentId: agentId(req) }), NO_STORE),
  revokeAgent: bind((s, ctx, req) => {
    const b = obj(req.body);
    return s.revokeAgent(ctx, { agentId: agentId(req), expectedVersion: ifMatch(req), reasonCode: b['reason_code'], reasonText: b['reason_text'] });
  }, ETAG),
  retireAgent: bind((s, ctx, req) => {
    const b = obj(req.body);
    return s.retireAgent(ctx, { agentId: agentId(req), expectedVersion: ifMatch(req), reasonCode: b['reason_code'], reasonText: b['reason_text'] });
  }, ETAG),
  requestAgentCommand: bind((s, ctx, req) => {
    const b = obj(req.body);
    return s.requestAgentCommand(ctx, { agentId: agentId(req), kind: b['kind'], params: b['params'] });
  }),
  listAgentCommands: bind((s, ctx, req) => {
    const q = obj(req.query);
    return s.listAgentCommands(ctx, { agentId: agentId(req), cursor: q['cursor'], limit: q['limit'] });
  }),
  listAgentHealthTransitions: bind((s, ctx, req) => {
    const q = obj(req.query);
    return s.listAgentHealthTransitions(ctx, { agentId: agentId(req), changedAtFrom: q['changed_at_from'], changedAtTo: q['changed_at_to'], cursor: q['cursor'], limit: q['limit'] });
  }),
  getAgentLogBundle: bind((s, ctx, req) => s.getAgentLogBundle(ctx, { agentId: agentId(req), bundleId: obj(req.params)['bundle_id'] }), NO_STORE),
  listAgentReleases: bind((s, ctx, req) => s.listAgentReleases(ctx, { channel: obj(req.query)['channel'] })),
} satisfies Record<string, Handler>);
