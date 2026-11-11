// Shared frame of the print tasks reporting.render_print and reporting.build_bulk_print (02-TRD §9; 05-SCHEMA §2.14; 01-PRD AC-12.2-12.4, AC-13.1).
// Lock the `rendering` print_jobs row -> build the pdf -> put under {tenant}/prints/ in reporting-prints -> `ready`.
// Failure contract = render_report_version (T09): a retryable failure on a non-final attempt THROWS a sanitised error (queue retry, tx rolled back, print stays `rendering`);
// on the final attempt, and at once for permanent failures, the task COMMITS `failed` with a stable error_code and RESOLVES. Messages are never stored (they can carry names).
import type { TaskHandler } from '../../../core/manifest.js';
import { codeOf, Permanent, sha, UUID } from './render_report_version.js';

type Row = Record<string, any>;
export const PRINTS_BUCKET = 'reporting-prints';
export interface Built { pdf: Uint8Array; pageCount: number }

export function printTask(task: string, kinds: readonly string[], build: (ctx: any, print: Row) => Promise<Built>): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const printId = payload?.['print_job_id'];
    if (typeof tenantId !== 'string' || payload?.['tenant_id'] !== tenantId || typeof printId !== 'string' || !UUID.test(printId)) {
      ctx.log?.warn?.({ event: `${task}_skipped`, reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx; const actor: string = ctx.actor.id;
    // tenant_id named in every statement next to RLS. FOR UPDATE: a duplicate job waits, then sees a state other than `rendering` and exits.
    const p: Row | undefined = (await tx.query(`SELECT id, kind, variant, draft_watermark, report_version_ids, template_version_id, state FROM reporting.print_jobs
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, printId])).rows[0];
    if (!p || !kinds.includes(p['kind'])) { ctx.log?.warn?.({ event: `${task}_skipped`, reason: 'unknown_print' }); return; }
    if (p['state'] !== 'rendering') { ctx.log?.info?.({ event: `${task}_noop`, print_job_id: printId, state: p['state'] }); return; }

    await tx.query('SAVEPOINT print_attempt', []);
    try {
      const out = await build(ctx, p);
      const path = `${tenantId}/prints/${printId}.pdf`;
      await ctx.storage.put(PRINTS_BUCKET, path, out.pdf, { contentType: 'application/pdf' });   // object key = print id: a retry rewrites the same key
      await tx.query(`UPDATE reporting.print_jobs SET state = 'ready', object_path = $3, sha256 = $4, page_count = $5, error_code = NULL, version = version + 1,
        updated_by = $6, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND state = 'rendering'`, [tenantId, printId, path, sha(out.pdf), out.pageCount, actor]);
      ctx.log?.info?.({ event: `${task}_done`, print_job_id: printId, page_count: out.pageCount, pdf_bytes: out.pdf.length });
    } catch (e) {
      const code = e instanceof Permanent ? e.code : codeOf(e) === 'reporting.template_invalid' ? 'reporting.template_invalid' : undefined;
      const final = ctx.attempt >= ctx.maxAttempts;
      if (code === undefined && !final) throw Object.assign(new Error('print attempt failed'), { code: 'reporting.render_unavailable' });
      await tx.query('ROLLBACK TO SAVEPOINT print_attempt', []);
      const errorCode = code ?? 'reporting.render_unavailable';
      await tx.query(`UPDATE reporting.print_jobs SET state = 'failed', error_code = $3, version = version + 1, updated_by = $4, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND state = 'rendering'`, [tenantId, printId, errorCode, actor]);
      ctx.log?.error?.({ event: `${task}_failed`, print_job_id: printId, error_code: errorCode, attempt: ctx.attempt });
    }
  };
}
