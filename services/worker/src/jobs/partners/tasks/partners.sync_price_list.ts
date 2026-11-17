// partners.sync_price_list (02-TRD §8.1, §8.2; 03-APP-FLOW §5.7). Payload {tenant_id, partner_id} = one partner; {tenant_id} only = the cron tick,
// which ENQUEUES one job per ACTIVE partner (job_key pricelist:<partner_id>) and writes nothing itself.
// One partner: read catalog.v_pub_price_list_items (that partner's credit-party list + the tenant default list, effective now), precedence partner > standard
// (US-11.1/11.2), classify + name each orderable (v_pub_test_directory / CatalogPort, memoised per run), then DELETE + INSERT the partner's
// partners.price_list_items rows and upsert partners.price_list_syncs in the job's single transaction (all-or-nothing; a throw rolls back and the job retries).
// No other party's prices are ever read: the view is filtered by owner_kind + owner_id = THIS partner's credit party (US-11.4); every value is a bound parameter.
// [CONV] effective_to is exclusive (half-open [from, to)): v2 ending 2026-01-01 and v3 starting 2026-01-01 never overlap.
// falls_through (08 A13 D-19, 03-IC §6.6, C3 catalog/domain/priceMatch.ts): default rows fill orderables only when include_default_price_list is on AND
// the partner has no effective credit-party list, or its effective list (highest version) has falls_through = true.
import { LimsError } from '../../../../../api/src/core/errors.js';
import type { JobContext, TaskHandler } from '../../../core/manifest.js';

export const PRICE_TASK = 'partners.sync_price_list';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 500; // 13 columns x 500 rows stays far below the 65535 parameter limit

/** payload tenant must equal the job tenant; partner_id is optional (tick) but must be a uuid. */
export function scopeOf(payload: Record<string, unknown>, ctx: JobContext): { tenantId: string; partnerId: string | undefined } {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new TypeError('partners job: job tenant is not a uuid');
  if (payload?.['tenant_id'] !== tenantId) throw new Error('partners job: payload tenant differs from the job tenant');
  const p = payload['partner_id'];
  if (p !== undefined && (typeof p !== 'string' || !UUID.test(p))) throw new TypeError('partners job: partner_id is not a uuid');
  return { tenantId, partnerId: p as string | undefined };
}

/** Enqueue one pricelist:<partner_id> job per active partner of the tenant; runAt (ISO) debounces (consumer: now + 60 s). */
export async function enqueuePriceListSyncs(ctx: JobContext, tenantId: string, runAt?: string): Promise<void> {
  const { rows } = await ctx.tx.query("SELECT id FROM partners.partners WHERE tenant_id = $1 AND status = 'active'", [tenantId]);
  for (const r of rows) {
    const payload = JSON.stringify({ tenant_id: tenantId, partner_id: r.id });
    if (runAt) await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, $4)', [PRICE_TASK, payload, `pricelist:${r.id}`, runAt]);
    else await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [PRICE_TASK, payload, `pricelist:${r.id}`]);
  }
}

interface ViewRow { price_list_id: string; price_list_version: number; owner_kind: string; owner_id: string; orderable_id: string; unit_price_paisa: string; effective_from: unknown; effective_to: unknown; falls_through: boolean }
const rank = (r: ViewRow) => (r.owner_kind === 'credit_party' ? 1 : 0); // partner > standard
const ms = (v: unknown) => new Date(v as string).getTime();

const notFound = (e: unknown) => e instanceof LimsError ? e.code === 'common.not_found' : (e as { code?: unknown } | null)?.code === 'common.not_found';

export const syncPriceListTask: TaskHandler = async (payload, ctx) => {
  const { tenantId, partnerId } = scopeOf(payload, ctx);
  if (partnerId === undefined) return enqueuePriceListSyncs(ctx, tenantId);
  const tx = ctx.tx;
  const now = ctx.now();
  const actor = ctx.actor.id;

  const partner = (await tx.query('SELECT id, credit_party_id FROM partners.partners WHERE tenant_id = $1 AND id = $2', [tenantId, partnerId])).rows[0];
  if (!partner) { ctx.log.warn({ partner_id: partnerId }, 'partners.sync_price_list: partner not found in tenant, skipped'); return; }
  const settings = (await tx.query('SELECT include_default_price_list FROM partners.settings WHERE tenant_id = $1', [tenantId])).rows[0];
  const includeDefault = settings?.include_default_price_list ?? true; // TRD §10.2 default

  // 1. candidate rows: this partner's credit-party list (+ the tenant default list), effective now
  const owners: string[] = [];
  const values: unknown[] = [tenantId, now];
  if (partner.credit_party_id) { values.push('credit_party', partner.credit_party_id); owners.push(`(owner_kind = $${values.length - 1} AND owner_id = $${values.length})`); }
  if (includeDefault) { values.push('default'); owners.push(`owner_kind = $${values.length}`); }
  const candidates: ViewRow[] = owners.length === 0 ? [] : (await tx.query(
    'SELECT price_list_id, price_list_version, owner_kind, owner_id, orderable_id, unit_price_paisa, effective_from, effective_to, falls_through FROM catalog.v_pub_price_list_items '
    + `WHERE tenant_id = $1 AND (${owners.join(' OR ')}) AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)`, values)).rows;
  // A13 D-19: the effective credit-party list (highest version) decides whether the default list may fill gaps
  const cp = candidates.filter((r) => r.owner_kind === 'credit_party').sort((a, b) => b.price_list_version - a.price_list_version)[0];
  const view = !cp || cp.falls_through === true ? candidates : candidates.filter((r) => r.owner_kind === 'credit_party');

  // 2. precedence per orderable: partner list over default; then higher list version, then later effective_from
  const best = new Map<string, ViewRow>();
  for (const r of view) {
    const b = best.get(r.orderable_id);
    if (!b || rank(r) > rank(b) || (rank(r) === rank(b) && (r.price_list_version > b.price_list_version || (r.price_list_version === b.price_list_version && ms(r.effective_from) > ms(b.effective_from))))) best.set(r.orderable_id, r);
  }

  // 3. classify + name (tests: this tenant's directory + CatalogPort.getTest for the department; panels: CatalogPort.getPanel; unknown ids skipped)
  const ids = [...best.keys()];
  const dir = ids.length === 0 ? [] : (await tx.query('SELECT test_id, code, name FROM catalog.v_pub_test_directory WHERE tenant_id = $1 AND test_id = ANY($2::uuid[])', [tenantId, ids])).rows;
  const tests = new Map<string, { code: string; name: string }>(dir.map((d: any) => [d.test_id, d]));
  const catalog = (ctx as unknown as { ports: { CatalogPort: { getTest(c: unknown, i: { testId: string }): Promise<any>; getPanel(c: unknown, i: { panelId: string }): Promise<any> } } }).ports.CatalogPort;
  const out: unknown[][] = [];
  let version: number | null = null;
  for (const id of ids) { // one lookup per id: ids are unique, so the run is memoised by construction
    const r = best.get(id)!;
    let kind: 'test' | 'panel', code: string, name: string, department: string | null = null;
    const t = tests.get(id);
    if (t) {
      kind = 'test'; code = t.code; name = t.name;
      try { department = (await catalog.getTest(ctx, { testId: id })).departmentName ?? null; } catch (e) { if (notFound(e)) continue; throw e; }
    } else {
      try { const p = await catalog.getPanel(ctx, { panelId: id }); kind = 'panel'; code = p.code; name = p.name; } catch (e) {
        if (notFound(e)) { ctx.log.warn({ orderable_id: id }, 'partners.sync_price_list: orderable is neither test nor panel, skipped'); continue; } // id only
        throw e;
      }
    }
    const source = rank(r) === 1 ? 'partner' : 'standard';
    if (source === 'partner' && (version === null || r.price_list_version > version)) version = r.price_list_version;
    out.push([tenantId, partnerId, id, kind, code, name, department, r.unit_price_paisa, source, r.price_list_id, r.price_list_version, r.effective_from, r.effective_to, now, actor]);
  }

  // 4. replace in this job's transaction (a failure anywhere rolls the whole job back: old rows + old sync state stay)
  await tx.query('DELETE FROM partners.price_list_items WHERE tenant_id = $1 AND partner_id = $2', [tenantId, partnerId]);
  for (let i = 0; i < out.length; i += CHUNK) {
    const chunk = out.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v) => `$${params.push(v)}`).join(', ')})`);
    await tx.query('INSERT INTO partners.price_list_items (tenant_id, partner_id, orderable_id, kind, code, name, department_name, unit_price_paisa, source, price_list_id, price_list_version, '
      + `effective_from, effective_to, synced_at, created_by) VALUES ${tuples.join(', ')}`, params);
  }
  await tx.query('INSERT INTO partners.price_list_syncs (tenant_id, partner_id, synced_at, price_list_version, row_count, last_error_code, created_by, updated_at, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, NULL, $6, $3, $6) ON CONFLICT (tenant_id, partner_id) DO UPDATE SET synced_at = EXCLUDED.synced_at, '
    + 'price_list_version = EXCLUDED.price_list_version, row_count = EXCLUDED.row_count, last_error_code = NULL, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by',
  [tenantId, partnerId, now, version, out.length, actor]);
};
