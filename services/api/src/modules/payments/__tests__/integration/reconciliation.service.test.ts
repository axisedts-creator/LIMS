// PG-T13 (C15) — reconciliation operations P12-P16 (02-TRD §5 rows P12-P16, §5.1 access log, §6.7 run row; AC-PG-08.1, 08.6-08.8; 07-SECURITY ST-24).
// Real service over the DB fake (helpers/merchantDb.ts: runs/findings tables with the 05-SCHEMA CHECKs + the one-running partial unique index) + scripted job queue (helpers/portHarness.ts).
// SEAM THE WRITER FOLLOWS: service/reconciliation.service.ts exports createReconciliationService(deps: PaymentsDeps) ->
//   { listReconciliationRuns(ctx, query?), getReconciliationRun(ctx, {runId}), startReconciliationRun(ctx, input?), listReconciliationFindings(ctx, query?),
//     resolveReconciliationFinding(ctx, {findingId, expectedVersion, body:{resolution_code, note?}}), startCronRun(ctx) }   // ctx.tx.query + ctx.now() + ctx.audit.access only
// [CONV] pinned here: a cron tick with a healthy running run starts nothing; the manual start ignores reconciliation_enabled; counts are `checked/ok/findings/critical` in the DTO.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makePortHarness, type PortHarness } from '../helpers/portHarness';
import { createReconciliationService } from '../../service/reconciliation.service.js';

const A = TENANTS.A, B = TENANTS.B;
const id = (n: number) => `01900000-0000-7000-8000-0000000e${String(n).padStart(4, '0')}`;
const RUN = (n: number) => id(100 + n), FND = (n: number) => id(200 + n), INT = (n: number) => id(300 + n);
const T = (iso: string) => Date.parse(iso);
const CRON_AT = T('2026-11-11T20:40:00Z');                      // 02:25 Asia/Kathmandu on 2026-11-12
const NOTE_SECRET = 'planted-note-xyz-SECRET-7731';

let h: PortHarness;
let svc: ReturnType<typeof createReconciliationService>;
const ctxOpts = (tenant: string, now: number) => ({ tenantId: tenant, now: () => new Date(now) });
const call = <T>(fn: (ctx: any) => Promise<T>, tenant: string = A, now: number = CRON_AT): Promise<T> =>
  h.db.run((c) => fn({ ...c, ports: h.ports }), ctxOpts(tenant, now));
const err = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e) => e);
const runRow = (n: number, o: Record<string, unknown> = {}) => h.db.put('payments.reconciliation_runs', { id: RUN(n), tenant_id: A, business_date: '2026-11-10', trigger: 'cron', status: 'completed',
  started_at: new Date(T('2026-11-10T20:40:00Z')), finished_at: new Date(T('2026-11-10T20:50:00Z')), checked_count: 4, ok_count: 3, findings_count: 1, critical_count: 1, created_by: A, updated_by: A, ...o });
const findingRow = (n: number, o: Record<string, unknown> = {}) => h.db.put('payments.reconciliation_findings', { id: FND(n), tenant_id: A, run_id: RUN(1), intent_id: INT(1), kind: 'missed_settlement',
  severity: 'warning', our_status: 'initiated', gateway_status_raw: 'COMPLETE', our_amount_paisa: 225000, gateway_amount_paisa: 225000, auto_action: 'settled', created_at: new Date(T('2026-11-11T20:41:00Z')),
  created_by: A, updated_by: A, ...o });

beforeEach(async () => {
  h = await makePortHarness();
  await h.seed({});
  svc = createReconciliationService(h.deps);
});

describe('P14 startReconciliationRun — run row, first batch job, one running run per tenant (AC-PG-08.1, TRD §6.7)', () => {
  it('inserts a running manual run (zero counts, version 1) and enqueues payments.reconcile_batch {tenant_id, run_id, phase: intents} with key recon:<run>:intents:start', async () => {
    const dto: any = await call((c) => svc.startReconciliationRun(c));
    expect(dto).toMatchObject({ trigger: 'manual', status: 'running', counts: { checked: 0, ok: 0, findings: 0, critical: 0 }, version: 1 });
    expect(dto.finished_at).toBeUndefined();
    expect(h.db.runs(A)).toHaveLength(1);
    expect(h.db.runs(A)[0]).toMatchObject({ id: dto.id, tenant_id: A, status: 'running', trigger: 'manual' });
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]).toMatchObject({ task: 'payments.reconcile_batch', payload: { tenant_id: A, run_id: dto.id, phase: 'intents' }, key: `recon:${dto.id}:intents:start` });
    expect(h.gateway.calls).toHaveLength(0);                    // starting a run never calls a gateway
  });

  it('a second start while one is running -> payments.reconciliation_in_progress; still exactly one running run and one job', async () => {
    await call((c) => svc.startReconciliationRun(c));
    const e = await err(call((c) => svc.startReconciliationRun(c)));
    expect(e.code).toBe('payments.reconciliation_in_progress');
    expect(h.db.runs(A).filter((r) => r.status === 'running')).toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
  });

  it('a seeded running run (e.g. the cron one) also blocks the manual start; completed / failed runs do not', async () => {
    runRow(1, { status: 'running', finished_at: null, trigger: 'cron' });
    expect((await err(call((c) => svc.startReconciliationRun(c)))).code).toBe('payments.reconciliation_in_progress');
    h.db.runs(A)[0]!.status = 'failed';
    await expect(call((c) => svc.startReconciliationRun(c))).resolves.toMatchObject({ status: 'running', trigger: 'manual' });
  });

  it('is per tenant: a running run of tenant B never blocks tenant A, and A\'s run is invisible to B', async () => {
    h.db.put('payments.reconciliation_runs', { id: RUN(9), tenant_id: B, business_date: '2026-11-12', trigger: 'manual', status: 'running', started_at: new Date(CRON_AT), created_by: B, updated_by: B });
    const a: any = await call((c) => svc.startReconciliationRun(c));
    expect(h.db.runs(A)).toHaveLength(1); expect(h.db.runs(B)).toHaveLength(1);
    expect((await err(call((c) => svc.getReconciliationRun(c, { runId: a.id }), B))).code).toBe('common.not_found');
  });

  it('the caller cannot choose trigger, date, tenant, counts or status: any body key -> common.validation_failed, no row, no job', async () => {
    for (const body of [{ trigger: 'cron' }, { business_date: '2020-01-01' }, { tenant_id: B }, { counts: { checked: 9 } }, { status: 'completed' }, []] as unknown[]) {
      expect((await err(call((c) => svc.startReconciliationRun(c, body)))).code).toBe('common.validation_failed');
    }
    expect(h.db.runs(A)).toHaveLength(0); expect(h.jobs).toHaveLength(0);
  });

  it('AC-PG-08.8: a manual run uses the CURRENT Kathmandu date (UTC+05:45), also across the UTC midnight boundary', async () => {
    const at = async (iso: string) => { const d: any = await call((c) => svc.startReconciliationRun(c), A, T(iso)); h.db.runs(A).forEach((r) => { r.status = 'completed'; }); return d.business_date; };
    expect(await at('2026-11-11T20:40:00Z')).toBe('2026-11-12');   // 02:25 next day in Kathmandu
    expect(await at('2026-11-11T18:14:59Z')).toBe('2026-11-11');   // 23:59:59 Kathmandu
    expect(await at('2026-11-11T18:15:00Z')).toBe('2026-11-12');   // 00:00:00 Kathmandu
    expect(await at('2026-11-12T06:00:00Z')).toBe('2026-11-12');
  });
});

describe('AC-PG-08.8 + 08.6 startCronRun (the payments.reconcile_tenant body)', () => {
  it('a cron run at 02:25 Kathmandu has business_date = the PREVIOUS Kathmandu date and enqueues only the first batch (no gateway call)', async () => {
    await call((c) => svc.startCronRun(c));
    const r = h.db.runs(A);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ trigger: 'cron', status: 'running', checked_count: 0, version: 1 });
    expect(String(r[0]!.business_date).slice(0, 10)).toBe('2026-11-11');
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]).toMatchObject({ task: 'payments.reconcile_batch', payload: { tenant_id: A, run_id: r[0]!.id, phase: 'intents' }, key: `recon:${r[0]!.id}:intents:start` });
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('the cron date is derived in Kathmandu, not UTC: 18:15Z (Kathmandu midnight) -> previous Kathmandu day, 18:14Z -> the day before that', async () => {
    await call((c) => svc.startCronRun(c), A, T('2026-11-11T18:15:00Z'));
    expect(String(h.db.runs(A)[0]!.business_date).slice(0, 10)).toBe('2026-11-11');
    h.db.runs(A)[0]!.status = 'completed';
    await call((c) => svc.startCronRun(c), A, T('2026-11-11T18:14:00Z'));
    expect(String(h.db.runs(A)[1]!.business_date).slice(0, 10)).toBe('2026-11-10');
  });

  it('reconciliation_enabled = false: no run row, no job', async () => {
    h.db.settings(A).forEach((s) => { s.reconciliation_enabled = false; });
    h.db.put('payments.settings', { tenant_id: A, reconciliation_enabled: false, created_by: A, updated_by: A });
    await call((c) => svc.startCronRun(c));
    expect(h.db.runs(A)).toHaveLength(0); expect(h.jobs).toHaveLength(0);
  });

  it('stalled-run rule: a running run with updated_at older than 2 h is failed (error_code stalled, finished_at set) and a new run starts', async () => {
    runRow(1, { status: 'running', finished_at: null, updated_at: new Date(CRON_AT - 2 * 3600_000 - 1000), started_at: new Date(CRON_AT - 5 * 3600_000) });
    await call((c) => svc.startCronRun(c));
    const old = h.db.runs(A).find((r) => r.id === RUN(1))!;
    expect(old).toMatchObject({ status: 'failed', error_code: 'stalled' });
    expect(old.finished_at).toBeInstanceOf(Date);
    expect(old.version).toBe(2);
    const fresh = h.db.runs(A).filter((r) => r.status === 'running');
    expect(fresh).toHaveLength(1); expect(fresh[0]).toMatchObject({ id: expect.not.stringMatching(RUN(1)), trigger: 'cron' });
    expect(h.jobs.filter((j) => j.task === 'payments.reconcile_batch')).toHaveLength(1);
  });

  it('a running run updated 1 h 59 min ago is healthy: it stays running, nothing new starts (no second running run)', async () => {
    runRow(1, { status: 'running', finished_at: null, updated_at: new Date(CRON_AT - 119 * 60_000) });
    await call((c) => svc.startCronRun(c)).catch((e) => { expect(e.code).toBe('payments.reconciliation_in_progress'); });
    expect(h.db.runs(A).map((r) => [r.id, r.status])).toEqual([[RUN(1), 'running']]);
    expect(h.jobs).toHaveLength(0);
  });

  it('the stalled boundary is strict: updated exactly 2 h ago is still healthy', async () => {
    runRow(1, { status: 'running', finished_at: null, updated_at: new Date(CRON_AT - 2 * 3600_000) });
    await call((c) => svc.startCronRun(c)).catch(() => undefined);
    expect(h.db.runs(A)[0]!.status).toBe('running'); expect(h.db.runs(A)).toHaveLength(1);
  });

  it('only the job\'s own tenant is touched: a stalled run of tenant B survives tenant A\'s tick', async () => {
    h.db.put('payments.reconciliation_runs', { id: RUN(9), tenant_id: B, business_date: '2026-11-10', trigger: 'cron', status: 'running', started_at: new Date(CRON_AT - 9 * 3600_000), updated_at: new Date(CRON_AT - 9 * 3600_000), created_by: B, updated_by: B });
    await call((c) => svc.startCronRun(c), A);
    expect(h.db.runs(B)[0]!.status).toBe('running');
  });
});

describe('P12 listReconciliationRuns / P13 getReconciliationRun (AC-PG-08.7)', () => {
  beforeEach(() => {
    runRow(1, { business_date: '2026-11-08' }); runRow(2, { business_date: '2026-11-09', status: 'failed' }); runRow(3, { business_date: '2026-11-10' });
    runRow(4, { business_date: '2026-11-11', trigger: 'manual', status: 'running', finished_at: null, checked_count: 0, ok_count: 0, findings_count: 0, critical_count: 0 });
    h.db.put('payments.reconciliation_runs', { id: RUN(9), tenant_id: B, business_date: '2026-11-11', trigger: 'cron', status: 'completed', started_at: new Date(CRON_AT), created_by: B, updated_by: B });
  });
  const list = (q?: unknown, tenant = A): Promise<any> => call((c) => svc.listReconciliationRuns(c, q), tenant);

  it('returns this tenant\'s runs newest business_date first, RunDto shape with counts {checked, ok, findings, critical} and version; never another tenant\'s', async () => {
    const r = await list();
    expect(r.data.map((x: any) => x.id)).toEqual([RUN(4), RUN(3), RUN(2), RUN(1)]);
    expect(r.data[1]).toEqual({ id: RUN(3), business_date: '2026-11-10', trigger: 'cron', status: 'completed', started_at: '2026-11-10T20:40:00.000Z', finished_at: '2026-11-10T20:50:00.000Z',
      counts: { checked: 4, ok: 3, findings: 1, critical: 1 }, version: 1 });
    expect(r.data[0].finished_at).toBeUndefined();
    expect(r.page).toMatchObject({ limit: 50 });
  });

  it('filters: status, business_date_from / _to (inclusive), sort=-business_date accepted', async () => {
    expect((await list({ status: 'failed' })).data.map((x: any) => x.id)).toEqual([RUN(2)]);
    expect((await list({ business_date_from: '2026-11-09', business_date_to: '2026-11-10' })).data.map((x: any) => x.id)).toEqual([RUN(3), RUN(2)]);
    expect((await list({ sort: '-business_date' })).data).toHaveLength(4);
  });

  it('keyset paging: limit 2 -> next_cursor -> the rest, no overlap, last page has no next_cursor', async () => {
    const p1 = await list({ limit: 2 });
    expect(p1.data.map((x: any) => x.id)).toEqual([RUN(4), RUN(3)]); expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = await list({ limit: 2, cursor: p1.page.next_cursor });
    expect(p2.data.map((x: any) => x.id)).toEqual([RUN(2), RUN(1)]); expect(p2.page.next_cursor).toBeUndefined();
  });

  it('rejects bad input with common.validation_failed (limit 0 / 201 / "abc", unknown status, sort, impossible date, unknown parameter, tenant_id)', async () => {
    for (const q of [{ limit: 0 }, { limit: 201 }, { limit: 'abc' }, { status: 'bogus' }, { sort: 'business_date' }, { business_date_from: '2026-02-30' }, { business_date_to: 'yesterday' }, { foo: 1 }, { tenant_id: B }]) {
      expect((await err(list(q))).code).toBe('common.validation_failed');
    }
  });

  it('a malformed / foreign cursor -> common.invalid_cursor (a findings cursor is not a runs cursor)', async () => {
    findingRow(1); findingRow(2); findingRow(3);
    const fc = (await call((c) => svc.listReconciliationFindings(c, { limit: 1 }))).page.next_cursor;
    for (const cursor of ['not-a-cursor', '', fc, Buffer.from('{"k":"runs"}').toString('base64url')]) expect((await err(list({ cursor }))).code).toBe('common.invalid_cursor');
  });

  it('P13 get: one run; another tenant\'s run id and an unknown id -> common.not_found; a non-uuid -> common.validation_failed', async () => {
    expect(await call((c) => svc.getReconciliationRun(c, { runId: RUN(3) }))).toMatchObject({ id: RUN(3), status: 'completed', counts: { checked: 4, ok: 3, findings: 1, critical: 1 } });
    expect((await err(call((c) => svc.getReconciliationRun(c, { runId: RUN(9) })))).code).toBe('common.not_found');
    expect((await err(call((c) => svc.getReconciliationRun(c, { runId: RUN(77) })))).code).toBe('common.not_found');
    expect((await err(call((c) => svc.getReconciliationRun(c, { runId: 'nope' })))).code).toBe('common.validation_failed');
  });
});

describe('P15 listReconciliationFindings (AC-PG-08.7)', () => {
  beforeEach(() => {
    findingRow(1, { kind: 'still_held', severity: 'info', auto_action: 'none', created_at: new Date(T('2026-11-11T20:41:00Z')) });
    findingRow(2, { kind: 'late_payment_found', severity: 'critical', auto_action: 'held', created_at: new Date(T('2026-11-11T20:42:00Z')) });
    findingRow(3, { kind: 'missed_settlement', severity: 'warning', run_id: RUN(2), created_at: new Date(T('2026-11-11T20:43:00Z')) });
    findingRow(4, { kind: 'amount_mismatch', severity: 'critical', status: 'resolved', resolution_code: 'confirmed_ok', resolved_by: A, resolved_at: new Date(T('2026-11-12T01:00:00Z')), created_at: new Date(T('2026-11-11T20:44:00Z')) });
    h.db.put('payments.reconciliation_findings', { id: FND(9), tenant_id: B, run_id: RUN(9), intent_id: INT(9), kind: 'status_divergence', severity: 'critical', created_by: B, updated_by: B });
  });
  const list = (q?: unknown, tenant = A): Promise<any> => call((c) => svc.listReconciliationFindings(c, q), tenant);

  it('default sort -created_at; FindingDto carries intent link, statuses, amounts as Money; no tenant_id/created_by leak; tenant B\'s finding is invisible', async () => {
    const r = await list();
    expect(r.data.map((x: any) => x.id)).toEqual([FND(4), FND(3), FND(2), FND(1)]);
    expect(r.data[2]).toEqual({ id: FND(2), run_id: RUN(1), kind: 'late_payment_found', severity: 'critical', intent_id: INT(1), our_status: 'initiated', gateway_status_raw: 'COMPLETE',
      our_amount: { amount_paisa: 225000, currency: 'NPR' }, gateway_amount: { amount_paisa: 225000, currency: 'NPR' }, auto_action: 'held', status: 'open', created_at: '2026-11-11T20:42:00.000Z', version: 1 });
    expect(JSON.stringify(r)).not.toMatch(/tenant_id|created_by|updated_by/);
    expect(r.data[0]).toMatchObject({ status: 'resolved', resolution_code: 'confirmed_ok', resolved_by: { membership_id: A }, resolved_at: '2026-11-12T01:00:00.000Z' });
  });

  it('filters: status, severity, run_id, kind (single and comma list)', async () => {
    expect((await list({ status: 'resolved' })).data.map((x: any) => x.id)).toEqual([FND(4)]);
    expect((await list({ severity: 'critical' })).data.map((x: any) => x.id)).toEqual([FND(4), FND(2)]);
    expect((await list({ run_id: RUN(2) })).data.map((x: any) => x.id)).toEqual([FND(3)]);
    expect((await list({ kind: 'still_held' })).data.map((x: any) => x.id)).toEqual([FND(1)]);
    expect((await list({ kind: 'still_held,missed_settlement' })).data.map((x: any) => x.id)).toEqual([FND(3), FND(1)]);
    expect((await list({ status: 'open', severity: 'critical' })).data.map((x: any) => x.id)).toEqual([FND(2)]);
  });

  it('sort=severity puts critical first, then warning, then info (newest first inside a severity)', async () => {
    expect((await list({ sort: 'severity' })).data.map((x: any) => x.id)).toEqual([FND(4), FND(2), FND(3), FND(1)]);
  });

  it('keyset paging with both sorts walks every finding exactly once', async () => {
    for (const sort of ['-created_at', 'severity']) {
      const seen: string[] = []; let cursor: string | undefined;
      for (let i = 0; i < 6; i++) { const p = await list({ sort, limit: 1, ...(cursor ? { cursor } : {}) }); seen.push(...p.data.map((x: any) => x.id)); cursor = p.page.next_cursor; if (!cursor) break; }
      expect(new Set(seen).size).toBe(4); expect(seen).toHaveLength(4);
    }
  });

  it('rejects unknown kind / severity / status / sort / limit / non-uuid run_id / unknown parameter -> common.validation_failed; a runs cursor -> common.invalid_cursor', async () => {
    for (const q of [{ kind: 'bogus' }, { kind: 'still_held,bogus' }, { severity: 'fatal' }, { status: 'closed' }, { sort: 'kind' }, { limit: 0 }, { limit: 201 }, { run_id: 'x' }, { tenant_id: B }]) {
      expect((await err(list(q))).code).toBe('common.validation_failed');
    }
    runRow(1); runRow(2);
    const rc = (await call((c) => svc.listReconciliationRuns(c, { limit: 1 }))).page.next_cursor;
    expect((await err(list({ cursor: rc }))).code).toBe('common.invalid_cursor');
  });
});

describe('P16 resolveReconciliationFinding — payments.intent.resolve + reason, access log (AC-PG-08.7, ST-24, D-112)', () => {
  const resolve = (o: Record<string, unknown> = {}, tenant: string = A): Promise<any> =>
    call((c) => svc.resolveReconciliationFinding(c, { findingId: FND(1), expectedVersion: 1, body: { resolution_code: 'confirmed_ok' }, ...o }), tenant);
  beforeEach(() => { runRow(1, { status: 'running', finished_at: null }); findingRow(1); });

  it('resolves: status resolved, resolution_code, resolved_by = the actor membership, resolved_at = now, version +1; the DTO shows it', async () => {
    const dto = await resolve({ body: { resolution_code: 'refunded_outside_system_recorded', note: 'refunded in the eSewa portal' } });
    expect(dto).toMatchObject({ id: FND(1), status: 'resolved', resolution_code: 'refunded_outside_system_recorded', note: 'refunded in the eSewa portal', resolved_at: new Date(CRON_AT).toISOString(), version: 2 });
    expect(typeof dto.resolved_by.membership_id).toBe('string');
    const row = h.db.findings(A)[0]!;
    expect(row).toMatchObject({ status: 'resolved', resolution_code: 'refunded_outside_system_recorded', version: 2 }); expect(row.resolved_by).toBe(dto.resolved_by.membership_id);
  });

  it('writes exactly one access-log row payment_intent.resolve on the finding, in the same transaction, detail = the resolution code only (never the note)', async () => {
    await resolve({ body: { resolution_code: 'escalated_to_provider', note: NOTE_SECRET } });
    expect(h.db.accessRows(A)).toEqual([{ action: 'payment_intent.resolve', entityType: 'reconciliation_finding', entityId: FND(1), outcome: 'allowed', detail: { resolution_code: 'escalated_to_provider' } }]);
    expect(JSON.stringify(h.db.accessRows(A))).not.toContain(NOTE_SECRET);
    expect(JSON.stringify(h.db.logs)).not.toContain(NOTE_SECRET);
  });

  it('every resolution code of the coded set is accepted; "other" needs a note; unknown code -> common.validation_failed', async () => {
    for (const [i, code] of ['confirmed_ok', 'refunded_outside_system_recorded', 'escalated_to_provider', 'ledger_corrected_in_billing', 'false_positive'].entries()) {
      findingRow(10 + i); await expect(resolve({ findingId: FND(10 + i), body: { resolution_code: code } })).resolves.toMatchObject({ status: 'resolved', resolution_code: code });
    }
    expect((await err(resolve({ body: { resolution_code: 'other' } }))).code).toBe('common.validation_failed');
    expect((await err(resolve({ body: { resolution_code: 'other', note: '' } }))).code).toBe('common.validation_failed');
    await expect(resolve({ body: { resolution_code: 'other', note: 'finance agreed offline' } })).resolves.toMatchObject({ resolution_code: 'other' });
    findingRow(20);
    expect((await err(resolve({ findingId: FND(20), body: { resolution_code: 'whatever' } }))).code).toBe('common.validation_failed');
    expect(h.db.findings(A).find((f) => f.id === FND(20))!.status).toBe('open');
  });

  it('validation: missing / extra body keys, note > 1000 chars, non-string note, non-uuid id, bad expectedVersion; none leaves an access row or a changed finding', async () => {
    const bad: Record<string, unknown>[] = [{ body: {} }, { body: { resolution_code: 'confirmed_ok', extra: 1 } }, { body: { resolution_code: 'confirmed_ok', note: 'x'.repeat(1001) } }, { body: { resolution_code: 'confirmed_ok', note: 5 } },
      { body: { resolution_code: 'confirmed_ok', status: 'open' } }, { findingId: 'nope' }, { expectedVersion: 0 }, { expectedVersion: '1' }, { expectedVersion: 1.5 }, { body: undefined }, { findingId: undefined }];
    for (const o of bad) expect((await err(resolve(o))).code).toBe('common.validation_failed');
    await expect(resolve({ body: { resolution_code: 'confirmed_ok', note: 'x'.repeat(1000) } })).resolves.toMatchObject({ status: 'resolved' });   // 1000 is the limit
    expect(h.db.accessRows(A)).toHaveLength(1);
  });

  it('no expectedVersion -> common.precondition_required; stale version -> common.version_conflict; unknown / other tenant\'s finding -> common.not_found', async () => {
    expect((await err(resolve({ expectedVersion: undefined }))).code).toBe('common.precondition_required');
    expect((await err(resolve({ expectedVersion: 7 }))).code).toBe('common.version_conflict');
    expect((await err(resolve({ findingId: FND(77) }))).code).toBe('common.not_found');
    h.db.put('payments.reconciliation_findings', { id: FND(9), tenant_id: B, run_id: RUN(9), intent_id: INT(9), kind: 'still_held', severity: 'info', created_by: B, updated_by: B });
    expect((await err(resolve({ findingId: FND(9) }))).code).toBe('common.not_found');
    expect(h.db.findings(B)[0]!.status).toBe('open'); expect(h.db.findings(A)[0]!.status).toBe('open'); expect(h.db.accessRows(A)).toEqual([]);
  });

  it('a resolution is never overwritten: resolving a resolved finding -> common.immutable_record, code and note stay, no second access row', async () => {
    await resolve({ body: { resolution_code: 'confirmed_ok', note: 'first' } });
    const e = await err(resolve({ expectedVersion: 2, body: { resolution_code: 'false_positive', note: 'second' } }));
    expect(e.code).toBe('common.immutable_record');
    expect(h.db.findings(A)[0]).toMatchObject({ resolution_code: 'confirmed_ok', note: 'first', version: 2 });
    expect(h.db.accessRows(A)).toHaveLength(1);
  });

  it('P16 never touches the intent, a refund or the ledger (a finding is a review record)', async () => {
    const before = h.db.stmts.length;
    await resolve();
    const writes = h.db.stmts.slice(before).filter((s) => /^\s*(update|insert|delete)\b/i.test(s.text)).map((s) => s.text.toLowerCase());
    expect(writes.every((w) => /reconciliation_findings|access_log/.test(w))).toBe(true);
    expect(h.ledger.calls).toHaveLength(0); expect(h.gateway.calls).toHaveLength(0);
  });

  it('a non user/system actor is refused before any state read', async () => {
    const e = await err(h.db.run((c) => svc.resolveReconciliationFinding({ ...c, ports: h.ports, actor: { type: 'service', id: A } }, { findingId: FND(1), expectedVersion: 1, body: { resolution_code: 'confirmed_ok' } }), ctxOpts(A, CRON_AT)));
    expect(e.code).toBe('auth.forbidden');
    expect(h.db.findings(A)[0]!.status).toBe('open');
  });
});

describe('fixture sanity', () => {
  it('FIXED_NOW is the shared fake clock (guards the date arithmetic above)', () => { expect(FIXED_NOW).toBe('2026-11-05T04:15:00.000Z'); });
});
