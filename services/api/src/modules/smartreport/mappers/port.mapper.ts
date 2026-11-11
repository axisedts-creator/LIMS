// Stored summary row -> SmartSummary (03-IC §4.10, 02-TRD §7.1 step 9, 08 A19 D-111, AC-14.4). Explicit allow-list: no tenant/patient/centre ids, hashes,
// review or LLM columns. 'rejected' is shown as 'draft' (no reject reason/comment); 'approved' carries the approver and time.
import type { Row } from '../repository/common.repo.js';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export function toSmartSummary(row: Row, reportVersionNo: number): Record<string, unknown> {
  const c = row.content as Row;
  const approved = row.status === 'approved';
  return {
    summaryId: row.id, orderId: row.order_id, reportVersionNo, templateLibraryVersion: row.template_library_version,
    status: approved ? 'approved' : 'draft',
    ...(approved && { approvedByMembershipId: row.approved_by_membership_id, approvedAt: iso(row.approved_at) }),
    ...(c.healthScore !== undefined && { healthScore: c.healthScore }),
    panels: c.panels, deranged: c.deranged, advice: c.advice, followUps: c.followUps, trends: c.trends,
    disclaimerBlockId: c.disclaimerBlockId, language: c.language, builtAt: iso(row.built_at), disclaimerText: c.disclaimerText,
  };
}
