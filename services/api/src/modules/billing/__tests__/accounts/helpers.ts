// T0B-ACCT-1 (LD-313, LD-310) shared kit (helper, not a test). Billing handlers run with a request-shaped object and a HandlerContext over a REAL PG17 tx
// (lims_api, RLS on, one request = one committed tx, rolled back on a throw), the same convention as frontdesk/__tests__/probes/kit.ts.
// The core pipeline (schema validation, x-permission, Idempotency-Key replay) is NOT re-run here: accounts.static.test.ts pins the contract side of it.
// Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/billing/T0B-ACCT-1.pg.sh boots PG17 with the 20261117120000 migration). Synthetic data only.
import { access } from '../../../../core/audit/access.js';
import { LimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { handlers } from '../../handlers/index.js';
import { CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid } from '../../../frontdesk/__tests__/integration/helpers.js';
import { expect } from 'vitest';

export { CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid };
export const T = 280_000;
/** 11:45 Asia/Kathmandu on 2026-11-17: today = 2026-11-17, entry_date may be at most 2026-11-18 (LD-313 / done_when 5). */
export const NOW = new Date('2026-11-17T06:00:00.000Z');
export const TODAY = '2026-11-17';

type Reply = { status: number; body?: any; headers?: Record<string, string> };
export interface Outcome { reply?: Reply; error?: any; stmts: string[]; writes: string[]; logs: string[]; accessCalls: any[]; requestId: string }
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
export const idem = () => ({ 'idempotency-key': uid() });
export const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const H = handlers as unknown as Record<string, ((r: any, ctx: any) => Promise<Reply>) | undefined>;
const WRITE = /^\s*(insert|update|delete|truncate)\b/i;

export const tag = () => Array.from({ length: 10 }, () => 'BCDFGHJKLMNPQRSTVWXZ'[Math.floor(Math.random() * 20)]).join('');

/** One request as tenant `tenant`. Never throws: a handler error comes back in .error. */
export interface Who {
  /** ctx.actor.id (a membership id). Default SYS_ACTOR (T0B-ACCT-1 behaviour). */
  actor?: string;
  /** centre scope of the actor (IdentityPort.getActor().centreScope). Default: all centres (T0B-ACCT-1 behaviour). */
  centreIds?: string[];
  /** roles of the actor ('tenant_admin' = administrator, T0B-ACCT-2 cancel rule). Default ['finance']. */
  roles?: string[];
  /** IdentityPort.getTenantSettings featureFlags (T0B-ACCT-2: allow_negative_pockets). */
  flags?: Record<string, boolean>;
  /** T0B-FINCTRL-1: extra IdentityPort.getTenantSettings keys (require_discount_reason, fiscal_year_start_bs), merged next to timezone / featureFlags. */
  settings?: Record<string, unknown>;
  /** T0B-FINCTRL-1: ctx.actor.membershipId (cash sessions belong to a membership). Absent = not set, as before. */
  membershipId?: string;
}
export async function fire(operationId: string, r: ReturnType<typeof req>, o: { tenant?: string; now?: Date; requestId?: string } & Who = {}): Promise<Outcome> {
  const tenant = o.tenant ?? TENANT_A;
  const actorId = o.actor ?? SYS_ACTOR;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const now = o.now ?? NOW;
  const out: Outcome = { stmts: [], writes: [], logs: [], accessCalls: [], requestId: o.requestId ?? uid() };
  const handler = H[operationId];
  if (!handler) { out.error = new Error(`no billing handler for ${operationId} (T0B-ACCT-1 must add it)`); return out; }
  try {
    out.reply = await appTx(tenant, async (rawTx: any) => {
      rawTx.startedAt = now;                                    // core events.publish stamps occurred_at from tx.startedAt
      const tx = { startedAt: now, query: async (text: string, values?: unknown[]) => { out.stmts.push(text); if (WRITE.test(text)) out.writes.push(text); return rawTx.query(text, values); } };
      const log = (lvl: string) => (obj: unknown, msg?: string) => { out.logs.push(`${lvl} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
      const identity = {
        assertRole: async () => undefined, getActor: async () => ({ actor: { type: 'system', id: actorId }, displayName: 'Synthetic Accountant', roles: o.roles ?? ['finance'], permissions: [], centreScope: { all: o.centreIds === undefined, centreIds: o.centreIds ?? [CENTRE[side]] }, branchIds: [], mfa: { enrolled: true, level: 'aal2' }, isLocked: false }),
        getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu', numbering: {}, channels: {}, featureFlags: o.flags ?? {}, ...(o.settings ?? {}) }),
      };
      const ctx: any = {
        operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
        tenantId: tenant, tx, requestId: out.requestId, now: () => now, centreId: CENTRE[side], actor: { type: 'system', id: actorId, ...(o.membershipId ? { membershipId: o.membershipId } : {}) },
        ports: { IdentityPort: identity }, events: createEvents({ producer: 'billing' }),
      };
      ctx.audit = { access: async (e: any) => { out.accessCalls.push(e); await access(ctx, e); } };
      return handler(r, ctx);
    });
  } catch (error) { out.error = error; }
  return out;
}

export function ok(o: Outcome, status = 200): any {
  expect(o.error, `unexpected error: ${o.error?.code ?? ''} ${o.error?.message ?? ''}`).toBeUndefined();
  expect(o.reply?.status).toBe(status);
  return o.reply!.body;
}
/** A refusal with `code` (default 400 common.validation_failed). A TypeError / pg error escaping the handler is a failure here, never a pass. */
export function rejected(o: Outcome, code = 'common.validation_failed'): any {
  expect(o.reply, `expected ${code} but the handler answered ${o.reply?.status} ${JSON.stringify(o.reply?.body)?.slice(0, 200)}`).toBeUndefined();
  expect(o.error, 'expected a LimsError').toBeInstanceOf(LimsError);
  expect(o.error.code, String(o.error.message)).toBe(code);
  return o.error;
}
export const notFound = (o: Outcome) => rejected(o, 'common.not_found');

// ---------------------------------------------------------------- fixtures (committed by the superuser; the API under test only sees them through RLS)
export interface World {
  tenant: string; centre: string; groupId: string; particularId: string; partyId: string; groupCode: string; particularCode: string;
}
/** One tenant graph: an active group + particular, and a credit party (billing.credit_accounts, limit NPR 50,000.00, not locked). */
export async function world(side: 'a' | 'b' = 'a', o: { limitPaisa?: number | null; locked?: boolean } = {}): Promise<World> {
  const tenant = side === 'a' ? TENANT_A : TENANT_B;
  const w: World = { tenant, centre: CENTRE[side], groupId: uid(), particularId: uid(), partyId: uid(), groupCode: `G_${tag()}`, particularCode: `P_${tag()}` };
  await seed('billing.account_groups', { id: w.groupId, tenant_id: tenant, code: w.groupCode, name: 'Synthetic income group', nature: 'income' });
  await seed('billing.account_particulars', { id: w.particularId, tenant_id: tenant, account_group_id: w.groupId, code: w.particularCode, name: 'Synthetic particular' });
  await seed('billing.credit_accounts', {
    tenant_id: tenant, credit_party_id: w.partyId, party_code: `CP_${tag()}`, party_display_name: 'Synthetic Credit Party',
    credit_limit_paisa: o.limitPaisa === undefined ? 5_000_000 : o.limitPaisa, is_locked: o.locked === true, lock_reason_code: o.locked ? 'overdue' : null,
  });
  return w;
}
export const entryBody = (w: World, over: Record<string, unknown> = {}) => ({
  centre_id: w.centre, party_kind: 'credit_party', party_id: w.partyId, entry_date: TODAY, account_particular_id: w.particularId,
  entry_type: 'credit', amount_paisa: 150_000, payment_mode: 'cash', ...over,
});
export const post = (w: World, over: Record<string, unknown> = {}, who: { tenant?: string; now?: Date } = {}) =>
  fire('createAccountLedgerEntry', req({ headers: idem(), body: entryBody(w, over) }), { tenant: w.tenant, ...who });
/** An entry created through the API (201 asserted). */
export async function entry(w: World, over: Record<string, unknown> = {}): Promise<any> { return ok(await post(w, over), 201); }
export const reverse = (w: World, id: string, reason = 'Synthetic wrong particular') =>
  fire('reverseAccountLedgerEntry', req({ params: { account_ledger_entry_id: id }, headers: idem(), body: { reason_text: reason } }), { tenant: w.tenant });
export const statement = (w: World, from: string, to: string, over: Record<string, unknown> = {}) =>
  fire('getAccountStatement', req({ query: { party_kind: 'credit_party', party_id: w.partyId, from, to, ...over } }), { tenant: w.tenant });
export const summary = (w: World, over: Record<string, unknown> = {}) =>
  fire('getAccountSummary', req({ query: { party_kind: 'credit_party', party_id: w.partyId, ...over } }), { tenant: w.tenant });

/** Owner-side truth (no RLS). $1 is the tenant; extra `values` start at $2. */
export const dbEntries = (tenant: string, where = 'true', values: unknown[] = []) =>
  superTx(async (tx) => (await tx.query(`SELECT * FROM billing.account_ledger_entries WHERE tenant_id = $1 AND (${where}) ORDER BY receipt_seq`, [tenant, ...values])).rows, tenant);
export const dbCount = async (tenant: string, where = 'true', values: unknown[] = []) => (await dbEntries(tenant, where, values)).length;
/** every receipt_seq of the tenant, ascending: the committed set must always be exactly 1..N (done_when 4). */
export const allSeqs = async (tenant: string): Promise<number[]> =>
  superTx(async (tx) => (await tx.query('SELECT receipt_seq::text AS s FROM billing.account_ledger_entries WHERE tenant_id = $1 ORDER BY receipt_seq', [tenant])).rows.map((r: any) => Number(r.s)), tenant);

/** signed paisa: credit +, debit -. */
export const signed = (type: string, amount: number): number => (type === 'credit' ? amount : -amount);
export const sideSigned = (paisa: number, side: string): number => (side === 'debit' ? -paisa : paisa);
/** deterministic PRNG so a failing random run can be replayed (the seed is part of every assertion message). */
export function prng(seed0: number): () => number {
  let a = seed0 >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** every number in a JSON body is a safe integer when it is a money field: never a string, never a float. */
export function moneyIsInteger(body: unknown, path = ''): string[] {
  const bad: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (/_paisa$/.test(k) && !(typeof x === 'number' && Number.isSafeInteger(x))) bad.push(`${p}.${k}=${JSON.stringify(x)} (${typeof x})`);
      else walk(x, `${p}.${k}`);
    }
  };
  walk(body, path);
  return bad;
}
