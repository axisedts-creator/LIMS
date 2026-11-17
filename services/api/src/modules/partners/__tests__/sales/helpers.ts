// T0B-SALES-1 test kit (tester fixture, not a test file). Handlers of the partners manifest run over a REAL PG17 tx (lims_api, RLS on) with a fake IdentityPort.
// Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/partners/T0B-SALES-1.pg.sh). Synthetic data only.
// Importing the frontdesk integration helper also takes its per-file advisory lock, so files that use this kit never run in parallel on the shared tenants.
// PINS (see .orchestra/notes/T0B-SALES-1-tests.md): the caller's own representative = sales_representative.user_id = ctx.actor.id; "today" = ctx.now() in Asia/Kathmandu;
// a rule failure = LimsError common.validation_failed with errors[].path as JSON pointer of the request field ('/level', '/manager_id' ...).
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { manifest } from '../../index.js';
import { BRANCH, CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, appTx, superTx, uid } from '../../../frontdesk/__tests__/integration/helpers.js';

export { BRANCH, CENTRE, SYS_ACTOR, TENANT_A, TENANT_B, superTx, uid };
export const T = 120_000;
export const READ = 'partners.sales.read';
export const MANAGE = 'partners.sales.manage';
/** fixed "now": 2026-11-17 20:30 UTC = 2026-11-18 02:15 in Asia/Kathmandu (UTC+5:45): UTC date and tenant date differ on purpose */
export const NOW = new Date('2026-11-17T20:30:00.000Z');
export const TODAY_NPT = '2026-11-18';

export interface Who { tenant: string; userId: string; membershipId: string; grants: readonly string[]; mfa: 'aal1' | 'aal2'; actorType?: string }
const mk = (tenant: string, n: number, grants: readonly string[], o: Partial<Who> = {}): Who =>
  ({ tenant, userId: `01a1a98a-ac40-7000-8000-5a1e5a1e${String(n).padStart(4, '0')}`, membershipId: `01a1a98a-ac40-7000-8000-5a1e5a1f${String(n).padStart(4, '0')}`, grants, mfa: 'aal2', ...o });
export const ADMIN_A = mk(TENANT_A, 1, [READ, MANAGE]);
export const ADMIN_B = mk(TENANT_B, 2, [READ, MANAGE]);
export const READER_A = mk(TENANT_A, 3, [READ]);
export const NOBODY_A = mk(TENANT_A, 4, []);
export const MANAGE_ONLY_A = mk(TENANT_A, 5, [MANAGE]);
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined as unknown, ...o });
export const ifm = (v: number) => ({ 'if-match': `"${v}"` });
export const idem = () => ({ 'idempotency-key': uid() });

export interface Probe { sql: string[]; writes: string[]; logs: string[]; identity: string[]; access: any[] }
export interface Outcome { reply?: { status: number; body?: any; headers?: Record<string, string> }; error?: any; probe: Probe }
const WRITE = /^\s*(insert|update|delete|truncate)\b/i;
type H = (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>;

/** One request = one committed tx under `who.tenant` (RLS on); a throw rolls back and is RETURNED as {error}. */
export async function fire(operationId: string, r: ReturnType<typeof req>, who: Who, o: { now?: Date; handlers?: Record<string, unknown> } = {}): Promise<Outcome> {
  const probe: Probe = { sql: [], writes: [], logs: [], identity: [], access: [] };
  const handler = ((o.handlers ?? manifest.handlers) as Record<string, H | undefined>)[operationId];
  if (typeof handler !== 'function') return { error: new Error(`no handler for ${operationId} (still pending / stub)`), probe };
  const at = o.now ?? NOW;
  const run = async (raw: any) => {
    const tx = { startedAt: at, query: (text: string, values?: unknown[]) => { probe.sql.push(text); if (WRITE.test(text)) probe.writes.push(text); return raw.query(text, values); } };
    const log = (l: string) => (obj: unknown, msg?: string) => { probe.logs.push(`${l} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: uid(), now: () => at, centreId: CENTRE.a,
      actor: { type: who.actorType ?? 'user', id: who.userId, membershipId: who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: { IdentityPort: {
        async assertRole(_c: unknown, a: { permission: string }) {
          probe.identity.push(a?.permission);
          if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
          if (a.permission === MANAGE && who.mfa !== 'aal2') throw new LimsError('auth.mfa_required');
        },
        async getActor() { return { actor: { type: 'user', id: who.userId, membershipId: who.membershipId }, displayName: 'Synthetic Caller', roles: [], permissions: [...who.grants], centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: who.mfa === 'aal2', level: who.mfa }, isLocked: false }; },
        async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
      } },
      audit: { access: async (e: any) => { probe.access.push(e); } }, commitOnError: () => undefined,
    };
    return handler(r, ctx);
  };
  try { return { reply: await appTx(who.tenant, run), probe }; } catch (error) { return { error, probe }; }
}

export const codeOf = (o: Outcome): string | undefined => (o.error instanceof LimsError ? (o.error as any).code : undefined);
export function ok(o: Outcome, status = 200): any {
  expect(o.error, `unexpected error: ${(o.error as any)?.code ?? ''} ${(o.error as any)?.message} ${JSON.stringify((o.error as any)?.errors ?? [])}`).toBeUndefined();
  expect(o.reply?.status).toBe(status);
  return o.reply!.body;
}
/** Rejection with `code` (default common.validation_failed). `path` must be in errors[]; any validation failure must carry at least one '/...' field path. `secret` must not leak. */
export function rejected(o: Outcome, code = 'common.validation_failed', path?: string, secret?: string): any {
  expect(o.reply, `expected ${code} but got ${o.reply?.status} ${JSON.stringify(o.reply?.body)?.slice(0, 200)}`).toBeUndefined();
  expect(o.error, 'expected a LimsError').toBeInstanceOf(LimsError);
  expect(codeOf(o), `${(o.error as any)?.message}`).toBe(code);
  const errs: Array<{ path?: string }> = (o.error as any).errors ?? [];
  if (path === '*') expect(errs.some((e) => typeof e.path === 'string' && e.path.startsWith('/')), 'errors[] needs a field path').toBe(true);   // '*' = any field path
  else if (path) expect(errs.map((e) => e.path), `errors[] must name ${path}`).toContain(path);
  if (secret) expect(`${(o.error as any).message} ${(o.error as any).detail ?? ''} ${JSON.stringify(errs)}`).not.toContain(secret);
  return o.error;
}
export const notFound = (o: Outcome) => rejected(o, 'common.not_found');
export const forbidden = (o: Outcome) => rejected(o, 'auth.forbidden');
/** a rule refused in the domain layer: no INSERT/UPDATE statement was even attempted */
export const noWrites = (o: Outcome) => expect(o.probe.writes, 'domain layer must refuse before any write').toEqual([]);

// ---------------------------------------------------------------- fixtures (superuser, committed)
const c = (tenant: string) => tenant;
export async function wipe(...tenants: string[]): Promise<void> {
  for (const t of tenants) {
    await superTx(async (tx) => {
      await tx.query('DELETE FROM partners.party_sales_assignment WHERE tenant_id = $1', [t]);
      await tx.query("SET LOCAL session_replication_role = 'replica'", []);
      await tx.query('UPDATE partners.sales_representative SET manager_id = NULL WHERE tenant_id = $1', [t]);
      await tx.query('DELETE FROM partners.sales_representative WHERE tenant_id = $1', [t]);
      await tx.query('DELETE FROM partners.sales_designation WHERE tenant_id = $1', [t]);
      await tx.query('DELETE FROM partners.service_area WHERE tenant_id = $1', [t]);
    }, c(t));
  }
}
const ins = async (tenant: string, table: string, row: Record<string, unknown>, replica = false): Promise<any> => superTx(async (tx) => {
  if (replica) await tx.query("SET LOCAL session_replication_role = 'replica'", []);
  const r = { created_by: SYS_ACTOR, updated_by: SYS_ACTOR, tenant_id: tenant, ...row };
  const cols = Object.keys(r);
  const out = await tx.query(`INSERT INTO ${table} (${cols.map((k) => `"${k}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, cols.map((k) => r[k]));
  return out.rows[0];
}, tenant);
export const mkDesignation = (tenant: string, level: number, o: Record<string, unknown> = {}) => ins(tenant, 'partners.sales_designation', { id: uid(), name: `Synthetic level ${level} ${uid().slice(-6)}`, level, ...o });
export const mkRep = (tenant: string, designationId: string, o: Record<string, unknown> = {}) => ins(tenant, 'partners.sales_representative', { id: uid(), name: `Synthetic Rep ${uid().slice(-8)}`, designation_id: designationId, ...o });
export const mkArea = (tenant: string, o: Record<string, unknown> = {}) => ins(tenant, 'partners.service_area', { id: uid(), name: `Synthetic area ${uid().slice(-6)}`, district: 'Kathmandu', ...o });
export const mkAssignment = (tenant: string, o: { kind?: string; party: string; rep: string; from?: string; to?: string | null }) =>
  ins(tenant, 'partners.party_sales_assignment', { id: uid(), party_kind: o.kind ?? 'credit_party', party_id: o.party, representative_id: o.rep, effective_from: o.from ?? '2026-01-01', effective_to: o.to ?? null });
export const mkCreditParty = (tenant: string, o: Record<string, unknown> = {}) => ins(tenant, 'catalog.credit_parties', { id: uid(), party_code: `S${uid().slice(-10).toUpperCase()}`, name: `Synthetic Party ${uid().slice(-6)}`, kind: 'hospital', ...o });
export const mkDoctor = (tenant: string, o: Record<string, unknown> = {}) => ins(tenant, 'catalog.doctors', { id: uid(), doctor_code: `D${uid().slice(-10).toUpperCase()}`, display_name: `Synthetic Doctor ${uid().slice(-6)}`, name_normalised: 'synthetic doctor', source: 'back_office', ...o });
export async function mkPartner(tenant: string, o: Record<string, unknown> = {}): Promise<any> {
  const side = tenant === TENANT_B ? 'b' : 'a';
  const cp = await mkCreditParty(tenant);
  return ins(tenant, 'partners.partners', { id: uid(), partner_code: `SP${uid().slice(-10).toUpperCase()}`, name: `Synthetic Partner ${uid().slice(-6)}`, credit_party_id: cp.id,
    receiving_branch_id: BRANCH[side], receiving_centre_id: CENTRE[side], conversion_mode: 'on_receipt', ...o });
}
/** a periodic credit invoice (net_paisa) of a credit party, issued at `issuedAt` */
export const mkInvoice = (tenant: string, creditPartyId: string, net: number, issuedAt: string) => {
  const side = tenant === TENANT_B ? 'b' : 'a'; const n = uid().slice(-9);
  return ins(tenant, 'billing.invoices', { id: uid(), branch_id: BRANCH[side], series: 'INV', fiscal_year_bs: '2083/84', invoice_seq: 1 + Math.floor(Math.random() * 2e9), invoice_no: `SYN-${n}`, invoice_kind: 'tax_invoice',
    purpose: 'periodic_credit', credit_party_id: creditPartyId, is_periodic_credit_bill: true, period_month: '2026-11-01', buyer_name: 'Synthetic buyer', seller_name: 'Synthetic seller', issued_at: issuedAt,
    invoice_date_bs: '2083-08-01', gross_paisa: net, discount_paisa: 0, exempt_paisa: net, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: net, prices_include_tax: false,
    quote_fingerprint: randomBytes(32).toString('hex'), status: 'issued', cbms_state: 'not_required' }, true); // replica: the fiscal chronology guard (billing.fiscal_counters) is a billing invariant, not under test here
};
export const dbRow = async (table: string, id: string): Promise<any | undefined> => (await superTx(async (tx) => (await tx.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows))[0];
export const dbRows = async (table: string, where: string, values: unknown[] = []): Promise<any[]> => superTx(async (tx) => (await tx.query(`SELECT * FROM ${table} WHERE ${where}`, values)).rows);
export const auditRows = (table: string, rowId: string) => dbRows('audit.audit_log', 'table_name = $1 AND row_id = $2 ORDER BY created_at, id', [table.split('.')[1], rowId]);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** reps of a chain: result[0] is the top (no manager), result[i] reports to result[i-1] */
export async function chain(tenant: string, designationId: string, n: number): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < n; i++) out.push(await mkRep(tenant, designationId, { name: `Chain ${i + 1}`, manager_id: i ? out[i - 1].id : null }));
  return out;
}
