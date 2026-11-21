// T0B-SYNC-1 (LD-322 decision 1, design section 4): number blocks for offline devices, lab codes and patient ids ONLY (bill, invoice and
// receipt numbers stay gap free: provisional offline number, final number at sync). A block is carved from the per tenant counter of the
// ONLINE allocator (lab.barcode_counters; frontdesk.number_counters kind patient_code, scope '') by advancing it under its row lock inside
// the request transaction, so blocks never overlap each other or an online number; core.number_block__no_overlap is the database safety net.
import { LimsError } from '../errors.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertUsable, guard, ownDevice, type SyncCtx } from './devices.service.js';
import { SERIES, UUID, invalid, objectWith, toNumberBlock, uuidOf } from './mappers.js';
import * as repo from './repository.js';

export async function reserveBlock(ctx: SyncCtx, body: unknown, maxBlockSize: number) {
  const w = await guard(ctx, 'sync.use');
  const b = objectWith(body, ['device_id', 'series', 'centre_id', 'size']);   // the caller never chooses the range, the tenant or the user
  const deviceId = uuidOf(b.device_id, '/device_id');
  if (typeof b.series !== 'string') throw invalid('/series', b.series === undefined ? 'common.field_required' : 'common.field_invalid');
  if (!SERIES.includes(b.series)) throw new LimsError('sync.series_unknown');
  const series = b.series as 'lab_code' | 'patient_id';
  const size = b.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) throw invalid('/size');
  if (size > maxBlockSize) throw new LimsError('sync.block_size_too_large');
  const centreId = b.centre_id === undefined ? undefined : uuidOf(b.centre_id, '/centre_id');
  // FOR SHARE: a concurrent revoke or wipe request waits for this reservation (or this one sees its result)
  assertUsable(await ownDevice(w, deviceId, 'share'));
  if (centreId && !(await repo.centreExists(w.tx, w.tenantId, centreId))) throw invalid('/centre_id');   // reserveNumberBlock declares no 404
  const last = await repo.advanceCounter(w.tx, w.tenantId, series, size, w.actorId);
  const row = await repo.insertBlock(w.tx, {
    tenantId: w.tenantId, id: uuidv7(), deviceId, series, ...(centreId ? { centreId } : {}), from: last - size + 1, to: last, at: ctx.now(), actorId: w.actorId,
  });
  const remaining = await repo.remainingSize(w.tx, w.tenantId, deviceId, series);
  ctx.log?.info({ event: 'sync_block_reserved', block_id: row.id, series, size });
  return { block: toNumberBlock(row), remaining_size: remaining };
}

/** T0B-SYNC-3 (design section 4): a patient id or lab code used offline must lie in a block of THIS device for its series, else
 *  sync.number_out_of_block. Validation only: the wrapped service still allocates its own numbers (open point in the impl note). */
export async function assertReservedInDeviceBlocks(ctx: { tenantId: string; tx: unknown }, op: { deviceId: string; reservedNumbers?: { patientId?: number; labCodes?: number[] } }): Promise<void> {
  const r = op.reservedNumbers;
  if (!r) return;
  const tx = ctx.tx as repo.Tx;
  const base = { tenantId: ctx.tenantId, deviceId: op.deviceId };
  if (r.patientId !== undefined && !(await repo.inDeviceBlocks(tx, { ...base, series: 'patient_id', values: [r.patientId] }))) throw new LimsError('sync.number_out_of_block');
  if (r.labCodes?.length && !(await repo.inDeviceBlocks(tx, { ...base, series: 'lab_code', values: r.labCodes }))) throw new LimsError('sync.number_out_of_block');
}

/** Unused numbers of a block are reported skipped (a gap is allowed for these series); the block is then closed and drops out of
 *  remaining_size. No contract operation yet (part 1): the sync batch of T0B-SYNC-2 calls it. Repeating the same report is a no-op. */
export async function reportBlockSkipped(ctx: SyncCtx, input: { blockId: unknown; skippedCount: unknown }) {
  const w = await guard(ctx, 'sync.use');
  const n = input?.skippedCount;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw invalid('/skippedCount');
  const id = input?.blockId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
  const row = await repo.lockBlock(w.tx, w.tenantId, id.toLowerCase());
  if (!row) throw new LimsError('common.not_found');
  if (String(row.device_user_id).toLowerCase() !== w.actorId) throw new LimsError('auth.forbidden');
  if (n > Number(row.to_value) - Number(row.from_value) + 1) throw invalid('/skippedCount');
  if (row.exhausted_at) {
    if (Number(row.skipped_count) === n) return toNumberBlock(row);
    throw invalid('/skippedCount');   // a closed block keeps its first report
  }
  return toNumberBlock(await repo.closeBlock(w.tx, { tenantId: w.tenantId, id: row.id, skipped: n, at: ctx.now(), actorId: w.actorId }));
}
