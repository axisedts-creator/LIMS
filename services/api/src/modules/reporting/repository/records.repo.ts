// Tenant-scoped by-id reads for the reporting tables whose behaviour lands in later C6 tasks (06-PLAN C6-T03 "repositories for all tables").
// Each later task replaces / extends its table's statements here or in its own *.repo.ts. REQ-SEC-024: explicit tenant_id on every statement.
import type { Tx } from './settings.repo.js';

const BY_ID = Object.freeze({
  channel_accounts: 'SELECT * FROM reporting.channel_accounts WHERE tenant_id = $1 AND id = $2',
  message_template_texts: 'SELECT * FROM reporting.message_template_texts WHERE tenant_id = $1 AND id = $2',
  report_templates: 'SELECT * FROM reporting.report_templates WHERE tenant_id = $1 AND id = $2',
  report_template_versions: 'SELECT * FROM reporting.report_template_versions WHERE tenant_id = $1 AND id = $2',
  narrative_templates: 'SELECT * FROM reporting.narrative_templates WHERE tenant_id = $1 AND id = $2',
  reports: 'SELECT * FROM reporting.reports WHERE tenant_id = $1 AND id = $2',
  report_order_items: 'SELECT * FROM reporting.report_order_items WHERE tenant_id = $1 AND id = $2',
  report_versions: 'SELECT * FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2',
  qr_tokens: 'SELECT * FROM reporting.qr_tokens WHERE tenant_id = $1 AND id = $2',
  deliveries: 'SELECT * FROM reporting.deliveries WHERE tenant_id = $1 AND id = $2',
  portal_links: 'SELECT * FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2',
  otp_challenges: 'SELECT * FROM reporting.otp_challenges WHERE tenant_id = $1 AND id = $2',
  portal_sessions: 'SELECT * FROM reporting.portal_sessions WHERE tenant_id = $1 AND id = $2',
  delivery_attempts: 'SELECT * FROM reporting.delivery_attempts WHERE tenant_id = $1 AND id = $2',
  provider_events: 'SELECT * FROM reporting.provider_events WHERE tenant_id = $1 AND id = $2',
  narrative_reports: 'SELECT * FROM reporting.narrative_reports WHERE tenant_id = $1 AND id = $2',
  input_files: 'SELECT * FROM reporting.input_files WHERE tenant_id = $1 AND id = $2',
  narrative_versions: 'SELECT * FROM reporting.narrative_versions WHERE tenant_id = $1 AND id = $2',
  print_jobs: 'SELECT * FROM reporting.print_jobs WHERE tenant_id = $1 AND id = $2',
  portal_payment_requests: 'SELECT * FROM reporting.portal_payment_requests WHERE tenant_id = $1 AND id = $2',
});
export type RecordTable = keyof typeof BY_ID;

export async function findById(tx: Tx, table: RecordTable, tenantId: string, id: string): Promise<any | undefined> {
  const sql = Object.hasOwn(BY_ID, table) ? BY_ID[table] : undefined;
  if (typeof sql !== 'string') throw new Error('unknown reporting table');
  return (await tx.query(sql, [tenantId, id])).rows[0];
}

/** Global catalogue (no tenant_id; read-only for lims_app). */
export async function findMessageTemplate(tx: Tx, code: string): Promise<any | undefined> {
  return (await tx.query('SELECT * FROM reporting.g_message_templates WHERE code = $1 AND is_active', [code])).rows[0];
}
