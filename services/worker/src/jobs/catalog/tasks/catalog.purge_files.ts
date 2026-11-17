// catalog.purge_files (02-TRD §10, per_tenant, daily): delete catalog.files past expires_at, NULL the plain-uuid references to them
// (imports.upload_file_id / report_file_id, exports.file_id; imports/exports rows are kept, 05-SCHEMA §10.1) and delete import_issues past
// expires_at — all in ONE job transaction, so a failure leaves files, references and issues untouched. Idempotent. File bytes are never read
// (DELETE … RETURNING id only). Nothing but counts is logged (07 S-13). [CONV] every purpose is purged; files and issues expire independently.
import type { TaskHandler } from '../../../core/manifest.js';
import { claimedTenant } from './tenant.js';

export const PURGE_FILES = 'catalog.purge_files';

export const purgeFiles: TaskHandler = async (payload, ctx) => {
  const tenantId = claimedTenant(payload, ctx);
  const files = await ctx.tx.query('DELETE FROM catalog.files WHERE tenant_id = $1 AND expires_at < now() RETURNING id', [tenantId]);
  const ids: string[] = files.rows.map((r: { id: string }) => r.id);
  if (ids.length) {
    await ctx.tx.query('UPDATE catalog.imports SET upload_file_id = NULL WHERE tenant_id = $1 AND upload_file_id = ANY($2::uuid[])', [tenantId, ids]);
    await ctx.tx.query('UPDATE catalog.imports SET report_file_id = NULL WHERE tenant_id = $1 AND report_file_id = ANY($2::uuid[])', [tenantId, ids]);
    await ctx.tx.query('UPDATE catalog.exports SET file_id = NULL WHERE tenant_id = $1 AND file_id = ANY($2::uuid[])', [tenantId, ids]);
  }
  const issues = await ctx.tx.query('DELETE FROM catalog.import_issues WHERE tenant_id = $1 AND expires_at < now()', [tenantId]);
  ctx.log.info({ files: ids.length, issues: issues.rowCount }, 'catalog.purge_files done');
};
