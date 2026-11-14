// C13 T10 review item 1 — the port call must run in a REAL savepoint with the production worker JobContext.
// consumer.ts:58 gives every task `db: { tx: (fn) => fn(ctx) }` (no SAVEPOINT / ROLLBACK TO), so the task wrapper must supply the savepoint itself
// (precedent: smartreport/tasks/prebuild_summary.ts withSavepoint). 02-TRD §8.1, 03-APP-FLOW §4.2 step 5, 08 A19 P-44.
// Here ctx.db is the production shape and ctx.tx records every statement; SAVEPOINT statements are recorded only (the in-memory world has no savepoints),
// so the assertions are on the SQL ORDER: SAVEPOINT -> (C4 writes, throws) -> ROLLBACK TO SAVEPOINT -> UPDATE ... conversion_failed.
import { describe, expect, it } from 'vitest';
import { makeFrontdesk, makeJobCtx, makeWorld10, markerPort, release, STAFF_ID, T_A, USERS, type Row } from '../../../../../api/src/modules/partners/__tests__/conversion.world.js';
import { convertManifestLine } from '../tasks/partners.convert_manifest_line.js';

const SP = /^\s*SAVEPOINT\s+(\w+)/i;
const RELEASE = /^\s*RELEASE\s+(?:SAVEPOINT\s+)?(\w+)/i;
const ROLLBACK = /^\s*ROLLBACK\s+TO\s+(?:SAVEPOINT\s+)?(\w+)/i;
const FAILED = /^\s*UPDATE\s+partners\.manifest_lines\b[\s\S]*conversion_failed/i;

function run(port: (fd: ReturnType<typeof makeFrontdesk>) => unknown, fail?: string | Error) {
  const w = makeWorld10(); const fd = makeFrontdesk();
  const m = w.mkManifest({ state: 'partially_received', version: 5, line_count: 1, submitted_by: USERS.x1.actor });
  const l = w.mkLine(m['id'], { state: 'converting', conversion_attempt: 1, sample_received_at: new Date('2026-11-12T10:00:00Z'), received_by: STAFF_ID, partner_sample_ref: 'SYN-1' });
  if (typeof fail === 'string') fd.failNext('createOrderFromBooking', fail);
  const jc = makeJobCtx(w, { port: port(fd) }); const ctx: any = jc.ctx;
  const sql: string[] = []; const base = ctx.tx;
  const rec: any = Object.create(base); rec.inner = base.inner;
  rec.query = async (text: string, vals?: unknown[]) => {
    sql.push(text);
    if (SP.test(text) || RELEASE.test(text) || ROLLBACK.test(text)) return { rows: [], rowCount: 0 };
    return base.query(text, vals);
  };
  ctx.tx = rec;
  ctx.db = { tx: (fn: (c: unknown) => Promise<unknown>) => fn(ctx) };            // exactly services/worker/src/core/consumer.ts:58
  const go = async () => { try { await convertManifestLine({ tenant_id: T_A, line_id: l['id'], attempt: 1 }, ctx); return undefined; } catch (e) { return e as any; } finally { release(ctx); } };
  return { w, l, sql, go, line: (): Row => w.lines.find((x) => x['id'] === l['id'])! };
}
const at = (sql: string[], re: RegExp) => sql.findIndex((s) => re.test(s));

describe('T10 worker task: port call in a real savepoint under the production JobContext (db.tx = fn(ctx))', () => {
  it('business failure: SAVEPOINT before C4 writes, ROLLBACK TO that savepoint before the conversion_failed UPDATE; the task resolves', async () => {
    const r = run((fd) => markerPort(fd), 'frontdesk.patient_duplicate_suspected');
    expect(await r.go()).toBeUndefined();
    const sp = at(r.sql, SP); const marker = at(r.sql, /fake_c4\.markers/i); const rb = at(r.sql, ROLLBACK); const failed = r.sql.findIndex((s) => FAILED.test(s));
    expect(sp, 'SAVEPOINT issued').toBeGreaterThan(-1);
    expect(marker, 'C4 marker write went through ctx.tx inside the savepoint').toBeGreaterThan(sp);
    expect(rb, 'ROLLBACK TO SAVEPOINT issued after the port threw').toBeGreaterThan(marker);
    expect(failed, 'UPDATE ... conversion_failed after the rollback').toBeGreaterThan(rb);
    expect(r.sql[rb]!.match(ROLLBACK)![1]).toBe(r.sql[sp]!.match(SP)![1]);        // same savepoint name
    expect(r.line()).toMatchObject({ state: 'conversion_failed', failure_code: 'frontdesk.patient_duplicate_suspected' });
  });
  it('infra failure: SAVEPOINT + ROLLBACK TO, the original error is rethrown, no conversion_failed UPDATE', async () => {
    const r = run((fd) => markerPort(fd), 'common.dependency_unavailable');
    const e = await r.go(); expect(e?.code).toBe('common.dependency_unavailable');
    const sp = at(r.sql, SP); expect(sp).toBeGreaterThan(-1); expect(at(r.sql, ROLLBACK)).toBeGreaterThan(sp);
    expect(r.sql.some((s) => FAILED.test(s))).toBe(false);
  });
  it('success: SAVEPOINT then RELEASE, never a ROLLBACK TO; line converted', async () => {
    const r = run((fd) => markerPort(fd));
    expect(await r.go()).toBeUndefined();
    const sp = at(r.sql, SP); expect(sp).toBeGreaterThan(-1); expect(at(r.sql, RELEASE)).toBeGreaterThan(sp); expect(at(r.sql, ROLLBACK)).toBe(-1);
    expect(r.line()).toMatchObject({ state: 'converted' }); expect(r.line()['order_id']).toBeTruthy();
  });
  it('no savepoint is opened when nothing calls the port (stale attempt -> no-op)', async () => {
    const r = run((fd) => markerPort(fd)); r.line()['conversion_attempt'] = 2;
    expect(await r.go()).toBeUndefined(); expect(at(r.sql, SP)).toBe(-1);
  });
});
