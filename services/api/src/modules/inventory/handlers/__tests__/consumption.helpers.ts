// C12.T-15 test helpers (not a test file). Synthetic data only. Operations #69-#79: listConsumptionRules, createConsumptionRule, getConsumptionRule, supersedeConsumptionRule, deactivateConsumptionRule,
// previewConsumption, listConsumptionFacts, logConsumptionEvent, resolveConsumptionFact, dismissConsumptionFact, reverseConsumptionFact.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention and ctx stub as T-09 / T-14 (lots.helpers.ts / counts.helpers.ts):
//   * `handlers[operationId](req, ctx)`; success => { status, body }; failure => the handler THROWS a LimsError. Header keys lower-case; If-Match = `"<version>"`. Idempotency is the core pipeline's job.
//   * GATE ORDER. Tenant-context ops (#69 #71 #73 #74 #75 #76 #78 and the writes #70 #72): `IdentityPort.assertRole(ctx, { permission })` with NO branchId is the FIRST thing, before validation and before any tx
//     statement. #77 (branch(body.store)) and #79 (branch(fact store)): request validation first (tx untouched), then load the fact (404) -> its store (404 when unknown or branch not visible) ->
//     assertRole({ permission, branchId }) (403; #79 is privileged: at aal1 the port rejects with auth.mfa_required) -> state checks -> If-Match (409 common.version_conflict).
//     #79 state order: `inventory.fact_not_reversible` (source <> manual) BEFORE `inventory.document_invalid_transition` (status <> posted). A fact whose store is NULL has no branch: #79 asserts the permission tenant-wide.
//   * CATALOG. `ctx.ports.CatalogPort.getTest(ctx, { testId, asOf? })` => TestDefinition (analytes[] with `id`, `reportable`). #70 (and #72) call it for rules that carry a test_id; an analyte that is not in
//     `analytes` => 400 common.validation_failed at `/analyte_id`. A LimsError thrown by the port (unknown test => common.not_found) propagates as the SAME object and nothing is written (P-23 pattern).
//   * RULE SHAPE (05-SCHEMA §2.23 consumption_rules__shape__ck, enforced as 400 common.validation_failed with the field pointer BEFORE the DB): per_test / per_rerun / per_calibration need test_id and forbid analyte_id;
//     per_analyte needs both; per_qc needs test_id (analyte optional); per_day needs instrument_id and forbids test_id / analyte_id. qty > 0. `pack_id` converts: qty_base = qty * pack.qty_in_base, entered_qty = qty,
//     entered_pack_id = pack_id; a pack of another item => 422 inventory.uom_mismatch. effective_from = ctx.now(). A second CURRENT rule for the same key => 409 inventory.rule_conflict.
//   * SUPERSEDE (#72): old rule effective_to = ctx.now() (stays is_active), a new rule (same key, supersedes_rule_id = old, effective_from = ctx.now(), new qty) is returned 201. Old rule not current => 409
//     inventory.document_invalid_transition. If-Match is the OLD rule's version. DEACTIVATE (#73): effective_to = ctx.now(), is_active = false; already deactivated / not current => 409 invalid transition.
//   * MATCH (02-TRD §8.3, domain/rules.ts) is re-run against the DB on EVERY call (no rule cache, TRD §11): a rule created after a call is seen by the next call. Rules are evaluated at occurred_at.
//   * RESOLUTION (02-TRD §8.2): steps 1, 2, 5, 6 only (3 / 4 sit behind LIMS_INVENTORY_RESOLUTION_STEPS, default `1,2,5`, 06-PLAN §3). `consumption.service.ts` exports
//     `resolveStore(rc, { instrument_id?, centre_id?, processing_branch_id? }) => Promise<{ store_id: string | null; step: 1 | 2 | 5 | 6 }>` (rc = { tx, tenantId, actorId }); #74 returns the same step.
//   * STATUS AT INSERT. A fact row is INSERTed with its FINAL status (posted / no_rule / unresolved). The only UPDATE the service may issue on consumption_facts for a new fact is the same-status
//     `value_paisa_total` write after posting: no UPDATE whose SET list names `status` may be sent for #76 (observable through the tx statement log).
//   * #76: fact_kind calibration needs reason_code (group calibration) and forbids observations; qc: observations 1-50 (default 1) = fact multiplier. occurred_at in [now - backdate_max_days, now + 300 s] (AC-15.2).
//     basis_key `manual:<uuid>`, source 'manual'. A matched rule with a resolved store in a branch the caller cannot see => 403 auth.forbidden, nothing written. no_rule / unresolved need tenant scope only.
//   * #77 resolve: body { store_id }; fact must be `unresolved` (409 invalid transition otherwise); the store must be active (else 400 `/store_id`); posts with the fact's ORIGINAL occurred_at / business_date.
//   * #78 dismiss: reason in group fact_dismiss (else 422 inventory.reason_required); fact must be `unresolved`. #79 reverse: reason in group fact_reverse (422 inventory.reason_required); movement kind `consume_reversal`.
//   * #75: facts whose store is in a visible branch + facts with store NULL; embedded movements[] follow the same rule. basis_key / source_event_id are NEVER on the wire. `value_paisa_total`, movement `value_paisa`
//     and preview `est_value_paisa` only with `inventory.cost.read` (02-TRD §6.3).
import { LimsError } from '../../../../core/errors.js';
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, type Req, type Tx } from './masters.helpers.js';
import { ADJUST, BENCH, COST, READ, makeLotCtx, addDays, ymdIn, type LotOpts, type LotStub } from './lots.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, ADJUST, BENCH, COST, READ, addDays, ymdIn, LimsError };
export type { Req, Tx, LotOpts, LotStub };
export const MANAGE = 'inventory.master.manage';

/** operationId -> permission the handler must assert (02-TRD §5.5 #69-#79). */
export const PERMISSION: Record<string, string> = {
  listConsumptionRules: READ, createConsumptionRule: MANAGE, getConsumptionRule: READ, supersedeConsumptionRule: MANAGE, deactivateConsumptionRule: MANAGE, previewConsumption: READ,
  listConsumptionFacts: READ, logConsumptionEvent: BENCH, resolveConsumptionFact: MANAGE, dismissConsumptionFact: MANAGE, reverseConsumptionFact: ADJUST,
};

export interface ConsOpts extends LotOpts { analytes?: Record<string, string[]>; catalogFailure?: LimsError }
export interface ConsStub extends LotStub { catalogCalls: { testId: string }[] }

/** ctx for the lab manager: item.read + master.manage + bench.record + stock.adjust (aal2) + a fake CatalogPort.getTest (test id -> analyte ids; an unknown test => common.not_found). */
export function makeConsCtx(tx: Tx, tenantId: string, o: ConsOpts = {}): ConsStub {
  const st = makeLotCtx(tx, tenantId, { permissions: [READ, MANAGE, BENCH, ADJUST], ...o });
  const catalogCalls: { testId: string }[] = [];
  const analytes = o.analytes ?? {};
  st.ctx.ports.CatalogPort = {
    async getTest(_c: unknown, i: { testId: string; asOf?: string }) {
      catalogCalls.push({ testId: i.testId });
      if (o.catalogFailure) throw o.catalogFailure;
      const ids = analytes[i.testId];
      if (!ids) throw new LimsError('common.not_found');
      return { id: i.testId, code: 'T', name: 'Synthetic test', departmentId: uid(1), departmentCode: 'D', specimenTypeCodes: [], workflowType: 'standard', isActive: true, revision: 1,
        analytes: ids.map((id, n) => ({ id, code: `A${n}`, name: `Analyte ${n}`, resultType: 'numeric', reportable: true, sortOrder: n })) };
    },
  };
  return { ...st, catalogCalls };
}

// ------------------------------------------------------------------ contract shapes (inventory.yaml components Rule / Fact; no tenant / audit / basis_key / source_event_id ever)
export const RULE_KEYS = ['id', 'rule_kind', 'test_id', 'analyte_id', 'instrument_id', 'item_id', 'qty_base', 'entered_qty', 'entered_pack_id', 'effective_from', 'effective_to', 'supersedes_rule_id', 'notes', 'is_active', 'version', 'history'];
export const FACT_KEYS = ['id', 'fact_kind', 'source', 'status', 'instrument_id', 'test_id', 'analyte_id', 'occurred_at', 'business_date', 'multiplier', 'store_id', 'rules_applied', 'value_paisa_total', 'reason_code', 'note', 'movements', 'version'];
export const PREVIEW_KEYS = ['store_id', 'store_resolution_step', 'lines'];
export const PREVIEW_LINE_KEYS = ['rule_id', 'item_id', 'qty_base', 'lot_id', 'est_value_paisa'];
export const SECRET_FACT_KEYS = ['basis_key', 'source_event_id', 'source_event_type', 'tenant_id', 'created_by', 'updated_by', 'resolved_by', 'department_id', 'centre_id', 'processing_branch_id'];
export const MONEY_KEY = /_paisa(_total|_x1e6)?$/;

// ------------------------------------------------------------------ request builders
export const ruleBody = (rule_kind: string, item_id: string, qty: string, over: Record<string, unknown> = {}) => ({ rule_kind, item_id, qty, ...over });
export const supersedeBody = (qty: string, over: Record<string, unknown> = {}) => ({ qty, ...over });
export const previewBody = (fact_kind: string, over: Record<string, unknown> = {}) => ({ fact_kind, ...over });
export const calBody = (test_id: string, occurred_at: string, over: Record<string, unknown> = {}) => ({ fact_kind: 'calibration', test_id, occurred_at, reason_code: 'scheduled', ...over });
export const qcBody = (test_id: string, occurred_at: string, over: Record<string, unknown> = {}) => ({ fact_kind: 'qc', test_id, occurred_at, ...over });
export const resolveBody = (store_id: string) => ({ store_id });
export const reasonBody = (reason_code: string) => ({ reason_code });
