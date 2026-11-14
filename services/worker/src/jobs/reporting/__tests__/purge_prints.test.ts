// C6-T16 — purge of prints: cron reporting.purge_ephemeral (`17 20 * * *`, per_tenant, 5 attempts; 02-TRD §9; 05-SCHEMA §2.14 / §6 retention "print_jobs + reporting-prints objects 24 h";
// policy print_jobs__*__tenant_expired = system actor AND expires_at < now(); object deletes are ctx.storage.delete (08 A13 P-12 (a))). Only the print_jobs part is asserted here.
// ASSUMED: manifest.tasks['reporting.purge_ephemeral'](payload {tenant_id}, ctx) with ctx.storage.delete(bucket, path); DELETE ... WHERE tenant_id = $1 AND expires_at < $2 (single table).
import { describe, expect, it } from 'vitest';
import { manifest } from '../index.js';
import { PID, PRINTS, REPORTS, TENANT_A, TENANT_B, idN, printJob, printWorld, releasedVersion, settle, type PrintWorld } from './print.helpers.js';

const PAST = '2026-11-07T11:00:00.000Z'; const FUTURE = '2026-11-08T11:00:00.000Z';       // fake NOW = 2026-11-07T12:00:30Z
const file = (i: number) => `${TENANT_A}/prints/${PID(i)}.pdf`;
const obj = (i: number): [string, Uint8Array] => [`${PRINTS}::${file(i)}`, new TextEncoder().encode(`%PDF-1.7 print ${i}`)];
const rowWithFile = (i: number, over: Record<string, unknown> = {}) => printJob(i, { state: 'ready', object_path: file(i), expires_at: PAST, ...over });
const purge = (w: PrintWorld, payload: Record<string, unknown> = { tenant_id: TENANT_A }, attempt = 1) => {
  const task = manifest.tasks['reporting.purge_ephemeral']; if (!task) throw Object.assign(new Error('purge_ephemeral missing'), { name: 'TaskLoadError' });
  return task(payload as any, w.ctx(attempt) as any);
};
const ids = (w: PrintWorld) => w.prints().map((p) => p['id']).sort();

describe('manifest', () => {
  it('reporting.purge_ephemeral is a task (5 attempts) and a per_tenant cron at 17 20 * * *', () => {
    expect(typeof manifest.tasks['reporting.purge_ephemeral']).toBe('function'); expect(manifest.maxAttempts?.['reporting.purge_ephemeral']).toBe(5);
    expect(manifest.crontab?.find((c) => c.identifier === 'reporting.purge_ephemeral')).toMatchObject({ schedule: '17 20 * * *', tenantScope: 'per_tenant', maxAttempts: 5 });
  });
});

describe('print_jobs retention (24 h)', () => {
  const world = (o: Parameters<typeof printWorld>[0] = {}) => printWorld({ versions: [releasedVersion(1)], ...o });
  it('deletes expired prints of the tenant (any state, with or without a file) and their objects; keeps unexpired ones and their objects', async () => {
    const w = world({ prints: [rowWithFile(1), rowWithFile(2, { state: 'rendering', object_path: null }), rowWithFile(3, { variant: 'letterhead', object_path: null }), rowWithFile(4, { state: 'failed', object_path: null, error_code: 'x.y' }),
      rowWithFile(5, { expires_at: FUTURE }), rowWithFile(6, { expires_at: FUTURE, state: 'rendering', object_path: null })], objects: Object.fromEntries([obj(1), obj(5)]) });
    expect(await settle(purge(w))).toBe('ok');
    expect(ids(w)).toEqual([PID(5), PID(6)].sort());
    expect(w.store.has(PRINTS, file(1))).toBe(false); expect(w.store.has(PRINTS, file(5))).toBe(true);
  });
  it('object deletes are exactly the expired rows\' own object_path in reporting-prints; the canonical report bucket is never touched (letterhead prints own no file)', async () => {
    const v = releasedVersion(1);
    const w = world({ prints: [rowWithFile(1), rowWithFile(3, { variant: 'letterhead', object_path: null })], objects: Object.fromEntries([obj(1)]) }); await purge(w);
    expect(w.store.deletes().map((d) => [d.bucket, d.path])).toEqual([[PRINTS, file(1)]]);
    expect(w.store.has(REPORTS, v['pdf_object_path'] as string)).toBe(true); expect(w.store.deletes().some((d) => d.bucket === REPORTS)).toBe(false);
  });
  it('another tenant\'s prints are never deleted (payload tenant only), even with RLS off; every statement names tenant_id', async () => {
    const w = world({ rls: false, prints: [rowWithFile(1), rowWithFile(2, { tenant_id: TENANT_B, object_path: `${TENANT_B}/prints/${PID(2)}.pdf` })],
      objects: { ...Object.fromEntries([obj(1)]), [`${PRINTS}::${TENANT_B}/prints/${PID(2)}.pdf`]: new Uint8Array([1]) } });
    await purge(w); expect(ids(w)).toEqual([PID(2)]); expect(w.store.has(PRINTS, `${TENANT_B}/prints/${PID(2)}.pdf`)).toBe(true);
    expect(w.db.stmts.filter((s) => s.verb === 'delete' || /print_jobs/.test(s.text)).every((s) => /\btenant_id\b/i.test(s.text))).toBe(true);
  });
  it('an object_path outside the tenant prefix is never deleted from storage', async () => {
    const w = world({ prints: [rowWithFile(1, { object_path: `${TENANT_B}/prints/${PID(1)}.pdf` })], objects: { [`${PRINTS}::${TENANT_B}/prints/${PID(1)}.pdf`]: new Uint8Array([1]) } });
    await settle(purge(w)); expect(w.store.deletes().filter((d) => d.path.startsWith(`${TENANT_B}/`))).toEqual([]);
  });
  it('a failing object delete keeps that row (the next run retries); the other expired rows are still purged', async () => {
    const w = world({ prints: [rowWithFile(1), rowWithFile(2)], objects: Object.fromEntries([obj(1), obj(2)]), storeOpts: { deleteFails: (p) => p === file(1) } });
    await settle(purge(w)); expect(ids(w)).toContain(PID(1)); expect(ids(w)).not.toContain(PID(2)); expect(w.store.has(PRINTS, file(1))).toBe(true);
  });
  it('an object that is already gone does not block the row delete (retry after a crash)', async () => {
    const w = world({ prints: [rowWithFile(1)], objects: {} }); w.store.delete = async (b: string, p: string) => { w.store.calls.push({ op: 'delete', bucket: b, path: p }); throw Object.assign(new Error('not found'), { code: 'common.not_found' }); };
    await settle(purge(w)); expect(ids(w)).toEqual([]);
  });
  it('is idempotent: a second run deletes nothing more and does not fail', async () => {
    const w = world({ prints: [rowWithFile(1), rowWithFile(5, { expires_at: FUTURE })], objects: Object.fromEntries([obj(1)]) }); await purge(w);
    const n = w.store.deletes().length; expect(await settle(purge(w))).toBe('ok'); expect(w.store.deletes()).toHaveLength(n); expect(ids(w)).toEqual([PID(5)]);
  });
  it('expiry is strict: a print expiring exactly now is kept, one millisecond earlier is purged', async () => {
    const w = world({ prints: [rowWithFile(1, { expires_at: '2026-11-07T12:00:30.000Z' }), rowWithFile(2, { expires_at: '2026-11-07T12:00:29.999Z' })], objects: Object.fromEntries([obj(1), obj(2)]) });
    await purge(w); expect(ids(w)).toEqual([PID(1)]);
  });
  it.each([[{ tenant_id: TENANT_B }], [{}], [{ tenant_id: 'x' }]])('bad / foreign payload %j: nothing deleted', async (payload) => {
    const w = world({ prints: [rowWithFile(1)], objects: Object.fromEntries([obj(1)]) }); await settle(purge(w, payload)); expect(ids(w)).toEqual([PID(1)]); expect(w.store.deletes()).toHaveLength(0);
  });
  it('purge never touches report versions or deliveries (history is kept)', async () => {
    const w = world({ prints: [rowWithFile(1)], objects: Object.fromEntries([obj(1)]) }); const before = JSON.stringify(w.versions()); await purge(w);
    expect(JSON.stringify(w.versions())).toBe(before); expect(w.db.stmts.filter((s) => s.verb === 'delete').every((s) => !/report_versions|deliveries|reports\b/.test(s.text))).toBe(true); expect(idN(1)).toBeTruthy();
  });
});
