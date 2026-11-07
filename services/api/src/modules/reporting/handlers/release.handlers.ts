// R6 POST /report-versions/{report_version_id}/release (02-TRD §4.6, §6.3; 03-APP-FLOW V5; AC-06.4..06.7, 06.9, 08.3, 08.6). Schema, auth, x-permission (reporting.report.release)
// and Idempotency-Key are enforced by the core pipeline; this handler re-checks what it needs (fail closed) and never echoes input. The transaction is release.service.ts.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { releaseVersion, type ReleaseCtx } from '../service/release.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLER_AUDIENCES = new Set(['patient', 'referrer', 'centre', 'partner']);     // print_only is never accepted from the caller
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const invalid = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);

function parseBody(raw: unknown): { audiences?: string[]; suppressNotifications: boolean } {
  if (raw === undefined || raw === null) return { suppressNotifications: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('/');
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'audiences' && k !== 'suppress_notifications') throw invalid('/');   // additionalProperties: false
  if (b['suppress_notifications'] !== undefined && typeof b['suppress_notifications'] !== 'boolean') throw invalid('/suppress_notifications');
  const a = b['audiences'];
  if (a !== undefined && (!Array.isArray(a) || a.length < 1 || a.length > 4 || new Set(a).size !== a.length || !a.every((x) => typeof x === 'string' && CALLER_AUDIENCES.has(x)))) throw invalid('/audiences');
  return { ...(a !== undefined ? { audiences: a as string[] } : {}), suppressNotifications: b['suppress_notifications'] === true };
}

export const releaseHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  releaseReportVersion: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<ReleaseCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.ports || !c.events) throw new LimsError('auth.unauthenticated');

    const header = obj(req.headers)['if-match'];
    if (header === undefined) throw new LimsError('common.precondition_required');
    const m = typeof header === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(header) : null;
    if (!m || Number(m[1]) > 2147483647) throw invalid('/If-Match');
    const body = parseBody(req.body);

    const id = obj(req.params)['report_version_id'];
    if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
    const out = await releaseVersion(c as ReleaseCtx, id, { mode: 'manual', expectedVersion: Number(m[1]), audiences: body.audiences, suppressNotifications: body.suppressNotifications });
    if (out.kind !== 'released') throw new LimsError('common.internal');                // manual mode throws instead of returning held / skipped
    const row = out.row;
    return {
      status: 200, headers: { etag: `"${out.version}"` },
      body: {
        id, version_no: out.versionNo, status: 'released', report_kind: row['report_kind'], completeness: row['completeness'], page_count: row['page_count'] ?? undefined,
        pdf_bytes: row['pdf_bytes'] == null ? undefined : Number(row['pdf_bytes']), rendered_at: row['rendered_at'] == null ? undefined : new Date(row['rendered_at']).toISOString(),
        released_at: out.releasedAt, release_basis: out.releaseBasis, audiences: out.audiences,
        ...(out.supersedesVersionNo !== null ? { supersedes_version_no: out.supersedesVersionNo } : {}), version: out.version,
      },
    };
  },
});
