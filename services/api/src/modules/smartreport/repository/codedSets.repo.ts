// Global coded sets (class G, no tenant column, read-only, 05-SCHEMA §3.1/§3.2): organ groups and summary reject reasons.
import type { RepoCtx, Row } from './common.repo.js';

export async function listOrganGroups(rc: RepoCtx): Promise<Row[]> {
  return (await rc.tx.query('SELECT * FROM smartreport.g_cs_organ_groups WHERE is_active ORDER BY sort_order ASC, code')).rows;
}
export async function listRejectReasons(rc: RepoCtx): Promise<Row[]> {
  return (await rc.tx.query('SELECT * FROM smartreport.g_cs_summary_reject_reasons WHERE is_active ORDER BY sort_order ASC, code')).rows;
}
