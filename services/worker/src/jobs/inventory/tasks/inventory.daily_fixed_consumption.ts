// inventory.daily_fixed_consumption (02-TRD §8.5, §9; PRD AC-16.1, AC-16.2; 08 A13 P-6 per_tenant, A17 D-72): for every active per_day rule x business date D
// (D = yesterday in the tenant timezone, plus catch-up for up to LIMS_INVENTORY_FIXED_CATCHUP_DAYS = 7 missing days [CONV]) creates the fact `fixed:<rule_id>:<D>` when activity holds
// (settings.per_day_requires_activity = false, or instruments.v_pub_message_daily.messages > 0 for (instrument, D)) and posts it (§8.2-§8.4, system actor). occurred_at = D 23:59:59.999 tenant time.
// Idempotent: the unique (tenant_id, basis_key) turns a second run into a no-op (INSERT ... ON CONFLICT DO NOTHING). A fact that fails rolls back alone (savepoint); the next run retries it.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { loadInventoryConfig } from '../../../../../api/src/modules/inventory/config.js';
import { fixedBasisKey } from '../../../../../api/src/modules/inventory/domain/basis.js';
import { addDaysYmd, endOfDay, ymdIn } from '../../../../../api/src/modules/inventory/domain/tenantTime.js';
import { type RepoCtx, first, query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { getSettings } from '../../../../../api/src/modules/inventory/repository/settings.repo.js';
import { matchFact, postNeeds, raiseUnresolvedAlert, resolveStore, setFactTotal } from '../../../../../api/src/modules/inventory/service/consumers.service.js';
import { jobScope, tenantClock } from './_shared.js';

export const DAILY_FIXED_CONSUMPTION = 'inventory.daily_fixed_consumption';

// per_day rules in force at $2 (is_active, effective_from <= at < effective_to) that pass the activity gate for business date $4
const RULES_AT = `SELECT r.id, r.instrument_id FROM inventory.consumption_rules r
   WHERE r.tenant_id = $1 AND r.rule_kind = 'per_day' AND r.is_active AND r.effective_from <= $2::timestamptz AND (r.effective_to IS NULL OR r.effective_to > $2::timestamptz)
     AND ($3::boolean = false OR EXISTS (SELECT 1 FROM instruments.v_pub_message_daily m WHERE m.tenant_id = $1 AND m.instrument_id = r.instrument_id AND m.business_date = $4::date AND m.messages > 0))
   ORDER BY r.id`;

// creates the fact once per (tenant, basis_key); no row back when it already exists (a second run, or a parallel one)
const NEW_FACT = `INSERT INTO inventory.consumption_facts (id, tenant_id, fact_kind, basis_key, source, instrument_id, occurred_at, business_date, multiplier, store_id, status, rules_applied, value_paisa_total, created_by, updated_by)
   VALUES ($2::uuid, $1, 'fixed', $3, 'cron', $4::uuid, $5::timestamptz, $6::date, 1, $7::uuid, $8, $9::int, 0, $10::uuid, $10::uuid)
   ON CONFLICT (tenant_id, basis_key) DO NOTHING RETURNING id`;

async function postRuleDay(rc: RepoCtx, rule: { id: string; instrument_id: string }, bd: string, occurredAt: string, clock: { tz: string; nowMs: number }): Promise<boolean> {
  const basisKey = fixedBasisKey(rule.id, bd);
  if ((await first(rc, 'SELECT 1 AS x FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key = $2', [basisKey])) !== null) return false; // cheap pre-check: the common second run writes nothing
  const needs = await matchFact(rc, { fact_kind: 'fixed', occurred_at: occurredAt, instrument_id: rule.instrument_id, test_id: null, analyte_id: null, multiplier: 1, rule_id: rule.id });
  const storeId = needs.length === 0 ? null : (await resolveStore(rc, { instrument_id: rule.instrument_id })).store_id;
  const status = needs.length === 0 ? 'no_rule' : storeId === null ? 'unresolved' : 'posted';
  const id = uuidv7();
  const made = await query(rc, NEW_FACT, [id, basisKey, rule.instrument_id, occurredAt, bd, status === 'posted' ? storeId : null, status, needs.length, rc.actorId]);
  if (made.length === 0) return false;
  if (status === 'unresolved') await raiseUnresolvedAlert(rc, rule.instrument_id); // resolve_unresolved (T-15) posts it at the original time once a store exists
  if (status === 'posted') {
    const { rows, total } = await postNeeds(rc, { factId: id, factKind: 'fixed', occurredAt, businessDate: bd, storeId: storeId!, instrumentId: rule.instrument_id, needs, clock });
    if (rows.length > 0) await setFactTotal(rc, id, total);
  }
  return true;
}

export const dailyFixedConsumption: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const rc = jobScope('daily_fixed_consumption', payload, jobCtx);
  if (rc === null) return;
  const clock = await tenantClock(jobCtx);
  const yesterday = addDaysYmd(ymdIn(clock.nowMs, clock.tz), -1);
  const catchup = (await loadInventoryConfig()).fixedCatchupDays;
  const requires = ((await getSettings(rc))?.['per_day_requires_activity'] ?? true) === true;
  let created = 0;
  let failed = 0;
  for (let back = catchup; back >= 0; back -= 1) { // oldest first: the days of a rule post in order
    const bd = addDaysYmd(yesterday, -back);
    const occurredAt = new Date(endOfDay(bd, clock.tz)).toISOString();
    for (const rule of await query(rc, RULES_AT, [occurredAt, requires, bd])) {
      try {
        if (await ctx.db.tx(() => postRuleDay(rc, rule as { id: string; instrument_id: string }, bd, occurredAt, clock))) created += 1;
      } catch (e) {
        failed += 1;
        ctx.log?.error?.({ event: 'daily_fixed_consumption_fact_failed', rule_id: rule['id'], business_date: bd, code: (e as { code?: string })?.code }, 'daily_fixed_consumption fact failed');
      }
    }
  }
  ctx.log?.info?.({ event: 'daily_fixed_consumption_done', created, failed });
  if (failed > 0) throw Object.assign(new Error(`daily_fixed_consumption: ${failed} fact(s) failed`), { code: 'common.internal' }); // the worker retries; done facts are skipped
};
