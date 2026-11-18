// T0B-MSGDESK-1 harness (LD-321, LD-325). Handlers (manifest.handlers of engagement and partners) are driven with a request-shaped object and a HandlerContext built over
// a REAL PG17 tx (lims_api, RLS on), the same convention as frontdesk/__tests__/patients/helpers.ts. The core pipeline (schema validation, x-permission, Idempotency-Key replay)
// is NOT re-tested here; the handler's own checks are: actor type, IdentityPort.assertRole, tenant, state machine, second person, cap.
// Env: LIMS_TEST_APP_URL (lims_api) + LIMS_TEST_SUPER_URL (superuser), exported by tests/engagement/T0B-MSGDESK-1.pg.sh. Missing env is a hard failure. Synthetic data only.
// Own pools (not the frontdesk ones) because the claims here carry actor_type user | partner and a membership id; the same advisory lock key is NOT taken: this suite runs alone.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { access } from '../../../../core/audit/access.js';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { uuidv7 } from '../../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { afterAll } from 'vitest';

export const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
export const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const SEED_USER = { a: '01a1a98a-ac40-7000-8000-00000000a300', b: '01a1a98a-ac40-7000-8000-00000000b300' } as const;
export const SEED_MEMBERSHIP = { a: '01a1a98a-ac40-7000-8000-00000000a500', b: '01a1a98a-ac40-7000-8000-00000000b500' } as const;
export const BRANCH = { a: '01a1a98a-ac40-7000-8000-00000000a101', b: '01a1a98a-ac40-7000-8000-00000000b101' } as const;
export const CENTRE = { a: '01a1a98a-ac40-7000-8000-00000000a201', b: '01a1a98a-ac40-7000-8000-00000000b201' } as const;
export const SYS_ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const NOW = new Date('2026-11-17T06:00:00.000Z');
export const T = 120_000;
export const uid = (): string => uuidv7();
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
export const tag = () => Array.from({ length: 8 }, () => 'bcdfghjklmnpqrstvwxz'[Math.floor(Math.random() * 20)]).join('');
export const phone = () => `+97798${digits(8)}`;

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: run .orchestra\\notes\\T0B-MSGDESK-1-verify.cmd (boots PG17 via docker) or export it against a migrated + seeded DB`);
  return v;
};
const pgModule = 'pg';
const { default: pg } = (await import(pgModule)) as any;
const app = new pg.Pool({ connectionString: need('LIMS_TEST_APP_URL'), max: 20 });
const sup = new pg.Pool({ connectionString: need('LIMS_TEST_SUPER_URL'), max: 4 });
afterAll(async () => { await app.end().catch(() => {}); await sup.end().catch(() => {}); }, 60_000);

export type ActorType = 'user' | 'system' | 'partner' | 'patient' | 'portal' | 'device';
export interface Claims { tenant: string; type: ActorType; sub: string; membership: string }
const claimsJson = (c: Claims) => JSON.stringify({ tenant_id: c.tenant, sub: c.sub, actor_type: c.type, membership_id: c.membership });

/** One committed tx as lims_api under RLS with these claims (set_config is tx-local). Rolls back on throw. */
export async function appTx<R>(c: Claims, fn: (tx: Tx) => Promise<R>): Promise<R> {
  const k = await app.connect();
  try {
    await k.query('BEGIN');
    await k.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsJson(c)]);
    const out = await fn(k);
    await k.query('COMMIT');
    return out;
  } catch (e) { await k.query('ROLLBACK').catch(() => {}); throw e; } finally { k.release(); }
}
export async function superTx<R>(fn: (tx: Tx) => Promise<R>, tenant = TENANT_A): Promise<R> {
  const k = await sup.connect();
  try {
    await k.query('BEGIN');
    await k.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: SYS_ACTOR, actor_type: 'system' })]);
    const out = await fn(k);
    await k.query('COMMIT');
    return out;
  } catch (e) { await k.query('ROLLBACK').catch(() => {}); throw e; } finally { k.release(); }
}
/** Fixture insert as superuser (columns that do not exist on the table are dropped; created_by / updated_by stamped when present). */
export async function seed(table: string, row: Record<string, unknown>): Promise<void> {
  const r = { created_by: SYS_ACTOR, updated_by: SYS_ACTOR, ...row };
  await superTx(async (tx) => {
    const has = (await tx.query('SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped', [table])).rows.map((x) => x.attname);
    const use = Object.keys(r).filter((c) => has.includes(c));
    const list = use.map((c) => `"${c}"`).join(',');
    await tx.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`,
      [JSON.stringify(Object.fromEntries(use.map((c) => [c, r[c]])))]);
  }, String(r.tenant_id ?? TENANT_A));
}
export const ownerRows = (table: string, where: string, values: unknown[] = []) =>
  superTx(async (tx) => (await tx.query(`SELECT * FROM ${table} WHERE ${where}`, values)).rows);
export const ownerExec = (sql: string, values: unknown[] = [], tenant = TENANT_A) => superTx(async (tx) => (await tx.query(sql, values)).rows, tenant);

// ---- actors ----
export const staff = (side: 'a' | 'b' = 'a', sub: string = uid()): Claims => ({ tenant: side === 'a' ? TENANT_A : TENANT_B, type: 'user', sub, membership: uid() });
/** a partner actor: needs the membership + partner_users row from seedPartner() (app.current_partner_id() resolves through them). */
export const partnerActor = (p: { userId: string; membershipId: string }): Claims => ({ tenant: TENANT_A, type: 'partner', sub: p.userId, membership: p.membershipId });

// ---- fake ports ----
export function makeIdentity(grants: readonly string[]) {
  const calls: string[] = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string }) { calls.push(r?.permission); if (!grants.includes(r?.permission)) throw new LimsError('auth.forbidden'); },
    async getActor() { return { actor: { type: 'user', id: SYS_ACTOR }, displayName: 'Synthetic Operator', roles: [], permissions: [...grants], centreScope: { all: true, centreIds: [] },
      branchIds: [], mfa: { enrolled: true, level: 'aal2' }, isLocked: false }; },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu', channels: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true } }; },
  };
}
export interface SendCall { channel: 'sms' | 'whatsapp' | 'email'; input: any }
/** Records every send. Like the real outbox it answers a repeated idempotencyKey with the first deliveryId and replayed: true (no second row). */
export function makeNotification(opts: { failFor?: (input: any) => boolean } = {}) {
  const sent: SendCall[] = [];
  const byKey = new Map<string, string>();
  const send = (channel: SendCall['channel']) => async (_c: unknown, input: any) => {
    sent.push({ channel, input });
    if (opts.failFor?.(input)) throw new LimsError('common.internal');
    const prior = byKey.get(input.idempotencyKey);
    if (prior) return { deliveryId: prior, status: 'queued', replayed: true };
    const deliveryId = uid();
    byKey.set(input.idempotencyKey, deliveryId);
    return { deliveryId, status: 'queued', replayed: false };
  };
  return { sent, byKey, sendSms: send('sms'), sendWhatsAppTemplate: send('whatsapp'), sendEmailLink: send('email') };
}
export type FakeNotification = ReturnType<typeof makeNotification>;

// ---- driving a handler ----
export type Reply = { status: number; body?: any; headers?: Record<string, string> };
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
export const idem = () => ({ 'idempotency-key': `k-${uid()}` });
export interface Probe { logs: string[]; sql: string[]; accessCalls: any[]; identity: ReturnType<typeof makeIdentity>; notification: FakeNotification; requestId: string; ctx: any }

export async function callWith(handlers: Record<string, (r: any, c: any) => Promise<Reply>>, operationId: string, r: ReturnType<typeof req>,
  o: { claims?: Claims; grants?: readonly string[]; notification?: FakeNotification; tenantId?: string } = {}): Promise<Reply & { probe: Probe }> {
  const claims = o.claims ?? staff('a');
  const probe = { logs: [] as string[], sql: [] as string[], accessCalls: [] as any[], identity: makeIdentity(o.grants ?? []), notification: o.notification ?? makeNotification(), requestId: uid() } as Probe;
  const out = await appTx(claims, async (tx) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') },
      tenantId: o.tenantId ?? claims.tenant, tx: { query: (t: string, v?: unknown[]) => { probe.sql.push(t); return tx.query(t, v); } }, requestId: probe.requestId, now: () => NOW, centreId: claims.tenant === TENANT_B ? CENTRE.b : CENTRE.a,
      actor: { type: claims.type, id: claims.sub, membershipId: claims.membership },
      ports: { IdentityPort: probe.identity, NotificationPort: probe.notification },
      core: { tenant: async () => ({ displayName: 'Synthetic Lab' }) },
    };
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    probe.ctx = ctx;
    const h = handlers[operationId];
    if (!h) throw new Error(`no handler for ${operationId}`);
    return h(r, ctx);
  });
  return { ...out, probe };
}
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection, got success'); };
export const errCode = (e: any): string | undefined => e?.code;

// ---- spec validators ----
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
export const specOf = (name: 'engagement' | 'partners'): any => loadSpec(join(REPO_ROOT, `contracts/openapi/${name}.yaml`));
export function schemaErrors(spec: any, name: string, x: unknown): string[] {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`);
}

// ---- fixtures ----
export const PERM = {
  bRead: 'engagement.broadcast.read', bManage: 'engagement.broadcast.manage', bApprove: 'engagement.broadcast.approve',
  tRead: 'partners.ticket.read', tManage: 'partners.ticket.manage',
} as const;
export const ALL_B = [PERM.bRead, PERM.bManage, PERM.bApprove] as const;
export const ALL_T = [PERM.tRead, PERM.tManage] as const;

/** LEAD PICK (see header of broadcast.test.ts): a message provider is "configured and approved" for a channel = an ACTIVE reporting.channel_accounts row for that channel
 *  whose provider_kind is not 'recording' (the in-memory recorder never reaches a handset). Sets or clears it for tenant `side`. */
export async function setProvider(side: 'a' | 'b', channel: 'sms' | 'whatsapp' | 'email', on: boolean): Promise<void> {
  const t = side === 'a' ? TENANT_A : TENANT_B;
  await superTx(async (tx) => {
    await tx.query('DELETE FROM reporting.channel_accounts WHERE tenant_id = $1 AND channel = $2', [t, channel]);
    if (!on) return;
    const kind = { sms: 'sms_sparrow', whatsapp: 'whatsapp_cloud_api', email: 'email_smtp_relay' }[channel];
    await tx.query(`INSERT INTO reporting.channel_accounts (id, tenant_id, channel, provider_kind, secret_ref, is_active, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,true,$6,$6)`,
      [uid(), t, channel, kind, `synthetic/msgdesk/${channel}`, SYS_ACTOR]);
  }, t);
}

/** an active credit party (client) with a phone; kind 'hospital' so it is never a partner lab. Returns the row. */
export async function seedClient(side: 'a' | 'b', o: Record<string, unknown> = {}): Promise<any> {
  const t = side === 'a' ? TENANT_A : TENANT_B;
  const row = { id: uid(), tenant_id: t, party_code: `SYN-${tag().toUpperCase().slice(0, 8)}`, name: `Synthetic Client ${tag()}`, kind: 'hospital', allows_credit: true,
    contact_phone_e164: phone(), contact_email: `c-${tag()}@example.test`, is_active: true, ...o };
  await seed('catalog.credit_parties', row);
  return row;
}

/** A partner (credit party + partners.partners) and, when asked, one active partner user with a core user + membership, so a partner actor resolves app.current_partner_id(). */
export async function seedPartner(o: { withUser?: boolean; phoneE164?: string | null; status?: 'active' | 'suspended' } = {}): Promise<{ partnerId: string; creditPartyId: string; name: string; phone: string | null;
  userId: string; membershipId: string }> {
  const creditPartyId = uid(); const partnerId = uid(); const code = `SYN-${tag().toUpperCase().slice(0, 8)}`; const name = `Synthetic Partner ${tag()}`;
  const ph = o.phoneE164 === undefined ? phone() : o.phoneE164;
  await seed('catalog.credit_parties', { id: creditPartyId, tenant_id: TENANT_A, party_code: code, name, kind: 'partner_lab' });
  await seed('partners.settings', { tenant_id: TENANT_A });
  const suspended = o.status === 'suspended';
  await seed('partners.partners', { id: partnerId, tenant_id: TENANT_A, partner_code: code, name, credit_party_id: creditPartyId, receiving_branch_id: BRANCH.a, receiving_centre_id: CENTRE.a,
    conversion_mode: 'on_receipt', contact_phone_e164: ph, contact_email: `p-${tag()}@example.test`, status: o.status ?? 'active',
    ...(suspended ? { suspended_at: '2026-11-01T00:00:00Z', suspended_by: SYS_ACTOR, suspend_reason_code: 'synthetic' } : {}) });
  const userId = uid(); const membershipId = uid();
  if (o.withUser) {
    await seed('core.users', { id: userId, tenant_id: TENANT_A, display_name: 'Synthetic Partner User' });
    await seed('core.memberships', { id: membershipId, tenant_id: TENANT_A, user_id: userId, actor_type: 'partner', all_centres: false, status: 'active', partner_role: 'partner_admin' });
    await seed('partners.partner_users', { id: uid(), tenant_id: TENANT_A, partner_id: partnerId, membership_id: membershipId, partner_role: 'partner_admin', status: 'active',
      display_name: 'Synthetic Partner User', email_masked: 'a***@p***.invalid', invited_by_actor_type: 'user' });
  }
  return { partnerId, creditPartyId, name, phone: ph, userId, membershipId };
}
