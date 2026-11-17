// C13 T21 — housekeeping jobs: partners.expire_drafts, partners.redact_expired_lines, cron.ts.
// done_when (06-IMPLEMENTATION-PLAN row T21): every cron task tenantScope 'per_tenant' (08 A13 P-6); drafts discarded + redacted after the TTL;
// redaction via the owner function partners.redact_lines(p_tenant_id uuid, p_older_than timestamptz) (05-SCHEMA §8; the DEFINER itself sets
// app.maintenance = 'partners_redact_lines', 08 A10.5 / A12.2 / A19 P-41); download_counters past expires_at deleted by the system actor (A17 P-18(c)).
// 02-TRD §8.1 rows expire_drafts / redact_expired_lines (3 attempts), §8.2 cron table, §10.2 draft_ttl_days (default 30), 05-SCHEMA §6 retention table.
//
// WHAT THESE TESTS CAN PROVE: the tasks run against a statement RECORDER (ctx.tx.query logs every statement + values and returns canned rows), so they
// pin the SQL the task sends (tables, tenant scoping, cutoffs, which function it calls), not what a real Postgres does with it. The DB side
// (DEFINER non-zero rows under FORCE RLS, trigger gating, delete policy) is C0-0B DDL (05-SCHEMA §8 DEFINER tests 2-3) and is NOT provable here:
// partners DDL is not in db/migrations (06-PLAN prerequisites row 1) - see .orchestra/notes/C13.T21-tests.md.
// SEAMS (names the spec does not fix; the writer must match them or dispute): task exports `expireDrafts` / `redactExpiredLines` (precedent
// convertManifestLine, T10); cron.ts exports `crontab` (precedent billing/frontdesk cron.ts) and index.ts uses it; IdentityPort via ctx.ports.IdentityPort
// (precedent analytics.purge); redact_lines invoked as `SELECT partners.redact_lines($1, <cutoff>)` with the tenant as first bound value; payload {tenant_id}.
import { describe, expect, it } from 'vitest';
import { crontab } from '../cron.js';
import { manifest } from '../index.js';
import { expireDrafts } from '../tasks/partners.expire_drafts.js';
import { redactExpiredLines } from '../tasks/partners.redact_expired_lines.js';

const T = '0190a000-0000-7000-8000-0000000c1301';
const OTHER = '0190a000-0000-7000-8000-0000000c1302';
const SYS = '0190a000-0000-7000-8000-0000000c1380';
const NOW = '2026-11-13T00:00:00.000Z';
const DAY = 86_400_000;
const PHI = 'SENTINEL-PHI-Test-Patient-0042';

interface Stmt { text: string; vals: unknown[] }
interface Opts { ttl?: number | undefined; retentionYears?: unknown; redacted?: number; counters?: number; failOn?: RegExp; identityThrows?: boolean; drafts?: number }

function makeCtx(o: Opts = {}) {
  const stmts: Stmt[] = []; const logs: string[] = []; const idCalls: unknown[] = [];
  const sink = (...a: unknown[]) => logs.push(JSON.stringify(a));
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child: () => log };
  const tx: any = {
    async query(text: string, vals: unknown[] = []) {
      stmts.push({ text, vals: [...vals] });
      if (o.failOn?.test(text)) throw Object.assign(new Error(`pg failure ${PHI}`), { code: '42501' });
      if (/\bSELECT\b[\s\S]*partners\.settings/i.test(text) && !/UPDATE|DELETE/i.test(text)) return { rows: o.ttl === undefined ? [] : [{ draft_ttl_days: o.ttl }], rowCount: o.ttl === undefined ? 0 : 1 };
      if (/partners\.redact_lines\s*\(/i.test(text)) { const n = o.redacted ?? 3; return { rows: [{ redact_lines: n, n, count: n }], rowCount: 1 }; }
      if (/^\s*DELETE\b/i.test(text)) return { rows: [], rowCount: o.counters ?? 2 };
      if (/^\s*SELECT\b[\s\S]*partners\.manifests\b/i.test(text)) {
        const rows = Array.from({ length: o.drafts ?? 2 }, (_, i) => ({ id: `0190a000-0000-7000-8000-0000000c13d${i}`, manifest_id: `0190a000-0000-7000-8000-0000000c13d${i}`, tenant_id: T, state: 'draft', version: 1 }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const ctx: any = {
    tenantId: T, actor: { type: 'system', id: SYS }, requestId: '0190a000-0000-7000-8000-0000000c1399', tx, attempt: 1, maxAttempts: 3, jobId: '1',
    now: () => NOW, isNewer: () => true, events: {}, core: {}, storage: {}, files: {}, audit: {}, log,
    metrics: { inc() {}, set() {}, observe() {} },
    ports: { IdentityPort: { async getTenantSettings(_c: unknown, input: unknown) {
      idCalls.push(input); if (o.identityThrows) throw new Error(`identity down ${PHI}`);
      return { retentionYears: 'retentionYears' in o ? o.retentionYears : 5 };
    } } },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { ctx, stmts, logs, idCalls };
}
const run = async (h: (p: any, c: any) => Promise<void>, ctx: any, payload: Record<string, unknown> = { tenant_id: T }) => { try { await h(payload, ctx); return undefined; } catch (e) { return e as Error; } };
const all = (s: Stmt[]) => s.map((x) => x.text).join('\n;\n');
const writes = (s: Stmt[]) => s.filter((x) => /^\s*(UPDATE|DELETE|INSERT)\b/i.test(x.text));
const touchesPartners = (s: Stmt) => /\bpartners\./i.test(s.text);
/** true when some statement carries a cutoff of `days` days ago: a bound number of days, a bound Date/ISO instant, or a literal in the SQL text. */
function ttlApplied(stmts: Stmt[], days: number): boolean {
  const want = Date.parse(NOW) - days * DAY;
  return stmts.some((s) => s.vals.some((v) => v === days || v === String(days) || ((v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\d/.test(v))) && Math.abs(Date.parse(String(v instanceof Date ? v.toISOString() : v)) - want) <= 3_600_000))
    || new RegExp(`\\b${days}\\s*(days?|d)\\b`, 'i').test(s.text));
}
/** same for N years (retention): bound integer years, or an instant within 2 days of NOW - N calendar years (leap days). */
function yearsApplied(stmts: Stmt[], years: number): boolean {
  const d = new Date(NOW); d.setUTCFullYear(d.getUTCFullYear() - years); const want = d.getTime();
  return stmts.some((s) => s.vals.some((v) => v === years || v === String(years) || ((v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\d/.test(v))) && Math.abs(Date.parse(String(v instanceof Date ? v.toISOString() : v)) - want) <= 2 * DAY))
    || new RegExp(`\\b${years}\\s*years?\\b`, 'i').test(s.text));
}

describe('T21 cron.ts + manifest wiring (A13 P-6)', () => {
  it('crontab = six TRD §8.2 rows, every one tenantScope per_tenant, no platform cron', () => {
    expect(crontab.map((c) => c.identifier).sort()).toEqual(['partners.expire_drafts', 'partners.purge_access_slips', 'partners.reconcile_orders',
      'partners.redact_expired_lines', 'partners.sync_price_list', 'partners.sync_statements']);
    for (const c of crontab) expect(c.tenantScope, c.identifier).toBe('per_tenant');
  });
  it('housekeeping schedules: expire_drafts 01:40 and redact_expired_lines 02:40 Asia/Kathmandu = 19:55 / 20:55 UTC (TRD §8.2, UTC+05:45)', () => {
    const by = Object.fromEntries(crontab.map((c) => [c.identifier, c.schedule]));
    expect(by['partners.expire_drafts']).toBe('55 19 * * *');
    expect(by['partners.redact_expired_lines']).toBe('55 20 * * *');
  });
  it('the manifest crontab IS cron.ts (single source) and its two housekeeping tasks are the real handlers, 3 attempts', () => {
    expect(manifest.crontab).toEqual(crontab);
    expect(manifest.tasks?.['partners.expire_drafts']).toBe(expireDrafts);
    expect(manifest.tasks?.['partners.redact_expired_lines']).toBe(redactExpiredLines);
    expect(manifest.maxAttempts?.['partners.expire_drafts']).toBe(3);
    expect(manifest.maxAttempts?.['partners.redact_expired_lines']).toBe(3);
  });
});

describe('T21 partners.expire_drafts (MS4; TRD §8.1; 05-SCHEMA §6)', () => {
  it('drafts older than draft_ttl_days (tenant setting) are discarded: manifests draft -> discarded, tenant-scoped, only state draft', async () => {
    const { ctx, stmts } = makeCtx({ ttl: 17 });
    expect(await run(expireDrafts, ctx)).toBeUndefined();
    const upd = stmts.filter((s) => /^\s*UPDATE\s+partners\.manifests\b/i.test(s.text));
    expect(upd.length, 'an UPDATE of partners.manifests').toBeGreaterThan(0);
    for (const u of upd) {
      expect(u.text + JSON.stringify(u.vals)).toMatch(/discarded/);
      expect(u.text + JSON.stringify(u.vals), 'only drafts are touched').toMatch(/draft/);
      expect(u.text).toMatch(/tenant_id\s*=\s*\$\d+/i);
      expect(u.vals).toContain(T);
    }
    expect(ttlApplied(stmts, 17), 'the cutoff uses the tenant draft_ttl_days (17), not the default').toBe(true);
    expect(ttlApplied(stmts, 30) && !ttlApplied(stmts, 17)).toBe(false);
  });
  it('no settings row (lazy row, A17 P-22): the default 30 days applies', async () => {
    const { ctx, stmts } = makeCtx({ ttl: undefined });
    expect(await run(expireDrafts, ctx)).toBeUndefined();
    expect(ttlApplied(stmts, 30)).toBe(true);
  });
  it('the cutoff is on updated_at (not created_at): a draft edited yesterday is not expired', async () => {
    const { ctx, stmts } = makeCtx({ ttl: 30 });
    await run(expireDrafts, ctx);
    const sel = stmts.filter((s) => /partners\.manifests\b/i.test(s.text) && /draft/.test(s.text + JSON.stringify(s.vals)) && /updated_at\s*</i.test(s.text));
    expect(sel.length, 'a statement filtering manifests by updated_at < cutoff').toBeGreaterThan(0);
    expect(all(stmts)).not.toMatch(/created_at\s*</i);
  });
  it('the draft lines are discarded AND their patient block redacted in the same run (patient fields NULL, is_redacted = true)', async () => {
    const { ctx, stmts } = makeCtx({ ttl: 30 });
    await run(expireDrafts, ctx);
    const l = stmts.filter((s) => /^\s*UPDATE\s+partners\.manifest_lines\b/i.test(s.text));
    expect(l.length, 'an UPDATE of partners.manifest_lines').toBeGreaterThan(0);
    const text = l.map((s) => s.text).join('\n');
    expect(text + JSON.stringify(l.map((s) => s.vals))).toMatch(/discarded/);
    for (const col of ['patient_full_name', 'patient_sex', 'patient_birth_on', 'patient_age_years', 'patient_phone_e164', 'clinical_note'])
      expect(text, col).toMatch(new RegExp(`${col}\\s*=\\s*NULL`, 'i'));
    expect(text).toMatch(/is_redacted\s*=\s*(true|\$\d+)/i);
    expect(text).toMatch(/orderables_snapshot/i);
    for (const s of l) { expect(s.text).toMatch(/tenant_id\s*=\s*\$\d+/i); expect(s.vals).toContain(T); expect(s.text + JSON.stringify(s.vals)).toMatch(/draft/); }
  });
  it('never DELETEs and never calls the owner DEFINER (a discard keeps the rows; redact_lines is the retention path only)', async () => {
    const { ctx, stmts } = makeCtx({ ttl: 30 });
    await run(expireDrafts, ctx);
    expect(all(stmts)).not.toMatch(/^\s*DELETE\b/im);
    expect(all(stmts)).not.toMatch(/redact_lines/i);
    expect(all(stmts)).not.toMatch(/app\.maintenance|set_config|SET\s+(LOCAL\s+)?ROLE/i);
  });
  it('idempotent by state: nothing to discard -> resolves; a second run re-selects only drafts (no error, no writes beyond the guarded UPDATEs)', async () => {
    const { ctx, stmts } = makeCtx({ ttl: 30, drafts: 0 });
    expect(await run(expireDrafts, ctx)).toBeUndefined();
    for (const w of writes(stmts)) expect(w.text + JSON.stringify(w.vals)).toMatch(/draft/);
  });
  it('payload tenant different from the job tenant is refused before any statement (REQ-SEC-024)', async () => {
    const { ctx, stmts } = makeCtx();
    expect(await run(expireDrafts, ctx, { tenant_id: OTHER })).toBeInstanceOf(Error);
    expect(stmts).toHaveLength(0);
  });
  it('every statement on partners.* is scoped by tenant_id bound to the job tenant, values are bound (no tenant id inlined in SQL text)', async () => {
    const { ctx, stmts } = makeCtx({ ttl: 30 });
    await run(expireDrafts, ctx);
    for (const s of stmts.filter(touchesPartners)) { expect(s.text, s.text).toMatch(/tenant_id\s*=\s*\$\d+/i); expect(s.vals, s.text).toContain(T); expect(s.text).not.toContain(T); }
  });
  it('a database error surfaces (retry up to 3 attempts), its message is not logged by the task', async () => {
    const { ctx, logs } = makeCtx({ ttl: 30, failOn: /UPDATE\s+partners\.manifest_lines/i });
    expect(await run(expireDrafts, ctx)).toBeInstanceOf(Error);
    expect(logs.join('\n')).not.toContain(PHI);
  });
});

describe('T21 partners.redact_expired_lines (TRD §8.1; 05-SCHEMA §6, §8; A12.2; A17 P-18(c))', () => {
  it('reads retentionYears from IdentityPort.getTenantSettings and calls partners.redact_lines(tenant, now - retentionYears)', async () => {
    const { ctx, stmts, idCalls } = makeCtx({ retentionYears: 7 });
    expect(await run(redactExpiredLines, ctx)).toBeUndefined();
    expect(idCalls.length).toBe(1);
    const call = stmts.find((s) => /partners\.redact_lines\s*\(/i.test(s.text));
    expect(call, 'a statement calling partners.redact_lines').toBeDefined();
    expect(call!.text).toMatch(/^\s*SELECT\b/i);
    expect(call!.text).toMatch(/redact_lines\s*\(\s*\$1\b/i);
    expect(call!.vals[0]).toBe(T);
    expect(yearsApplied([call!], 7), 'cutoff = now - 7 years').toBe(true);
    expect(yearsApplied([call!], 5), 'not the default 5').toBe(false);
  });
  it('default retention 5 years (B15) when the tenant keeps the default', async () => {
    const { ctx, stmts } = makeCtx({ retentionYears: 5 });
    await run(redactExpiredLines, ctx);
    expect(yearsApplied(stmts.filter((s) => /redact_lines/i.test(s.text)), 5)).toBe(true);
  });
  it('line + report redaction goes ONLY through the owner function: no direct UPDATE of manifest_lines / order_reports, no maintenance GUC, no role switch', async () => {
    const { ctx, stmts } = makeCtx({ retentionYears: 5 });
    await run(redactExpiredLines, ctx);
    expect(all(stmts)).not.toMatch(/^\s*UPDATE\s+partners\.(manifest_lines|order_reports|order_tracking)\b/im);
    expect(all(stmts), 'the DEFINER sets the gate itself (A12.2); the task must not').not.toMatch(/app\.maintenance|partners_redact_lines|set_config|SET\s+(LOCAL\s+)?(ROLE|SESSION)/i);
    expect(all(stmts)).not.toMatch(/SECURITY|lims_owner|ALTER|DISABLE\s+(ROW|TRIGGER)|NO\s+FORCE/i);
  });
  it('download_counters past expires_at are deleted in the same run, by tenant, under the system actor (no DEFINER involved)', async () => {
    const { ctx, stmts } = makeCtx({ retentionYears: 5 });
    await run(redactExpiredLines, ctx);
    const del = stmts.filter((s) => /^\s*DELETE\b/i.test(s.text));
    expect(del).toHaveLength(1);
    expect(del[0]!.text).toMatch(/DELETE\s+FROM\s+partners\.download_counters\b/i);
    expect(del[0]!.text).toMatch(/tenant_id\s*=\s*\$1\b/i);
    expect(del[0]!.text).toMatch(/expires_at\s*<\s*(now\(\)|\$\d+)/i);
    expect(del[0]!.vals[0]).toBe(T);
  });
  it('the counters purge also runs when no line is due (redact_lines returns 0): housekeeping is idempotent and the two parts are independent', async () => {
    const { ctx, stmts } = makeCtx({ retentionYears: 5, redacted: 0, counters: 0 });
    expect(await run(redactExpiredLines, ctx)).toBeUndefined();
    expect(stmts.some((s) => /DELETE\s+FROM\s+partners\.download_counters/i.test(s.text))).toBe(true);
    expect(stmts.some((s) => /redact_lines/i.test(s.text))).toBe(true);
  });
  it('no other table is deleted from (lines, reports, tracking, manifests are redacted, never deleted)', async () => {
    const { ctx, stmts } = makeCtx({ retentionYears: 5 });
    await run(redactExpiredLines, ctx);
    for (const s of stmts.filter((x) => /^\s*DELETE\b/i.test(x.text))) expect(s.text).toMatch(/partners\.download_counters/i);
  });
  it('FAIL CLOSED: an unusable retentionYears (undefined, 0, negative, fractional, string, NaN) rejects before any redaction or delete (precedent analytics.purge)', async () => {
    for (const bad of [undefined, null, 0, -1, 2.5, '5', Number.NaN]) {
      const { ctx, stmts } = makeCtx({ retentionYears: bad });
      expect(await run(redactExpiredLines, ctx), String(bad)).toBeInstanceOf(Error);
      expect(writes(stmts), String(bad)).toHaveLength(0);
      expect(stmts.some((s) => /redact_lines/i.test(s.text)), String(bad)).toBe(false);
    }
  });
  it('FAIL CLOSED: IdentityPort failure rejects (retry) and nothing is redacted or deleted; the error text is not logged by the task', async () => {
    const { ctx, stmts, logs } = makeCtx({ identityThrows: true });
    expect(await run(redactExpiredLines, ctx)).toBeInstanceOf(Error);
    expect(writes(stmts)).toHaveLength(0);
    expect(stmts.some((s) => /redact_lines/i.test(s.text))).toBe(false);
    expect(logs.join('\n')).not.toContain(PHI);
  });
  it('redaction_scope (42501) from the DEFINER is not swallowed: the job fails and the counters purge does not report success', async () => {
    const { ctx, logs } = makeCtx({ retentionYears: 5, failOn: /redact_lines/i });
    const e: any = await run(redactExpiredLines, ctx);
    expect(e).toBeInstanceOf(Error);
    expect(logs.join('\n')).not.toContain(PHI);
  });
  it('payload tenant different from the job tenant is refused before any statement: never redacts another tenant (REQ-SEC-024, DEFINER tenant check 42501)', async () => {
    const { ctx, stmts, idCalls } = makeCtx();
    expect(await run(redactExpiredLines, ctx, { tenant_id: OTHER })).toBeInstanceOf(Error);
    expect(stmts).toHaveLength(0);
    expect(idCalls).toHaveLength(0);
  });
  it('tenant id and cutoff are bound values, never inlined into SQL text', async () => {
    const { ctx, stmts } = makeCtx({ retentionYears: 5 });
    await run(redactExpiredLines, ctx);
    for (const s of stmts) { expect(s.text).not.toContain(T); expect(s.text).not.toMatch(/\d{4}-\d\d-\d\dT/); }
  });
});
