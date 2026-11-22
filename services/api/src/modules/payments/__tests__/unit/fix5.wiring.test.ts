// T0D-FIX-5 (LD-447, LD-449; AUTH AND MONEY SENSITIVE; CR DEPLOY-AXIS-012 item 1): payments/index.ts must register the real handlers; today every operation is the
// 503 placeholder (handlers/index.ts). Tests go through the REAL manifest (`manifest.handlers`), not through the service functions, so they prove the wiring.
// Table per operation (derived from contracts/openapi/payments.yaml + contracts/permissions.yaml, never typed by hand):
//   forbidden-first (caller without x-permission -> auth.forbidden, IdentityPort asked first, nothing read) | privileged permission at aal1 -> auth.mfa_required, nothing read |
//   tenant scope (every payments statement carries tenant_id = $1 = the caller's tenant; another tenant's rows never appear) | no merchant account / empty tenant -> 200 empty or typed 4xx |
//   no outside provider call (global fetch is a throwing spy) | reads write no access log; settings change writes one (names only).
// An operation that is still the 503 placeholder must be named in .orchestra/notes/T0D-FIX-5-left.md (CR item 1). Idempotency-Key refusal is the core pipeline's (stage 6,
// core/pipeline/__tests__/stage06-idempotency-pre.test.ts); here the contract's `x-idempotency: required` set is pinned so the wiring cannot weaken it.
// Fails now: every operation answers common.service_unavailable.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

// ---------------------------------------------------------------------------------------------------- contract tables
const spec: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'payments.yaml'), 'utf8'));
const perms: any = parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
const OPS: Record<string, { permission?: string; idempotency?: string }> = {};
for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) {
  if (op && typeof op === 'object' && op.operationId) OPS[op.operationId] = { permission: op['x-permission'], idempotency: op['x-idempotency'] };
}
const PRIVILEGED = new Set<string>((perms.permissions as Array<{ code: string; privileged?: boolean }>).filter((p) => p.privileged === true).map((p) => p.code));
const PAYMENTS_PERMS = (perms.permissions as Array<{ code: string }>).map((p) => p.code).filter((c) => c.startsWith('payments.'));
const ALL_OPS = Object.keys(OPS);
const PUBLIC_OPS = ALL_OPS.filter((o) => OPS[o]!.permission === undefined);          // provider callbacks / result page: callback token, no x-permission
const STAFF_OPS = ALL_OPS.filter((o) => OPS[o]!.permission !== undefined);
// CR DEPLOY-AXIS-012 item 1 / LD-447 done_when (1): at least these seven must be real.
const REQUIRED = ['listPaymentIntents', 'listPaymentRefunds', 'listReconciliationRuns', 'listReconciliationFindings', 'listStaticQrReconciliations', 'previewStaticQrReconciliation', 'getPaymentSettings'];

// ---------------------------------------------------------------------------------------------------- synthetic fixtures
const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';   // demo tenant: no merchant account, no payments data at all
const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';   // has data; must never leak into A
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const CENTRE = '0190a000-0000-7000-8000-0000000ce001';
const U = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-11-22T08:15:00.000Z';
const D = new Date(NOW);
const SEED_B: Record<string, Array<Record<string, any>>> = {
  'payments.intents': [{ tenant_id: TENANT_B, id: U(101), order_id: U(201), centre_id: CENTRE, gateway: 'esewa', environment: 'uat', status: 'held_for_review', amount_paisa: '225000', hold_reason: 'gateway_ambiguous',
    failure_reason: null, created_at: D, expires_at: D, settled_at: null, last_checked_at: null, version: 1 }],
  'payments.refunds': [{ tenant_id: TENANT_B, id: U(102), intent_id: U(101), order_id: U(201), centre_id: CENTRE, gateway: 'esewa', mode: 'manual', status: 'requested', amount_paisa: '10000', reason_code: 'overpayment',
    reason_text: null, requested_by_membership_id: ACTOR, requested_at: D, created_at: D, version: 1 }],
  'payments.reconciliation_runs': [{ tenant_id: TENANT_B, id: U(103), business_date: '2026-11-20', trigger: 'cron', status: 'completed', started_at: D, finished_at: D, updated_at: D,
    checked_count: 3, ok_count: 3, findings_count: 0, critical_count: 0, version: 1 }],
  'payments.reconciliation_findings': [{ tenant_id: TENANT_B, id: U(104), run_id: U(103), kind: 'missed_settlement', severity: 'warning', auto_action: 'none', status: 'open', created_at: D, version: 1 }],
  'payments.static_qr_reconciliations': [{ tenant_id: TENANT_B, id: U(105), business_date: '2026-11-20', centre_id: null, system_entries: 2, system_total_paisa: '100000', statement_total_paisa: '100000',
    difference_paisa: '0', statement_reference: 'STMT-SYN-B', status: 'matched', note: null, reconciled_by: ACTOR, created_at: D }],
  'payments.settings': [{ tenant_id: TENANT_B, refund_two_person_threshold_paisa: '5000000', purchase_order_label: 'Tenant B lab', reconciliation_enabled: false, version: 7 }],
};
const GLOBAL_TABLES = /g_cs_reasons/;

// ---------------------------------------------------------------------------------------------------- rig
interface Rig { ctx: any; stmts: Array<{ text: string; values: unknown[] }>; asserts: Array<{ permission: string; centreId?: string; at: number }>; access: any[] }
interface Who { tenant?: string; grant?: readonly string[] | 'all'; aal2?: boolean; actorType?: string }
function makeRig(op: string, who: Who = {}): Rig {
  const tenant = who.tenant ?? TENANT_A;
  const granted = who.grant ?? 'all';
  const stmts: Rig['stmts'] = [], asserts: Rig['asserts'] = [], access: any[] = [];
  const tx = {
    query: async (text: string, values: unknown[] = []) => {
      stmts.push({ text, values });
      const table = /(?:FROM|INTO|UPDATE)\s+([a-z_]+\.[a-z_0-9]+)/i.exec(text)?.[1]?.toLowerCase() ?? '';
      if (/INSERT INTO payments\.settings/i.test(text)) {
        const row = { tenant_id: values[0], refund_two_person_threshold_paisa: values[1], purchase_order_label: values[2], reconciliation_enabled: values[3], version: 1 };
        return { rows: [row], rowCount: 1 };
      }
      if (/^\s*UPDATE payments\.reconciliation_findings/i.test(text)) {       // resolve: only tenant B's seeded open finding exists; $6 is the tenant, $7 the id
        const cur = values[5] === TENANT_B ? SEED_B['payments.reconciliation_findings']!.find((r) => r['id'] === values[6]) : undefined;
        const row = cur ? { ...cur, status: 'resolved', resolution_code: values[0], note: values[1], resolved_by: values[2], resolved_at: values[3], version: Number(cur['version']) + 1 } : undefined;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/^\s*INSERT INTO payments\.static_qr_reconciliations/i.test(text)) {  // create: id, tenant, date, centre, entries, system, statement, ref, status, note, by
        const row = { id: values[0], tenant_id: values[1], business_date: values[2], centre_id: values[3], system_entries: values[4], system_total_paisa: values[5], statement_total_paisa: values[6],
          difference_paisa: Number(values[6]) - Number(values[5]), statement_reference: values[7], status: values[8], note: values[9], reconciled_by: values[10], created_at: D };
        return { rows: [row], rowCount: 1 };
      }
      if (table === 'billing.v_pub_payment_collection') return { rows: [values[0] === TENANT_B ? { entries: '3', total: '90000' } : { entries: '0', total: '0' }], rowCount: 1 };
      const rows = values[0] === TENANT_B ? (SEED_B[table] ?? []) : [];
      return { rows, rowCount: rows.length };
    },
  };
  const IdentityPort = {
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }): Promise<void> {
      asserts.push({ permission: r.permission, ...(r.centreId ? { centreId: r.centreId } : {}), at: stmts.length });
      if (granted !== 'all' && !granted.includes(r.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && who.aal2 === false) throw new LimsError('auth.mfa_required');
    },
  };
  const noop = () => undefined;
  const ctx = {
    operationId: op, requestId: 'req-synthetic-fix5', clientIp: '203.0.113.9', tenantId: tenant, actor: { type: who.actorType ?? 'user', id: ACTOR, membershipId: ACTOR },
    tx, now: () => NOW, audit: { access: async (e: unknown) => { access.push(e); } }, log: { info: noop, warn: noop, error: noop, debug: noop },
    db: { tx: async (fn: (c: unknown) => Promise<unknown>) => fn({ tx }) }, metrics: { set: noop, inc: noop },
    ports: { IdentityPort, BillingPort: { getOrderBalance: async () => ({ balanceDue: { amountPaisa: 0, currency: 'NPR' } }), recordGatewayPayment: async () => ({ ledgerEntryId: U(900), duplicate: false }) },
      FrontdeskPort: { getOrderSummary: async () => ({ branchId: U(901), centreId: CENTRE, status: 'open' }) } },
  };
  return { ctx, stmts, asserts, access };
}

const PARAMS = { intent_id: U(101), refund_id: U(102), run_id: U(103), finding_id: U(104), gateway: 'esewa', environment: 'uat', set_name: 'hold_reasons' };
const QUERY: Record<string, Record<string, unknown>> = { previewStaticQrReconciliation: { business_date: '2026-11-20' } };
const reqFor = (op: string, over: Record<string, unknown> = {}) => ({ params: PARAMS, query: QUERY[op] ?? {}, headers: { 'if-match': '"1"' }, body: undefined, ...over });
type Out = { res?: any; err?: any } & Rig;
async function run(op: string, who: Who = {}, req: Record<string, unknown> = {}): Promise<Out> {
  const rig = makeRig(op, who);
  try { return { ...rig, res: await (manifest.handlers as Record<string, any>)[op](reqFor(op, req), rig.ctx) }; } catch (err) { return { ...rig, err }; }
}
const code = (o: Out): string | undefined => (o.err instanceof LimsError ? o.err.code : undefined);

// ---------------------------------------------------------------------------------------------------- which operations are still placeholders
const PLACEHOLDER = 'common.service_unavailable';
const unwired = new Set<string>();
const fetchSpy = vi.fn(async () => { throw new Error('T0D-FIX-5: no outside call is allowed in a test'); });
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', fetchSpy);                      // before the probe below: nothing in this file may reach the network
afterAll(() => { vi.unstubAllGlobals(); globalThis.fetch = realFetch; });
for (const op of ALL_OPS) {
  const probe = await run(op, { grant: [] });     // a caller with nothing: a real staff handler says auth.forbidden, the placeholder says service_unavailable before any check
  if (code(probe) === PLACEHOLDER) unwired.add(op);
}
const wiredStaff = STAFF_OPS.filter((o) => !unwired.has(o));
const leftFile = join(REPO_ROOT, '.orchestra', 'notes', 'T0D-FIX-5-left.md');
const leftText = existsSync(leftFile) ? readFileSync(leftFile, 'utf8') : '';

describe('(1) payments/index.ts registers the real handlers', () => {
  it.each(REQUIRED)('%s is wired (not the 503 placeholder)', (op) => {
    expect(unwired.has(op), `${op} still answers ${PLACEHOLDER}; wire its factory in handlers/index.ts`).toBe(false);
  });
  it('the manifest still has exactly one handler per payments.yaml operationId', () => {
    expect(Object.keys(manifest.handlers).sort()).toEqual([...ALL_OPS].sort());
  });
  it('every operation that is still the 503 placeholder is named in .orchestra/notes/T0D-FIX-5-left.md (CR item 1)', () => {
    const missing = [...unwired].filter((op) => !new RegExp(`\\b${op}\\b`).test(leftText));
    expect(missing, existsSync(leftFile) ? 'not named in notes/T0D-FIX-5-left.md' : 'notes/T0D-FIX-5-left.md does not exist').toEqual([]);
  });
});

describe('(2) guard table: every wired staff operation', () => {
  it('has at least the required seven wired, so the table is not empty', () => { expect(wiredStaff.length).toBeGreaterThanOrEqual(REQUIRED.length); });
  const table = (): string[] => [...new Set([...REQUIRED, ...wiredStaff])];

  it.each(table())('%s: a caller with no payments permission gets auth.forbidden, IdentityPort is asked FIRST for the contract permission, nothing is read, written, logged or called out', async (op) => {
    const o = await run(op, { grant: [] });
    expect(code(o), `${op}: ${String(o.err ?? JSON.stringify(o.res))}`).toBe('auth.forbidden');
    expect(o.asserts[0]?.permission).toBe(OPS[op]!.permission);
    expect(o.stmts).toEqual([]);
    expect(o.access).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(table())('%s: a caller who holds every OTHER payments permission is still auth.forbidden before any read', async (op) => {
    const o = await run(op, { grant: PAYMENTS_PERMS.filter((p) => p !== OPS[op]!.permission) });
    expect(code(o)).toBe('auth.forbidden');
    expect(o.stmts).toEqual([]);
  });

  it.each(table().filter((op) => PRIVILEGED.has(OPS[op]!.permission!)))('%s: permission is privileged in permissions.yaml; at aal1 IdentityPort says auth.mfa_required and the handler lets it through unchanged, nothing read', async (op) => {
    const o = await run(op, { aal2: false });
    expect(code(o)).toBe('auth.mfa_required');
    expect(o.stmts).toEqual([]);
    expect(o.access).toEqual([]);
  });

  it('the contract keeps x-idempotency: required on every payments write the wiring exposes (the core pipeline refuses a missing key, stage 6)', () => {
    const required = ALL_OPS.filter((o) => OPS[o]!.idempotency === 'required').sort();
    expect(required).toEqual(['approvePaymentRefund', 'cancelPaymentIntent', 'confirmManualPaymentRefund', 'createPaymentRefundRequest', 'createStaticQrReconciliation', 'failManualPaymentRefund',
      'rejectPaymentRefund', 'resolvePaymentIntent', 'resolveReconciliationFinding', 'startReconciliationRun']);
    for (const op of required) expect(OPS[op]!.permission, `${op} is a staff operation with a permission`).toBeTruthy();
  });
});

describe('(3) a tenant with NO merchant account and NO payments data (the demo tenant)', () => {
  const LISTS = ['listPaymentIntents', 'listPaymentRefunds', 'listReconciliationRuns', 'listReconciliationFindings', 'listStaticQrReconciliations'];

  it.each(LISTS)('%s: 200 with empty data and a page object; no provider call; no access log row', async (op) => {
    const o = await run(op);
    expect(o.err, String(o.err)).toBeUndefined();
    expect(o.res.status).toBe(200);
    expect(o.res.body.data).toEqual([]);
    expect(o.res.body.page).toMatchObject({ limit: 50 });
    expect(o.res.body.page.next_cursor).toBeUndefined();
    expect(o.access).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('listMerchantAccounts (when wired): 200 with data []', async () => {
    if (unwired.has('listMerchantAccounts')) return;
    const o = await run('listMerchantAccounts');
    expect(o.res?.status).toBe(200);
    expect(o.res.body).toEqual({ data: [] });
  });

  it('getPaymentSettings: 200 with the contract shape and the documented defaults (no settings row yet), never tenant B\'s values', async () => {
    const o = await run('getPaymentSettings');
    expect(o.err, String(o.err)).toBeUndefined();
    expect(o.res.status).toBe(200);
    expect(Object.keys(o.res.body).sort()).toEqual(['purchase_order_label', 'reconciliation_enabled', 'refund_two_person_threshold', 'version']);
    expect(o.res.body).toEqual({ refund_two_person_threshold: { amount_paisa: 0, currency: 'NPR' }, purchase_order_label: 'Lab payment', reconciliation_enabled: true, version: 1 });
    expect(o.access).toEqual([]);
  });

  it('previewStaticQrReconciliation: 200 with zero system figures (no collection that day), contract shape', async () => {
    const o = await run('previewStaticQrReconciliation');
    expect(o.err, String(o.err)).toBeUndefined();
    expect(o.res.status).toBe(200);
    expect(o.res.body).toEqual({ business_date: '2026-11-20', system_entries: 0, system_total: { amount_paisa: 0, currency: 'NPR' } });
  });

  it.each([['business_date missing', {}], ['business_date not a date', { business_date: 'yesterday' }], ['unknown key', { business_date: '2026-11-20', tenant_id: TENANT_B }]])(
    'previewStaticQrReconciliation: %s -> typed 400 common.validation_failed, never 500', async (_n, query) => {
      const o = await run('previewStaticQrReconciliation', {}, { query });
      expect(code(o)).toBe('common.validation_failed');
      expect(o.err.statusCode).toBe(400);
    });

  it.each(LISTS.map((op) => [op]))('%s: bad input (limit 0, limit 201, garbage cursor, unknown filter) is a typed 4xx and no SQL is built from it', async (op) => {
    for (const query of [{ limit: 0 }, { limit: 201 }, { cursor: "' OR 1=1 --" }, { nope: 'x' }]) {
      const o = await run(op, {}, { query });
      expect(o.err, `${op} ${JSON.stringify(query)} -> ${JSON.stringify(o.res)}`).toBeInstanceOf(LimsError);
      expect(o.err.statusCode, `${op} ${JSON.stringify(query)}`).toBeGreaterThanOrEqual(400);
      expect(o.err.statusCode).toBeLessThan(500);
      expect(JSON.stringify(o.stmts.map((s) => s.values))).not.toMatch(/OR 1=1/);
    }
  });

  it.each(STAFF_OPS.map((op) => [op]))('%s: with every permission and an empty tenant the answer is 2xx or a typed 4xx (never 500, never a TypeError), and no provider is called', async (op) => {
    if (unwired.has(op)) return;                                   // named in left.md by test (1)
    const o = await run(op);
    if (o.err !== undefined) {
      expect(o.err, `${op} threw a non-typed error: ${String(o.err?.stack ?? o.err)}`).toBeInstanceOf(LimsError);
      expect(o.err.statusCode, `${op}: ${o.err.code}`).toBeGreaterThanOrEqual(400);
      expect(o.err.statusCode, `${op}: ${o.err.code}`).toBeLessThan(500);
    } else expect(o.res.status).toBeLessThan(300);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('testMerchantAccount (when wired): no merchant account row -> 404 common.not_found, the provider is never called', async () => {
    if (unwired.has('testMerchantAccount')) return;
    const o = await run('testMerchantAccount');
    expect(code(o)).toBe('common.not_found');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('(2b) another tenant sees nothing; every payments statement is scoped by the caller\'s tenant', () => {
  const READS = ['listPaymentIntents', 'listPaymentRefunds', 'listReconciliationRuns', 'listReconciliationFindings', 'listStaticQrReconciliations', 'getPaymentSettings', 'previewStaticQrReconciliation'];
  const scoped = (o: Out, tenant: string) => {
    const own = o.stmts.filter((s) => !GLOBAL_TABLES.test(s.text));
    expect(own.length, 'the handler reads the database').toBeGreaterThan(0);
    for (const s of own) {
      expect(s.text, s.text).toMatch(/tenant_id\s*=\s*\$1\b/);
      expect(s.values[0], s.text).toBe(tenant);
    }
  };

  it.each(READS)('%s: tenant A (no rows) gets none of tenant B\'s rows or values; tenant B (control) does read its own', async (op) => {
    const a = await run(op, { tenant: TENANT_A });
    expect(a.err, String(a.err)).toBeUndefined();
    scoped(a, TENANT_A);
    expect(JSON.stringify(a.res.body)).not.toMatch(/Tenant B|STMT-SYN-B|5000000|90000|0190a000-0000-7000-8000-00000000bbbb/);
    const b = await run(op, { tenant: TENANT_B });
    expect(b.err, String(b.err)).toBeUndefined();
    scoped(b, TENANT_B);
    if (op === 'getPaymentSettings') expect(b.res.body).toMatchObject({ purchase_order_label: 'Tenant B lab', reconciliation_enabled: false, version: 7, refund_two_person_threshold: { amount_paisa: 5000000, currency: 'NPR' } });
    else if (op === 'previewStaticQrReconciliation') expect(b.res.body).toMatchObject({ system_entries: 3, system_total: { amount_paisa: 90000, currency: 'NPR' } });
    else expect(b.res.body.data.length, `${op}: the control tenant's own row is listed (the handler really reads the database)`).toBe(1);
  });

  it('a caller-supplied tenant_id in the query is refused (400), never used as a scope', async () => {
    for (const op of ['listPaymentIntents', 'listPaymentRefunds', 'listReconciliationRuns', 'listReconciliationFindings', 'listStaticQrReconciliations']) {
      const o = await run(op, { tenant: TENANT_A }, { query: { tenant_id: TENANT_B } });
      expect(code(o), op).toBe('common.validation_failed');
      expect(o.stmts.every((s) => !JSON.stringify(s.values).includes(TENANT_B)), op).toBe(true);
    }
  });
});

describe('(2c) access / audit log entries the neighbouring code and contract declare', () => {
  it('updatePaymentSettings (when wired): one settings.change access row, field NAMES only (never the label or the amount), outcome allowed; a read writes none', async () => {
    if (unwired.has('updatePaymentSettings')) return;
    const body = { refund_two_person_threshold_paisa: 7654300, purchase_order_label: 'Syn Lab Label', reconciliation_enabled: false };
    const o = await run('updatePaymentSettings', {}, { body, headers: {} });
    expect(o.err, String(o.err)).toBeUndefined();
    expect(o.res.status).toBe(200);
    expect(o.access).toHaveLength(1);
    expect(o.access[0]).toMatchObject({ action: 'settings.change', entityType: 'payment_settings', outcome: 'allowed' });
    expect(JSON.stringify(o.access[0])).not.toMatch(/7654300|Syn Lab Label/);
    expect(String(o.access[0].detail?.fields)).toMatch(/refund_two_person_threshold_paisa/);
  });
  it('updatePaymentSettings (when wired): bad body -> typed 400, no access row, nothing written', async () => {
    if (unwired.has('updatePaymentSettings')) return;
    const o = await run('updatePaymentSettings', {}, { body: { refund_two_person_threshold_paisa: -1, purchase_order_label: '<script>', reconciliation_enabled: 'yes' }, headers: {} });
    expect(code(o)).toBe('common.validation_failed');
    expect(o.access).toEqual([]);
    expect(o.stmts.filter((s) => /^\s*(INSERT|UPDATE)/i.test(s.text))).toEqual([]);
  });
  // reviewer item 1 (T0D-FIX-5-review.md): the success path and the log entry of the two wired write operations, through the real manifest.
  const portCalls = (rig: Rig): string[] => {
    const calls: string[] = [];
    for (const [pn, port] of Object.entries(rig.ctx.ports as Record<string, Record<string, unknown>>)) {
      for (const fn of Object.keys(port)) if (fn !== 'assertRole') port[fn] = async () => { calls.push(`${pn}.${fn}`); throw new Error('no port call expected'); };
    }
    return calls;
  };
  const runB = async (op: string, req: Record<string, unknown>) => {
    const rig = makeRig(op, { tenant: TENANT_B });
    const calls = portCalls(rig);
    try { return { ...rig, calls, res: await (manifest.handlers as Record<string, any>)[op](reqFor(op, req), rig.ctx) } as Out & { calls: string[] }; } catch (err) { return { ...rig, calls, err } as Out & { calls: string[] }; }
  };
  const FINDING = { findingId: U(104) };
  it('resolveReconciliationFinding: open finding, If-Match "1" -> 200, one payment_intent.resolve access row with the resolution code only (never the note), UPDATE scoped to the tenant', async () => {
    const o = await runB('resolveReconciliationFinding', { params: { finding_id: FINDING.findingId }, headers: { 'if-match': '"1"' }, body: { resolution_code: 'escalated_to_provider', note: 'syn-note-must-not-be-logged' } });
    expect(o.err, String(o.err)).toBeUndefined();
    expect(o.res.status).toBe(200);
    expect(o.res.body).toMatchObject({ id: U(104), status: 'resolved', resolution_code: 'escalated_to_provider', version: 2 });
    expect(o.access).toHaveLength(1);
    expect(o.access[0]).toMatchObject({ action: 'payment_intent.resolve', entityType: 'reconciliation_finding', outcome: 'allowed', detail: { resolution_code: 'escalated_to_provider' } });
    expect(JSON.stringify(o.access[0])).not.toContain('syn-note-must-not-be-logged');
    const upd = o.stmts.find((s) => /^\s*UPDATE payments\.reconciliation_findings/i.test(s.text))!;
    expect(upd, 'the finding is updated').toBeDefined();
    const at = Number(/tenant_id\s*=\s*\$(\d+)/.exec(upd.text)?.[1]);
    expect(upd.values[at - 1], 'tenant_id in the UPDATE WHERE is the caller\'s tenant').toBe(TENANT_B);
    expect(o.calls, 'no port is called').toEqual([]);
    expect(o.asserts[0]?.permission).toBe('payments.intent.resolve');
    expect(o.asserts[0]!.at, 'permission checked before any statement').toBe(0);
  });
  it('resolveReconciliationFinding: no If-Match -> common.precondition_required, no access row, no UPDATE', async () => {
    const o = await runB('resolveReconciliationFinding', { params: { finding_id: FINDING.findingId }, headers: {}, body: { resolution_code: 'escalated_to_provider' } });
    expect(code(o)).toBe('common.precondition_required');
    expect(o.access).toEqual([]);
    expect(o.stmts.filter((s) => /^\s*UPDATE/i.test(s.text))).toEqual([]);
  });
  it('resolveReconciliationFinding: stale If-Match -> common.version_conflict; another tenant\'s finding -> common.not_found; neither logs', async () => {
    const stale = await runB('resolveReconciliationFinding', { params: { finding_id: FINDING.findingId }, headers: { 'if-match': '"9"' }, body: { resolution_code: 'escalated_to_provider' } });
    expect(code(stale)).toBe('common.version_conflict');
    expect(stale.access).toEqual([]);
    const other = await run('resolveReconciliationFinding', { tenant: TENANT_A }, { params: { finding_id: FINDING.findingId }, body: { resolution_code: 'escalated_to_provider' } });
    expect(code(other)).toBe('common.not_found');
    expect(other.access).toEqual([]);
  });
  it('createStaticQrReconciliation: valid body -> 201, row inserted for the caller\'s tenant, no access row (row trigger only, D-112), no port call', async () => {
    const o = await runB('createStaticQrReconciliation', { headers: {}, body: { business_date: '2026-11-20', statement_total_paisa: 90000, statement_reference: 'STMT-SYN-FIX5' } });
    expect(o.err, String(o.err)).toBeUndefined();
    expect(o.res.status).toBe(201);
    expect(o.res.body).toMatchObject({ business_date: '2026-11-20', statement_reference: 'STMT-SYN-FIX5', status: 'matched', system_entries: 3, statement_total: { amount_paisa: 90000, currency: 'NPR' } });
    const ins = o.stmts.find((s) => /^\s*INSERT INTO payments\.static_qr_reconciliations/i.test(s.text))!;
    expect(ins, 'the reconciliation is inserted').toBeDefined();
    expect(ins.text).toMatch(/\btenant_id\b/);
    expect(ins.values).toContain(TENANT_B);
    expect(o.access, 'the contract declares no access row for this operation; the row trigger records it').toEqual([]);
    expect(o.calls, 'no port is called').toEqual([]);
    expect(o.asserts[0]?.permission).toBe('payments.intent.resolve');
    expect(o.asserts[0]!.at).toBe(0);
  });
  it('createStaticQrReconciliation: difference without a note -> 400, nothing inserted; empty body -> 400', async () => {
    const diff = await runB('createStaticQrReconciliation', { headers: {}, body: { business_date: '2026-11-20', statement_total_paisa: 1, statement_reference: 'STMT-SYN-FIX5' } });
    expect(code(diff)).toBe('common.validation_failed');
    expect(diff.stmts.filter((s) => /^\s*INSERT/i.test(s.text))).toEqual([]);
    const empty = await runB('createStaticQrReconciliation', { headers: {}, body: {} });
    expect(code(empty)).toBe('common.validation_failed');
  });
  it('putMerchantAccount (when wired): the secret never reaches the access log, an error or the response', async () => {
    if (unwired.has('putMerchantAccount')) return;
    const SECRET = 'sk_test_SYNTHETIC_FIX5_SECRET_0001';
    const o = await run('putMerchantAccount', {}, { body: { is_enabled: true, esewa_product_code: 'LIMS_SYN_01', secret: SECRET }, headers: {} });
    expect(JSON.stringify([o.access, o.res, String(o.err), o.err?.fieldErrors])).not.toContain(SECRET);
  });
});

describe('(5) LD-449 (d): handlers read the gateway environment only from the validated config', () => {
  const here = join(import.meta.dirname, '..', '..');
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '__tests__' ? [] : e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  it('no payments source outside config.ts mentions process.env or LIMS_PAYMENTS_GATEWAY_ENV (no second variable)', () => {
    const offenders = sources(here).filter((f) => !f.endsWith('config.ts')).filter((f) => /process\.env|GATEWAY_ENV/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
