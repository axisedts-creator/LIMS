// Stored summary row -> SmartSummary (03-IC §4.10, 02-TRD §7.1 step 9, 08 A19 D-111, AC-14.4). Explicit allow-list: no tenant/patient/centre ids, hashes,
// review or LLM columns. 'rejected' is shown as 'draft' (no reject reason/comment); 'approved' carries the approver and time.
import { fillPlaceholders } from '../domain/placeholders.js';
import type { Row } from '../repository/common.repo.js';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** AC-20.4: the LLM overlay text replaces an item's text ONLY for an approved summary with use_llm_text = true and only for an item the overlay holds
 *  (itemRef deranged:<resultId> | advice:<blockId> | followup:<ruleId>). Overlay text keeps its {placeholders} (validator L1): they are filled here from the stored
 *  item; one that cannot be filled keeps the stored template-filled text (no raw token is ever printed). Items are never added or removed. */
function withOverlay(row: Row, c: Row): Row {
  const items = row.status === 'approved' && row.use_llm_text === true ? (row.llm_overlay as Row | null)?.items : undefined;
  if (items == null || typeof items !== 'object') return c;
  const pick = (ref: string, stored: string, values: Record<string, string | undefined>): string => {
    const t: unknown = Object.hasOwn(items, ref) ? items[ref] : undefined;
    if (typeof t !== 'string') return stored;
    try { return fillPlaceholders(t, values); } catch { return stored; }
  };
  return {
    ...c,
    deranged: (c.deranged as Row[]).map((d) => ({ ...d, text: pick(`deranged:${d.resultId}`, d.text, { analyte_name: d.analyteName }) })),
    advice: (c.advice as Row[]).map((a) => ({ ...a, text: pick(`advice:${a.templateBlockId}`, a.text, {}) })),
    followUps: (c.followUps as Row[]).map((f) => ({ ...f, text: pick(`followup:${f.ruleId}`, f.text, { test_name: f.suggestedTestName, interval_days: f.intervalDays === undefined ? undefined : String(f.intervalDays) }) })),
  };
}

export function toSmartSummary(row: Row, reportVersionNo: number): Record<string, unknown> {
  const c = withOverlay(row, row.content as Row);
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
