// Task reporting.build_bulk_print (02-TRD §9 "R13: sandbox assemble of stored PDFs (<= 200) -> reporting-prints"; 01-PRD AC-12.4; 05-SCHEMA §2.14).
// Merges the STORED canonical pdfs (bucket reports) of the print's released versions in the order of report_version_ids; nothing is re-rendered, nothing is watermarked.
// A version that is not released at build time (or not visible to the tenant) is left out. A path outside the tenant prefix is never read (permanent common.internal).
// ASSUMED: the sandbox requires a stamp, so the merged bundle gets "Page n Of m" over the whole bundle; `variant: plain` has no spec'd behaviour for bulk (stored pdfs are letterhead).
import type { TaskHandler } from '../../../core/manifest.js';
import { printTask } from './print_common.js';
import { Permanent, sha, STAMP, type RenderPorts } from './render_report_version.js';

export function createBuildBulkPrint(o: Pick<RenderPorts, 'sandbox'>): TaskHandler {
  return printTask('build_bulk_print', ['bulk'], async (ctx, p) => {
    const tenantId: string = ctx.tenantId; const ids = p['report_version_ids'] as string[];
    const vs: Array<Record<string, any>> = (await ctx.tx.query(`SELECT id, released_at, pdf_object_path FROM reporting.report_versions WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids])).rows;
    const byId = new Map(vs.map((v) => [v['id'], v]));
    const paths = ids.map((i) => byId.get(i)).filter((v) => v && v['released_at'] != null).map((v) => v!['pdf_object_path']);
    if (paths.length === 0) throw new Permanent('reporting.report_not_released');
    if (!paths.every((x) => typeof x === 'string' && x.startsWith(`${tenantId}/`))) throw new Permanent('common.internal');   // before any read
    const parts: Array<Record<string, unknown>> = [];
    for (const path of paths as string[]) {
      const bytes: Uint8Array = await ctx.storage.read('reports', path);       // storage failure = retryable
      parts.push({ kind: 'main', pdf_base64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) });
    }
    return o.sandbox.assemble({ parts, stamp: STAMP });
  });
}
