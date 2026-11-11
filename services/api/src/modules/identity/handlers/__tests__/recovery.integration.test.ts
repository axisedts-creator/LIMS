// T9 integration: request handler -> worker job identity.send_recovery -> GoTrue mail -> confirmEmailToken -> setPasswordFromSetup -> login with the new password.
//   - always: the in-memory GoTrue fake (passes the shared contract suite);
//   - live:   the pinned GoTrue container through createHttpGoTrueGateway (done_when: "60-min TTL observed against the real GoTrue container", T1 precondition, 08 A25 D-219).
//             Env exactly like gotrue/__tests__/http.live.test.ts: LIMS_TEST_GOTRUE_URL + LIMS_TEST_GOTRUE_SERVICE_KEY + LIMS_TEST_GOTRUE_PSQL (reads the mail token hash and ages
//             auth.users.{recovery_sent_at,confirmation_sent_at,invited_at} + auth.one_time_tokens); LIMS_TEST_REQUIRE_LIVE=1 turns missing env into a failure. Live leg NOT run by the tester.
// Persistence is the in-memory store of recovery.helpers.ts (real SQL: db/tests/identity + a later live repo test). Expected now: fail (handlers are stubs, no worker task).
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createHttpGoTrueGateway } from '../../gotrue/gateway.http.js';
import type { GoTrueGateway } from '../../gotrue/gateway.js';
import { GOOD_PW, MEMB_A, errBody, makeWorld, mkEmail, rejection, tenantRow } from './recovery.helpers.js';
import { createSendRecovery } from '../../../../../../worker/src/jobs/identity/tasks/send_recovery.js';
import { createConfirmEmailToken } from '../confirmEmailToken.js';
import { createRequestPasswordRecovery } from '../requestPasswordRecovery.js';
import { createSetPasswordFromSetup } from '../setPasswordFromSetup.js';

const url = process.env['LIMS_TEST_GOTRUE_URL']; const key = process.env['LIMS_TEST_GOTRUE_SERVICE_KEY']; const psql = process.env['LIMS_TEST_GOTRUE_PSQL'];
const live = Boolean(url && key && psql);
if (process.env['LIMS_TEST_REQUIRE_LIVE'] === '1') describe('live GoTrue required (T9)', () => { it('LIMS_TEST_GOTRUE_URL / _SERVICE_KEY / _PSQL are set', () => { expect(live).toBe(true); }); });

type W = Awaited<ReturnType<typeof makeWorld>>;
interface Env { world: W; mailHash(email: string, type: 'recovery' | 'invite'): Promise<string | undefined>; age(seconds: number): Promise<void> }
const sql = (q: string) => { const [cmd, ...args] = psql!.split(/\s+/); return execFileSync(cmd!, [...args, q], { encoding: 'utf8' }).trim(); };
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const T = 90_000;

async function fakeEnv(): Promise<Env> { const world = await makeWorld(); return { world, mailHash: async (e, t) => world.fake!.mailbox.latestTokenHash(e, t), age: async (s) => { world.advance(s * 1000); } }; }
async function liveEnv(): Promise<Env> {
  const world = await makeWorld({ gateway: createHttpGoTrueGateway({ url: url!, serviceKey: key! }) as GoTrueGateway });
  const tt = { invite: 'confirmation_token', recovery: 'recovery_token' } as const;
  return { world, mailHash: async (e, t) => sql(`select ot.token_hash from auth.one_time_tokens ot join auth.users u on u.id = ot.user_id where lower(u.email) = lower(${lit(e)}) and ot.token_type = '${tt[t]}' order by ot.created_at desc limit 1`) || undefined,
    age: async (s) => { const n = Math.trunc(s); sql(`update auth.one_time_tokens set created_at = created_at - interval '${n} seconds'`); sql(`update auth.users set recovery_sent_at = recovery_sent_at - interval '${n} seconds', confirmation_sent_at = confirmation_sent_at - interval '${n} seconds', invited_at = invited_at - interval '${n} seconds'`); } };
}

/** run the recovery pipeline for `email` up to the e-mail in the (fake or real) mailbox; returns the link hash */
async function requestAndSend(e: Env, email: string) {
  const w = e.world; await w.call(createRequestPasswordRecovery(w.deps as any), { body: { email } });
  const job = w.store.committed('enqueue').map((x) => x.arg).filter((a: any) => a.identifier === 'identity.send_recovery').pop(); expect(job).toBeTruthy();
  const ctx: any = { tenantId: undefined, actor: { type: 'system', id: w.deps.newId() }, requestId: w.deps.newId(), tx: w.tx, log: w.log, attempt: 1, maxAttempts: 8, jobId: '1', now: () => new Date(w.clock.ms).toISOString() };
  await createSendRecovery({ gotrue: w.gotrue, repo: w.store.repo } as any)(job.payload, ctx); return e.mailHash(email, 'recovery');
}

function suite(label: string, mk: () => Promise<Env>, skip = false) {
  describe.skipIf(skip)(`recovery / invite flows vs ${label}`, () => {
    it('AC-A7.1-A7.3 end to end: forgot -> job sends -> confirm -> set password -> other session revoked, counter cleared, password_reset_completed; new password works, old one does not, link cannot be reused', async () => {
      const e = await mk(); const w = e.world; const u = await w.addUser(); const other = await w.addOtherSession(u.userId, u.email, u.password);
      const hash = await requestAndSend(e, u.email); expect(hash).toBeTruthy();
      const c = await w.call(createConfirmEmailToken(w.deps as any) as any, { body: { token_hash: hash, type: 'recovery' } }); expect(c.body.session.state).toBe('password_setup');
      const s = await w.call(createSetPasswordFromSetup(w.deps as any) as any, { token: c.body.session_token, body: { new_password: GOOD_PW } }); expect(s.body.state).toBe('active');
      expect(other.state).toBe('revoked'); expect(w.store.eventsOf('password_reset_completed')).toHaveLength(1); expect(w.store.eventsOf('recovery_link_opened')).toHaveLength(1);
      expect((await w.gw.signInWithPassword(u.email, GOOD_PW)).ok).toBe(true); expect((await w.gw.signInWithPassword(u.email, u.password)).ok).toBe(false);
      expect((await rejection(w.call(createConfirmEmailToken(w.deps as any) as any, { body: { token_hash: hash, type: 'recovery' } }))).code).toBe('auth.reset_token_invalid');
    }, T);

    it('AC-A7.1: an unknown e-mail gets the same 202 and NO mail is sent (job stops silently)', async () => {
      const e = await mk(); const w = e.world; const ghost = mkEmail('ghost'); const hash = await requestAndSend(e, ghost); expect(hash).toBeUndefined(); expect(w.calls.filter((c) => c.method === 'sendRecovery')).toHaveLength(0);
    }, T);

    it('AC-A7.1: a locked / deactivated account gets no mail either', async () => {
      const e = await mk(); const w = e.world; const u = await w.addUser({ row: tenantRow({ membership_locked: true }) }); expect(await requestAndSend(e, u.email)).toBeUndefined();
    }, T);

    it('AC-A7.2 / AU-T6 / done_when 60-min TTL (T1 precondition): a link aged 59 min is accepted; one aged 61 min -> 400 auth.reset_token_invalid with the SAME body as an unknown token', async () => {
      const e = await mk(); const w = e.world; const u = await w.addUser(); const hash = await requestAndSend(e, u.email); await e.age(59 * 60); const h = createConfirmEmailToken(w.deps as any) as any;
      expect((await w.call(h, { body: { token_hash: hash, type: 'recovery' } })).status).toBe(200);
      const e2 = await mk(); const w2 = e2.world; const u2 = await w2.addUser(); const hash2 = await requestAndSend(e2, u2.email); await e2.age(61 * 60);
      const old = await rejection(w2.call(createConfirmEmailToken(w2.deps as any) as any, { body: { token_hash: hash2, type: 'recovery' } })); const unk = await rejection(w2.call(createConfirmEmailToken(w2.deps as any) as any, { body: { token_hash: 'u'.repeat(43), type: 'recovery' } }));
      expect(old.code).toBe('auth.reset_token_invalid'); expect(errBody(old)).toBe(errBody(unk)); expect(w2.store.committed('insertSession')).toHaveLength(0);
    }, T);

    it('AC-A8.1 / AC-A8.2: invitation link works within the hour (state password_setup -> set password -> invite_accepted); the same link after use, and a 61-min-old link, -> 400 auth.invite_invalid (identical bodies)', async () => {
      const e = await mk(); const w = e.world; const email = mkEmail('invitee'); await w.gw.sendInvite(email, '/auth/confirm'); const f = await w.gw.adminFindUserByEmail(email); w.store.ctxRows.set(f!.userId, tenantRow({ mfa_required: true })); w.store.pendingInvites.add(MEMB_A);
      const hash = await e.mailHash(email, 'invite'); expect(hash).toBeTruthy(); const confirm = createConfirmEmailToken(w.deps as any) as any;
      const c = await w.call(confirm, { body: { token_hash: hash, type: 'invite' } }); expect(c.body.session).toMatchObject({ state: 'password_setup', kind: 'tenant_staff' });
      const s = await w.call(createSetPasswordFromSetup(w.deps as any) as any, { token: c.body.session_token, body: { new_password: GOOD_PW } }); expect(s.body.state).toBe('mfa_enrolment_required'); expect(w.store.eventsOf('invite_accepted')).toHaveLength(1);
      const used = await rejection(w.call(confirm, { body: { token_hash: hash, type: 'invite' } }));
      const e2 = await mk(); const w2 = e2.world; const email2 = mkEmail('invitee-old'); await w2.gw.sendInvite(email2, '/auth/confirm'); const f2 = await w2.gw.adminFindUserByEmail(email2); w2.store.ctxRows.set(f2!.userId, tenantRow());
      const hash2 = await e2.mailHash(email2, 'invite'); await e2.age(61 * 60); const expired = await rejection(w2.call(createConfirmEmailToken(w2.deps as any) as any, { body: { token_hash: hash2, type: 'invite' } }));
      expect(used.code).toBe('auth.invite_invalid'); expect(expired.code).toBe('auth.invite_invalid'); expect(errBody(used)).toBe(errBody(expired));
    }, T);
  });
}

suite('GoTrue fake', fakeEnv);
suite('real GoTrue container (T1 precondition)', liveEnv, !live);
