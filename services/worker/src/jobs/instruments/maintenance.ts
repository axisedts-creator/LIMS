// instruments.expire_credentials_and_commands, instruments.refresh_observed_code_mapping (+ its catalog.changed.v1 consumer),
// instruments.purge_archive (02-TRD §9.2, §10; AC-17.3, AC-20.1, AC-20.2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobTenant, type Ctx } from './shared.js';

// ------------------------------------------------------------------ expiry (03-APP-FLOW §2.3 / §2.5)
const EXPIRE_CODES_SQL = `UPDATE instruments.agent_credentials
  SET status = 'expired', updated_at = $2, updated_by = $3, version = version + 1
  WHERE tenant_id = $1 AND kind = 'enrolment_code' AND status = 'active' AND expires_at <= $2`;
const EXPIRE_COMMANDS_SQL = `UPDATE instruments.agent_commands
  SET state = 'expired', updated_at = $2, updated_by = $3, version = version + 1
  WHERE tenant_id = $1 AND state IN ('queued', 'delivered') AND expires_at <= $2`;

export async function expireCredentialsAndCommands(payload: { tenant_id?: unknown }, ctx: Ctx): Promise<void> {
  const tenantId = jobTenant(payload, ctx);
  const v = [tenantId, ctx.now(), ctx.actor.id];
  await ctx.tx.query(EXPIRE_CODES_SQL, v);
  await ctx.tx.query(EXPIRE_COMMANDS_SQL, v);
}

// ------------------------------------------------------------------ catalog.changed.v1 consumer (02-TRD §9.2)
export const REFRESH_TASK = 'instruments.refresh_observed_code_mapping';
const REFRESH_TYPES = new Set(['instrument_code_map', 'global_reference']);
/** Known entity_type values of the contract; anything else is an unknown x-extensible value -> invalidate all (08 R13). */
const KNOWN_TYPES: ReadonlySet<string> = new Set(JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '..', '..', '..', '..', 'contracts', 'events', 'catalog.changed.v1.schema.json'), 'utf8',
)).$defs.Payload.properties.entity_type.enum);

export async function onCatalogChanged(event: any, ctx: Ctx): Promise<void> {
  const t = event?.payload?.entity_type;
  if (KNOWN_TYPES.has(t) && !REFRESH_TYPES.has(t)) return;
  const tenantId = jobTenant({}, ctx);
  // job_key coalesces a burst into one pending refresh per tenant
  await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, NULL, NULL)', [REFRESH_TASK, JSON.stringify({ tenant_id: tenantId }), `instruments.refresh:${tenantId}`]);
}

// ------------------------------------------------------------------ refresh (AC-17.3)
const PAGE = 500;
const MAX_ROWS = 5000;                                   // 02-TRD §10 [CONV] per run
const OBSERVED_SQL = `SELECT instrument_id, record_class, instrument_analyte_code FROM instruments.observed_codes
  WHERE tenant_id = $1 AND (instrument_id, record_class, instrument_analyte_code) > ($2::uuid, $3, $4)
  ORDER BY instrument_id, record_class, instrument_analyte_code LIMIT ${PAGE}`;
const MARK_SQL = `UPDATE instruments.observed_codes
  SET last_mapping_status = $5, last_analyte_id = $6, last_mapping_checked_at = $7, updated_at = $7, updated_by = $8
  WHERE tenant_id = $1 AND instrument_id = $2 AND record_class = $3 AND instrument_analyte_code = $4`;

export async function refreshObservedCodeMapping(payload: { tenant_id?: unknown }, ctx: Ctx): Promise<void> {
  const tenantId = jobTenant(payload, ctx);
  const now = ctx.now();
  const memo = new Map<string, string | null>();          // instrument + code -> analyte id (null = unmapped)
  let last = ['00000000-0000-0000-0000-000000000000', '', ''];
  let seen = 0;
  while (seen < MAX_ROWS) {
    const { rows } = await ctx.tx.query(OBSERVED_SQL, [tenantId, ...last]);
    if (rows.length === 0) break;
    for (const r of rows) {
      const k = `${r.instrument_id}\u0000${r.instrument_analyte_code}`;
      if (!memo.has(k)) {
        try {
          const m = await ctx.ports.CatalogPort.mapInstrumentCode(ctx, { instrumentId: r.instrument_id, direction: 'inbound', instrumentCode: r.instrument_analyte_code });
          memo.set(k, m.analyteId);
        } catch (e: any) {
          if (e?.code !== 'catalog.instrument_code_unmapped') throw e;   // transient: fail the job, never mark unmapped
          memo.set(k, null);
        }
      }
      const analyte = memo.get(k)!;
      await ctx.tx.query(MARK_SQL, [tenantId, r.instrument_id, r.record_class, r.instrument_analyte_code, analyte ? 'mapped' : 'unmapped', analyte, now, ctx.actor.id]);
    }
    seen += rows.length;
    const z = rows[rows.length - 1];
    last = [z.instrument_id, z.record_class, z.instrument_analyte_code];
    if (rows.length < PAGE) break;
  }
  ctx.log.info('instruments.refresh_observed_code_mapping', { codes: seen });
}

// ------------------------------------------------------------------ purge (AC-20.1 / AC-20.2)
const BUCKET = 'instruments-attachments';                // 05-SCHEMA attachments__bucket__ck
const DAYS_PER_YEAR = 366;                               // 02-TRD §10 [CONV]
const ATTACHMENTS_SQL = `SELECT id, object_path FROM instruments.attachments
  WHERE tenant_id = $1 AND created_at < $2 AND object_path NOT LIKE '%#deleted' AND id > $3::uuid
  ORDER BY id LIMIT ${PAGE}`;
const MARK_DELETED_SQL = `UPDATE instruments.attachments
  SET object_path = object_path || '#deleted', updated_at = $3, updated_by = $4, version = version + 1
  WHERE tenant_id = $1 AND id = $2 AND object_path NOT LIKE '%#deleted'`;

export async function purgeArchive(payload: { tenant_id?: unknown }, ctx: Ctx): Promise<void> {
  const tenantId = jobTenant(payload, ctx);
  const settings = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['retention'] });
  const years = settings?.retention?.rawInstrumentYears;
  if (!Number.isInteger(years) || years < 1) throw new Error('purge_archive: retention.rawInstrumentYears is not an integer >= 1');
  const days = years * DAYS_PER_YEAR;
  const now = ctx.now();
  const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
  // 1. Storage first: the DEFINER deletes only attachment rows already marked '#deleted', so a failed object delete just waits.
  let after = '00000000-0000-0000-0000-000000000000';
  let failed = 0;
  for (;;) {
    const { rows } = await ctx.tx.query(ATTACHMENTS_SQL, [tenantId, cutoff, after]);
    for (const r of rows) {
      try { await ctx.storage.delete(BUCKET, r.object_path); } catch { failed += 1; continue; }
      await ctx.tx.query(MARK_DELETED_SQL, [tenantId, r.id, now, ctx.actor.id]);
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
  }
  if (failed) ctx.log.warn('instruments.purge_archive storage deletes failed', { failed });
  // 2. the inventoried DEFINER: current tenant only, refuses < 365 days
  const { rows } = await ctx.tx.query('SELECT table_name, deleted FROM app.purge_instruments_archive($1)', [days]);
  for (const r of rows) ctx.metrics.inc('lims_instruments_archive_purged_rows_total', { table: r.table_name }, Number(r.deleted));
}
