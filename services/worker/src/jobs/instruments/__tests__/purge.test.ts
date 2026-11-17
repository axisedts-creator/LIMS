// API-T14 — instruments.purge_archive (02-TRD §10; AC-20.1, AC-20.2; 05-SCHEMA §5 purge function + §8 items 7, 9, 10; 07-SECURITY REQ-SEC-139, AB15).
// The row-level boundaries (younger rows kept, other tenants untouched, FORCE RLS, 364 raises) are proven by the DB suite db/tests/instruments (C7 check 16/17).
// Here: the worker passes the right number under the right claims, deletes Storage objects only when retention is valid, never bypasses the DEFINER.
import { describe, expect, it } from 'vitest';
import { manifest } from '../index.js';
import { T_A, T_B, SENTINEL, daysAgo, makeWorld, rejects, uid, type World } from './helpers.js';

const ID = 'instruments.purge_archive';
const BUCKET = 'instruments-attachments';                                    // 05-SCHEMA attachments__bucket__ck
const att = (n: number, ageDays: number, tenant = T_A, path?: string) => ({ id: uid(0xa000 + n), tenant_id: tenant, bucket: BUCKET, object_path: path ?? `${tenant}/att/${n}.pdf`, created_at: daysAgo(ageDays), message_id: uid(0xb000 + n) });
async function run(w: World, tenantId = T_A) { const ctx = w.makeCtx({ tenantId }); await manifest.tasks![ID]!({ tenant_id: tenantId }, ctx); return ctx; }
const marks = (w: World) => w.writes().filter((s) => /UPDATE\s+instruments\.attachments/i.test(s.text));

describe('AC-20.1 retention from IdentityPort, days = years x 366', () => {
  it.each([[1, 366], [2, 732], [5, 1830]])('rawInstrumentYears %i -> app.purge_instruments_archive(%i) exactly once, under the job tenant claims', async (years, days) => {
    const w = makeWorld(); w.tenantSettings.retention.rawInstrumentYears = years;
    await run(w);
    expect(w.purgeCalls).toEqual([{ days, tenant: T_A }]);
    expect(w.settingsCalls).toHaveLength(1);
    expect(w.settingsCalls[0].input?.keys).toEqual(expect.arrayContaining(['retention']));
    const call = w.stmts.find((s) => /purge_instruments_archive/.test(s.text))!;
    expect(call.claims).toMatchObject({ tenant_id: T_A, actor_type: 'system' });
  });

  it('two tenants with different settings: each call carries its own days and its own claims (one tenant per call)', async () => {
    const w = makeWorld();
    w.tenantSettings.retention.rawInstrumentYears = 1; await run(w, T_A);
    w.tenantSettings.retention.rawInstrumentYears = 3; await run(w, T_B);
    expect(w.purgeCalls).toEqual([{ days: 366, tenant: T_A }, { days: 1098, tenant: T_B }]);
  });

  it('per-table counts feed lims_instruments_archive_purged_rows_total{table} (label table only, no tenant/ids)', async () => {
    const w = makeWorld(); w.purgeRows.find((r) => r.table_name === 'messages')!.deleted = 12; w.purgeRows.find((r) => r.table_name === 'message_records')!.deleted = 40;
    await run(w);
    expect(w.metrics.total('lims_instruments_archive_purged_rows_total', { table: 'messages' })).toBe(12);
    expect(w.metrics.total('lims_instruments_archive_purged_rows_total', { table: 'message_records' })).toBe(40);
    for (const c of w.metrics.calls.filter((x) => x.name === 'lims_instruments_archive_purged_rows_total')) expect(Object.keys(c.labels)).toEqual(['table']);
  });

  it('Storage first: attachments older than the retention lose their object (ctx.storage.delete, owner bucket), are marked #deleted, THEN the function runs', async () => {
    const w = makeWorld(); w.attachments.push(att(1, 400), att(2, 500));
    const order: string[] = [];
    const ctx = w.makeCtx(); const del = ctx.storage.delete; ctx.storage.delete = async (b: string, p: string) => { order.push('storage'); await del(b, p); };
    const q = ctx.tx.query; ctx.tx.query = async (t: string, v: unknown[]) => { if (/UPDATE\s+instruments\.attachments/i.test(t)) order.push('mark'); if (/purge_instruments_archive/.test(t)) order.push('purge'); return q(t, v); };
    await manifest.tasks![ID]!({ tenant_id: T_A }, ctx);
    expect(w.storageDeleted).toEqual([{ bucket: BUCKET, path: `${T_A}/att/1.pdf` }, { bucket: BUCKET, path: `${T_A}/att/2.pdf` }]);
    expect(marks(w)).toHaveLength(2);
    expect(marks(w).every((s) => /#deleted/.test(`${s.text} ${JSON.stringify(s.values)}`))).toBe(true);
    expect(order.lastIndexOf('storage')).toBeLessThan(order.indexOf('purge'));
    expect(order.at(-1)).toBe('purge');
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('purge'));
  });

  it('attachments younger than the retention keep their object; already #deleted rows are not deleted again (a second run is a no-op for Storage)', async () => {
    const w = makeWorld(); w.attachments.push(att(1, 100), att(2, 500, T_A, `${T_A}/att/2.pdf#deleted`), att(3, 365 + 366));
    await run(w);
    expect(w.storageDeleted.map((d) => d.path)).toEqual([`${T_A}/att/3.pdf`]);
  });

  it('a Storage failure leaves that attachment unmarked (the DB row must wait) and does not mark the others wrongly', async () => {
    const w = makeWorld(); w.attachments.push(att(1, 400), att(2, 400)); w.storageFail.add(`${T_A}/att/1.pdf`);
    await run(w).catch(() => undefined);
    const marked = marks(w).map((s) => `${s.text} ${JSON.stringify(s.values)}`);
    expect(marked.some((m) => m.includes(`${T_A}/att/1.pdf`) || m.includes(uid(0xa001)))).toBe(false);
  });

  it('object paths are never logged (file/attachment identity stays out of logs)', async () => {
    const w = makeWorld(); w.attachments.push(att(1, 400, T_A, `${T_A}/${SENTINEL}.pdf`));
    await run(w);
    expect(w.logs.text()).not.toContain(SENTINEL);
  });
});

describe('AC-20.2 a retention below the floor deletes nothing', () => {
  it.each([[0], [0.5], [-1], [Number.NaN], [undefined], [null], ['1']])('rawInstrumentYears %s: the task rejects, no Storage object is deleted, nothing is marked', async (years) => {
    const w = makeWorld(); w.tenantSettings.retention.rawInstrumentYears = years; w.attachments.push(att(1, 9999));
    await rejects(run(w));
    expect(w.storageDeleted).toHaveLength(0);
    expect(marks(w)).toHaveLength(0);
    expect(w.purgeCalls.every((c) => typeof c.days === 'number' && c.days >= 365)).toBe(true);   // either never called, or only with a legal value
  });

  it('IdentityPort unavailable: reject, delete nothing', async () => {
    const w = makeWorld(); w.attachments.push(att(1, 9999));
    const ctx = w.makeCtx(); ctx.ports.IdentityPort.getTenantSettings = async () => { throw new Error('identity down'); };
    await rejects(manifest.tasks![ID]!({ tenant_id: T_A }, ctx));
    expect(w.storageDeleted).toHaveLength(0); expect(w.purgeCalls).toHaveLength(0);
  });

  it('the DEFINER refusing (raises) propagates and the task fails', async () => {
    const w = makeWorld(); const ctx = w.makeCtx();
    const q = ctx.tx.query; ctx.tx.query = async (t: string, v: unknown[]) => { if (/purge_instruments_archive/.test(t)) throw Object.assign(new Error('retention below 365 days'), { code: 'P0001' }); return q(t, v); };
    await rejects(manifest.tasks![ID]!({ tenant_id: T_A }, ctx));
  });
});

describe('no bypass of the inventoried function (REQ-SEC-019/020, AB15; 05-SCHEMA §8 items 9-10)', () => {
  it('the only deletion path is app.purge_instruments_archive: no DELETE, no app.maintenance, no row_security/role switch, no TRUNCATE/DROP', async () => {
    const w = makeWorld(); w.attachments.push(att(1, 400));
    await run(w);
    for (const s of w.stmts) {
      expect(s.text, s.text).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\b|app\.maintenance|row_security|SET\s+(LOCAL\s+)?ROLE|SET\s+SESSION\s+AUTHORIZATION|set_config/i);
    }
  });
  it('instruments.* statements other than the function bind the job tenant; none mentions another tenant', async () => {
    const w = makeWorld(); w.attachments.push(att(1, 400));
    await run(w);
    for (const s of w.stmts.filter((x) => /instruments\./i.test(x.text))) expect(s.text).toMatch(/tenant_id/);
    expect(w.stmts.some((s) => s.values.includes(T_B) || s.text.includes(T_B))).toBe(false);
  });
  it('a cron fire with a payload naming another tenant than the job claims cannot purge that other tenant (function called only under ctx tenant)', async () => {
    const w = makeWorld(); const ctx = w.makeCtx({ tenantId: T_A });
    await manifest.tasks![ID]!({ tenant_id: T_B }, ctx).catch(() => undefined);
    expect(w.purgeCalls.every((c) => c.tenant === T_A)).toBe(true);
    expect(w.stmts.some((s) => s.values.includes(T_B))).toBe(false);
  });
});
