// T0B-SYNC-4 done_when (2), (5) (LD-322 decisions 2 and 3, LD-325 b; design C:/LIMS-state/offline-design-20261117.md sections 3 and 8): offline adapter
// of result.verify = verifyResult (lab.result.verify), entity_id = result id, base_version = the version signed. The verification policy of
// T0B-VERLEVEL-1 (levels, distinct people, enterer is not verifier, pathologist for the final sign off) is RE-RUN at sync time by calling the SAME
// service the online handler calls (verify.handlers.ts), as the signed in user, in a nested SAVEPOINT; this file holds no copy of the policy.
//   policy failure (lab.verifier_not_distinct, lab.enterer_cannot_verify, lab.result_invalid_transition, a version that moved on, or
//   lab.pathologist_required for a signer who is not a pathologist) -> rejected sync.verification_policy_failed; every report printed offline on
//   the result is marked recall_required; an alert to the lab manager lists their report version ids; the outcome is recorded. Those writes are
//   kept (outcome rejected), the service's writes are rolled back with the nested SAVEPOINT.
//   lab.pathologist_required for a pathologist (= holds lab.result.approve): the approval needs MFA step up, which an offline device cannot give ->
//   sync.offline_not_allowed, unless the tenant policy allows offline approval (default off, LD-322 decision 3): then approveResult runs and the
//   audit event records the offline approval with the op id and the device time.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import { payloadShape, type SyncAdapter, type SyncOp } from '../../../core/sync/engine.js';
import { settleMarker, syncAlerts, syncSignoffs, type Alerts, type ReadResult, type Signoffs } from '../../../core/sync/offlineSignoffs.js';
import { authed } from '../handlers/resultEntry.handlers.js';
import { approveResult, verifyResult } from '../service/result.service.js';
import { readResultState } from './resultEnter.adapter.js';

/** The refusals of signoff.service.ts / result.service.ts that mean "the sign off breaks the policy" (lab.pathologist_required is decided apart). */
const POLICY = new Set(['lab.verifier_not_distinct', 'lab.enterer_cannot_verify', 'lab.result_invalid_transition', 'common.version_conflict']);
const FLAGS = ['delta', 'critical', 'unit_mismatch', 'instrument_flag'];   // lab.yaml VerifyResultRequest.acknowledged_flags (as verify.handlers.ts)
const codeOf = (e: unknown): string | undefined => (e instanceof LimsError ? e.code : undefined);

async function isPathologist(ctx: HandlerContext): Promise<boolean> {
  const a = await (ctx as any).ports?.IdentityPort?.getActor?.(ctx);
  return Array.isArray(a?.permissions) && a.permissions.includes('lab.result.approve');
}

export function createResultVerifyAdapter(deps: { readResult?: ReadResult; alerts?: Alerts; signoffs?: Signoffs; offlineApprovalAllowed?: (ctx: HandlerContext) => Promise<boolean> } = {}): SyncAdapter {
  const readResult = deps.readResult ?? readResultState;
  const alerts = deps.alerts ?? syncAlerts;
  const signoffs = deps.signoffs ?? syncSignoffs;
  // [CONV] no tenant settings source yet: off = DEFAULT_SYNC_SETTINGS.offlineApprovalAllowed of core/sync/index.ts, the value getSyncStatus reports
  // (a literal here: importing index.ts would close an import cycle, index.ts registers this adapter)
  const offlineApprovalAllowed = deps.offlineApprovalAllowed ?? (async () => false);
  const record = (ctx: HandlerContext, op: SyncOp, outcome: 'accepted' | 'rejected') =>
    signoffs.recordVerify(ctx, { opId: op.opId, deviceId: op.deviceId, resultId: op.entityId!, outcome, deviceCreatedAt: op.deviceCreatedAt });

  async function policyFailed(ctx: HandlerContext, op: SyncOp, code: string) {
    const resultId = op.entityId!;
    const hit = (await signoffs.markersForResult(ctx, resultId)).filter((m) => m.state !== 'recall_required');
    for (const m of hit) await signoffs.setMarkerState(ctx, m.opId, 'recall_required');
    await alerts.raise(ctx, { kind: 'verification_policy_failed', opId: op.opId, resultId, code, reportVersionIds: [...new Set(hit.map((m) => m.reportVersionId))] });
    await record(ctx, op, 'rejected');
    return { entityId: resultId, outcome: 'rejected' as const, errorCode: 'sync.verification_policy_failed' };
  }
  /** an accepted sign off may complete the offline prints waiting on this result */
  async function accepted(ctx: HandlerContext, op: SyncOp) {
    await record(ctx, op, 'accepted');
    for (const m of await signoffs.markersForResult(ctx, op.entityId!)) await settleMarker(ctx, { readResult, signoffs, alerts }, m);
    return { entityId: op.entityId! };
  }

  return {
    opType: 'result.verify', permission: 'lab.result.verify',
    validate(payload) {
      payloadShape('lab.yaml', 'VerifyResultRequest')(payload);
      const f = (payload as Record<string, unknown>)['acknowledged_flags'];
      if (f !== undefined && (!Array.isArray(f) || f.some((x) => typeof x !== 'string' || !FLAGS.includes(x)))) throw new LimsError('common.validation_failed');
    },
    async execute(ctx, op) {
      const resultId = op.entityId!;
      const s = await readResult(ctx, resultId);
      if (!s) throw new LimsError('common.not_found');
      if (Number(s.version) !== op.baseVersion) return policyFailed(ctx, op, 'common.version_conflict');   // superseded since the device signed
      const flags = op.payload['acknowledged_flags'] as string[] | undefined;
      const item = { resultId, version: op.baseVersion!, ...(flags === undefined ? {} : { acknowledgedFlags: flags }) };
      let refusal: string | undefined;
      try {
        await ctx.db.tx!(async (cx) => verifyResult(authed(cx), item));
        return accepted(ctx, op);
      } catch (e) {
        refusal = codeOf(e);
        if (refusal === undefined || (!POLICY.has(refusal) && refusal !== 'lab.pathologist_required')) throw e;
      }
      if (refusal === 'lab.pathologist_required') {
        if (!(await isPathologist(ctx))) return policyFailed(ctx, op, refusal);   // wrong role for the final sign off
        if (!(await offlineApprovalAllowed(ctx))) throw new LimsError('sync.offline_not_allowed' as never);
        await ctx.db.tx!(async (cx) => approveResult(authed(cx), { resultId, version: op.baseVersion! }));
        // [CR .orchestra/cr/T0B-SYNC-4.nonblocking.md] no approve access action exists; lab_result.view is the nearest registered one
        await (ctx as any).audit.access({ action: 'lab_result.view', entityType: 'result', entityId: resultId, outcome: 'allowed',
          detail: { event: 'offline_approval', op_id: op.opId, device_created_at: op.deviceCreatedAt } });
        return accepted(ctx, op);
      }
      return policyFailed(ctx, op, refusal);
    },
  };
}

export const resultVerifyAdapter: SyncAdapter = createResultVerifyAdapter();
