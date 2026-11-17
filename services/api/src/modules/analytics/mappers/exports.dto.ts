// analytics.exports row -> OpenAPI ExportDto (TRD §5 #20-#22). No tenant, requester, scope, sha256 or file content ever leaves.
import type { ExportRecord } from '../repository/exports.repo.js';

const iso = (d: Date | string): string => new Date(d).toISOString();

export function toExportDto(r: ExportRecord) {
  return {
    id: r.id, report_code: r.report_code, format: r.format, status: r.status, params: r.params, requested_at: iso(r.requested_at),
    ...(r.ready_at == null ? {} : { ready_at: iso(r.ready_at) }),
    ...(r.expires_at == null ? {} : { expires_at: iso(r.expires_at) }),
    ...(r.row_count == null ? {} : { row_count: Number(r.row_count) }),
    ...(r.size_bytes == null ? {} : { size_bytes: Number(r.size_bytes) }),
    downloads_used: r.downloads_used, downloads_allowed: r.downloads_allowed,
    ...(r.failure_code == null ? {} : { failure_code: r.failure_code }),
  };
}
