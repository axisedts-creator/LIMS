// T0B-SYNC-3 (LD-322, LD-325 b; design C:/LIMS-state/offline-design-20261117.md sections 3 and 8): shared part of the two specimen move
// adapters (collection.mark_collected, accession.receive). The move itself is the online SERVICE LAYER function (specimen.service.js,
// passed in by the adapter), run as the signed in user on the operation's SAVEPOINT with If-Match "<base_version>", so its permission,
// transition table, validation and audit events apply unchanged. Here only the offline classification of the CURRENT specimen state:
//   from state + current version  -> run the move
//   from state + other version    -> CONFLICT sync.base_version_stale (another device edited it)
//   already there or further      -> duplicate, no change (idempotent state move)
//   contradicted (rejected, recollection ordered, discarded, or never reached the from state) -> CONFLICT lab.specimen_invalid_transition
import type { HandlerContext } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { assertReservedInDeviceBlocks } from '../../../core/sync/blocks.service.js';
import { SyncConflictError, auditSyncApplied, payloadShape, type SyncAdapter, type SyncOp } from '../../../core/sync/engine.js';
import { scopeOf, visible } from '../service/specimen.service.js';

export type ReadSpecimen = (ctx: HandlerContext, specimenId: string) => Promise<{ status: string; version: number } | undefined>;
/** Default seam: the tenant row (SQL of the adapter) filtered by the SAME centre scope as the online service (review item 1, REQ-SEC-017,
 *  T-32: a foreign specimen is common.not_found BEFORE any classification, so its state never leaks as duplicate / conflict). */
export const scopedRead = (sql: string): ReadSpecimen => async (ctx, id) => {
  const row = (await (ctx as any).tx.query(sql, [ctx.tenantId, id])).rows[0];
  return row && visible(await scopeOf(ctx as never), row) ? { status: row.status, version: Number(row.version) } : undefined;
};
type Move = (c: unknown, params: unknown, headers: unknown, body: unknown) => Promise<unknown>;

/** The forward path of a specimen (specimen.state.ts S2..S10, S13): a later position means the move already happened. */
const PATH = ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored'];

export function specimenMoveAdapter(a: {
  opType: string; permission: string; schema: string; from: readonly string[]; to: string; move: Move; readSpecimen: ReadSpecimen;
  body(op: SyncOp): Record<string, unknown>; audit?: boolean;
}): SyncAdapter {
  const target = PATH.indexOf(a.to);
  return {
    opType: a.opType, permission: a.permission,
    validate: payloadShape('lab.yaml', a.schema),
    async execute(ctx, op) {
      const id = op.entityId!;
      await assertReservedInDeviceBlocks(ctx as never, op);
      const s = await a.readSpecimen(ctx, id);
      if (!s) throw new LimsError('common.not_found');
      const now = { status: s.status, version: Number(s.version) };
      if (a.from.includes(s.status)) {
        if (now.version !== op.baseVersion) throw new SyncConflictError({ entityType: 'specimen', entityId: id, serverPayload: now, errorCode: 'sync.base_version_stale' });
        await a.move(ctx, { specimen_id: id }, { 'if-match': `"${op.baseVersion}"` }, a.body(op));
        if (a.audit) await auditSyncApplied(ctx, 'specimen', id, op); // no captured time field on this move (done_when 1)
        return { entityId: id };
      }
      if (PATH.indexOf(s.status) >= target) return { entityId: id, outcome: 'duplicate' };
      throw new SyncConflictError({ entityType: 'specimen', entityId: id, serverPayload: now, errorCode: 'lab.specimen_invalid_transition' });
    },
  };
}
