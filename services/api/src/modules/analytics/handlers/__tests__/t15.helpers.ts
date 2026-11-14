// AN-T15 test helpers (not a test file). Synthetic data only. Builds on ./t10.helpers.ts (owner personas, flag, REAL core/audit/access.ts on ctx.tx).
// Exports tables are emulated by ../../export/__tests__/sqlFake.ts (see its header for the SQL seams). Handlers are real.
//
// SEAMS pinned here (spec leaves them open; the writer may dispute through the reviewer):
//   * Handlers #20-#23 are reached through handlers/index.ts (createAnalyticsExport, listAnalyticsExports, getAnalyticsExport, downloadAnalyticsExport); path param name `export_id`.
//   * Everything goes through ctx.tx.query (user transaction, RLS own-only = emulated) and ctx.audit.access; export_files bytes are read from analytics.export_files.content.
//   * Quota check + insert must be SERIALISED by the writer: a lock statement (`pg_advisory_xact_lock(...)` or a `SELECT ... FOR UPDATE`) before the count. The emulator makes the
//     holder of that lock exclusive until the handler settles (what a row/advisory lock does until commit). Without a lock two parallel requests both see 9 and both insert (X16 fails).
//   * ctx.now() is db15.clock (advance with db15.advance).
import { vi } from 'vitest';
import { idFor } from '../../../../../../../packages/fakes/src/base';
import { ExportsDb, HOUR, type ExportRow } from '../../export/__tests__/sqlFake.js';
import {
  A1, A2, B1, D1, D2, D3, FINANCE, LAB_MANAGER, NO_PERM, OWNER, OWNER_A1, OWNER_AAL1, OWNER_REVOKED, PARTNER, TA, TB, contractErrors, expectLims, makeCtx10, rejection,
  type Ctx10Opts,
} from './t10.helpers.js';

export { A1, A2, B1, D1, D2, D3, FINANCE, LAB_MANAGER, NO_PERM, OWNER, OWNER_A1, OWNER_AAL1, OWNER_REVOKED, PARTNER, TA, TB, contractErrors, expectLims, rejection, HOUR };

export const db15 = new ExportsDb();
export const SEED = 1;
/** membership ids of makeCtx10's personas (t10.helpers.ts: idFor(SEED, 0xb00 + n)). */
export const MEMBER: Record<string, string> = {
  [OWNER]: idFor(SEED, 0xb01), [OWNER_A1]: idFor(SEED, 0xb02), [OWNER_AAL1]: idFor(SEED, 0xb03), [OWNER_REVOKED]: idFor(SEED, 0xb04),
  [FINANCE]: idFor(SEED, 0xb05), [LAB_MANAGER]: idFor(SEED, 0xb06),
};
export const SHA = 'abcdef01' + '0'.repeat(56);
export const exportId = (n: number): string => idFor(SEED, 0x1500 + n);
export const NOW = '2026-11-06T06:00:00.000Z';

// ------------------------------------------------------------------ tiny exclusive lock (what a row / advisory lock does until commit)
let chain: Promise<void> = Promise.resolve();
async function acquire(ctx: any): Promise<void> {
  if (ctx.__held) return;
  const prev = chain;
  let release!: () => void;
  chain = new Promise<void>((r) => { release = r; });
  await prev;
  ctx.__held = true; ctx.__release = release;
}
const releaseLock = (ctx: any): void => { if (ctx.__held) { ctx.__held = false; ctx.__release(); } };

export async function makeCtx15(actorKey: string, o: Ctx10Opts = {}) {
  const r = await makeCtx10(actorKey, o);
  const ctx: any = r.ctx;
  ctx.now = () => db15.clock.now;
  const membershipId = MEMBER[actorKey];
  ctx.actor = { ...ctx.actor, ...(membershipId ? { membershipId } : {}) };
  ctx.tx = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (/insert\s+into\s+audit\.access_log/i.test(text)) {
        if (o.accessFails) throw new Error('synthetic access_log failure');
        r.accessRows.push(values); return { rows: [], rowCount: 1 };
      }
      if (/pg_advisory(_xact)?_lock/i.test(text)) { await acquire(ctx); return { rows: [{}], rowCount: 1 }; }
      if (/FOR\s+UPDATE/i.test(text)) await acquire(ctx);
      return db15.exec(text, values, { tenant: ctx.tenantId, ...(membershipId ? { membership: membershipId } : {}), txId: 'main' });
    }),
  };
  const baseAccess = ctx.audit.access;
  ctx.audit.access = vi.fn(async (e: any) => { await baseAccess(e); db15.events.push(`audit:${e?.detail?.phase ?? e?.action}`); });
  return { ...r, ctx, membershipId: membershipId ?? '' };
}
export type Ctx15 = Awaited<ReturnType<typeof makeCtx15>>;

export type ExportOp = 'createAnalyticsExport' | 'listAnalyticsExports' | 'getAnalyticsExport' | 'downloadAnalyticsExport';
let keySeq = 0;
export async function callExp(op: ExportOp, ctx: any, o: { body?: unknown; params?: Record<string, unknown>; query?: Record<string, unknown> } = {}) {
  const { handlers } = await import('../index.js');
  ctx.operationId = op;
  try {
    return await handlers[op]({ params: o.params ?? {}, query: o.query ?? {}, headers: { 'idempotency-key': `k15-${++keySeq}` }, body: o.body }, ctx);
  } finally { releaseLock(ctx); }
}
export async function okExp(op: ExportOp, ctx: any, o: Parameters<typeof callExp>[2] = {}, status = 200): Promise<any> {
  const r = await callExp(op, ctx, o);
  if (r.status !== status) throw new Error(`expected ${status} from ${op}, got ${r.status}`);
  return r;
}

export const PARAMS = { business_date_from: D1, business_date_to: D2 };
export const createBody = (over: Record<string, unknown> = {}) => ({ report_code: 'income', format: 'xlsx', params: { ...PARAMS }, ...over });

/** A ready export of `actorKey` with its file (expires in 20 h). */
export function seedReady(n: number, actorKey: string, over: Partial<ExportRow> = {}, tenant = TA, bytes = Buffer.from(`PK-fake-file-${n}`)): ExportRow {
  const now = Date.parse(db15.clock.now);
  const row = db15.seed({
    id: exportId(n), tenant_id: tenant, requested_by_membership_id: MEMBER[actorKey]!, status: 'ready', format: 'xlsx', report_code: 'income',
    ready_at: new Date(now - HOUR), expires_at: new Date(now + 20 * HOUR), row_count: '2', size_bytes: String(bytes.length), sha256: SHA, requested_at: new Date(now - 2 * HOUR), ...over,
  });
  db15.seedFile(tenant, row.id, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', SHA, new Date(now + 20 * HOUR));
  return row;
}
/** n filler exports of one membership requested `minutesAgo[i]` minutes ago (status failed: they count for the quota all the same). */
export function seedQuota(count: number, actorKey: string, minutesAgo: (i: number) => number, tenant = TA): void {
  for (let i = 0; i < count; i++) {
    db15.seed({ id: idFor(SEED, 0x1600 + ++fillSeq), tenant_id: tenant, requested_by_membership_id: MEMBER[actorKey]!, status: 'failed', failure_code: 'auth.forbidden',
      requested_at: new Date(Date.parse(db15.clock.now) - minutesAgo(i) * 60_000) });
  }
}
let fillSeq = 0;
