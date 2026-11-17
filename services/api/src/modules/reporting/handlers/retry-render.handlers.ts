// R8 POST /report-versions/{report_version_id}/retry-render (02-TRD §6.3; 03-APP-FLOW V4; AC-03.9). Schema, auth, x-permission (reporting.report.render) and
// Idempotency-Key are enforced by the core pipeline. render_failed -> rendering in ONE guarded UPDATE (status + If-Match version in the WHERE), counters reset,
// then the keyed render job `render:<id>` (same key the assembly and sweep_stuck_renders use, so a live job collapses). Errors never echo input.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { Q } from '../repository/retry-render.repo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENDER_TASK = 'reporting.render_report_version';
const RENDER_MAX_ATTEMPTS = 5;                                   // 02-CV §7.5
const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

export const retryRenderHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  retryRenderReportVersion: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as { tenantId?: string; actor?: { id?: string }; tx?: { query(sql: string, v: unknown[]): Promise<{ rows: any[] }> } };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const { tenantId, tx } = c; const actorId = c.actor.id;

    const header = obj(req.headers)['if-match'];
    if (header === undefined) throw new LimsError('common.precondition_required');
    const m = typeof header === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(header) : null;
    if (!m || Number(m[1]) > 2147483647) throw new LimsError('common.validation_failed', undefined, [{ path: '/If-Match', code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
    const expected = Number(m[1]);

    const id = obj(req.params)['report_version_id'];
    if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
    const v = (await tx.query(Q.selectReportVersions, [tenantId, id])).rows[0];
    if (!v) throw new LimsError('common.not_found');                                  // other tenants' rows are invisible: same answer
    if (v.status !== 'render_failed') throw new LimsError('common.immutable_record');
    if (v.version !== expected) throw new LimsError('common.version_conflict');

    const done = (await tx.query(Q.updateReportVersions, [tenantId, id, expected, actorId])).rows[0];
    if (!done) throw new LimsError('common.version_conflict');                        // lost a race between the read above and the write
    await tx.query(ENQUEUE, [RENDER_TASK, JSON.stringify({ tenant_id: tenantId, report_id: v.report_id, report_version_id: id }), `render:${id}`, null, RENDER_MAX_ATTEMPTS]);
    return {
      status: 202, headers: { etag: `"${done.version}"` },
      body: { id, version_no: v.version_no, status: 'rendering', report_kind: v.report_kind, completeness: v.completeness, version: done.version },
    };
  },
});
