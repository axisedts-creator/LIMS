// C2-T27 platform maintenance tasks (02-TRD §10 crontab; 05-SCHEMA §6 maintenance DEFINERs, §9; §11 tests 22/24/31/33; 08 A15.3, A17 P-18(c), A28.5; 07-SECURITY D-T19;
// AC-E4.4 requested > 24 h / unapproved ends the session, AC-E4.5 expired session is refused, AC-D4.5 export gone after 24 h or 3 downloads).
// A platform task ONLY calls its inventoried maintenance DEFINER (the DEFINER sets/resets app.maintenance, deletes the 1-year-old audit_exports rows, writes the A28.5 audit rows):
//   the task text must not hold DML, must not touch `app.maintenance` itself, and must run with platform system claims (no tenant_id).
// ASSUMED seams (spec silent): tasks/<id>.ts export <CONST> (the task id) + `<camel>: TaskHandler`:
//   purge_sessions -> PURGE_SESSIONS / purgeSessions (app.identity_purge_sessions), expire_support_sessions -> EXPIRE_SUPPORT_SESSIONS / expireSupportSessions,
//   expire_invitations -> EXPIRE_INVITATIONS / expireInvitations, purge_auth_events -> PURGE_AUTH_EVENTS / purgeAuthEvents, expire_audit_exports -> EXPIRE_AUDIT_EXPORTS / expireAuditExports.
//   The handler issues the DEFINER through ctx.tx.query (`SELECT … app.<fn>()`); expire_audit_exports reads `object_path` rows of `SELECT object_path FROM app.identity_expire_audit_exports()`
//   and deletes each object with ctx.storage.delete('identity-exports', path) (08 R26 bucket). A 'common.not_found' LimsError from storage.delete = already gone = success (the tx
//   is rolled back by any other failure, so a retry sees the same due rows again: idempotent).
import { describe, expect, it, vi } from 'vitest';
import { setup, systemActorOf } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { EXPIRE_AUDIT_EXPORTS, expireAuditExports } from '../tasks/expire_audit_exports.js';
import { EXPIRE_INVITATIONS, expireInvitations } from '../tasks/expire_invitations.js';
import { EXPIRE_SUPPORT_SESSIONS, expireSupportSessions } from '../tasks/expire_support_sessions.js';
import { PURGE_AUTH_EVENTS, purgeAuthEvents } from '../tasks/purge_auth_events.js';
import { PURGE_SESSIONS, purgeSessions } from '../tasks/purge_sessions.js';
import { LimsError, TENANT, ctx27, err, idN, makeTx } from './t27.helpers.js';

const BUCKET = 'identity-exports';
const FNS = [
  ['identity.purge_sessions', PURGE_SESSIONS, purgeSessions, 'identity_purge_sessions'],
  ['identity.expire_support_sessions', EXPIRE_SUPPORT_SESSIONS, expireSupportSessions, 'identity_expire_support_sessions'],
  ['identity.expire_invitations', EXPIRE_INVITATIONS, expireInvitations, 'identity_expire_invitations'],
  ['identity.purge_auth_events', PURGE_AUTH_EVENTS, purgeAuthEvents, 'identity_purge_auth_events'],
] as const;
const DML = /\b(insert\s+into|update\s+\w|delete\s+from|truncate|alter|drop|create)\b/i;

describe('task ids are the TRD §10 names', () => {
  it('constants', () => { expect([PURGE_SESSIONS, EXPIRE_SUPPORT_SESSIONS, EXPIRE_INVITATIONS, EXPIRE_AUDIT_EXPORTS, PURGE_AUTH_EVENTS]).toEqual(['identity.purge_sessions', 'identity.expire_support_sessions', 'identity.expire_invitations', 'identity.expire_audit_exports', 'identity.purge_auth_events']); });
});

describe.each(FNS)('%s (platform, one DEFINER call)', (id, _c, handler, fn) => {
  it(`calls app.${fn}() exactly once with no DML and never touches app.maintenance (D-T19, A15.3)`, async () => {
    const t = makeTx([(sql) => (new RegExp(`app\\.${fn}\\s*\\(\\s*\\)`).test(sql) ? [{ [fn]: 2 }] : undefined)]); const { ctx } = ctx27({ tx: t.tx });
    await handler({}, ctx);
    expect(t.sqls().filter((s) => new RegExp(`app\\.${fn}\\s*\\(\\s*\\)`).test(s))).toHaveLength(1);
    for (const s of t.sqls()) { expect(s).not.toMatch(DML); expect(s).not.toMatch(/app\.maintenance|set_config/i); }
  });
  it('a DEFINER failure propagates (queue retry / dead letter), it is never swallowed', async () => {
    const t = makeTx([], { match: new RegExp(`app\\.${fn}`), error: () => new LimsError('common.dependency_unavailable') }); const { ctx } = ctx27({ tx: t.tx });
    expect(await err(handler({}, ctx))).toBeDefined();
  });
  it('is repeatable: two consecutive runs both succeed (nothing due = the DEFINER returns 0)', async () => {
    const t = makeTx([(sql) => (/app\.identity_/.test(sql) ? [{ [fn]: 0 }] : undefined)]); const { ctx } = ctx27({ tx: t.tx });
    await handler({}, ctx); await handler({}, ctx);
  });
  it('through the real worker core: platform scope, claims = identity system actor with NO tenant_id, one transaction named after the task', async () => {
    const s = await setup([manifest]);
    await s.run(id, {}, { attempts: 1 });
    const tx = s.world.txLog.at(-1)!;
    expect(tx.claims0).toEqual({ sub: systemActorOf('identity'), actor_type: 'system' }); expect(tx.operation).toBe(id); expect(tx.outcome).toBe('commit');
    expect(tx.stmts.filter((x) => new RegExp(`app\\.${fn}\\s*\\(`).test(x.text))).toHaveLength(1);
  });
  it('a failing DEFINER through the core rolls the transaction back (no half-done maintenance)', async () => {
    const s = await setup([manifest]); s.world.failOn(new RegExp(`app\\.${fn}`), () => new LimsError('common.dependency_unavailable'));
    expect(await err(s.run(id, {}, { attempts: 1 }))).toBeDefined(); expect(s.world.txLog.at(-1)!.outcome).toBe('rollback');
  });
});

describe('identity.expire_audit_exports (P-18(c): DEFINER also deletes expired/failed rows > 1 year; AC-D4.5 objects deleted at expiry)', () => {
  const FN = /app\.identity_expire_audit_exports\s*\(\s*\)/;
  const paths = [`${TENANT}/2026/11/${idN(1)}.csv`, `${TENANT}/2026/11/${idN(2)}.csv`, `${idN(0xa2)}/2026/10/${idN(3)}.csv`];
  const run = async (rows: string[], storage?: any) => {
    const t = makeTx([(sql) => (FN.test(sql) ? rows.map((object_path) => ({ object_path })) : undefined)]); const c = ctx27({ tx: t.tx, ...(storage ? { storage } : {}) });
    const e = await err(expireAuditExports({}, c.ctx)); return { t, e, storage: c.ctx.storage };
  };
  it('calls the DEFINER once and deletes each returned object from bucket identity-exports exactly once', async () => {
    const { t, e, storage } = await run(paths); expect(e).toBeUndefined();
    expect(t.sqls().filter((s) => FN.test(s))).toHaveLength(1);
    expect(storage.delete.mock.calls.map((c: unknown[]) => c.join('|')).sort()).toEqual(paths.map((p) => `${BUCKET}|${p}`).sort());
  });
  it('issues no DML itself: the 1-year row purge and the status flip are the DEFINER\'s (FORCE RLS, app.maintenance reset inside it)', async () => {
    const { t } = await run(paths); for (const s of t.sqls()) { expect(s).not.toMatch(DML); expect(s).not.toMatch(/app\.maintenance|set_config/i); }
  });
  it('nothing due -> no storage call', async () => { const { e, storage } = await run([]); expect(e).toBeUndefined(); expect(storage.delete).not.toHaveBeenCalled(); });
  it('an object that is already gone (common.not_found) does not fail the job; the other objects are still deleted', async () => {
    const del = vi.fn(async (_b: string, p: string) => { if (p === paths[0]) throw new LimsError('common.not_found'); });
    const { e } = await run(paths, { delete: del }); expect(e).toBeUndefined(); expect(del).toHaveBeenCalledTimes(3);
  });
  it('any other storage failure rejects the job (the tx rolls back, the rows stay ready and the next run retries them) — never ack a leaked object', async () => {
    const del = vi.fn(async () => { throw new LimsError('common.dependency_unavailable'); });
    const { e } = await run(paths, { delete: del }); expect(e).toBeDefined();
  });
  it('through the core: platform scope, claims = identity system actor without tenant_id', async () => {
    const s = await setup([manifest]); await s.run(EXPIRE_AUDIT_EXPORTS, {}, { attempts: 1 });
    expect(s.world.txLog.at(-1)!.claims0).toEqual({ sub: systemActorOf('identity'), actor_type: 'system' });
  });
});
