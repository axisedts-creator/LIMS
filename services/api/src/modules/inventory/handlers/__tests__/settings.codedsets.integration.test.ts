// C12 T-06 — Settings + coded sets, operations #26-#29 (06-IMPLEMENTATION-PLAN row T-06; 02-TRD §5 #26-#29, §2.4 of 05-SCHEMA; AC-05.8; 07-SECURITY P-1 validation, tenant isolation).
// done_when: lazy settings row (INSERT ... ON CONFLICT DO NOTHING, P-22); pattern validation 400 (P-1); consumption_enabled_at >= now-3600 s when set from NULL; tenant code shadowing; tax codes carry no rate, seed display VAT.
// Style: contract + probes. The REAL handler map (handlers/index.ts, keys = the operationIds already in the manifest) is called with a request-shaped transaction as role lims_api (RLS on);
// no new module names are needed. Needs the migrated database of tests/db/c12-t03/run.sh (LIMS_TEST_DATABASE_URL = lims_api, LIMS_TEST_ADMIN_DATABASE_URL = superuser) + its fixtures.sql;
// run via .orchestra/notes/C12.T-06-verify.cmd. Without the DB the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
//
// SEAM the spec does not fix (writer must provide exactly this):
//   handlers[op](req, ctx) -> { status, body }, req = { params, query, headers, body } (headers lower-case: 'if-match': '"<version>"'); ctx = { tenantId, actor: {type, id}, requestId, tx: { query }, now: () => ISO string, ... }.
//   Handlers throw LimsError (code + errors[{path (JSON pointer), code, message}]); permission checks are the pipeline's (x-permission, asserted below from the contract); the repositories are the T-03 ones (settings.repo, codedSets.repo).
//   The request transaction is the caller's (BEGIN/COMMIT); on a thrown error nothing is written by the handler (tests read back in the same transaction).
// ASSUMPTIONS (change them via CR if wrong):
//   - PUT /settings is a FULL replace of the mutable fields (SettingsUpdate: nullable fields absent => NULL; the body has no id/tenant_id/version/is_active). If-Match is ALWAYS required: absent => 428 common.precondition_required, stale => 409 common.version_conflict.
//   - A first GET or first PUT on a tenant without a row creates the default row (version 1) with INSERT ... ON CONFLICT (tenant_id) DO NOTHING; a PUT with If-Match "1" then yields version 2.
//   - Responses carry no null (02-CV §4.2): consumption_enabled_at / default_consumption_store_id are OMITTED when NULL. The Settings response has no id/tenant_id/created_*/updated_*/is_active.
//   - Coded-set entries (#28/#29) are exactly {code, display, reason_group?, uom_kind?, sort_order?, is_active}: no id/tenant_id/version/scope/system. The tenant row version is not on the wire; a client addresses the row it just created with If-Match "1".
//   - #29 If-Match: absent on a missing tenant row creates it; absent on an existing tenant row => 409 common.version_conflict (#29 declares no 428 in the contract; review item 1); stale => 409. A first PUT of a code that only exists globally creates the shadow row (no If-Match).
//   - A tenant cs_* row, active or not, shadows the global row with the same (group,) code (repo comment in codedSets.repo.ts). Unknown set_name => 400 or 404, never 500. #28 reason_group is optional per contract (required:false): without it every group is returned.
//   - A default_consumption_store_id that is not a store of THIS tenant => 400 common.validation_failed at /default_consumption_store_id, identical for "other tenant's store" and "no such store" (no existence oracle).
//   - The 3600 s rule uses a +/-200 s margin (the handler may take now from ctx.now() or the database; tests do not rely on the exact boundary).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parse } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
const STORE_A = uid(1001);
const STORE_B = uid(1101);
const NOW = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });
// tenant B has no settings row in the fixtures: tests that need the lazy path start from that state
beforeEach(async () => { if (live) await admin.query('DELETE FROM inventory.settings WHERE tenant_id = $1', [B]); });

describe('T-06 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

interface Req { params?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown }
type Q = (sql: string, v?: unknown[]) => Promise<{ rows: any[] }>;
/** One request-shaped transaction as `tenantId` (claims set transaction-locally, like core/db/tx.ts); ROLLBACK unless commit. */
async function inTx<T>(tenantId: string, fn: (ctx: any, q: Q) => Promise<T>, commit = false): Promise<T> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' })]);
    const q: Q = (t, v) => client.query(t, v);
    const ctx = {
      tenantId, actor: { type: 'user', id: SYS }, requestId: '0190c514-0000-7000-8000-0000000000aa', tx: { query: q }, now: () => iso(NOW()),
      db: {}, ports: {}, operationId: '', clientIp: '127.0.0.1', log: { info() {}, warn() {}, error() {} }, noRetry() {},
    };
    const out = await fn(ctx, q);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
const call = (ctx: any, op: string, req: Req = {}) => {
  const h = handlers[op];
  if (!h) throw new Error(`no handler ${op}`);
  return h({ params: req.params ?? {}, query: req.query ?? {}, headers: req.headers ?? {}, body: req.body ?? undefined }, { ...ctx, operationId: op });
};
async function rej(p: Promise<unknown>): Promise<LimsError> {
  try { await p; } catch (e) { return e as LimsError; }
  throw new Error('expected a rejection, but it resolved');
}
const ifm = (v: number | string) => ({ 'if-match': `"${v}"` });
const bad = (e: LimsError) => [e.code, e.statusCode];
const paths = (e: LimsError) => (e.errors ?? []).map((f) => f.path);
const readSettings = async (q: Q, tenant: string) => (await q('SELECT * FROM inventory.settings WHERE tenant_id = $1', [tenant])).rows;

const DEFAULTS = {
  vat_in_cost: true, po_self_approval_allowed: false, grn_without_po_allowed: true, over_receipt_tolerance_bp: 0, expiry_alert_days: 30, count_locks_store: false,
  per_day_requires_activity: true, reconciliation_gap_alert_bp: 200, backdate_max_days: 7, po_no_pattern: 'PO{yy}{seq:6}', grn_no_pattern: 'GR{yy}{seq:6}',
  transfer_no_pattern: 'TR{yy}{seq:6}', count_no_pattern: 'SC{yy}{seq:5}', doc_no_pattern: 'SD{yy}{seq:6}',
};
const SETTINGS_KEYS = [...Object.keys(DEFAULTS), 'consumption_enabled_at', 'default_consumption_store_id', 'version'].sort();
const full = (o: Record<string, unknown> = {}) => ({ ...DEFAULTS, ...o });
const put = (ctx: any, body: Record<string, unknown>, version: number | string = 1) => call(ctx, 'updateInventorySettings', { headers: ifm(version), body });

describe('T-06 contract: operations are wired with the spec permissions/context', () => {
  const spec = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/inventory.yaml', import.meta.url)), 'utf8'));
  const op = (id: string) => Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p)).find((o) => o?.operationId === id);
  it.each([
    ['getInventorySettings', 'inventory.item.read'], ['updateInventorySettings', 'inventory.master.manage'],
    ['listInventoryCodedSet', 'inventory.item.read'], ['putInventoryTenantCode', 'inventory.master.manage'],
  ])('%s requires %s in tenant context (the pipeline enforces it before the handler)', (id, perm) => {
    expect(op(id)).toMatchObject({ 'x-permission': perm, 'x-context': 'tenant' });
    expect(typeof handlers[id]).toBe('function');
  });
});

describe.skipIf(!live)('#26 getInventorySettings', () => {
  it('existing tenant row: 200, exactly the Settings schema keys, no null on the wire, defaults + version', async () => {
    await inTx(A, async (ctx) => {
      const r = await call(ctx, 'getInventorySettings');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ...DEFAULTS, version: 1 });
      expect(Object.keys(r.body as object).sort()).toEqual(SETTINGS_KEYS.filter((k) => k !== 'consumption_enabled_at' && k !== 'default_consumption_store_id'));
      expect(JSON.stringify(r.body)).not.toContain('null');
    });
  });

  it('lazy row (P-22): a tenant without a row gets the column defaults, version 1, and the row now exists exactly once', async () => {
    await inTx(B, async (ctx, q) => {
      expect(await readSettings(q, B)).toHaveLength(0);
      const r = await call(ctx, 'getInventorySettings');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ...DEFAULTS, version: 1 });
      const rows = await readSettings(q, B);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: B, created_by: SYS, version: 1 });
      await call(ctx, 'getInventorySettings');
      expect(await readSettings(q, B)).toHaveLength(1);
    });
  });

  it('lazy row under concurrency: 10 parallel first calls (own committed transactions) all succeed, one row, no unique-violation 500', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => inTx(B, (ctx) => call(ctx, 'getInventorySettings'), true)));
    try {
      expect(results.filter((x) => x.status === 'rejected').map((x) => (x as PromiseRejectedResult).reason?.code ?? String((x as PromiseRejectedResult).reason))).toEqual([]);
      for (const x of results) expect((x as PromiseFulfilledResult<any>).value.body).toMatchObject({ ...DEFAULTS, version: 1 });
      expect((await admin.query('SELECT count(*)::int AS n FROM inventory.settings WHERE tenant_id = $1', [B])).rows[0].n).toBe(1);
    } finally { await admin.query('DELETE FROM inventory.settings WHERE tenant_id = $1', [B]); }
  });

  it('tenant isolation: each tenant reads its own row (B values differ from A)', async () => {
    await admin.query('INSERT INTO inventory.settings (id, tenant_id, created_by, updated_by, backdate_max_days) VALUES ($1, $2, $3, $3, 3)', [uid(9699), B, SYS]);
    const a = await inTx(A, (ctx) => call(ctx, 'getInventorySettings'));
    const b = await inTx(B, (ctx) => call(ctx, 'getInventorySettings'));
    expect((a.body as any).backdate_max_days).toBe(7);
    expect((b.body as any).backdate_max_days).toBe(3);
  });
});

describe.skipIf(!live)('#27 updateInventorySettings', () => {
  it('full update with If-Match "1": 200, new values, version 2, persisted, updated_by = actor, row identity unchanged', async () => {
    await inTx(A, async (ctx, q) => {
      const body = full({ vat_in_cost: false, po_self_approval_allowed: true, grn_without_po_allowed: false, over_receipt_tolerance_bp: 500, expiry_alert_days: 45, count_locks_store: true,
        per_day_requires_activity: false, reconciliation_gap_alert_bp: 350, backdate_max_days: 14, default_consumption_store_id: STORE_A,
        po_no_pattern: 'PO{fy}-{seq:6}', grn_no_pattern: 'GR{fyl}{seq:4}', transfer_no_pattern: 'TR-{yy}/{seq:5}', count_no_pattern: 'SC{seq:3}', doc_no_pattern: 'SD{yy}{seq:9}' });
      const r = await put(ctx, body);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ...body, version: 2 });
      const [row] = await readSettings(q, A);
      expect(row).toMatchObject({ id: uid(9601), tenant_id: A, version: 2, updated_by: SYS, is_active: true, vat_in_cost: false, over_receipt_tolerance_bp: 500, default_consumption_store_id: STORE_A, po_no_pattern: 'PO{fy}-{seq:6}' });
      expect((await call(ctx, 'getInventorySettings')).body).toMatchObject({ ...body, version: 2 });
    });
  });

  it('lazy PUT: a tenant without a row can PUT with If-Match "1" (row created with defaults, then updated => version 2)', async () => {
    await inTx(B, async (ctx, q) => {
      const r = await put(ctx, full({ backdate_max_days: 2 }));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ backdate_max_days: 2, version: 2 });
      expect(await readSettings(q, B)).toHaveLength(1);
    });
  });

  it('If-Match: absent => 428 common.precondition_required; stale => 409 common.version_conflict; nothing changes', async () => {
    await inTx(A, async (ctx, q) => {
      expect(bad(await rej(call(ctx, 'updateInventorySettings', { body: full({ backdate_max_days: 1 }) })))).toEqual(['common.precondition_required', 428]);
      expect(bad(await rej(put(ctx, full({ backdate_max_days: 1 }), 5)))).toEqual(['common.version_conflict', 409]);
      expect((await readSettings(q, A))[0]).toMatchObject({ version: 1, backdate_max_days: 7 });
      await put(ctx, full({ backdate_max_days: 1 }), 1);
      expect(bad(await rej(put(ctx, full({ backdate_max_days: 2 }), 1)))).toEqual(['common.version_conflict', 409]);
    });
  });

  it.each([
    ['over_receipt_tolerance_bp', 5001], ['over_receipt_tolerance_bp', -1], ['expiry_alert_days', 0], ['expiry_alert_days', 366], ['reconciliation_gap_alert_bp', 10001],
    ['reconciliation_gap_alert_bp', -1], ['backdate_max_days', 32], ['backdate_max_days', -1], ['backdate_max_days', 1.5], ['expiry_alert_days', '30'], ['vat_in_cost', 'yes'], ['count_locks_store', 1],
  ])('range/type probe %s = %j => 400 common.validation_failed at /%s, nothing written (P-1)', async (field, value) => {
    await inTx(A, async (ctx, q) => {
      const e = await rej(put(ctx, full({ [field]: value })));
      expect(bad(e)).toEqual(['common.validation_failed', 400]);
      expect(paths(e)).toContain(`/${field}`);
      expect((await readSettings(q, A))[0]).toMatchObject({ version: 1, ...DEFAULTS });
    });
  });

  it('range boundaries are accepted (0/5000, 1/365, 0/10000, 0/31)', async () => {
    await inTx(A, async (ctx) => {
      const lo = await put(ctx, full({ over_receipt_tolerance_bp: 0, expiry_alert_days: 1, reconciliation_gap_alert_bp: 0, backdate_max_days: 0 }));
      expect(lo.body).toMatchObject({ over_receipt_tolerance_bp: 0, expiry_alert_days: 1, reconciliation_gap_alert_bp: 0, backdate_max_days: 0, version: 2 });
      const hi = await put(ctx, full({ over_receipt_tolerance_bp: 5000, expiry_alert_days: 365, reconciliation_gap_alert_bp: 10000, backdate_max_days: 31 }), 2);
      expect(hi.body).toMatchObject({ over_receipt_tolerance_bp: 5000, expiry_alert_days: 365, reconciliation_gap_alert_bp: 10000, backdate_max_days: 31, version: 3 });
    });
  });

  const PATTERN_FIELDS = ['po_no_pattern', 'grn_no_pattern', 'transfer_no_pattern', 'count_no_pattern', 'doc_no_pattern'];
  const BAD_PATTERNS: Array<[string, string]> = [
    ['no {seq:N} token', 'PO{yy}'], ['two {seq:N} tokens', 'PO{seq:3}{seq:3}'], ['lower-case literal', 'po{yy}{seq:6}'], ['unknown token', 'PO{zz}{seq:6}'], ['{seq:0}', 'PO{seq:0}'],
    ['{seq:10}', 'PO{seq:10}'], ['unbalanced brace', 'PO{yy{seq:6}'], ['empty', ''], ['41 characters (DDL limit 40)', `${'A'.repeat(32)}{seq:6}-X`], ['space', 'PO {seq:6}'],
    ['SQL injection text', "PO'; DROP TABLE inventory.settings; --{seq:6}"], ['markup', '<b>{seq:6}'],
  ];
  it.each(PATTERN_FIELDS.flatMap((f) => BAD_PATTERNS.map(([why, p]) => [f, why, p] as const)))(
    '%s rejects %s => 400 common.validation_failed at the field, not a DB error, nothing written (P-1)', async (field, _why, pattern) => {
      await inTx(A, async (ctx, q) => {
        const e = await rej(put(ctx, full({ [field]: pattern })));
        expect(bad(e)).toEqual(['common.validation_failed', 400]);
        expect(paths(e)).toContain(`/${field}`);
        expect((await readSettings(q, A))[0]).toMatchObject({ version: 1, ...DEFAULTS });
        expect(JSON.stringify(e)).not.toContain('DROP TABLE'); // the submitted value is not echoed (02-CV §4.6)
      });
    });
  it('valid patterns of the C12 grammar are accepted (yy / fy / fyl / literal with - and /, width 1-9)', async () => {
    await inTx(A, async (ctx) => {
      const r = await put(ctx, full({ po_no_pattern: 'P-O/{fy}{seq:1}', grn_no_pattern: '{fyl}-{seq:9}', transfer_no_pattern: '{yy}{seq:6}', count_no_pattern: 'A{seq:5}', doc_no_pattern: `${'B'.repeat(30)}{seq:9}` }));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ po_no_pattern: 'P-O/{fy}{seq:1}', doc_no_pattern: `${'B'.repeat(30)}{seq:9}` });
    });
  });

  describe('consumption_enabled_at (no retroactive deduction; UI S18)', () => {
    it('NULL -> now-3500 s: accepted and stored; response carries it', async () => {
      await inTx(A, async (ctx, q) => {
        const t = iso(NOW() - 3500_000);
        const r = await put(ctx, full({ consumption_enabled_at: t }));
        expect(r.status).toBe(200);
        expect(new Date((r.body as any).consumption_enabled_at).getTime()).toBe(new Date(t).getTime());
        expect(new Date((await readSettings(q, A))[0].consumption_enabled_at).getTime()).toBe(new Date(t).getTime());
      });
    });
    it('NULL -> now-3700 s: 400 common.validation_failed at /consumption_enabled_at; stays NULL', async () => {
      await inTx(A, async (ctx, q) => {
        const e = await rej(put(ctx, full({ consumption_enabled_at: iso(NOW() - 3700_000) })));
        expect(bad(e)).toEqual(['common.validation_failed', 400]);
        expect(paths(e)).toContain('/consumption_enabled_at');
        expect((await readSettings(q, A))[0]).toMatchObject({ consumption_enabled_at: null, version: 1 });
      });
    });
    it('NULL -> far past (2020) is rejected the same way; NULL -> future is accepted', async () => {
      await inTx(A, async (ctx) => {
        expect(paths(await rej(put(ctx, full({ consumption_enabled_at: '2020-01-01T00:00:00.000Z' }))))).toContain('/consumption_enabled_at');
        const r = await put(ctx, full({ consumption_enabled_at: iso(NOW() + 86_400_000) }));
        expect(r.status).toBe(200);
      });
    });
    it('malformed value => 400 at /consumption_enabled_at', async () => {
      await inTx(A, async (ctx) => {
        for (const v of ['yesterday', '2026-11-13', 12345, 'not-a-date']) expect(paths(await rej(put(ctx, full({ consumption_enabled_at: v }))))).toContain('/consumption_enabled_at');
      });
    });
    it('the rule applies only on NULL -> value: re-saving an unchanged old value passes; turning off (omit) clears it; turning on again from NULL is checked again', async () => {
      await inTx(A, async (ctx, q) => {
        await q("UPDATE inventory.settings SET consumption_enabled_at = '2026-10-01T00:00:00Z' WHERE tenant_id = $1", [A]); // enabled long ago (older than 1 h)
        const same = await put(ctx, full({ consumption_enabled_at: '2026-10-01T00:00:00.000Z', backdate_max_days: 3 }));
        expect(same.status).toBe(200);
        expect(same.body).toMatchObject({ consumption_enabled_at: '2026-10-01T00:00:00.000Z', backdate_max_days: 3, version: 2 });
        const off = await put(ctx, full({ backdate_max_days: 3 }), 2);
        expect(off.status).toBe(200);
        expect(off.body).not.toHaveProperty('consumption_enabled_at');
        expect((await readSettings(q, A))[0].consumption_enabled_at).toBeNull();
        expect(paths(await rej(put(ctx, full({ consumption_enabled_at: '2026-10-01T00:00:00.000Z' }), 3)))).toContain('/consumption_enabled_at');
      });
    });
    it('lazy PUT with an old value on a tenant without a row is rejected too (the default row has NULL)', async () => {
      await inTx(B, async (ctx) => {
        expect(paths(await rej(put(ctx, full({ consumption_enabled_at: '2026-01-01T00:00:00.000Z' }))))).toContain('/consumption_enabled_at');
      });
    });
  });

  it('default_consumption_store_id: own store accepted; another tenant\'s store and an unknown id give the SAME 400 at /default_consumption_store_id (no oracle, no FK 500)', async () => {
    await inTx(A, async (ctx, q) => {
      const other = await rej(put(ctx, full({ default_consumption_store_id: STORE_B })));
      const none = await rej(put(ctx, full({ default_consumption_store_id: uid(987654) })));
      expect(bad(other)).toEqual(['common.validation_failed', 400]);
      expect([bad(none), paths(none), none.detail]).toEqual([bad(other), paths(other), other.detail]);
      expect(paths(other)).toContain('/default_consumption_store_id');
      expect((await readSettings(q, A))[0]).toMatchObject({ default_consumption_store_id: null, version: 1 });
      const ok = await put(ctx, full({ default_consumption_store_id: STORE_A }));
      expect(ok.body).toMatchObject({ default_consumption_store_id: STORE_A, version: 2 });
      const cleared = await put(ctx, full(), 2);
      expect(cleared.body).not.toHaveProperty('default_consumption_store_id');
    });
  });

  it('mass assignment: tenant_id / id / version / is_active in the body never reach the row (400, or ignored)', async () => {
    await inTx(A, async (ctx, q) => {
      let r: any;
      try { r = await put(ctx, { ...full({ backdate_max_days: 5 }), tenant_id: B, id: uid(1), version: 99, is_active: false, created_by: uid(2) }); } catch (e) { expect(bad(e as LimsError)).toEqual(['common.validation_failed', 400]); return; }
      expect(r.status).toBe(200);
      const [row] = await readSettings(q, A);
      expect(row).toMatchObject({ id: uid(9601), tenant_id: A, version: 2, is_active: true, created_by: SYS, backdate_max_days: 5 });
      expect(r.body.version).toBe(2);
    });
  });

  it('tenant isolation: A\'s update never touches B\'s row; B cannot be reached with A\'s If-Match', async () => {
    await admin.query('INSERT INTO inventory.settings (id, tenant_id, created_by, updated_by, backdate_max_days) VALUES ($1, $2, $3, $3, 3)', [uid(9699), B, SYS]);
    await inTx(A, (ctx) => put(ctx, full({ backdate_max_days: 20 })), true);
    try {
      expect((await admin.query('SELECT backdate_max_days, version FROM inventory.settings WHERE tenant_id = $1', [B])).rows[0]).toEqual({ backdate_max_days: 3, version: 1 });
      expect((await admin.query('SELECT backdate_max_days, version FROM inventory.settings WHERE tenant_id = $1', [A])).rows[0]).toEqual({ backdate_max_days: 20, version: 2 });
    } finally { await admin.query('UPDATE inventory.settings SET backdate_max_days = 7, version = 1 WHERE tenant_id = $1', [A]); }
  });

  it('concurrent updates with the same If-Match "1": exactly one wins (200), the others 409 common.version_conflict', async () => {
    try {
      const rs = await Promise.allSettled([1, 2, 3, 4].map((n) => inTx(A, (ctx) => put(ctx, full({ backdate_max_days: n })), true)));
      expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      for (const x of rs.filter((y) => y.status === 'rejected')) expect(((x as PromiseRejectedResult).reason as LimsError).code).toBe('common.version_conflict');
      expect((await admin.query('SELECT version FROM inventory.settings WHERE tenant_id = $1', [A])).rows[0].version).toBe(2);
    } finally { await admin.query('UPDATE inventory.settings SET backdate_max_days = 7, version = 1 WHERE tenant_id = $1', [A]); }
  });
});

const ENTRY_KEYS = new Set(['code', 'display', 'reason_group', 'uom_kind', 'sort_order', 'is_active']);
const entryOk = (e: object) => Object.keys(e).every((k) => ENTRY_KEYS.has(k));
const list = (ctx: any, set: string, reason_group?: string) => call(ctx, 'listInventoryCodedSet', { params: { set_name: set }, query: reason_group ? { reason_group } : {} });
const putCode = (ctx: any, set: string, code: string, body: Record<string, unknown>, version?: number | string) =>
  call(ctx, 'putInventoryTenantCode', { params: { set_name: set, code }, headers: version === undefined ? {} : ifm(version), body });
const byCode = (r: any) => Object.fromEntries((r.body.data as any[]).map((e) => [e.code, e]));

describe.skipIf(!live)('#28 listInventoryCodedSet', () => {
  it('uom: global list {data}, entries carry code/display/uom_kind/is_active only, sorted, ml is volume', async () => {
    await inTx(A, async (ctx) => {
      const r = await list(ctx, 'uom');
      expect(r.status).toBe(200);
      expect(Object.keys(r.body as object)).toEqual(['data']);
      const m = byCode(r);
      expect(m['ml']).toMatchObject({ code: 'ml', display: 'mL', uom_kind: 'volume', is_active: true });
      expect(m['test']).toMatchObject({ uom_kind: 'count' });
      for (const e of (r.body as any).data) { expect(entryOk(e)).toBe(true); expect(e).not.toHaveProperty('reason_group'); }
    });
  });

  it('reasons + reason_group: global ∪ tenant, tenant shadows (display), inactive tenant rows are not listed, other groups absent', async () => {
    await inTx(A, async (ctx) => {
      const r = await list(ctx, 'reasons', 'wastage');
      const m = byCode(r);
      expect(m['spillage']).toMatchObject({ display: 'Spillage (tenant label)', reason_group: 'wastage', is_active: true });
      expect((r.body as any).data.filter((e: any) => e.code === 'spillage')).toHaveLength(1); // shadowed, not duplicated
      expect(m['lab_custom']).toMatchObject({ display: 'Lab custom' });
      expect(m['damaged']).toMatchObject({ display: 'Damaged' }); // global, not shadowed
      expect(m).not.toHaveProperty('old_one'); // inactive tenant row
      expect(m).not.toHaveProperty('duplicate'); // po_cancel group
      for (const e of (r.body as any).data) { expect(entryOk(e)).toBe(true); expect(e.reason_group).toBe('wastage'); }
    });
  });

  it('reasons without reason_group => 200 with all groups, tenant shadows, inactive tenant rows absent, no duplicate (group, code)', async () => {
    await inTx(A, async (ctx) => {
      const r = await list(ctx, 'reasons');
      expect(r.status).toBe(200);
      const d = (r.body as any).data as any[];
      for (const e of d) { expect(entryOk(e)).toBe(true); expect(typeof e.reason_group).toBe('string'); }
      expect(new Set(d.map((e) => `${e.reason_group}/${e.code}`)).size).toBe(d.length);
      expect(new Set(d.map((e) => e.reason_group)).size).toBeGreaterThan(1);
      expect(d.find((e) => e.code === 'spillage')).toMatchObject({ display: 'Spillage (tenant label)', reason_group: 'wastage' });
      expect(d.find((e) => e.code === 'duplicate')).toMatchObject({ reason_group: 'po_cancel' });
      expect(d.some((e) => e.code === 'old_one')).toBe(false);
    });
  });

  it('reasons: tenant B sees its own shadow label and none of A\'s codes (tenant isolation)', async () => {
    await inTx(B, async (ctx) => {
      const m = byCode(await list(ctx, 'reasons', 'wastage'));
      expect(m['spillage']).toMatchObject({ display: 'Spillage B' });
      expect(m).not.toHaveProperty('lab_custom');
      expect(m['damaged']).toMatchObject({ display: 'Damaged' });
    });
  });

  it('tax_codes: seeded VAT (display VAT) + tenant code, inactive hidden, NO rate anywhere in the payload (AC-05.8)', async () => {
    await inTx(A, async (ctx) => {
      const r = await list(ctx, 'tax_codes');
      const m = byCode(r);
      expect(m['VAT']).toMatchObject({ code: 'VAT', display: 'VAT', is_active: true });
      expect(m['LOCALTAX']).toBeDefined();
      expect(m).not.toHaveProperty('OLDTAX');
      expect(m).not.toHaveProperty('exempt'); // exemption is a treatment, not a code (08 A4.1)
      expect(Object.keys(m)).toEqual([...Object.keys(m)].sort()); // ordered by code
      for (const e of (r.body as any).data) {
        expect(entryOk(e)).toBe(true);
        expect(Object.keys(e).filter((k) => /rate|bp|percent|pct/i.test(k))).toEqual([]);
        expect(String(e.display)).not.toMatch(/\d\s*%/); // the display holds no rate
        expect(e.code).toMatch(/^[A-Z0-9_]{1,16}$/);
      }
    });
  });

  it('bad inputs: unknown set_name => 400/404 (never 500); reason_group outside the enum => 400 at /reason_group', async () => {
    await inTx(A, async (ctx) => {
      const e1 = await rej(list(ctx, "uom'; DROP TABLE inventory.g_cs_uom;--"));
      expect(['common.validation_failed', 'common.not_found']).toContain(e1.code);
      const e2 = await rej(list(ctx, 'reasons', 'bogus_group'));
      expect(bad(e2)).toEqual(['common.validation_failed', 400]);
      expect(paths(e2)).toContain('/reason_group');
    });
  });
});

describe.skipIf(!live)('#29 putInventoryTenantCode', () => {
  it('reasons: new tenant code => 200 with the entry (no ids/versions), visible in #28; global rows untouched', async () => {
    await inTx(A, async (ctx, q) => {
      const r = await putCode(ctx, 'reasons', 'my_code', { reason_group: 'wastage', display: 'My code', sort_order: 5, is_active: true });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ code: 'my_code', display: 'My code', reason_group: 'wastage', sort_order: 5, is_active: true });
      expect(byCode(await list(ctx, 'reasons', 'wastage'))['my_code']).toMatchObject({ display: 'My code', sort_order: 5 });
      expect((await q('SELECT tenant_id, version FROM inventory.cs_reasons WHERE tenant_id = $1 AND code = $2', [A, 'my_code'])).rows).toEqual([{ tenant_id: A, version: 1 }]);
    });
    expect((await admin.query("SELECT count(*)::int AS n FROM inventory.g_cs_reasons WHERE code = 'my_code'")).rows[0].n).toBe(0);
  });

  it('reasons: PUT on a global code creates the tenant shadow for this tenant only (B still sees the global label); deactivating hides it for A only', async () => {
    await inTx(A, async (ctx) => {
      await putCode(ctx, 'reasons', 'damaged', { reason_group: 'wastage', display: 'Broken', is_active: true });
      const after = await list(ctx, 'reasons', 'wastage');
      expect((after.body as any).data.filter((e: any) => e.code === 'damaged')).toEqual([expect.objectContaining({ display: 'Broken' })]);
      await putCode(ctx, 'reasons', 'damaged', { reason_group: 'wastage', display: 'Broken', is_active: false }, 1);
      expect(byCode(await list(ctx, 'reasons', 'wastage'))).not.toHaveProperty('damaged'); // inactive tenant row still shadows the global one
      await putCode(ctx, 'reasons', 'spillage', { reason_group: 'wastage', display: 'Spillage (tenant label)', is_active: false }, 1);
      expect(byCode(await list(ctx, 'reasons', 'wastage'))).not.toHaveProperty('spillage');
    });
    await inTx(B, async (ctx) => { expect(byCode(await list(ctx, 'reasons', 'wastage'))['damaged']).toMatchObject({ display: 'Damaged' }); });
    expect((await admin.query("SELECT display FROM inventory.g_cs_reasons WHERE code = 'damaged'")).rows[0].display).toBe('Damaged');
  });

  it('reasons: reason_group is required and must be in the enum => 400 at /reason_group', async () => {
    await inTx(A, async (ctx) => {
      expect(paths(await rej(putCode(ctx, 'reasons', 'no_group', { display: 'x', is_active: true })))).toContain('/reason_group');
      expect(paths(await rej(putCode(ctx, 'reasons', 'bad_group', { reason_group: 'nope', display: 'x', is_active: true })))).toContain('/reason_group');
    });
  });

  it('tax_codes: new tenant code => 200 {code, display, is_active}, listed by #28, no rate; shadowing/deactivating the global VAT affects this tenant only', async () => {
    await inTx(A, async (ctx) => {
      const r = await putCode(ctx, 'tax_codes', 'EXTRA_1', { display: 'Extra tax', is_active: true });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ code: 'EXTRA_1', display: 'Extra tax', is_active: true });
      expect(byCode(await list(ctx, 'tax_codes'))['EXTRA_1']).toMatchObject({ display: 'Extra tax' });
      await putCode(ctx, 'tax_codes', 'VAT', { display: 'VAT', is_active: false });
      expect(byCode(await list(ctx, 'tax_codes'))).not.toHaveProperty('VAT');
    });
    await inTx(B, async (ctx) => { expect(byCode(await list(ctx, 'tax_codes'))['VAT']).toMatchObject({ display: 'VAT' }); });
    expect((await admin.query("SELECT is_active FROM inventory.g_cs_tax_codes WHERE code = 'VAT'")).rows[0].is_active).toBe(true);
  });

  it('tax_codes carry no rate: a rate-like field is rejected (400) or ignored, never stored or echoed (AC-05.8, 08 A2.2)', async () => {
    await inTx(A, async (ctx, q) => {
      for (const extra of [{ rate_bp: 1300 }, { rate: 13 }, { tax_rate_bp: 1300 }]) {
        let r: any;
        try { r = await putCode(ctx, 'tax_codes', 'RATED', { display: 'Rated', is_active: true, ...extra }); } catch (e) { expect(bad(e as LimsError)).toEqual(['common.validation_failed', 400]); continue; }
        expect(Object.keys(r.body).filter((k) => /rate|bp/i.test(k))).toEqual([]);
      }
      const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = 'inventory' AND table_name IN ('cs_tax_codes','g_cs_tax_codes')")).rows.map((x) => x.column_name);
      expect(cols.filter((c) => /rate|bp/i.test(c))).toEqual([]);
    });
  });

  it('uom is global only => 404 common.not_found, nothing written', async () => {
    await inTx(A, async (ctx, q) => {
      const e = await rej(putCode(ctx, 'uom', 'my_unit', { display: 'My unit', is_active: true }));
      expect(bad(e)).toEqual(['common.not_found', 404]);
      expect((await q("SELECT count(*)::int AS n FROM inventory.g_cs_uom WHERE code = 'my_unit'")).rows[0].n).toBe(0);
    });
  });

  it.each([
    ['reasons', 'MY_CODE', { reason_group: 'wastage' }], ['reasons', '1abc', { reason_group: 'wastage' }], ['reasons', 'a'.repeat(33), { reason_group: 'wastage' }], ['reasons', 'has-dash', { reason_group: 'wastage' }],
    ['tax_codes', 'vat2', {}], ['tax_codes', 'A'.repeat(17), {}], ['tax_codes', 'BAD-CODE', {}], ['tax_codes', "X'; DROP TABLE inventory.cs_tax_codes;--", {}],
  ])('%s code %j violates its pattern => 400 common.validation_failed (DDL CHECK is mapped, not a 500)', async (set, code, extra) => {
    await inTx(A, async (ctx) => {
      const e = await rej(putCode(ctx, set, code, { display: 'X', is_active: true, ...extra }));
      expect(bad(e)).toEqual(['common.validation_failed', 400]);
    });
  });

  it.each([
    ['display empty', { display: '' }], ['display 81 chars', { display: 'x'.repeat(81) }], ['sort_order 10000', { sort_order: 10000 }], ['sort_order -1', { sort_order: -1 }], ['sort_order 1.5', { sort_order: 1.5 }],
    ['is_active "true"', { is_active: 'true' }], ['display number', { display: 5 }],
  ])('field probe: %s => 400 common.validation_failed', async (_why, patch) => {
    await inTx(A, async (ctx) => {
      const e = await rej(putCode(ctx, 'reasons', 'probe_code', { reason_group: 'wastage', display: 'ok', sort_order: 1, is_active: true, ...patch }));
      expect(bad(e)).toEqual(['common.validation_failed', 400]);
    });
  });

  it('display is stored verbatim (bound parameter): SQL text in display is data, the table survives', async () => {
    await inTx(A, async (ctx, q) => {
      const text = "x'); DROP TABLE inventory.cs_reasons; --";
      const r = await putCode(ctx, 'reasons', 'inj_probe', { reason_group: 'wastage', display: text, is_active: true });
      expect((r.body as any).display).toBe(text);
      expect((await q('SELECT display FROM inventory.cs_reasons WHERE tenant_id = $1 AND code = $2', [A, 'inj_probe'])).rows[0].display).toBe(text);
    });
  });

  it('If-Match only when the tenant row exists: create without it; update without it => 409; stale => 409; right version => 200', async () => {
    await inTx(A, async (ctx) => {
      expect((await putCode(ctx, 'reasons', 'ver_probe', { reason_group: 'wastage', display: 'v1', is_active: true })).status).toBe(200);
      expect(bad(await rej(putCode(ctx, 'reasons', 'ver_probe', { reason_group: 'wastage', display: 'v?', is_active: true })))).toEqual(['common.version_conflict', 409]);
      expect(bad(await rej(putCode(ctx, 'reasons', 'ver_probe', { reason_group: 'wastage', display: 'v?', is_active: true }, 7)))).toEqual(['common.version_conflict', 409]);
      expect((await putCode(ctx, 'reasons', 'ver_probe', { reason_group: 'wastage', display: 'v2', is_active: true }, 1)).body).toMatchObject({ display: 'v2' });
      expect(bad(await rej(putCode(ctx, 'reasons', 'ver_probe', { reason_group: 'wastage', display: 'v3', is_active: true }, 1)))).toEqual(['common.version_conflict', 409]);
      expect(byCode(await list(ctx, 'reasons', 'wastage'))['ver_probe']).toMatchObject({ display: 'v2' });
      await putCode(ctx, 'tax_codes', 'TAX_V', { display: 't1', is_active: true });
      expect(bad(await rej(putCode(ctx, 'tax_codes', 'TAX_V', { display: 't2', is_active: true })))).toEqual(['common.version_conflict', 409]);
      expect((await putCode(ctx, 'tax_codes', 'TAX_V', { display: 't2', is_active: true }, 1)).body).toMatchObject({ display: 't2' });
    });
  });

  it('the same code in another reason group is a separate row (key = group + code) and does not alter the first', async () => {
    await inTx(A, async (ctx) => {
      await putCode(ctx, 'reasons', 'twin_code', { reason_group: 'wastage', display: 'in wastage', is_active: true });
      // same code in another group is a different row: it must be creatable without If-Match and must not alter the wastage row
      const r = await putCode(ctx, 'reasons', 'twin_code', { reason_group: 'adjustment', display: 'in adjustment', is_active: true });
      expect(r.status).toBe(200);
      expect(byCode(await list(ctx, 'reasons', 'wastage'))['twin_code']).toMatchObject({ display: 'in wastage' });
      expect(byCode(await list(ctx, 'reasons', 'adjustment'))['twin_code']).toMatchObject({ display: 'in adjustment' });
    });
  });

  it('tenant isolation: B writing a code never changes A\'s row of the same code, and A cannot see B\'s', async () => {
    await inTx(B, (ctx) => putCode(ctx, 'reasons', 'lab_custom', { reason_group: 'wastage', display: 'B custom', is_active: true }), true);
    try {
      await inTx(A, async (ctx) => { expect(byCode(await list(ctx, 'reasons', 'wastage'))['lab_custom']).toMatchObject({ display: 'Lab custom' }); });
      await inTx(B, async (ctx) => { expect(byCode(await list(ctx, 'reasons', 'wastage'))['lab_custom']).toMatchObject({ display: 'B custom' }); });
    } finally { await admin.query("DELETE FROM inventory.cs_reasons WHERE tenant_id = $1 AND code = 'lab_custom'", [B]); }
  });

  it('two parallel first PUTs of the same new code: one row, no unique-violation 500 (loser gets 200 or 409)', async () => {
    try {
      const rs = await Promise.allSettled([1, 2].map((n) => inTx(A, (ctx) => putCode(ctx, 'tax_codes', 'RACE_TAX', { display: `racer ${n}`, is_active: true }), true)));
      for (const x of rs.filter((y) => y.status === 'rejected')) expect('common.version_conflict').toBe(((x as PromiseRejectedResult).reason as LimsError).code);
      expect(rs.some((x) => x.status === 'fulfilled')).toBe(true);
      expect((await admin.query("SELECT count(*)::int AS n FROM inventory.cs_tax_codes WHERE tenant_id = $1 AND code = 'RACE_TAX'", [A])).rows[0].n).toBe(1);
    } finally { await admin.query("DELETE FROM inventory.cs_tax_codes WHERE tenant_id = $1 AND code = 'RACE_TAX'", [A]); }
  });
});
