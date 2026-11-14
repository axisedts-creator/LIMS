'use server';
// C13.T19 R2 markPartnerReportsSeen through the partner BFF. Only { ok } reaches the browser.
import 'server-only';
import { partnerApi } from '@/core/api';
import { isUuid } from '../common/api';

export async function markSeenAction(items: { report_id: string; version_no: number }[]): Promise<{ ok: boolean }> {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) return { ok: false };
  if (!items.every((i) => isUuid(i?.report_id) && Number.isInteger(i?.version_no) && i.version_no >= 1)) return { ok: false };
  const r = await partnerApi('/v1/partners/reports/mark-seen', { method: 'POST', body: { report_versions: items.map((i) => ({ report_id: i.report_id, version_no: i.version_no })) } });
  return { ok: r.ok };
}
