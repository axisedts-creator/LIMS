// C16.T-AC1 - E10 getMyAccount / E11 updateMyAccount (reminder opt-out) / E12 deleteMyAccount (06-PLAN row T-AC1; 02-TRD §4.14 + §5 E10-E12 + §6.2 revokePatientSessions; 05-SCHEMA accounts, links, addresses,
// payment_requests + §5.2 RLS; PRD US-EN-19.1 / 19.2 / 23.3; 07-SECURITY REQ-SEC-024 tenant binding, REQ-SEC-096/097 access_log `patient_account.delete`, REQ-SEC-139).
// done_when: deletion effects per TRD §4.14. tests: after delete sessions revoked (fake spy), links revoked, phone nulled; re-sign-in -> new account.
// Fails now: handlers/index.ts maps getMyAccount / updateMyAccount / deleteMyAccount to the T-01 placeholder (common.service_unavailable); there is no account.service.
//
// SEAMS (spec fixes behaviour, not names; same convention as auth.verify.test.ts / selfreg.handlers.test.ts):
//   handlers.getMyAccount / updateMyAccount / deleteMyAccount ({params, query, headers, body}, ctx). ctx = account.world.ts: actor {type:'patient', id: <accounts.membership_id>} (TRD §4.2 claims.membership_id), so the
//   service finds the caller's account by `membership_id = ctx.actor.id` (as T-L4); all SQL goes through ctx.tx (grammar of fakeSql.ts: single-table statements, plain AND-of-predicates WHERE).
//   E10 -> {status:200, body: Account, headers:{cache-control:'no-store'}}; E11 -> same shape, body {reminders_opt_out}; E12 -> {status:204} without body.
//   Permission: ctx.ports.IdentityPort.assertRole({permission:'engagement.self.read'|'engagement.self.manage'}) before any DB access (the world's `identity.asserted`).
//   If-Match header = the quoted decimal accounts.version ('"3"', same grammar as membership.handlers.test.ts): absent -> 428 common.precondition_required (before any DB access), malformed -> 400
//   common.validation_failed, stale -> 409 common.version_conflict; Idempotency-Key handling for E12 belongs to the core pipeline (x-idempotency: required), the handler must simply be safe to replay.
//   E12 effects (TRD §4.14): IdentityPort.revokePatientSessions(ctx, {membershipId: <account.membership_id>, reason:'account_deleted', deactivateMembership:true}) called as the PATIENT (08 A28.2 runs the write
//   under C2's own system actor); links -> revoked (revoked_by_kind 'account', revoked_reason_code 'account_deleted', revoked_at now); payment_requests queued|ready -> expired; addresses -> is_active false;
//   account status 'deleted', phone_e164 = NULL, phone_hmac = NULL, deleted_at now; ctx.audit.access({action:'patient_account.delete', entityType:'patient_account', entityId: account_id, outcome:'success'}).
//   One transaction: any failure rolls everything back (the world snapshots tables and audit; the IdentityPort spy is not rolled back).
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { LimsError } from '../../../../core/errors.js';
import {
  ACC1, ACC2, ACCB, AD_1, AD_2, AD_A2, AD_B, AD_OLD, BK1, EQ1, HMAC1, IFM, L_A2, L_ACTIVE, L_B, L_ACTIVE2, L_REVOKED, MEM1, PAT2, PHONE1, PHONE2, PR_A2, PR_B, PR_DONE, PR_FAILED, PR_QUEUED, PR_READY, REVOKED_EARLIER, RM1, T0,
  TA, TB, V1, makeAccountWorld, suspendLink, type AccountWorld, type InvokeOpts,
} from '../../__tests__/account.world.js';
import { findLiveByPhone, insertAccount } from '../../repository/accounts.repo.js';
import { handlers } from '../../handlers/index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const fail = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e: any) { return e; } throw new Error('expected a rejection'); };
const hdr = (out: any, name: string) => out.headers?.[name] ?? out.headers?.[name.toLowerCase()];
/** A refusal that is a real refusal: not a 2xx and not the T-01 placeholder (so a stub cannot pass a "nothing happened" test by throwing). */
const refused = async (p: Promise<unknown>) => { const c = await code(p); expect(c).not.toBe('RESOLVED'); expect(c).not.toBe('common.service_unavailable'); return c; };
const DIGITS = PHONE1.slice(1); // "9779800000001": the phone must never appear in logs / audit / responses other than masked

const getAcc = (w: AccountWorld, o: InvokeOpts = {}) => w.invoke((ctx) => (handlers as any).getMyAccount({ params: {}, query: {}, headers: {}, body: undefined }, ctx), { ...o, ctx: { operationId: 'getMyAccount', ...o.ctx } });
const patch = (w: AccountWorld, body: unknown, headers: Record<string, string> = IFM(V1), o: InvokeOpts = {}) =>
  w.invoke((ctx) => (handlers as any).updateMyAccount({ params: {}, query: {}, headers, body }, ctx), { ...o, ctx: { operationId: 'updateMyAccount', ...o.ctx } });
const del = (w: AccountWorld, body: unknown = { confirm: true }, headers: Record<string, string> = { ...IFM(V1), 'idempotency-key': 'idem-delete-1' }, o: InvokeOpts = {}) =>
  w.invoke((ctx) => (handlers as any).deleteMyAccount({ params: {}, query: {}, headers, body }, ctx), { ...o, ctx: { operationId: 'deleteMyAccount', ...o.ctx } });
const untouched = (w: AccountWorld) => { for (const t of Object.keys(w.pristine)) expect(w.snapshot(t), t).toEqual(w.pristine[t]); };

describe('contract sanity (the spec is the source of the permission, idempotency and body)', () => {
  it('E10/E11/E12: permission, idempotency, tier (TRD §5)', () => {
    expect(opOf('getMyAccount')).toMatchObject({ 'x-permission': 'engagement.self.read', 'x-idempotency': 'none', 'x-rate-limit-tier': 'general' });
    expect(opOf('updateMyAccount')).toMatchObject({ 'x-permission': 'engagement.self.manage', 'x-idempotency': 'optional' });
    expect(opOf('deleteMyAccount')).toMatchObject({ 'x-permission': 'engagement.self.manage', 'x-idempotency': 'required' });
  });
});

describe('world guards (the test world itself enforces what the database enforces - a failing guard means the world is wrong, not the service)', () => {
  it('RLS: a patient UPDATE reaches only its own account row (A2 untouched, the miss is counted)', async () => {
    const w = makeAccountWorld();
    const r: any = await w.invoke((ctx) => ctx.tx.query(`UPDATE engagement.accounts SET reminders_opt_out = true WHERE tenant_id = $1`, [TA]));
    expect(w.account(ACC1)['reminders_opt_out']).toBe(true); expect(w.account(ACC2)['reminders_opt_out']).toBe(false); expect(w.account(ACCB)['reminders_opt_out']).toBe(false);
    expect(w.foreign.touches).toBe(1); expect(r.rowCount).toBe(1);
  });
  it('patient column guard on links: a patient may only revoke; changing patient_id or reviving is refused (P0001)', async () => {
    const w = makeAccountWorld();
    const e = await fail(w.invoke((ctx) => ctx.tx.query(`UPDATE engagement.account_patient_links SET patient_id = $2 WHERE tenant_id = $1 AND id = $3`, [TA, PAT2, L_ACTIVE])));
    expect(e.code).toBe('P0001');
    const e2 = await fail(w.invoke((ctx) => ctx.tx.query(`UPDATE engagement.account_patient_links SET status = 'suspended', suspend_reason = 'x', suspended_at = now() WHERE tenant_id = $1 AND id = $2`, [TA, L_ACTIVE])));
    expect(e2.code).toBe('P0001'); untouched(w);
  });
  it('payment_requests check: a row that leaves `ready` must have its action_json scrubbed (secret-bearing URL)', async () => {
    const w = makeAccountWorld();
    await fail(w.invoke((ctx) => ctx.tx.query(`UPDATE engagement.payment_requests SET status = 'expired' WHERE tenant_id = $1 AND id = $2`, [TA, PR_READY])));
    expect(w.payment(PR_READY)['status']).toBe('ready');
  });
});
describe('E10 getMyAccount', () => {
  it('200 with the caller\'s account only: Account schema-valid, phone masked, no internal columns, Cache-Control: no-store', async () => {
    const w = makeAccountWorld(); const r: any = await getAcc(w);
    expect(r.status).toBe(200); expect(hdr(r, 'cache-control')).toBe('no-store');
    expect(schemaErrors('Account', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: ACC1, status: 'active', reminders_opt_out: false, version: V1 });
    expect(JSON.stringify(r.body)).not.toContain(DIGITS);
    for (const k of ['phone_e164', 'phone_hmac', 'membership_id', 'user_id', 'tenant_id', 'created_by', 'deleted_at']) expect(r.body).not.toHaveProperty(k);
  });
  it('a read: asserts engagement.self.read first, writes nothing', async () => {
    const w = makeAccountWorld(); await getAcc(w);
    expect(w.identity.asserted[0]).toMatchObject({ permission: 'engagement.self.read', at: 0 }); expect(w.writes()).toEqual([]);
  });
  it('A2 sees A2 (never A1): id and masked phone differ', async () => {
    const w = makeAccountWorld(); const r: any = await getAcc(w, { account: ACC2 });
    expect(r.body.id).toBe(ACC2); expect(JSON.stringify(r.body)).not.toContain(PHONE2.slice(1));
  });
  it('without the grant -> auth.forbidden before any DB access; a staff or system actor is refused too', async () => {
    const w = makeAccountWorld(); w.grants.delete('engagement.self.read');
    expect(await code(getAcc(w))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
    const w2 = makeAccountWorld();
    for (const who of ['user', 'system'] as const) expect(['auth.forbidden', 'auth.unauthenticated'], who).toContain(await code(getAcc(w2, { who })));
  });
  it('another tenant\'s session cannot read tenant A\'s account (RLS hides the row): no 200', async () => {
    const w = makeAccountWorld();
    expect(['common.not_found', 'auth.unauthenticated', 'auth.forbidden']).toContain(await code(getAcc(w, { tenant: TB })));
  });
  it('a deleted account is not served (its session is gone; a stale call must not return 200)', async () => {
    const w = makeAccountWorld(); await del(w);
    expect(['common.not_found', 'auth.unauthenticated', 'auth.forbidden']).toContain(await code(getAcc(w)));
  });
});

describe('E11 updateMyAccount - reminder opt-out (US-EN-23.3: the column the reminder dispatch reads)', () => {
  it('current If-Match + {reminders_opt_out:true} -> 200, version + 1, schema-valid, no-store; ONLY accounts.reminders_opt_out (+ audit columns) changed', async () => {
    const w = makeAccountWorld(); const r: any = await patch(w, { reminders_opt_out: true });
    expect(r.status).toBe(200); expect(hdr(r, 'cache-control')).toBe('no-store'); expect(schemaErrors('Account', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: ACC1, reminders_opt_out: true, version: V1 + 1 });
    const a = w.account(ACC1);
    expect(a).toMatchObject({ reminders_opt_out: true, version: V1 + 1, status: 'active', phone_e164: PHONE1, membership_id: MEM1 }); expect(Buffer.from(a['phone_hmac']).equals(HMAC1)).toBe(true);
    expect(Date.parse(a['updated_at'])).toBe(Date.parse(T0)); expect(a['updated_by']).toBeTruthy();
    expect(w.account(ACC2)).toEqual(w.pristine['accounts']!.find((x) => x['id'] === ACC2)); expect(w.account(ACCB)).toEqual(w.pristine['accounts']!.find((x) => x['id'] === ACCB));
    expect(w.writtenTables()).toEqual(['accounts']); expect(w.identity.revokes).toEqual([]);
  });
  it('the opt-out is reversible, and a revoke / link / address is never touched by it', async () => {
    const w = makeAccountWorld(); await patch(w, { reminders_opt_out: true }); const r: any = await patch(w, { reminders_opt_out: false }, IFM(V1 + 1));
    expect(r.body).toMatchObject({ reminders_opt_out: false, version: V1 + 2 });
    for (const t of ['account_patient_links', 'addresses', 'payment_requests', 'bookings', 'reminders', 'enquiries']) expect(w.snapshot(t), t).toEqual(w.pristine[t]);
    expect(w.identity.revokes).toEqual([]);
  });
  it('asserts engagement.self.manage first; without it -> auth.forbidden and nothing is written; staff / system actors are refused', async () => {
    const w = makeAccountWorld(); w.grants.delete('engagement.self.manage');
    expect(await code(patch(w, { reminders_opt_out: true }))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
    const w2 = makeAccountWorld();
    for (const who of ['user', 'system'] as const) expect(['auth.forbidden', 'auth.unauthenticated'], who).toContain(await code(patch(w2, { reminders_opt_out: true }, IFM(V1), { who })));
    untouched(w2);
  });
  it('If-Match absent -> 428 common.precondition_required before any DB access; malformed (weak, unquoted, zero, text, *) -> 400; stale -> 409 common.version_conflict; nothing changes', async () => {
    const w = makeAccountWorld();
    expect(await code(patch(w, { reminders_opt_out: true }, {}))).toBe('common.precondition_required'); expect(w.stmts).toEqual([]);
    for (const h of ['3', 'W/"3"', '"0"', '"abc"', '*']) expect(await code(patch(makeAccountWorld(), { reminders_opt_out: true }, { 'if-match': h })), h).toBe('common.validation_failed');
    expect(await code(patch(w, { reminders_opt_out: true }, IFM(V1 - 1)))).toBe('common.version_conflict');
    untouched(w);
  });
  it('strict body: missing key, null, "true", 1, extra property, array -> 400 common.validation_failed and no write', async () => {
    for (const b of [{}, { reminders_opt_out: null }, { reminders_opt_out: 'true' }, { reminders_opt_out: 1 }, { reminders_opt_out: true, status: 'deleted' }, [true], undefined]) {
      const w = makeAccountWorld(); expect(await code(patch(w, b)), JSON.stringify(b)).toBe('common.validation_failed'); expect(w.writes(), JSON.stringify(b)).toEqual([]);
    }
  });
  it('mass assignment: a body that also names status / phone_e164 / version is refused, the account row keeps its phone and status', async () => {
    const w = makeAccountWorld();
    expect(await code(patch(w, { reminders_opt_out: true, phone_e164: '+9779899999999', status: 'deleted', version: 99 }))).toBe('common.validation_failed'); untouched(w);
  });
  it('tenant binding: every write names tenant_id and the account (REQ-SEC-024), and no foreign row was reached', async () => {
    const w = makeAccountWorld(); await patch(w, { reminders_opt_out: true });
    for (const c of w.writes()) { expect(c.text).toMatch(/tenant_id/i); expect(c.values).toContain(TA); expect(c.values.some((v) => v === ACC1 || v === MEM1), c.text).toBe(true); }
    expect(w.foreign.touches).toBe(0);
  });
  it('another tenant\'s session cannot change tenant A\'s account', async () => {
    const w = makeAccountWorld();
    expect(['common.not_found', 'auth.unauthenticated', 'auth.forbidden', 'common.version_conflict']).toContain(await code(patch(w, { reminders_opt_out: true }, IFM(V1), { tenant: TB }))); untouched(w);
  });
  it('a deleted account cannot be edited', async () => {
    const w = makeAccountWorld(); await del(w);
    expect(await code(patch(w, { reminders_opt_out: true }, IFM(V1 + 1)))).not.toBe('RESOLVED'); expect(w.account(ACC1)['reminders_opt_out']).toBe(false);
  });
});

describe('E12 deleteMyAccount - effects per TRD §4.14 (US-EN-19.1)', () => {
  it('204 without a body; sessions revoked through IdentityPort.revokePatientSessions exactly once with the contract input, called as the patient of this tenant', async () => {
    const w = makeAccountWorld(); const r: any = await del(w);
    expect(r.status).toBe(204); expect(r.body == null).toBe(true);
    expect(w.identity.revokes).toHaveLength(1);
    expect(w.identity.revokes[0]).toMatchObject({ actorType: 'patient', actorId: MEM1, tenantId: TA, input: { membershipId: MEM1, reason: 'account_deleted', deactivateMembership: true } });
    expect(Object.keys(w.identity.revokes[0]!.input).sort()).toEqual(['deactivateMembership', 'membershipId', 'reason']);
  });
  it('account: status deleted, phone_e164 and phone_hmac NULL, deleted_at = now; other accounts (same tenant, other tenant) untouched', async () => {
    const w = makeAccountWorld(); await del(w);
    const a = w.account(ACC1);
    expect(a).toMatchObject({ status: 'deleted', phone_e164: null, phone_hmac: null }); expect(Date.parse(a['deleted_at'])).toBe(Date.parse(T0)); expect(a['version']).toBeGreaterThan(V1);
    for (const id of [ACC2, ACCB]) expect(w.account(id), id).toEqual(w.pristine['accounts']!.find((x) => x['id'] === id));
  });
  it('links: every active link of the account -> revoked by the account (account_deleted) at now; an earlier staff revoke keeps its own reason; another account\'s link to the same patient stays active', async () => {
    const w = makeAccountWorld(); await del(w);
    for (const id of [L_ACTIVE, L_ACTIVE2]) {
      const l = w.link(id); expect(l, id).toMatchObject({ status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'account_deleted' }); expect(Date.parse(l['revoked_at'])).toBe(Date.parse(T0));
      expect(l['patient_id']).toBe(w.pristine['account_patient_links']!.find((x) => x['id'] === id)!['patient_id']); expect(l['account_id']).toBe(ACC1);
    }
    expect(w.link(L_REVOKED)).toMatchObject({ status: 'revoked', revoked_by_kind: 'staff', revoked_reason_code: 'suspected_misuse', revoked_at: REVOKED_EARLIER });
    expect(w.link(L_A2)).toEqual(w.pristine['account_patient_links']!.find((x) => x['id'] === L_A2)); expect(w.link(L_B)).toEqual(w.pristine['account_patient_links']!.find((x) => x['id'] === L_B));
    expect(w.snapshot('account_patient_links').filter((l) => l['account_id'] === ACC1 && ['active', 'suspended'].includes(l['status']))).toEqual([]);
  });
  it('addresses are deactivated BEFORE the links are revoked: under PAT_ACC_PID an address of a patient with no active link is unreachable (0 rows, no error) - review T-AC1 item 1', async () => {
    const w = makeAccountWorld(); await del(w);
    const at = (t: string) => w.writes().findIndex((c) => c.text.includes('UPDATE engagement.' + t + ' '));
    // statement order is checked via `at` (index of the write);/(?:update)\s+(?:engagement\.)?(\w+)/i.exec(c.text) ?? [])[1]);
    expect(at('addresses')).toBeGreaterThanOrEqual(0); expect(at('addresses')).toBeLessThan(at('account_patient_links'));
    for (const id of [AD_1, AD_2]) expect(w.address(id)['is_active'], id).toBe(false);
  });
  // BLOCKED by .orchestra/cr/T-AC1.md (lead ruling pending): a suspended link cannot be revoked by the patient actor (guard_patient_link_update refuses suspend_reason/suspended_at -> immutable_row -> 500)
  // and its addresses are unreachable (PAT_ACC_PID needs an active link). Unskip when the CR is ruled (guard change, or the writes move to the engagement system actor).
  it.skip('BLOCKED (CR T-AC1): an account with a suspended link is deleted completely: link revoked by the account, its address inactive, 204', async () => {
    const w = makeAccountWorld({ seed: suspendLink }); const r: any = await del(w);
    expect(r.status).toBe(204);
    expect(w.link(L_ACTIVE2)).toMatchObject({ status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'account_deleted' });
    expect(w.address(AD_2)['is_active']).toBe(false);
  });
  it('payment requests: queued and ready -> expired (the secret action URL scrubbed); completed and failed keep their state; other accounts\' requests untouched', async () => {
    const w = makeAccountWorld(); await del(w);
    expect(w.payment(PR_QUEUED)['status']).toBe('expired'); expect(w.payment(PR_READY)).toMatchObject({ status: 'expired', action_json: null });
    expect(w.payment(PR_DONE)).toEqual(w.pristine['payment_requests']!.find((x) => x['id'] === PR_DONE)); expect(w.payment(PR_FAILED)).toEqual(w.pristine['payment_requests']!.find((x) => x['id'] === PR_FAILED));
    for (const id of [PR_A2, PR_B]) expect(w.payment(id), id).toEqual(w.pristine['payment_requests']!.find((x) => x['id'] === id));
  });
  it('addresses: all of the account\'s addresses -> is_active = false; other accounts\' addresses untouched', async () => {
    const w = makeAccountWorld(); await del(w);
    for (const id of [AD_1, AD_2, AD_OLD]) expect(w.address(id)['is_active'], id).toBe(false);
    for (const id of [AD_A2, AD_B]) expect(w.address(id), id).toEqual(w.pristine['addresses']!.find((x) => x['id'] === id));
  });
  it('lab records stay: bookings, reminders (future booking reminders included), enquiries and patients are not written (PRD 19.1, TRD §4.14)', async () => {
    const w = makeAccountWorld(); await del(w);
    for (const t of ['bookings', 'reminders', 'enquiries', 'patients']) expect(w.snapshot(t), t).toEqual(w.pristine[t]);
    expect(w.snapshot('bookings')[0]!['id']).toBe(BK1); expect(w.snapshot('reminders')[0]!['id']).toBe(RM1); expect(w.snapshot('enquiries')[0]!['id']).toBe(EQ1);
    expect(w.writtenTables().every((t) => ['accounts', 'account_patient_links', 'payment_requests', 'addresses'].includes(t)), w.writtenTables().join()).toBe(true);
  });
  it('reminders to the account stop: no active/suspended link and no active account remain (the dispatch joins active links of active accounts only)', async () => {
    const w = makeAccountWorld(); await del(w);
    expect(w.account(ACC1)['status']).toBe('deleted'); expect(w.snapshot('account_patient_links').some((l) => l['account_id'] === ACC1 && l['status'] === 'active')).toBe(false);
  });
  it('access_log: one patient_account.delete entry for this account (success), no phone, no name, in audit or logs', async () => {
    const w = makeAccountWorld(); await del(w);
    expect(w.audit.access).toHaveLength(1);
    expect(w.audit.access[0]).toMatchObject({ action: 'patient_account.delete', entityType: 'patient_account', entityId: ACC1, outcome: 'success' });
    expect(JSON.stringify([w.audit, w.logs])).not.toContain(DIGITS);
  });
  it('tenant binding: every write names tenant_id and this account (REQ-SEC-024); no foreign row was reached by any statement', async () => {
    const w = makeAccountWorld(); await del(w);
    expect(w.writes().length).toBeGreaterThan(0);
    for (const c of w.writes()) { expect(c.text, c.text).toMatch(/tenant_id/i); expect(c.values, c.text).toContain(TA); expect(c.values.some((v) => v === ACC1 || v === MEM1), c.text).toBe(true); }
    expect(w.foreign.touches).toBe(0);
  });
  it('asserts engagement.self.manage before any DB access', async () => {
    const w = makeAccountWorld(); await del(w); expect(w.identity.asserted[0]).toMatchObject({ permission: 'engagement.self.manage', at: 0 });
  });
});

describe('E12 refusals - nothing is deleted, no session is revoked, nothing is audited', () => {
  const nothing = (w: AccountWorld) => { untouched(w); expect(w.identity.revokes).toEqual([]); expect(w.audit.access).toEqual([]); };
  it('confirm absent / false / "true" / 1 / null / extra property / no body -> 400 common.validation_failed', async () => {
    for (const b of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, { confirm: null }, { confirm: true, reminders_opt_out: true }, null]) { // (an `undefined` argument would take del()'s default body)
      const w = makeAccountWorld(); expect(await code(del(w, b)), JSON.stringify(b)).toBe('common.validation_failed'); nothing(w);
    }
  });
  it('If-Match absent -> 428 before any DB access; malformed -> 400; stale -> 409 common.version_conflict', async () => {
    const w = makeAccountWorld();
    expect(await code(del(w, { confirm: true }, { 'idempotency-key': 'k' }))).toBe('common.precondition_required'); expect(w.stmts).toEqual([]); nothing(w);
    for (const h of ['3', 'W/"3"', '"0"', '"abc"', '*']) { const w2 = makeAccountWorld(); expect(await code(del(w2, { confirm: true }, { 'if-match': h, 'idempotency-key': 'k' })), h).toBe('common.validation_failed'); nothing(w2); }
    const w3 = makeAccountWorld(); expect(await code(del(w3, { confirm: true }, { ...IFM(V1 + 1), 'idempotency-key': 'k' }))).toBe('common.version_conflict'); nothing(w3);
  });
  it('without engagement.self.manage -> auth.forbidden; a staff, system or other-tenant session cannot delete tenant A\'s patient account', async () => {
    const w = makeAccountWorld(); w.grants.delete('engagement.self.manage'); expect(await code(del(w))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]); nothing(w);
    for (const o of [{ who: 'user' as const }, { who: 'system' as const }, { tenant: TB }]) {
      const w2 = makeAccountWorld(); await refused(del(w2, { confirm: true }, { ...IFM(V1), 'idempotency-key': 'k' }, o)); nothing(w2);
    }
  });
  it('IdentityPort failure (C2 down) propagates unchanged and the whole deletion rolls back: account keeps its phone, links stay active, no audit entry', async () => {
    const w = makeAccountWorld(); w.identity.failRevoke = () => new LimsError('common.internal');
    expect(await code(del(w))).toBe('common.internal'); expect(w.identity.revokes).toHaveLength(1); // C2 was reached and refused
    untouched(w); expect(w.audit.access).toEqual([]);
  });
  it('a database failure half-way (addresses update fails) rolls back everything: no partial deletion (links revoked but phone kept), no audit entry', async () => {
    const w = makeAccountWorld(); w.inject.failOn = /UPDATE\s+engagement\.addresses/i;
    await refused(del(w)); expect(w.writes().length).toBeGreaterThan(0); // the deletion really started writing before the failure
    untouched(w); expect(w.audit.access).toEqual([]);
    const w2 = makeAccountWorld(); w2.inject.failOn = /UPDATE\s+engagement\.account_patient_links/i;
    await refused(del(w2)); expect(w2.stmts.length).toBeGreaterThan(0); untouched(w2); expect(w2.audit.access).toEqual([]);
  });
});

describe('E12 replay and double submission', () => {
  it('a second delete with the old If-Match after success is refused and does nothing more: one revoke call, one audit entry, state unchanged', async () => {
    const w = makeAccountWorld(); await del(w); const state = w.snapshot('accounts'); const links = w.snapshot('account_patient_links');
    expect(['common.version_conflict', 'common.not_found', 'auth.unauthenticated', 'auth.forbidden']).toContain(await code(del(w)));
    expect(w.identity.revokes).toHaveLength(1); expect(w.audit.access).toHaveLength(1); expect(w.snapshot('accounts')).toEqual(state); expect(w.snapshot('account_patient_links')).toEqual(links);
  });
  it('a second delete with the NEW version (account already deleted) is refused too and writes nothing', async () => {
    const w = makeAccountWorld(); await del(w); const v = w.account(ACC1)['version']; const writes = w.writes().length;
    expect(await code(del(w, { confirm: true }, { ...IFM(v), 'idempotency-key': 'idem-delete-2' }))).not.toBe('RESOLVED');
    expect(w.writes().length).toBe(writes); expect(w.audit.access).toHaveLength(1); expect(w.identity.revokes).toHaveLength(1);
  });
});

describe('re-sign-in with the same phone -> a new account with no links (US-EN-19.2)', () => {
  it('after the deletion no live account has the phone, so E3 verify creates a new one (T-A3 code: findLiveByPhone / insertAccount)', async () => {
    const w = makeAccountWorld(); await del(w);
    const live = await w.invoke((ctx) => findLiveByPhone(ctx.tx, { tenantId: TA, phoneE164: PHONE1 }), { who: 'system' });
    expect(live).toBeUndefined();
    const NEW = '01a1a98a-ac40-7000-8000-0000000000a9';
    const created = await w.invoke((ctx) => insertAccount(ctx.tx, { id: NEW, tenantId: TA, phoneE164: PHONE1, phoneHmac: HMAC1, createdBy: NEW }), { who: 'system' });
    expect(created['id']).toBe(NEW); expect(NEW).not.toBe(ACC1);
    expect(w.snapshot('accounts').filter((a) => a['phone_e164'] === PHONE1)).toHaveLength(1);
    expect(w.snapshot('account_patient_links').filter((l) => l['account_id'] === NEW)).toEqual([]); // no links: the old profiles are gone, a new sign-in starts empty
    expect(w.account(ACC1)).toMatchObject({ status: 'deleted', phone_e164: null }); // the old row stays as the audit trail, never reused
  });
  it('a live account of the phone blocks a second one (the partial unique index the new-account path relies on): deletion is what frees the number', async () => {
    const w = makeAccountWorld(); const NEW = '01a1a98a-ac40-7000-8000-0000000000a9';
    expect((await fail(w.invoke((ctx) => insertAccount(ctx.tx, { id: NEW, tenantId: TA, phoneE164: PHONE1, phoneHmac: HMAC1, createdBy: NEW }), { who: 'system' }))).code).toBe('23505');
  });
});
