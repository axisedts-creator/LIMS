// T24 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute:
//
//   ../dead-letter.service.ts  exports `createDeadLetterService(deps?: { platformEvents?: { insert(tx, e): Promise<void> } })` ->
//                              { listDeadLetters, getDeadLetter, replayDeadLetter, discardDeadLetter }, each `(ctx, input) => Promise<{ status, body, version? }>`
//                              (same convention as support/role.service). It imports NO repository and holds NO SQL (08 A8.6): rows come only from
//                              `ctx.core.deadLetters.{list,get,replay,discard}(ctx, input)` (02-TRD s6.8 signatures: ctx first). Every operation calls
//                              PlatformAuthz.assertPlatform(ctx, 'platform.dead_letter.manage') ITSELF before any core call. The only write is the
//                              view trail of getDeadLetter (03-APP-FLOW s9.3): tenant row -> inside `ctx.db.withTenantScope(ctx.tx, tenantId, fn)` one
//                              `ctx.audit.access({action:'dead_letter.view', entityType:'dead_letter', entityId, outcome:'allowed'})`; NULL-tenant row ->
//                              `deps.platformEvents.insert(ctx.tx, {eventType:'dead_letter_viewed', targetType:'dead_letter', targetId, targetTenantId:null,
//                              detail:{}, actorPlatformStaffId, requestId?, clientIp?})`. The default platformEvents writer is wired in the handler glue
//                              (handlers/dead-letter.http.ts), NOT in the service (so the service imports no repository).
//   ctx (platform request context, as T21) = { actor{type:'user',id}, platformRole, platformStaffId, platformSessionId, aal, requestId, tx, now(), clientIp?,
//                              db{withTenantScope(tx,tenantId,fn)}, audit{access(entry)}, core{deadLetters}, log }.
//   inputs (camelCase): listDeadLetters{state?,platformRows?,tenantId?,taskIdentifier?,deadAtFrom?,deadAtTo?,cursor?,limit?} - getDeadLetter{deadLetterId}
//        - replayDeadLetter{deadLetterId,expectedVersion|undefined,reasonText?} - discardDeadLetter{deadLetterId,expectedVersion|undefined,reasonText}
//     The service validates (400 common.validation_failed): state enum, uuids, limit integer 1..200, platformRows boolean|undefined, ISO-UTC dates,
//     platformRows=true together with tenantId (08 A10.2; core NOT called), reason_text 1..500 chars. Missing expectedVersion -> 428 common.precondition_required.
//   bodies = DeadLetterRow (snake_case, contracts/openapi/identity.yaml; additionalProperties:false, null/absent optionals OMITTED, never job_payload);
//        list body = { data: DeadLetterRow[], page: { limit, next_cursor? } } (limit = requested or 50).
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1);
export const STAFF_USER = idN(0xd1), STAFF_ID = idN(0xd2), PSESSION = idN(0xe2), REQ_ID = idN(0xe1);
export const NOW = new Date('2026-11-08T06:00:00.000Z');
export const SECRET = 'PAYLOAD-SENTINEL-7f3a';
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const day = (d: number, h = 0) => new Date(Date.UTC(2026, 10, d, h, 0, 0, 0));

export type DlState = 'open' | 'replayed' | 'discarded';
/** C0 DeadLetterRow (02-TRD s6.8). `jobPayload` is NOT part of it: it is stored here only so tests can prove it never reaches a response. */
export interface DlRow {
  id: string; tenantId: string | null; taskIdentifier: string; lastErrorCode: string; lastErrorMessageRedacted: string; attempts: number;
  firstFailedAt: string; deadAt: string; state: DlState; resolvedBy: string | null; resolvedAt: string | null; resolutionNote: string | null; version: number;
  jobPayload?: Record<string, unknown>;
}
let seq = 0;
export const dl = (o: Partial<DlRow> = {}): DlRow => {
  const n = ++seq;
  return {
    id: idN(0x1000 + n), tenantId: TENANT_A, taskIdentifier: 'billing.recompute_balance', lastErrorCode: 'common.internal', lastErrorMessageRedacted: 'handler failed',
    attempts: 10, firstFailedAt: day(1).toISOString(), deadAt: day(2).toISOString(), state: 'open', resolvedBy: null, resolvedAt: null, resolutionNote: null, version: 3,
    jobPayload: { invoice_id: idN(0x2000 + n), note: SECRET }, ...o,
  };
};

/**
 * Fake of `ctx.core.deadLetters` (C0 contract, 02-TRD s6.8 + 08 A6.4/A8.4/A8.5/A9.1-A9.3/A10.2): version guard, open-only, 1..500 note, inclusive-from/exclusive-to,
 * keyset paging dead_at DESC / id DESC, platformRows filter, `get` -> common.not_found. `leak: true` makes it return rows WITH `jobPayload` (a hostile/buggy core):
 * the service must still never forward it. Every call is recorded with its (ctx, input) arguments.
 */
export function makeCore(initial: DlRow[] = [], o: { leak?: boolean } = {}) {
  const rows = initial.map((r) => ({ ...r }));
  const calls: Array<{ m: 'list' | 'get' | 'replay' | 'discard'; ctx: unknown; input: any }> = [];
  const enqueued: Array<{ id: string; note: string | null }> = [];
  const state = { fail: undefined as Error | undefined };
  const out = (r: DlRow): DlRow => { const c = { ...r }; if (!o.leak) delete c.jobPayload; return c; };
  const pre = (m: 'list' | 'get' | 'replay' | 'discard', ctx: unknown, input: unknown) => { calls.push({ m, ctx, input }); if (state.fail) throw state.fail; };
  const noteOk = (s: unknown): s is string => typeof s === 'string' && [...s].length >= 1 && [...s].length <= 500;
  const invalid = () => new LimsError('common.validation_failed', undefined, [{ path: '/reasonText', code: 'common.field_invalid', message: 'Field invalid' }]);
  const resolve = (input: any, to: 'replayed' | 'discarded', note: string | null) => {
    const r = rows.find((x) => x.id === input.deadLetterId);
    if (!r) throw new LimsError('common.not_found');
    if (r.state !== 'open' || r.version !== input.expectedVersion) throw new LimsError('common.version_conflict');
    Object.assign(r, { state: to, resolvedBy: STAFF_USER, resolvedAt: NOW.toISOString(), resolutionNote: note, version: r.version + 1 });
    if (to === 'replayed') enqueued.push({ id: r.id, note });
  };
  const deadLetters = {
    async list(ctx: unknown, input: any = {}) {
      pre('list', ctx, input);
      const i = input;
      const sorted = rows.filter((r) =>
        (i.platformRows === true ? r.tenantId === null : r.tenantId !== null)
        && (i.state === undefined || r.state === i.state) && (i.tenantId === undefined || r.tenantId === i.tenantId)
        && (i.taskIdentifier === undefined || r.taskIdentifier === i.taskIdentifier)
        && (i.deadAtFrom === undefined || r.deadAt >= i.deadAtFrom) && (i.deadAtTo === undefined || r.deadAt < i.deadAtTo))
        .sort((a, b) => (a.deadAt === b.deadAt ? (a.id < b.id ? 1 : -1) : a.deadAt < b.deadAt ? 1 : -1));
      const start = i.cursor === undefined ? 0 : sorted.findIndex((r) => r.id === i.cursor) + 1;   // opaque to C2: the fake's cursor = last id
      const limit = i.limit ?? 50;
      const items = sorted.slice(start, start + limit).map(out);
      return start + limit < sorted.length ? { items, nextCursor: items[items.length - 1]!.id } : { items };
    },
    async get(ctx: unknown, input: any) { pre('get', ctx, input); const r = rows.find((x) => x.id === input.deadLetterId); if (!r) throw new LimsError('common.not_found'); return out(r); },
    async replay(ctx: unknown, input: any) {
      pre('replay', ctx, input);
      if (input.reasonText !== undefined && !noteOk(input.reasonText)) throw invalid();
      resolve(input, 'replayed', input.reasonText ?? null);
    },
    async discard(ctx: unknown, input: any) {
      pre('discard', ctx, input);
      if (!noteOk(input.reasonText)) throw invalid();
      resolve(input, 'discarded', input.reasonText);
    },
  };
  const spies = { list: vi.spyOn(deadLetters, 'list'), get: vi.spyOn(deadLetters, 'get'), replay: vi.spyOn(deadLetters, 'replay'), discard: vi.spyOn(deadLetters, 'discard') };
  return { deadLetters, rows, calls, enqueued, state, spies, by: (m: string) => calls.filter((c) => c.m === m), row: (id: string) => rows.find((r) => r.id === id)! };
}
export type FakeCore = ReturnType<typeof makeCore>;

export function makeCtx(core: FakeCore, o: Record<string, unknown> = {}) {
  const tx = { __tx: 1 };
  const trail: Array<{ kind: 'access'; scope: string | null; entry: any }> = [];
  const events: any[] = [];
  const st = { scope: null as string | null };
  const withTenantScope = vi.fn(async (t: unknown, tenantId: string, fn: () => Promise<unknown>) => {
    if (t !== tx) throw new Error('fake: withTenantScope must be given the request transaction');
    if (st.scope !== null) throw new Error('fake: nested withTenantScope');
    st.scope = tenantId;
    try { return await fn(); } finally { st.scope = null; }
  });
  const access = vi.fn(async (entry: any) => {
    if (st.scope === null) throw new Error('fake RLS: ctx.audit.access outside withTenantScope in a platform context');
    trail.push({ kind: 'access', scope: st.scope, entry });
  });
  const platformEvents = { insert: vi.fn(async (t: unknown, e: any) => { if (t !== tx) throw new Error('fake: platform event not on the request tx'); events.push(e); }) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: any = {
    actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION, aal: 'aal2',
    requestId: REQ_ID, clientIp: '203.0.113.9', tx, now: () => NOW, db: { withTenantScope }, audit: { access }, core: { deadLetters: core.deadLetters }, log, ...o,
  };
  return { ctx, tx, withTenantScope, access, trail, events, platformEvents, log };
}
