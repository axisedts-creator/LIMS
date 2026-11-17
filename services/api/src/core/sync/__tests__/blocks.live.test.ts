// T0B-SYNC-1 done_when (3) BLOCKS: reserveNumberBlock takes the next range from the per tenant counter inside one transaction with a row lock; blocks never overlap; size above
// the maximum is refused; unused numbers can be reported skipped; lab code and patient id series only (bill, invoice and receipt numbers are never blocks, design section 4).
// Live PG17. Pinned (see .orchestra/notes/T0B-SYNC-1-tests.md):
//  - lab_code is carved from lab.barcode_counters (per tenant), patient_id from frontdesk.number_counters (counter_kind patient_code, scope ''): the counter is advanced BY the
//    block size, block = [last_value + 1 .. last_value + size], so an online allocation after the block can never repeat a number of the block.
//  - maximum block size: default 1000 for both series, setting `maxBlockSize` (createSyncHandlers({ settings })); above it: sync.block_size_too_large (422), nothing moves.
//  - a series other than lab_code / patient_id (bill, invoice, receipt, anything) -> sync.series_unknown (422), nothing moves.
//  - a centre_id that is not a centre of the tenant -> common.validation_failed (reserveNumberBlock declares no common.not_found / 404).
//  - skipped numbers: services/api/src/core/sync/blocks.service.ts exports reportBlockSkipped(ctx, { blockId, skippedCount }) (no contract operation exists for it in part 1):
//    only the owner of the block's device; 0 <= skippedCount <= size else common.validation_failed; sets skipped_count and closes the block (exhausted_at = now);
//    a closed block no longer counts in remaining_size; repeating the same report is a no-op; unknown / other tenant block -> common.not_found.
import { describe, expect, it } from 'vitest';
import { reportBlockSkipped } from '../blocks.service.js';
import { A1, A2, AADM, B1, TENANT_A, TENANT_B, USER, CENTRE, codeOf, counter, createSyncHandlers, fire, newDevice, ok, ownerRows, req, reserve, revoke, setCounters, uid, wipe, withCtx } from './helpers.js';

const T = 120_000;
const blockRow = async (id: string) => (await ownerRows('SELECT * FROM core.number_block WHERE id = $1', [id]))[0];
const blocksOf = (tenant: string, series: string) => ownerRows('SELECT id, from_value, to_value FROM core.number_block WHERE tenant_id = $1 AND series = $2 ORDER BY from_value', [tenant, series]);
const BLOCK_KEYS = ['id', 'device_id', 'series', 'centre_id', 'from_value', 'to_value', 'issued_at', 'exhausted_at', 'skipped_count'];

describe('reserveNumberBlock: the range comes from the per tenant counter', () => {
  it('lab codes: counter 5000 + block of 200 -> [5001..5200], 201, counter now 5200, remaining 200, response keys only from the NumberBlock schema', async () => {
    await setCounters(TENANT_A, { lab: 5000 });
    const dev = await newDevice(A1);
    const r = await reserve(A1, dev, 'lab_code', 200);
    expect(r.reply!.status).toBe(201);
    const { block, remaining_size } = r.reply!.body;
    expect(block).toMatchObject({ device_id: dev, series: 'lab_code', from_value: 5001, to_value: 5200, skipped_count: 0 });
    expect(remaining_size).toBe(200);
    for (const k of Object.keys(block)) expect(BLOCK_KEYS, k).toContain(k);
    expect(Object.keys(r.reply!.body).sort()).toEqual(['block', 'remaining_size']);
    expect(await counter(TENANT_A, 'lab_code')).toBe(5200);
    const row = await blockRow(block.id);
    expect(row).toMatchObject({ tenant_id: TENANT_A, device_id: dev, series: 'lab_code' });
    expect(Number(row.from_value)).toBe(5001); expect(Number(row.to_value)).toBe(5200);
    expect(row.created_by).toBe(USER.a1);
  }, T);

  it('patient ids: carved from the patient_code counter of the tenant; the two series use separate counters', async () => {
    await setCounters(TENANT_A, { lab: 100, patient: 7000 });
    const dev = await newDevice(A1);
    const p = ok(await reserve(A1, dev, 'patient_id', 100));
    expect(p.block).toMatchObject({ from_value: 7001, to_value: 7100, series: 'patient_id' });
    expect(await counter(TENANT_A, 'patient_id')).toBe(7100);
    expect(await counter(TENANT_A, 'lab_code')).toBe(100);
    const l = ok(await reserve(A1, dev, 'lab_code', 10));
    expect(l.block).toMatchObject({ from_value: 101, to_value: 110 });
    expect(await counter(TENANT_A, 'patient_id')).toBe(7100);
  }, T);

  it('consecutive blocks are gap free and never overlap; an ONLINE allocation after a block gets a number above the block (no repeat)', async () => {
    await setCounters(TENANT_A, { lab: 0 });
    const d1 = await newDevice(A1), d2 = await newDevice(A2);
    const b1 = ok(await reserve(A1, d1, 'lab_code', 50)).block, b2 = ok(await reserve(A2, d2, 'lab_code', 30)).block;
    expect([b1.from_value, b1.to_value, b2.from_value, b2.to_value]).toEqual([1, 50, 51, 80]);
    const online = await ownerRows('UPDATE lab.barcode_counters SET last_value = last_value + 1 WHERE tenant_id = $1 RETURNING last_value', [TENANT_A]);
    expect(Number(online[0].last_value)).toBe(81);
  }, T);

  it('a counter that does not exist yet starts at 1 (first block [1..size])', async () => {
    await ownerRows('DELETE FROM frontdesk.number_counters WHERE tenant_id = $1 AND counter_kind = $2', [TENANT_B, 'patient_code']);
    const dev = await newDevice(B1);
    expect(ok(await reserve(B1, dev, 'patient_id', 25)).block).toMatchObject({ from_value: 1, to_value: 25 });
  }, T);

  it('tenants have independent counters: a block of tenant B does not move tenant A and starts at B\'s own counter', async () => {
    await setCounters(TENANT_A, { lab: 900 }); await setCounters(TENANT_B, { lab: 40 });
    const db = await newDevice(B1);
    expect(ok(await reserve(B1, db, 'lab_code', 10)).block).toMatchObject({ from_value: 41, to_value: 50 });
    expect(await counter(TENANT_A, 'lab_code')).toBe(900);
    expect(await counter(TENANT_B, 'lab_code')).toBe(50);
    expect((await blocksOf(TENANT_B, 'lab_code')).map((b) => Number(b.to_value)).pop()).toBe(50);
  }, T);

  it('a centre of the tenant may be named and is stored; a centre of another tenant is common.validation_failed and moves nothing', async () => {
    await setCounters(TENANT_A, { patient: 10 });
    const dev = await newDevice(A1);
    const b = ok(await reserve(A1, dev, 'patient_id', 5, { centre_id: CENTRE.a1 })).block;
    expect(b.centre_id).toBe(CENTRE.a1);
    const before = await counter(TENANT_A, 'patient_id');
    expect(codeOf(await reserve(A1, dev, 'patient_id', 5, { centre_id: CENTRE.b1 }))).toBe('common.validation_failed');
    expect(await counter(TENANT_A, 'patient_id')).toBe(before);
  }, T);
});

describe('reserveNumberBlock: refusals leave the counter and the table untouched', () => {
  const untouched = async (tenant: string, fn: () => Promise<unknown>) => {
    const [l, p, n] = [await counter(tenant, 'lab_code'), await counter(tenant, 'patient_id'), (await ownerRows('SELECT count(*)::int AS n FROM core.number_block WHERE tenant_id = $1', [tenant]))[0].n];
    await fn();
    expect([await counter(tenant, 'lab_code'), await counter(tenant, 'patient_id'), (await ownerRows('SELECT count(*)::int AS n FROM core.number_block WHERE tenant_id = $1', [tenant]))[0].n]).toEqual([l, p, n]);
  };

  it('size above the maximum (default 1000) -> sync.block_size_too_large (422); the maximum itself is allowed', async () => {
    await setCounters(TENANT_A, { lab: 0 });
    const dev = await newDevice(A1);
    await untouched(TENANT_A, async () => { expect(codeOf(await reserve(A1, dev, 'lab_code', 1001))).toBe('sync.block_size_too_large'); });
    expect(ok(await reserve(A1, dev, 'lab_code', 1000)).block).toMatchObject({ from_value: 1, to_value: 1000 });
  }, T);

  it('the maximum is a setting: maxBlockSize 50 refuses 51 and allows 50, for both series', async () => {
    const handlers = createSyncHandlers({ settings: { maxBlockSize: 50 } });
    const dev = await newDevice(A1);
    await untouched(TENANT_A, async () => {
      expect(codeOf(await reserve(A1, dev, 'lab_code', 51, {}, { handlers }))).toBe('sync.block_size_too_large');
      expect(codeOf(await reserve(A1, dev, 'patient_id', 51, {}, { handlers }))).toBe('sync.block_size_too_large');
    });
    const lab = ok(await reserve(A1, dev, 'lab_code', 50, {}, { handlers })).block, pat = ok(await reserve(A1, dev, 'patient_id', 50, {}, { handlers })).block;
    expect([lab.to_value - lab.from_value + 1, pat.to_value - pat.from_value + 1]).toEqual([50, 50]);
  }, T);

  it.each(['bill', 'invoice', 'receipt', 'bill_no', 'registration_no', '', 'LAB_CODE'])('series %j is never a block: sync.series_unknown (422)', async (series) => {
    const dev = await newDevice(A1);
    await untouched(TENANT_A, async () => { expect(codeOf(await reserve(A1, dev, series as never, 10))).toBe('sync.series_unknown'); });
  }, T);

  it.each([0, -5, 1.5, '10', null])('size %j -> common.validation_failed', async (size) => {
    const dev = await newDevice(A1);
    await untouched(TENANT_A, async () => { expect(codeOf(await fire('reserveNumberBlock', req({ body: { device_id: dev, series: 'lab_code', size } }), A1))).toBe('common.validation_failed'); });
  }, T);

  it('unknown device, another user\'s device, another tenant\'s device -> sync.device_unknown; revoked -> sync.device_revoked; wipe pending -> sync.wipe_required', async () => {
    const other = await newDevice(A2), foreign = await newDevice(B1), r = await newDevice(A1), w = await newDevice(A1);
    ok(await revoke(AADM, r)); ok(await wipe(AADM, w));
    await untouched(TENANT_A, async () => {
      for (const id of [uid(), other, foreign]) expect(codeOf(await reserve(A1, id, 'lab_code', 10)), id).toBe('sync.device_unknown');
      expect(codeOf(await reserve(A1, r, 'lab_code', 10))).toBe('sync.device_revoked');
      expect(codeOf(await reserve(A1, w, 'lab_code', 10))).toBe('sync.wipe_required');
    });
  }, T);

  it('an unknown body field (user_id, tenant_id, from_value) is refused: the caller never chooses the range or the tenant', async () => {
    const dev = await newDevice(A1);
    for (const extra of [{ from_value: 1 }, { tenant_id: TENANT_B }, { user_id: USER.a2 }]) {
      expect(codeOf(await fire('reserveNumberBlock', req({ body: { device_id: dev, series: 'lab_code', size: 5, ...extra } }), A1))).toBe('common.validation_failed');
    }
  }, T);
});

describe('remaining_size, skipped numbers, audit, logs', () => {
  it('remaining_size = unused numbers the device holds in that series, this block included: 200 then 100 -> 300; other series and other devices are separate', async () => {
    const dev = await newDevice(A1), other = await newDevice(A2);
    expect(ok(await reserve(A1, dev, 'lab_code', 200)).remaining_size).toBe(200);
    expect(ok(await reserve(A1, dev, 'lab_code', 100)).remaining_size).toBe(300);
    expect(ok(await reserve(A1, dev, 'patient_id', 40)).remaining_size).toBe(40);
    expect(ok(await reserve(A2, other, 'lab_code', 20)).remaining_size).toBe(20);
  }, T);

  it('reportBlockSkipped: records skipped_count, closes the block, and a closed block drops out of remaining_size', async () => {
    const dev = await newDevice(A1);
    const b1 = ok(await reserve(A1, dev, 'lab_code', 200)).block;
    const out = await withCtx(A1, (ctx) => reportBlockSkipped(ctx, { blockId: b1.id, skippedCount: 30 }), { now: new Date('2026-11-17T08:00:00.000Z') });
    expect(out.error).toBeUndefined();
    expect(out.reply).toMatchObject({ id: b1.id, skipped_count: 30 });
    const row = await blockRow(b1.id);
    expect(row.skipped_count).toBe(30); expect(new Date(row.exhausted_at).getTime()).toBe(new Date('2026-11-17T08:00:00.000Z').getTime());
    expect(ok(await reserve(A1, dev, 'lab_code', 10)).remaining_size).toBe(10);
  }, T);

  it('reportBlockSkipped: same value again is a no-op; a count above the block size, a negative or a fractional count -> common.validation_failed', async () => {
    const dev = await newDevice(A1);
    const b = ok(await reserve(A1, dev, 'patient_id', 20)).block;
    expect((await withCtx(A1, (c) => reportBlockSkipped(c, { blockId: b.id, skippedCount: 5 }))).error).toBeUndefined();
    const v = (await blockRow(b.id)).version;
    expect((await withCtx(A1, (c) => reportBlockSkipped(c, { blockId: b.id, skippedCount: 5 }))).error).toBeUndefined();
    expect((await blockRow(b.id)).version).toBe(v);
    for (const n of [21, -1, 2.5]) expect(codeOf(await withCtx(A1, (c) => reportBlockSkipped(c, { blockId: b.id, skippedCount: n }))), String(n)).toBe('common.validation_failed');
    expect((await blockRow(b.id)).skipped_count).toBe(5);
  }, T);

  it('reportBlockSkipped: only the owner of the block\'s device; another user -> auth.forbidden; unknown block and another tenant\'s block -> common.not_found', async () => {
    const dev = await newDevice(A1); const b = ok(await reserve(A1, dev, 'lab_code', 10)).block;
    expect(codeOf(await withCtx(A2, (c) => reportBlockSkipped(c, { blockId: b.id, skippedCount: 1 })))).toBe('auth.forbidden');
    expect(codeOf(await withCtx(B1, (c) => reportBlockSkipped(c, { blockId: b.id, skippedCount: 1 })))).toBe('common.not_found');
    expect(codeOf(await withCtx(A1, (c) => reportBlockSkipped(c, { blockId: uid(), skippedCount: 1 })))).toBe('common.not_found');
    expect((await blockRow(b.id)).skipped_count).toBe(0);
  }, T);

  it('every block write is audited: INSERT on reserve (actor, tenant, request id), UPDATE with skipped_count on report', async () => {
    const dev = await newDevice(A1); const requestId = uid();
    const b = ok(await reserve(A1, dev, 'lab_code', 10, {}, { requestId })).block;
    await withCtx(A1, (c) => reportBlockSkipped(c, { blockId: b.id, skippedCount: 2 }));
    const rows = await ownerRows(`SELECT action, changed_columns, actor_id, request_id, tenant_id FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'number_block' AND row_id = $1 ORDER BY occurred_at, id`, [b.id]);
    expect(rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE']);
    expect(rows[0]).toMatchObject({ actor_id: USER.a1, tenant_id: TENANT_A, request_id: requestId });
    expect(rows[1].changed_columns).toContain('skipped_count');
  }, T);

  it('no personal data in logs', async () => {
    const dev = await newDevice(A1, { device_label: 'Sita Rai tablet (SYNTHETIC)' });
    const o = await reserve(A1, dev, 'lab_code', 5);
    for (const l of o.logs) expect(l).not.toMatch(/Sita Rai|device_label/);
  }, T);
});
