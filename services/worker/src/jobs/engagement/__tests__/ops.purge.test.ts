// C16.T-OPS1 — crons `engagement.purge_ephemeral` (hourly :37) and `engagement.purge_queue` (daily 03:10), both per_tenant (08 A13 P-6).
// Sources: 02-TRD §8.2 rows; 05-SCHEMA §5.3 (class-E deletes by the system actor under `<t>__delete__tenant`, NO DEFINER; 08 A17 P-18(c), A19 P-41/D-121), §6.4 (the only two purge DEFINERs,
// `engagement.purge_payment_requests()` / `engagement.purge_queue()`), §9 retention; plan row T-OPS1 ("purge tasks call the 6.4 DEFINERs; all crons per_tenant").
// Fails now: manifest has no cron row and only a fail-closed stub for neither task (`engagement.purge_ephemeral` / `engagement.purge_queue` are not registered).
//
// SEAMS (spec fixes behaviour, not file/function names; same convention as T-Q2/T-R1):
//   tasks are manifest.tasks['engagement.purge_ephemeral'] / ['engagement.purge_queue'], payload {tenant_id}; DB only through ctx.tx.query(sql, params) as the system actor (ctx.actor.type 'system').
//   crontab schedule fields are UTC (core/manifest.ts); NPT = UTC+05:45: hourly :37 NPT = minute 52 UTC, daily 03:10 NPT = 21:25 UTC.
//   Tenant guard (REQ-SEC-024, as close_queue_day): runs only when payload.tenant_id is a uuid equal to ctx.tenantId, otherwise it resolves without running ANY statement.
//   SQL is asserted on text (whitespace-folded, case-insensitive) because the DEFINER bodies and RLS policies are exercised for real in db/tests/engagement/T-OPS1_purge.test.sql;
//   here we pin WHAT the task asks the database to do: the right statements, in the right order, tenant-bound, never touching the guard GUC, never deleting anything the spec keeps.
//   Open in the spec (NOT asserted): batching/LIMIT, metrics emitted by the purge, the exact column order of the redaction UPDATE, the return value of the task.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

const EPH = 'engagement.purge_ephemeral', QUE = 'engagement.purge_queue';
const TA = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const SYSTEM = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

interface Call { sql: string; params: unknown[] }
function setup(opts: { tenantId?: string | null; failOn?: RegExp } = {}) {
  const calls: Call[] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = norm(sql);
      calls.push({ sql: text, params });
      if (opts.failOn?.test(text)) throw new Error('boom');
      if (/select\s+engagement\.purge_/.test(text)) return { rows: [{ purge_queue: 4, purge_payment_requests: 2, count: 2 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const ctx: any = {
    tenantId: opts.tenantId === null ? undefined : (opts.tenantId ?? TA), tx, actor: { type: 'system', id: SYSTEM }, requestId: 'r', attempt: 1, maxAttempts: 3, jobId: '1',
    now: () => '2026-11-13T06:00:00.000Z', isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, audit: {},
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { calls, ctx };
}
const run = async (id: string, payload: Record<string, unknown> = { tenant_id: TA }, opts: Parameters<typeof setup>[0] = {}) => {
  const s = setup(opts);
  await (manifest.tasks as any)[id](payload, s.ctx);
  return s.calls;
};
const dml = (calls: Call[]) => calls.filter((c) => /^(delete|update|insert|truncate)\b/.test(c.sql));
const deletes = (calls: Call[]) => calls.filter((c) => /^delete\b/.test(c.sql));
const from = (calls: Call[], table: string) => calls.filter((c) => new RegExp(`^delete from engagement\\.${table}\\b`).test(c.sql));
const tenantBound = (c: Call) => c.params.includes(TA) || /app\.current_tenant_id\(\)/.test(c.sql);

describe('manifest + crontab (02-TRD §8.2, 08 A13 P-6)', () => {
  it('both tasks are registered functions, the manifest still validates, and no purge stub throws "not implemented"', () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(typeof manifest.tasks?.[EPH]).toBe('function'); expect(typeof manifest.tasks?.[QUE]).toBe('function');
  });

  it('purge_ephemeral: hourly :37 NPT = `52 * * * *` UTC, per_tenant', () => {
    const row = manifest.crontab?.find((c) => c.identifier === EPH);
    expect(row, EPH).toBeDefined();
    expect(row!.schedule).toBe('52 * * * *'); expect(row!.tenantScope).toBe('per_tenant');
  });

  it('purge_queue: daily 03:10 NPT = `25 21 * * *` UTC, per_tenant', () => {
    const row = manifest.crontab?.find((c) => c.identifier === QUE);
    expect(row, QUE).toBeDefined();
    expect(row!.schedule).toBe('25 21 * * *'); expect(row!.tenantScope).toBe('per_tenant');
  });

  it('every cron row of the module is per_tenant and names a registered task; the earlier rows are still there', () => {
    const rows = manifest.crontab ?? [];
    for (const c of rows) { expect(c.tenantScope, c.identifier).toBe('per_tenant'); expect(typeof manifest.tasks?.[c.identifier], c.identifier).toBe('function'); }
    for (const id of ['engagement.close_queue_day', 'engagement.dispatch_due_reminders', EPH, QUE]) expect(rows.map((r) => r.identifier), id).toContain(id);
    expect(new Set(rows.map((r) => r.identifier)).size).toBe(rows.length);
  });
});

describe('engagement.purge_queue (05-SCHEMA §6.4: tokens + day counters older than 1 year)', () => {
  it('runs exactly one statement: SELECT engagement.purge_queue() (the DEFINER), with no argument', async () => {
    const calls = await run(QUE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/^select\s+(\*\s+from\s+)?engagement\.purge_queue\(\s*\)/);
    expect(calls[0]!.params ?? []).toHaveLength(0);
  });

  it('never deletes or touches the guard GUC itself: no DELETE, no set_config, no app.maintenance (only the DEFINER may set it; a task that sets it defeats the owner policies)', async () => {
    const calls = await run(QUE);
    expect(dml(calls)).toEqual([]);
    for (const c of calls) { expect(c.sql).not.toMatch(/app\.maintenance|set_config|set\s+(local\s+)?app\./); expect(c.sql).not.toMatch(/queue_tokens|queue_day_counters/); }
  });

  it('tenant guard: a payload tenant that is missing, not a uuid, or not the job tenant runs NO statement', async () => {
    for (const payload of [{}, { tenant_id: 'x' }, { tenant_id: TB }, { tenant_id: null }, { tenant_id: [TA] }]) {
      expect(await run(QUE, payload as any), JSON.stringify(payload)).toEqual([]);
    }
    expect(await run(QUE, { tenant_id: TA }, { tenantId: null })).toEqual([]);
  });

  it('a DEFINER error (e.g. purge_requires_system_tenant_claims) fails the job so it is retried/dead-lettered, never swallowed', async () => {
    await expect(run(QUE, { tenant_id: TA }, { failOn: /purge_queue/ })).rejects.toThrow('boom');
  });
});

describe('engagement.purge_ephemeral (02-TRD §8.2; 05-SCHEMA §5.3 class-E deletes, §9 retention)', () => {
  it('deletes otp_challenges past expires_at + 24 hours', async () => {
    const [d, ...more] = from(await run(EPH), 'otp_challenges');
    expect(d, 'otp_challenges delete').toBeDefined(); expect(more).toHaveLength(0);
    expect(d!.sql).toMatch(/expires_at\s*<\s*now\(\)\s*-\s*interval\s*'24 hours?'/);
    expect(tenantBound(d!)).toBe(true);
  });

  it('deletes link_codes past expires_at + 90 days, but only those NOT referenced by an account_patient_links row (a referenced code is kept for the link lifetime)', async () => {
    const [d, ...more] = from(await run(EPH), 'link_codes');
    expect(d, 'link_codes delete').toBeDefined(); expect(more).toHaveLength(0);
    expect(d!.sql).toMatch(/expires_at\s*<\s*now\(\)\s*-\s*interval\s*'90 days'/);
    expect(d!.sql).toMatch(/not exists\s*\(\s*select 1 from engagement\.account_patient_links \w+ where \w+\.tenant_id\s*=\s*(engagement\.)?link_codes\.tenant_id and \w+\.link_code_id\s*=\s*(engagement\.)?link_codes\.id\s*\)/);
    expect(tenantBound(d!)).toBe(true);
  });

  it('deletes notifications past expires_at', async () => {
    const [d, ...more] = from(await run(EPH), 'notifications');
    expect(d, 'notifications delete').toBeDefined(); expect(more).toHaveLength(0);
    expect(d!.sql).toMatch(/expires_at\s*<\s*now\(\)(?!\s*-)/); expect(tenantBound(d!)).toBe(true);
  });

  it('deletes number_counters rate keys past expires_at, and never the numbering keys (expires_at IS NULL)', async () => {
    const [d, ...more] = from(await run(EPH), 'number_counters');
    expect(d, 'number_counters delete').toBeDefined(); expect(more).toHaveLength(0);
    expect(d!.sql).toMatch(/expires_at is not null/); expect(d!.sql).toMatch(/expires_at\s*<\s*now\(\)/); expect(tenantBound(d!)).toBe(true);
  });

  it('redacts self_registrations personal fields 30 days after terminal by UPDATE (full_name, sex, birth_on, age_years -> NULL); the ROW is kept (B15: no row delete)', async () => {
    const calls = await run(EPH);
    const u = calls.filter((c) => /^update engagement\.self_registrations\b/.test(c.sql));
    expect(u, 'self_registrations update').toHaveLength(1);
    for (const col of ['full_name', 'sex', 'birth_on', 'age_years']) expect(u[0]!.sql, col).toMatch(new RegExp(`\\b${col}\\s*=\\s*null\\b`));
    expect(u[0]!.sql).toMatch(/expires_at\s*<\s*now\(\)/);
    expect(u[0]!.sql).toMatch(/where .*\bis not null\b/);   // idempotent: an already redacted row is not rewritten (updated_at stays)
    expect(u[0]!.sql).toMatch(/status\s*(<>|!=)\s*'queued'|status in \('created',\s*'failed'\)|status in \('failed',\s*'created'\)/);   // terminal only (self_registrations__queued_fields__ck forbids nulling a queued row)
    expect(tenantBound(u[0]!)).toBe(true);
    expect(from(calls, 'self_registrations')).toEqual([]);
  });

  it('auto-closes enquiries open/answered with last_message_at older than 30 days (03-APP-FLOW §4.5); closed_at is set with the status (enquiries__closed__ck)', async () => {
    const u = (await run(EPH)).filter((c) => /^update engagement\.enquiries\b/.test(c.sql));
    expect(u, 'enquiries update').toHaveLength(1);
    expect(u[0]!.sql).toMatch(/status\s*=\s*'closed'/); expect(u[0]!.sql).toMatch(/closed_at\s*=\s*(now\(\)|\$\d)/);
    expect(u[0]!.sql).toMatch(/status in \('open',\s*'answered'\)/); expect(u[0]!.sql).toMatch(/last_message_at\s*<\s*now\(\)\s*-\s*interval\s*'30 days'/);
    expect(tenantBound(u[0]!)).toBe(true);
  });

  it('then calls the DEFINER SELECT engagement.purge_payment_requests() exactly once, AFTER all the class-E statements, with no argument', async () => {
    const calls = await run(EPH);
    const idx = calls.map((c, i) => (/engagement\.purge_payment_requests\(\s*\)/.test(c.sql) ? i : -1)).filter((i) => i >= 0);
    expect(idx).toHaveLength(1);
    expect(calls[idx[0]!]!.sql).toMatch(/^select\b/); expect(calls[idx[0]!]!.params ?? []).toHaveLength(0);
    expect(idx[0]).toBe(calls.length - 1);
    expect(calls.length).toBeGreaterThanOrEqual(7);   // 4 deletes + 2 updates + the DEFINER call
  });

  it('deletes ONLY from the four class-E tables; never from rows the spec keeps (queue, payments, bookings, accounts, links, consents, enquiries, reminders, self_registrations)', async () => {
    const calls = await run(EPH);
    const tables = deletes(calls).map((c) => /^delete from (?:engagement\.)?(\w+)/.exec(c.sql)?.[1]);
    expect(tables.sort()).toEqual(['link_codes', 'notifications', 'number_counters', 'otp_challenges']);
    expect(calls.filter((c) => /\btruncate\b/.test(c.sql))).toEqual([]);
    expect(calls.filter((c) => /engagement\.purge_queue\(/.test(c.sql))).toEqual([]);   // purge_queue is its own daily task
  });

  it('never sets the guard GUC itself (the DEFINER does; a task-side app.maintenance would let the policies be bypassed)', async () => {
    for (const c of await run(EPH)) expect(c.sql).not.toMatch(/app\.maintenance|set_config|set\s+(local\s+)?app\./);
  });

  it('every DELETE/UPDATE is tenant-scoped to the job tenant and never binds another tenant (REQ-SEC-024)', async () => {
    const calls = await run(EPH);
    for (const c of dml(calls)) { expect(tenantBound(c), c.sql.slice(0, 60)).toBe(true); expect(c.params, c.sql.slice(0, 60)).not.toContain(TB); }
  });

  it('tenant guard: a payload tenant that is missing, not a uuid, or not the job tenant runs NO statement', async () => {
    for (const payload of [{}, { tenant_id: 'x' }, { tenant_id: TB }, { tenant_id: null }]) {
      expect(await run(EPH, payload as any), JSON.stringify(payload)).toEqual([]);
    }
    expect(await run(EPH, { tenant_id: TA }, { tenantId: null })).toEqual([]);
  });

  it('a failing statement fails the job (retry/dead-letter), and the payment-requests DEFINER is not reached after it', async () => {
    const s = setup({ failOn: /delete from engagement\.notifications/ });
    await expect((manifest.tasks as any)[EPH]({ tenant_id: TA }, s.ctx)).rejects.toThrow('boom');
    expect(s.calls.some((c) => /purge_payment_requests/.test(c.sql))).toBe(false);
  });

  it('is idempotent: two runs issue the same statements (no counters or state carried between runs)', async () => {
    const a = await run(EPH), b = await run(EPH);
    expect(b.map((c) => c.sql)).toEqual(a.map((c) => c.sql));
  });
});
