// T0B-PARTYSET-1 test kit (tester fixture, not a test file). Handlers run over a REAL PG17 tx (lims_api, RLS on) with a fake IdentityPort, like sales/helpers.ts.
// Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/partners/T0B-PARTYSET-1.pg.sh). Synthetic data only. Importing the sales kit also takes the per-file advisory lock.
// PINS (see .orchestra/notes/T0B-PARTYSET-1-tests.md): rule failure = LimsError common.validation_failed with errors[].path = JSON pointer of the request field;
// every handler asserts its own x-permission through IdentityPort.assertRole; privileged partners.party_id_number.read needs aal2 (else auth.mfa_required);
// ctx.commitOnError() (core feature) keeps the tx alive when the handler throws after calling it; the mask = '*' x (length-4) + last four characters (see contract examples).
import { billingPort } from '../../../billing/ports/BillingPort.impl.js';
import { expect } from 'vitest';
import { createCoreRepo } from '../../../../core/core-repo/index.js';
import { LimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { manifest as catalogManifest } from '../../../catalog/index.js';
import { manifest as partnersManifest } from '../../index.js';
import { appTx } from '../../../frontdesk/__tests__/integration/helpers.js';
import { BRANCH, CENTRE, NOW, SYS_ACTOR, T, TENANT_A, TENANT_B, TODAY_NPT, auditRows, codeOf, dbRow, dbRows, forbidden, idem, ifm, mkCreditParty, mkDoctor, mkInvoice,
  mkPartner, noWrites, notFound, ok, rejected, req, superTx, uid, type Outcome, type Probe } from '../sales/helpers.js';

export { BRANCH, CENTRE, NOW, SYS_ACTOR, T, TENANT_A, TENANT_B, TODAY_NPT, auditRows, codeOf, dbRow, dbRows, forbidden, idem, ifm, mkCreditParty, mkDoctor, mkInvoice, mkPartner, noWrites, notFound, ok, rejected, req, superTx, uid };
export type { Outcome, Probe };

export const P = {
  settingRead: 'partners.party_setting.read', settingManage: 'partners.party_setting.manage', decide: 'partners.onboarding.decide',
  idRead: 'partners.party_id_number.read', penalty: 'partners.penalty.manage', icd: 'catalog.icd.manage',
  partnerRead: 'partners.partner.read', partnerManage: 'partners.partner.manage', referrerRead: 'catalog.referrer.read', referrerManage: 'catalog.referrer.manage',
  priceRead: 'catalog.price_list.read', priceManage: 'catalog.price_list.manage',
} as const;
export const ALL_GRANTS: readonly string[] = Object.values(P);
/** the only code that needs aal2 in this kit (contract: privileged, MFA) */
const PRIVILEGED = new Set<string>([P.idRead]);

export interface Who { tenant: string; userId: string; membershipId: string; grants: readonly string[]; mfa: 'aal1' | 'aal2'; actorType?: string }
const mk = (tenant: string, n: number, grants: readonly string[], o: Partial<Who> = {}): Who =>
  ({ tenant, userId: `01a1a98a-ac40-7000-8000-9a47${String(n).padStart(8, '0')}`, membershipId: `01a1a98a-ac40-7000-8000-9a48${String(n).padStart(8, '0')}`, grants, mfa: 'aal2', ...o });
export const ADMIN_A = mk(TENANT_A, 1, ALL_GRANTS);
export const ADMIN_B = mk(TENANT_B, 2, ALL_GRANTS);
export const SECOND_A = mk(TENANT_A, 3, ALL_GRANTS);          // a different person than ADMIN_A (decider != creator)
export const NOBODY_A = mk(TENANT_A, 4, []);
export const only = (n: number, ...grants: string[]): Who => mk(TENANT_A, 10 + n, grants);
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

const WRITE = /^\s*(insert|update|delete|truncate)\b/i;
type H = (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>;

/** One request = one committed tx under `who.tenant` (RLS on); a throw rolls back and is RETURNED as {error} (unless the handler called ctx.commitOnError() first: then the tx commits). */
let registryDone = false;
/** app.enqueue_job rejects identifiers absent from core.g_task_registry (same as frontdesk ensureTaskRegistry; the FD-T03 boot skips registry-sync). The partners tasks updatePartner / statements enqueue are added (ruling item 1). Superuser, idempotent. */
async function ensureTaskRegistry(): Promise<void> {
  if (registryDone) return;
  await superTx(async (tx) => { await tx.query(`INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES
    ('core.event_fanout','core','core','per_tenant',25), ('partners.sync_price_list','partners','task','per_tenant',5), ('partners.sync_statements','partners','task','per_tenant',5),
    ('partners.reconcile_orders','partners','task','per_tenant',5) ON CONFLICT DO NOTHING`); });
  registryDone = true;
}

export async function fire(operationId: string, r: ReturnType<typeof req>, who: Who, o: { now?: Date; manifest?: { handlers: Record<string, unknown> } } = {}): Promise<Outcome> {
  const probe: Probe = { sql: [], writes: [], logs: [], identity: [], access: [] };
  const handler = (((o.manifest ?? partnersManifest).handlers) as Record<string, H | undefined>)[operationId];
  if (typeof handler !== 'function') return { error: new Error(`no handler for ${operationId} (still pending / stub)`), probe };
  const at = o.now ?? NOW;
  await ensureTaskRegistry();
  const run = async (raw: any) => {
    let keep = false;
    const tx = { startedAt: at, query: (text: string, values?: unknown[]) => { probe.sql.push(text); if (WRITE.test(text)) probe.writes.push(text); return raw.query(text, values); } };
    const log = (l: string) => (obj: unknown, msg?: string) => { probe.logs.push(`${l} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: uid(), now: () => at, centreId: CENTRE[who.tenant === TENANT_B ? 'b' : 'a'],
      actor: { type: who.actorType ?? 'user', id: who.userId, membershipId: who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: { IdentityPort: {
        async assertRole(_c: unknown, a: { permission: string }) {
          probe.identity.push(a?.permission);
          if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
          if (PRIVILEGED.has(a.permission) && who.mfa !== 'aal2') throw new LimsError('auth.mfa_required');
        },
        async getActor() { return { actor: { type: 'user', id: who.userId, membershipId: who.membershipId }, displayName: 'Synthetic Caller', roles: [], permissions: [...who.grants], centreScope: { all: true, centreIds: [] }, branchIds: [], mfa: { enrolled: who.mfa === 'aal2', level: who.mfa }, isLocked: false }; },
        async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {}, channels: {}, featureFlags: {} }; },
      }, CatalogPort: catalogManifest.ports.CatalogPort, BillingPort: billingPort },   // real billing port: charge posts through it (CR-C13-016)
      // ruling item 1: what the pipeline always supplies (ctx.events = real core createEvents, ctx.core = real createCoreRepo reading core.branches / core.centres)
      events: createEvents({ producer: (o.manifest as { name?: string } | undefined)?.name ?? 'partners' }), core: createCoreRepo({} as never),
      audit: { access: async (e: any) => { probe.access.push(e); } }, commitOnError: () => { keep = true; },
    };
    try { return { reply: await handler(r, ctx) } as { reply?: any; error?: unknown }; } catch (e) { if (keep) return { error: e }; throw e; }
  };
  try {
    const out = await appTx(who.tenant, run);
    return out.error === undefined ? { reply: out.reply, probe } : { error: out.error, probe };
  } catch (error) { return { error, probe }; }
}

/** Rejection with any of `codes` (the contract lists more than one acceptable answer). */
export function rejectedAny(o: Outcome, codes: readonly string[]): LimsError {
  expect(o.reply, `expected one of ${codes.join('|')} but got ${o.reply?.status} ${JSON.stringify(o.reply?.body)?.slice(0, 200)}`).toBeUndefined();
  expect(o.error, 'expected a LimsError').toBeInstanceOf(LimsError);
  expect(codes, `${(o.error as any)?.message}`).toContain(codeOf(o));
  return o.error as LimsError;
}
export const mustBePendingFree = (ids: readonly string[], m: { pendingOperations?: readonly string[] } = partnersManifest as never): string[] => ids.filter((id) => (m.pendingOperations ?? []).includes(id));

/** the mask every read must show: '*' x (length - 4) + the last four characters; a value of four or fewer characters is fully starred */
export const mask = (v: string): string => (v.length <= 4 ? '*'.repeat(v.length) : '*'.repeat(v.length - 4) + v.slice(-4));

// ---------------------------------------------------------------- fixtures (superuser, committed)
const ins = async (tenant: string, table: string, row: Record<string, unknown>): Promise<any> => superTx(async (tx) => {
  const r = { created_by: SYS_ACTOR, updated_by: SYS_ACTOR, tenant_id: tenant, ...row };
  const cols = Object.keys(r);
  return (await tx.query(`INSERT INTO ${table} (${cols.map((k) => `"${k}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, cols.map((k) => r[k]))).rows[0];
}, tenant);
export async function wipe(...tenants: string[]): Promise<void> {
  for (const t of tenants) await superTx(async (tx) => {
    await tx.query('DELETE FROM partners.non_compliance_event WHERE tenant_id = $1', [t]);
    await tx.query('DELETE FROM partners.non_compliance_penalty WHERE tenant_id = $1', [t]);
    await tx.query('DELETE FROM partners.party_onboarding WHERE tenant_id = $1', [t]);
    await tx.query('DELETE FROM partners.party_commercial_setting WHERE tenant_id = $1', [t]);
    await tx.query('DELETE FROM catalog.icd_code WHERE tenant_id = $1', [t]);
  }, t);
}
export const mkSetting = (tenant: string, kind: string, partyId: string, o: Record<string, unknown> = {}) => ins(tenant, 'partners.party_commercial_setting', {
  id: uid(), party_kind: kind, party_id: partyId, auto_release_reports: false, whatsapp_enabled: false, insurance_enabled: false, print_exception: false, auto_block_overdue: false,
  billing_cycle: 'monthly', invoice_payment_days: 30, invoice_blocking_days: 60, invoice_warning_days: 45, interest_bp_per_day: 0, commission_bp: 0, tds_bp: 0, priority: 'P3', header_footer_mode: 'both', ...o });
export const mkOnboarding = (tenant: string, kind: string, partyId: string, o: Record<string, unknown> = {}) =>
  ins(tenant, 'partners.party_onboarding', { id: uid(), party_kind: kind, party_id: partyId, created_by: ADMIN_A.userId, updated_by: ADMIN_A.userId, ...o });
export const mkPenalty = (tenant: string, o: Record<string, unknown> = {}) =>
  ins(tenant, 'partners.non_compliance_penalty', { id: uid(), code: `PN${uid().slice(-10).toUpperCase()}`, name: `Synthetic penalty ${uid().slice(-6)}`, amount_paisa: 50_000, ...o });
export const mkEvent = (tenant: string, penaltyId: string, kind: string, partyId: string, o: Record<string, unknown> = {}) =>
  ins(tenant, 'partners.non_compliance_event', { id: uid(), party_kind: kind, party_id: partyId, penalty_id: penaltyId, event_date: '2026-11-10', amount_paisa: 50_000, reason: 'Synthetic: late sample', ...o });
export const mkIcd = (tenant: string, code: string, title: string, o: Record<string, unknown> = {}) => ins(tenant, 'catalog.icd_code', { id: uid(), code, title, ...o });

/** a credit party known to billing (billing.credit_accounts: the party of the account ledger) plus the particular the penalty charge may post under (code NON_COMPLIANCE_PENALTY, pinned) */
export interface LedgerWorld { tenant: string; creditPartyId: string; partnerId: string; doctorId: string; particularId: string }
export async function ledgerWorld(tenant = TENANT_A): Promise<LedgerWorld> {
  const cp = await mkCreditParty(tenant);
  await ins(tenant, 'billing.credit_accounts', { credit_party_id: cp.id, party_code: cp.party_code, party_display_name: cp.name, credit_limit_paisa: 5_000_000, is_locked: false });
  const partner = await mkPartner(tenant, { credit_party_id: cp.id });
  const doctor = await mkDoctor(tenant);
  const g = await superTx(async (tx) => (await tx.query(`INSERT INTO billing.account_groups (id, tenant_id, code, name, nature, created_by, updated_by) VALUES ($1,$2,'NON_COMPLIANCE','Synthetic penalties','income',$3,$3)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, is_active = true RETURNING id`, [uid(), tenant, SYS_ACTOR])).rows[0], tenant);
  const p = await superTx(async (tx) => (await tx.query(`INSERT INTO billing.account_particulars (id, tenant_id, account_group_id, code, name, created_by, updated_by) VALUES ($1,$2,$3,'NON_COMPLIANCE_PENALTY','Non compliance penalty',$4,$4)
     ON CONFLICT (tenant_id, code) DO UPDATE SET is_active = true RETURNING id`, [uid(), tenant, g.id, SYS_ACTOR])).rows[0], tenant);
  return { tenant, creditPartyId: cp.id, partnerId: partner.id, doctorId: doctor.id, particularId: p.id };
}
/** owner-side truth: account ledger entries of one party */
export const ledgerRows = (tenant: string, partyId: string) =>
  superTx(async (tx) => (await tx.query('SELECT * FROM billing.account_ledger_entries WHERE tenant_id = $1 AND party_id = $2 ORDER BY receipt_seq', [tenant, partyId])).rows, tenant);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const trailOf = async (table: string, id: string, o: Outcome): Promise<string> => JSON.stringify([await auditRows(table, id), o.probe.access]);
