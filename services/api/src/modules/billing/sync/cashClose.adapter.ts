// T0B-SYNC-4 done_when (4), (5) (LD-322, LD-325 b; design C:/LIMS-state/offline-design-20261117.md sections 3 and 8): offline adapter of
// daily_cash.close = closeCashSession (billing.payment.record), entity_id = cash_session_id, base_version = the If-Match version. Calls the SAME
// service the online handler calls (ledger.handlers.ts), mapped the same way, as the signed in cashier on the operation's SAVEPOINT: the service
// owns the own session rule, the variance, the deposit limit and the carry forward into the next session (the online rule). Here only the
// offline classification of the CURRENT session state:
//   unknown / other tenant          -> common.not_found
//   tenant needs a step up to close -> rejected sync.offline_not_allowed (an offline device cannot give MFA)
//   closed by this membership       -> duplicate (idempotent per session = per cashier, centre and day)
//   closed by someone else          -> CONFLICT common.immutable_record (server state status and version only, never counted money)
//   open, other version             -> CONFLICT sync.base_version_stale
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import { SyncConflictError, payloadShape, type SyncAdapter } from '../../../core/sync/engine.js';
import { getCashSession } from '../repository/cashSessions.repo.js';
import { createCashService } from '../service/cash.service.js';

export type ReadSession = (ctx: HandlerContext, sessionId: string) => Promise<{ status: 'open' | 'closed'; version: number; closedByMembershipId?: string } | undefined>;

/** Default seam: billing.cash_sessions under RLS. Close is own session only, so a closed session was closed by its owner membership. */
export const readCashSession: ReadSession = async (ctx, id) => {
  const s = await getCashSession((ctx as any).tx, { tenantId: ctx.tenantId!, sessionId: id });
  if (!s) return undefined;
  const status = s['status'] === 'closed' ? 'closed' : 'open';
  return { status, version: Number(s['version']), ...(status === 'closed' ? { closedByMembershipId: String(s['membership_id']) } : {}) };
};

export function createDailyCashCloseAdapter(deps: { readSession?: ReadSession; closeNeedsStepUp?: (ctx: HandlerContext) => Promise<boolean> } = {}): SyncAdapter {
  const readSession = deps.readSession ?? readCashSession;
  // [CONV] no tenant setting names a step up for the day close yet (online closeCashSession needs none): default off
  const closeNeedsStepUp = deps.closeNeedsStepUp ?? (async () => false);
  return {
    opType: 'daily_cash.close', permission: 'billing.payment.record',
    validate: payloadShape('billing.yaml', 'CloseCashSessionRequest'),
    async execute(ctx, op) {
      const sessionId = op.entityId!;
      const s = await readSession(ctx, sessionId);
      if (!s) throw new LimsError('common.not_found');
      if (await closeNeedsStepUp(ctx)) throw new LimsError('sync.offline_not_allowed' as never);
      const server = { status: s.status, version: Number(s.version) };
      if (s.status === 'closed') {
        const me = (ctx as any).actor?.membershipId ?? (ctx as any).actor?.id;
        if (s.closedByMembershipId !== undefined && String(s.closedByMembershipId).toLowerCase() === String(me).toLowerCase()) return { entityId: sessionId, outcome: 'duplicate' };
        throw new SyncConflictError({ entityType: 'cash_session', entityId: sessionId, serverPayload: server, errorCode: 'common.immutable_record' });
      }
      if (server.version !== op.baseVersion) throw new SyncConflictError({ entityType: 'cash_session', entityId: sessionId, serverPayload: server, errorCode: 'sync.base_version_stale' });
      const b = op.payload;
      await createCashService().closeCashSession(ctx as never, {
        sessionId, expectedVersion: op.baseVersion, counted: b['counted'], ...(b['note'] === undefined ? {} : { note: b['note'] }),
        ...(Object.hasOwn(b, 'deposit_paisa') ? { deposit: b['deposit_paisa'] } : {}),
      });
      return { entityId: sessionId };
    },
  };
}

export const dailyCashCloseAdapter: SyncAdapter = createDailyCashCloseAdapter();
