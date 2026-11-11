// C5 T-32 probe kit (helper, not a test): one request table for ALL 55 lab operations (contracts/openapi/lab.yaml), one universal HandlerContext over a REAL PG17 tx
// (lims_api, RLS on; same convention as ../../handlers/__tests__/specimen.handlers.integration.test.ts and C4 FD-T16 kit), and the tenant/centre object graphs the probes share.
// Needs LIMS_TEST_DATABASE_URL (role lims_api) + LIMS_TEST_ADMIN_DATABASE_URL (superuser): tests/db/c5-t03/run.sh boots PG17 + migrations + seeds. Synthetic data only.
// Under LIMS_T03_REQUIRE_DB=1 a missing database FAILS (never skips): see the "database is provided" test of every live file.
// ASSUMED (as T-07 .. T-29 suites): centre scope = IdentityPort.getActor().centreScope / assertRole({ permission, centreId }); privileged permissions need aal2 (REQ-SEC-062/067;
// contracts/permissions.yaml is the source of "privileged"); the core pipeline (schema, x-permission, Idempotency-Key replay, membership re-validation) is NOT re-run here:
// the IdentityPort fake models what it hands the handler, and every probe also asserts the handler asked for the CONTRACT's x-permission.
import { uuidv7 } from '../../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { access } from '../../../../core/audit/access.js';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';

export const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
export const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
export const live = Boolean(API_URL && ADMIN_URL);
export const requireDb = process.env['LIMS_T03_REQUIRE_DB'] === '1';
export const T = 120_000;

export const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
export const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const MEM = { a: '01a1a98a-ac40-7000-8000-00000000a500', b: '01a1a98a-ac40-7000-8000-00000000b500' } as const;
export const CENTRE = { a: '01a1a98a-ac40-7000-8000-00000000a201', b: '01a1a98a-ac40-7000-8000-00000000b201' } as const;
export const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';          // db/seeds/010: second centre of tenant A, in the other branch
export const BRANCH = { a: '01a1a98a-ac40-7000-8000-00000000a101', b: '01a1a98a-ac40-7000-8000-00000000b101' } as const;
export const BRANCH_A2 = '01a1a98a-ac40-7000-8000-00000000a102';
export const NOW = new Date('2026-06-15T05:00:30.000Z');
export const tenantOf = (side: 'a' | 'b'): string => (side === 'a' ? TENANT_A : TENANT_B);
export const uid = (): string => uuidv7();                            // unique per call: the live files share one database and run in parallel workers

// ---------------------------------------------------------------- the contract (operations) - from lab.yaml, never from the handlers
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/lab.yaml'));
export interface OpInfo { id: string; method: string; path: string; permission: string; idempotency: string; pathParams: string[]; queryParams: string[]; isList: boolean; operation: any }
export const OPS: OpInfo[] = Object.entries<any>(spec.paths).flatMap(([path, item]) =>
  ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId).map((method) => {
    const op = item[method];
    const params: any[] = [...(item.parameters ?? []), ...(op.parameters ?? [])];
    return { id: op.operationId as string, method, path, permission: op['x-permission'] as string, idempotency: String(op['x-idempotency'] ?? ''), operation: op,
      pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!), queryParams: params.filter((p) => p?.in === 'query').map((p) => p.name as string),
      isList: method === 'get' && params.some((p) => p?.$ref?.endsWith('/Cursor') || p?.name === 'cursor') } satisfies OpInfo;
  }));
export const opById = (id: string): OpInfo => OPS.find((o) => o.id === id)!;
export const fileText = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** permissions.yaml is the source: lab.* codes, which are privileged (aal2), which default roles hold them. */
export interface PermRow { code: string; privileged: boolean; roles: string[] }
export const LAB_PERMS: PermRow[] = [...fileText('contracts/permissions.yaml').matchAll(/code:\s*(lab\.[a-z_.]+),\s*privileged:\s*(true|false),\s*roles:\s*\[([^\]]*)\]/g)]
  .map((m) => ({ code: m[1]!, privileged: m[2] === 'true', roles: m[3]!.split(',').map((r) => r.trim()).filter(Boolean) }));
export const PRIVILEGED: ReadonlySet<string> = new Set(LAB_PERMS.filter((p) => p.privileged).map((p) => p.code));
export const ALL_LAB_PERMS: string[] = LAB_PERMS.map((p) => p.code);
export const ROLES = ['front_desk', 'phlebotomist', 'centre_staff', 'lab_technologist', 'pathologist', 'lab_manager'] as const;
export const grantsOfRole = (role: string): string[] => LAB_PERMS.filter((p) => p.roles.includes(role)).map((p) => p.code);

// ---------------------------------------------------------------- database
let apiPool: pg.Pool | undefined;
let adminPool: pg.Pool | undefined;
export const api = (): pg.Pool => (apiPool ??= new pg.Pool({ connectionString: API_URL, max: 8 }));
export const admin = (): pg.Pool => (adminPool ??= new pg.Pool({ connectionString: ADMIN_URL, max: 4 }));
export const closePools = async (): Promise<void> => { await Promise.all([apiPool?.end(), adminPool?.end()]); apiPool = adminPool = undefined; };
export const claimsOf = (tenant: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'system', ...extra });
/** owner-side query (superuser, no RLS): the truth the probes compare against. */
export const owner = async (text: string, values: unknown[] = []): Promise<any[]> => (await admin().query(text, values)).rows;

/** run `fn` in ONE committed tx on `pool` with the given claims set (RLS applies on the api pool). A throw rolls back. */
export async function withClaims<R>(pool: pg.Pool, claims: string, fn: (c: pg.PoolClient) => Promise<R>): Promise<R> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
export const asOwner = <R>(tenant: string, fn: (c: pg.PoolClient) => Promise<R>): Promise<R> => withClaims(admin(), claimsOf(tenant), fn);

const colsCache = new Map<string, Set<string>>();
/** INSERT one row; created_by / updated_by filled when the table has them. */
export async function ins(c: pg.PoolClient, table: string, row: Record<string, unknown>): Promise<void> {
  if (!colsCache.has(table)) {
    const [s, t] = table.split('.');
    colsCache.set(table, new Set((await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [s, t])).rows.map((r) => r.column_name)));
  }
  const cols = colsCache.get(table)!;
  const r: Record<string, unknown> = { ...row };
  for (const a of ['created_by', 'updated_by']) if (cols.has(a) && !(a in r)) r[a] = SYS;
  const keys = Object.keys(r);
  await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => r[k]));
}

/** Ruling E: app.enqueue_job rejects identifiers absent from core.g_task_registry; the deploy-time registry-sync fills it, app code never does (precedent ports/__tests__/harness.ts ensureTaskRegistry, ruling
 *  C5.T-24 #2). Seeds the task receiveSpecimen enqueues (S-12: lab.reapply_exceptions_for_specimen). Superuser, idempotent; objs() calls it, so every live file has it. */
let registrySeeded = false;
export async function ensureLabTaskRegistry(): Promise<void> {
  if (registrySeeded) return;
  await owner(`INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('lab.reapply_exceptions_for_specimen','lab','task','per_tenant',10) ON CONFLICT DO NOTHING`);
  registrySeeded = true;
}

// ---------------------------------------------------------------- actors
export interface Who {
  tenant: string; membershipId: string; grants: readonly string[]; mfa: 'aal1' | 'aal2'; centreIds: readonly string[]; allCentres: boolean;
  /** IdentityPort refuses every assertRole with this code (locked account / membership revoked after token issue, 07 §4 re-validation) */ refuse?: string;
  type?: 'user' | 'device' | 'system';
}
export const mk = (side: 'a' | 'b', o: Partial<Who> = {}): Who => ({
  tenant: tenantOf(side), membershipId: MEM[side], grants: ALL_LAB_PERMS, mfa: 'aal2', centreIds: [CENTRE[side]], allCentres: false, type: 'user', ...o });
/** tenant A, every lab permission at aal2, every centre. */
export const FULL_A: Who = mk('a', { allCentres: true, centreIds: [CENTRE.a, CENTRE_A2] });
export const FULL_B: Who = mk('b', { allCentres: true });
/** tenant A, same permissions, centre A1 ONLY (the cross-centre actor). */
export const A1_ONLY: Who = mk('a', { centreIds: [CENTRE.a], allCentres: false });
export const as = (w: Who, o: Partial<Who>): Who => ({ ...w, ...o });

/** IdentityPort fake: what the real port hands a handler (auth.forbidden / auth.mfa_required / centre scope). The privileged set comes from permissions.yaml. */
export function identityOf(w: Who) {
  const calls: Array<{ permission: string; centreId?: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string; centreId?: string }) {
      calls.push({ permission: r?.permission, ...(r?.centreId ? { centreId: r.centreId } : {}) });
      if (w.refuse) throw new LimsError(w.refuse as never);
      if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && w.mfa !== 'aal2') throw new LimsError('auth.mfa_required');
      if (r.centreId && !w.allCentres && !w.centreIds.includes(r.centreId)) throw new LimsError('auth.forbidden');
    },
    async getActor() {
      return { actor: { type: w.type ?? 'user', id: SYS, membershipId: w.membershipId }, permissions: [...w.grants], roles: [], centreScope: { all: w.allCentres, centreIds: w.centreIds },
        branchIds: [BRANCH.a], mfa: { enrolled: w.mfa === 'aal2', level: w.mfa }, isLocked: w.refuse === 'auth.account_locked' };
    },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
  };
}

// ---------------------------------------------------------------- one request
export interface Probe { logs: string[]; events: Array<{ type: string; input: any }>; accessCalls: any[]; writes: string[]; requestId: string; identity: ReturnType<typeof identityOf>; ctx: any }
export interface Outcome { reply?: { status: number; body?: any; headers?: Record<string, string> }; error?: any; probe: Probe }
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined as unknown, ...o });
const WRITE = /^\s*(insert|update|delete|truncate)\b/i;
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
export interface FireOpts { now?: Date; ports?: Record<string, unknown>; claims?: Record<string, unknown> }

// Ruling B (C5.T-32-ruling.md): worklist / pending / worksheet / status board / label ops need FrontdeskPort (02-TRD.md:111, 364). Synthetic fake over the SAME tenant-scoped tx (RLS on), so a foreign-tenant id is
// invisible exactly as with the real port; LD-124 "invent no port" binds the handler, not the test fakes. Demographics are the synthetic rows objs() inserts (label printing reads them through the batch call).
function frontdeskFake(tx: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }) {
  const demo = (r: any) => ({ patientId: r.id, patientCode: r.patient_code, fullName: r.full_name, sex: r.sex, ageAtOrder: { years: 30, months: 0, days: 0 }, dateOfBirth: null });
  return {
    async getOrderSummary(_c: unknown, a: { orderId: string }) {
      const o = (await tx.query('SELECT * FROM frontdesk.orders WHERE id = $1', [a.orderId])).rows[0];
      if (!o) throw new LimsError('common.not_found');
      const items = (await tx.query('SELECT id, status FROM frontdesk.order_items WHERE order_id = $1', [a.orderId])).rows;
      return { orderId: o.id, centreId: o.centre_id, branchId: o.branch_id, patientId: o.patient_id, registrationNo: o.registration_no, visitType: o.visit_type, priority: o.priority, referrerId: null, source: o.source,
        registeredAt: new Date(o.registered_at).toISOString(), items: items.map((i) => ({ orderItemId: i.id, status: i.status ?? 'active' })) };
    },
    async getPatientDemographics(_c: unknown, a: { patientId: string }) {
      const r = (await tx.query('SELECT * FROM frontdesk.patients WHERE id = $1', [a.patientId])).rows[0];
      if (!r) throw new LimsError('common.not_found');
      return demo(r);
    },
    async getPatientDemographicsBatch(_c: unknown, a: { patientIds: string[] }) {
      return (await tx.query('SELECT * FROM frontdesk.patients WHERE id = ANY($1::uuid[])', [a.patientIds])).rows.map(demo);
    },
  };
}

/** One request = one committed tx under `who.tenant`'s claims (RLS on); on a throw the tx rolls back and the error is returned, never thrown. */
export async function fire(operationId: string, r: ReturnType<typeof req>, who: Who, o: FireOpts = {}): Promise<Outcome> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const probe: Probe = { logs: [], events: [], accessCalls: [], writes: [], requestId: uid(), identity: identityOf(who), ctx: undefined };
  const run = async (rawTx: pg.PoolClient) => {
    const tx = { query: async (text: string, values?: unknown[]) => { if (WRITE.test(text)) probe.writes.push(text); return rawTx.query(text, values as never); }, startedAt: NOW };
    const log = (lvl: string) => (obj: unknown, msg?: string) => { probe.logs.push(`${lvl} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => o.now ?? NOW, centreId: CENTRE[side],
      actor: { type: who.type ?? 'user', id: SYS, membershipId: who.membershipId },
      ports: { IdentityPort: probe.identity, FrontdeskPort: frontdeskFake(tx), ...(o.ports ?? {}) },
      events: { publish: async (_c: unknown, type: string, input: unknown) => { probe.events.push({ type, input }); return { eventId: uid(), duplicate: false }; } },
      core: { centres: { list: async () => [{ id: CENTRE[side], branchId: BRANCH[side], branch_id: BRANCH[side] }, { id: CENTRE_A2, branchId: BRANCH_A2, branch_id: BRANCH_A2 }] } },
    };
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    probe.ctx = ctx;
    return H[operationId]!(r, ctx);
  };
  try { return { reply: await withClaims(api(), claimsOf(who.tenant, o.claims), run), probe }; } catch (error) { return { error, probe }; }
}
export const codeOf = (o: Outcome): string | undefined => (o.error instanceof LimsError ? (o.error as any).code : undefined);
export const statusOf = (o: Outcome): number | undefined => o.reply?.status ?? (o.error as any)?.statusCode;
/** everything an error carries to the client: code, detail, errors[], own fields - for "no B data in the answer" scans. */
export const seen = (e: any): string => JSON.stringify({ code: e?.code, detail: e?.detail, message: e?.message, errors: e?.errors, extra: { ...e } });

// ---------------------------------------------------------------- fixtures: one full object graph per side
let seq = 0;
export interface Objs {
  side: 'a' | 'b'; tenant: string; centre: string; patientId: string; orderId: string; regNo: string; itemId: string; specimenId: string; barcode: string; specimenVersion: number;
  orderTestId: string; testId: string; resultId: string; analyteId: string; criticalId: string; exceptionId: string; resultKey: string; worksheetId: string; holdId: string; ruleId: string; ruleRowId: string;
  codeOnlyHere: string; instrumentId: string;
}
/** order + specimen (received at its centre) + order test + pending result + critical event + open ingest exception + worksheet + active QC hold + delta rule + a tenant-only coded-set code. */
export async function objs(side: 'a' | 'b', o: { centre?: string; processing?: string; state?: 'received' | 'collected' } = {}): Promise<Objs> {
  const tenant = tenantOf(side); const centre = o.centre ?? CENTRE[side]; const branch = centre === CENTRE_A2 ? BRANCH_A2 : BRANCH[side];
  const received = (o.state ?? 'received') === 'received'; const proc = received ? (o.processing ?? centre) : undefined; const procBranch = proc === CENTRE_A2 ? BRANCH_A2 : BRANCH[side];
  await ensureLabTaskRegistry();
  const n = ++seq; const tag = `${Date.now() % 1e8}${n}`;
  const S: Objs = { side, tenant, centre, patientId: uid(), orderId: uid(), regNo: `R32${tag}`, itemId: uid(), specimenId: uid(), barcode: `T32${tag}`.slice(0, 20), specimenVersion: 1, orderTestId: uid(), testId: uid(), resultId: uid(),
    analyteId: uid(), criticalId: uid(), exceptionId: uid(), resultKey: `rk-${tag}-${uid()}`, worksheetId: uid(), holdId: uid(), ruleId: uid(), ruleRowId: uid(), codeOnlyHere: `zprobe_${tag}`.toLowerCase(), instrumentId: uid() };
  await asOwner(tenant, async (c) => {
    await ins(c, 'frontdesk.patients', { id: S.patientId, tenant_id: tenant, patient_code: `PT32${tag}`, full_name: `Probe ${tag} Sentinel`, name_search: `probe ${tag} sentinel`, sex: 'female', registered_centre_id: centre });
    await ins(c, 'frontdesk.orders', { id: S.orderId, tenant_id: tenant, branch_id: branch, centre_id: centre, patient_id: S.patientId, registration_no: S.regNo, status: 'registered', visit_type: 'opd', billing_mode: 'cash',
      priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1, registered_at: '2026-06-15T04:00:00.000Z' });
    await ins(c, 'lab.orders', { id: S.orderId, tenant_id: tenant, centre_id: centre, branch_id: branch, patient_id: S.patientId, registration_no: S.regNo, visit_type: 'opd', priority: 'routine', collection_mode: 'walk_in',
      source: 'front_desk', registered_at: '2026-06-15T04:00:00.000Z', patient_sex: 'female', patient_age_days: 10950, lab_status: 'active', last_order_seq: 1, items_version: 1 });
    await ins(c, 'frontdesk.order_items', { id: S.itemId, tenant_id: tenant, order_id: S.orderId, centre_id: centre, orderable_id: uid(), orderable_kind: 'test', code: 'T32', name: 'T32 (SYNTHETIC)', test_ids: [S.testId],
      priority: 'routine', unit_price_paisa: 1000, price_list_id: uid(), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
    await ins(c, 'lab.specimens', { id: S.specimenId, tenant_id: tenant, centre_id: centre, order_id: S.orderId, patient_id: S.patientId, barcode: S.barcode, creation_key: `${S.orderId}:WB:EDTA:0`, specimen_type_code: 'WB',
      container_code: 'EDTA', priority: 'routine', patient_sex: 'female', patient_age_days: 10950, status: received ? 'received' : 'collected', ordered_at: '2026-06-15T04:00:00.000Z',
      collected_at: '2026-06-15T04:10:00.000Z', collected_by_membership_id: MEM[side], is_active: true,
      ...(received ? { processing_centre_id: proc, processing_branch_id: procBranch, received_at: '2026-06-15T04:30:00.000Z', received_by_membership_id: MEM[side] } : {}) });
    await ins(c, 'lab.order_tests', { id: S.orderTestId, tenant_id: tenant, centre_id: centre, order_id: S.orderId, order_item_id: S.itemId, test_id: S.testId, test_code: 'T32', test_revision: 1, catalog_revision: 1,
      department_id: uid(), workflow_type: 'standard', priority: 'routine', specimen_id: S.specimenId, status: received ? 'in_process' : 'awaiting_receipt', ordered_at: '2026-06-15T04:00:00.000Z',
      ...(received ? { received_at: '2026-06-15T04:30:00.000Z', processing_centre_id: proc, processing_branch_id: procBranch } : {}) });
    await ins(c, 'lab.results', { id: S.resultId, tenant_id: tenant, centre_id: centre, order_id: S.orderId, order_item_id: S.itemId, order_test_id: S.orderTestId, specimen_id: S.specimenId, patient_id: S.patientId,
      test_id: S.testId, analyte_id: S.analyteId, analyte_code: 'T321', department_id: uid(), is_reportable: true, result_type: 'numeric', status: 'pending',
      ...(received ? { processing_centre_id: proc, processing_branch_id: procBranch } : {}) });
    await ins(c, 'lab.critical_value_log', { id: S.criticalId, tenant_id: tenant, centre_id: centre, result_id: S.resultId, result_version_no: 1, order_id: S.orderId, patient_id: S.patientId, analyte_id: S.analyteId,
      direction: 'high', value_sha256_prefix16: 'a1b2c3d4e5f60718', value_numeric: 99, detected_at: '2026-06-15T04:40:00.000Z' });
    await ins(c, 'lab.ingest_exceptions', { id: S.exceptionId, tenant_id: tenant, centre_id: centre, result_key: S.resultKey, reason: 'unknown_barcode', instrument_id: S.instrumentId, instrument_message_id: uid(),
      sample_barcode: `X${tag}`.slice(0, 30), record_kind: 'quantitative', instrument_analyte_code: 'WBC', value_raw: '5.1', received_at: '2026-06-15T04:45:00.000Z', last_attempt_at: '2026-06-15T04:45:00.000Z' });
    await ins(c, 'lab.worksheets', { id: S.worksheetId, tenant_id: tenant, centre_id: centre, processing_centre_id: centre, title: `WS ${tag}`.slice(0, 80), item_count: 1 });
    await ins(c, 'lab.worksheet_items', { id: uid(), tenant_id: tenant, centre_id: centre, processing_centre_id: centre, worksheet_id: S.worksheetId, position: 1, order_test_id: S.orderTestId, specimen_id: S.specimenId,
      snapshot: JSON.stringify({ barcode: S.barcode, registration_no: S.regNo, test_code: 'T32', priority: 'routine', received_at: '2026-06-15T04:30:00.000Z' }) });
    await ins(c, 'lab.qc_holds', { id: S.holdId, tenant_id: tenant, qc_run_id: uid(), instrument_id: S.instrumentId, analyte_ids: [S.analyteId], since: '2026-06-15T04:00:00.000Z', reason_code: 'qc_rejected' });
    await ins(c, 'lab.delta_check_rules', { id: S.ruleRowId, tenant_id: tenant, rule_id: S.ruleId, rule_version: 1, analyte_id: S.analyteId, unit_code: 'g/L', window_seconds: 86400, abs_threshold: 5,
      effective_from: '2026-01-01T00:00:00.000Z' });
    await ins(c, 'lab.cs_rejection_reasons', { id: uid(), tenant_id: tenant, code: S.codeOnlyHere, display: `Only ${tenant.slice(-4)} (SYNTHETIC)` });
  });
  return S;
}

/** one more result of S's order test (new analyte) in status 'verified' (verified_by = `verifiedBy`) or 'approved' (+ version 1 row, approved_by = `approvedBy`). Returns its id (version 1 / 2 as seeded). */
export async function seedResult(S: Objs, o: { status: 'verified' | 'approved'; verifiedBy?: string; approvedBy?: string }): Promise<string> {
  const id = uid(); const verifiedBy = o.verifiedBy ?? MEM.a; const approvedBy = o.approvedBy ?? '01a1a98a-ac40-7000-8000-00000000a5ff';
  await asOwner(S.tenant, async (c) => {
    await ins(c, 'lab.results', { id, tenant_id: S.tenant, centre_id: S.centre, processing_centre_id: S.centre, order_id: S.orderId, order_item_id: S.itemId, order_test_id: S.orderTestId, specimen_id: S.specimenId,
      patient_id: S.patientId, test_id: S.testId, analyte_id: uid(), analyte_code: 'T32S', department_id: uid(), is_reportable: true, result_type: 'numeric', status: o.status, origin: 'manual', value_numeric: 5, unit_code: 'g/L',
      resulted_at: '2026-06-15T04:40:00.000Z', verified_at: '2026-06-15T04:45:00.000Z', verified_by_membership_id: verifiedBy,
      ...(o.status === 'approved' ? { approved_at: '2026-06-15T04:50:00.000Z', approved_by_membership_id: approvedBy } : {}) });
    if (o.status === 'approved') await ins(c, 'lab.result_versions', { id: uid(), tenant_id: S.tenant, centre_id: S.centre, processing_centre_id: S.centre, result_id: id, version_no: 1, origin: 'manual', value_numeric: 5,
      unit_code: 'g/L', is_critical: false, approved_at: '2026-06-15T04:50:00.000Z', approved_by_membership_id: approvedBy });
  });
  return id;
}

const FP = { id: uid(), version: 1 };
/** The request each operation receives when it names `S`'s objects (path, query, body, arrays). `via` = which of S's centres the caller claims where a body carries a centre. */
export function requestFor(id: string, S: Objs): ReturnType<typeof req> {
  const idem = { 'idempotency-key': uid() };
  const im = { ...idem, 'if-match': '"1"' };
  const ifm = { 'if-match': '"1"' };
  void FP;
  switch (id) {
    case 'lookupSpecimenByBarcode': return req({ body: { barcode: S.barcode } });
    case 'listSpecimens': return req({ query: { order_id: S.orderId } });
    case 'getSpecimen': return req({ params: { specimen_id: S.specimenId } });
    case 'collectSpecimen': return req({ params: { specimen_id: S.specimenId }, headers: ifm, body: {} });
    case 'bulkCollectSpecimens': return req({ headers: idem, body: { items: [{ id: S.specimenId, version: 1 }] } });
    case 'bulkDispatchSpecimens': return req({ headers: idem, body: { items: [{ id: S.specimenId, version: 1 }] } });
    case 'receiveSpecimen': return req({ params: { specimen_id: S.specimenId }, headers: ifm, body: { processing_centre_id: S.centre } });
    case 'bulkReceiveSpecimens': return req({ headers: idem, body: { processing_centre_id: S.centre, items: [{ id: S.specimenId, version: 1 }] } });
    case 'rejectSpecimen': return req({ params: { specimen_id: S.specimenId }, headers: im, body: { reason_code: S.codeOnlyHere, recollection_required: false } });
    case 'requestRecollection': return req({ params: { specimen_id: S.specimenId }, headers: im, body: {} });
    case 'createAliquots': return req({ params: { specimen_id: S.specimenId }, headers: im, body: { aliquots: [{ test_ids: [S.testId] }] } });
    case 'storeSpecimen': return req({ params: { specimen_id: S.specimenId }, headers: ifm, body: { location: 'Freezer 1 (SYNTHETIC)' } });
    case 'discardSpecimen': return req({ params: { specimen_id: S.specimenId }, headers: ifm, body: { discard_reason: 'Probe (SYNTHETIC)' } });
    case 'printSpecimenLabels': return req({ body: { specimen_ids: [S.specimenId] } });
    case 'requestOrderLabelPrint': return req({ params: { order_id: S.orderId }, body: {} });
    case 'getLabOrder': return req({ params: { order_id: S.orderId } });
    case 'listOrderResults': return req({ params: { order_id: S.orderId } });
    case 'getStatusBoard': return req({ query: { registered_at_from: '2026-06-15T00:00:00.000Z', registered_at_to: '2026-06-16T00:00:00.000Z' } });
    case 'listWorklistItems': return req();
    case 'listPendingItems': return req();
    case 'listWorksheets': return req({ query: { created_at_from: '2000-01-01T00:00:00.000Z', created_at_to: '2100-01-01T00:00:00.000Z' } });
    case 'createWorksheet': return req({ headers: idem, body: { title: 'Probe worksheet', order_test_ids: [S.orderTestId] } });
    case 'getWorksheet': return req({ params: { worksheet_id: S.worksheetId } });
    case 'getResult': return req({ params: { result_id: S.resultId } });
    case 'bulkEnterResults': return req({ headers: idem, body: { entries: [{ result_id: S.resultId, version: 1, value_numeric: '5.5' }] } });   // ruling A: DecimalString (lab.yaml:6220-6221), never a JSON number
    case 'getResultHistory': return req({ params: { result_id: S.resultId } });
    case 'getAnalyteTrend': return req({ params: { patient_id: S.patientId, analyte_id: S.analyteId } });
    case 'verifyResult': return req({ params: { result_id: S.resultId }, headers: ifm, body: {} });
    case 'bulkVerifyResults': return req({ headers: idem, body: { items: [{ id: S.resultId, version: 1 }] } });
    case 'returnResult': return req({ params: { result_id: S.resultId }, headers: ifm, body: { reason_code: 'recheck' } });
    case 'approveResult': return req({ params: { result_id: S.resultId }, headers: ifm, body: {} });
    case 'bulkApproveResults': return req({ headers: idem, body: { items: [{ id: S.resultId, version: 1 }] } });
    case 'amendResult': return req({ params: { result_id: S.resultId }, headers: im, body: { amendment_reason_code: 'transcription_error', value_numeric: '6' } });
    case 'listResultVersions': return req({ params: { result_id: S.resultId } });
    case 'listVerificationQueue': return req({ query: { stage: 'verify' } });
    case 'listCriticalValues': return req();
    case 'getCriticalValue': return req({ params: { critical_event_id: S.criticalId } });
    case 'logCriticalNotification': return req({ params: { critical_event_id: S.criticalId }, headers: idem, body: { notified_party_kind: 'clinician', notified_party_name: 'Dr Synthetic', contact_method: 'phone',
      notified_at: '2026-06-15T04:55:00.000Z', outcome: 'reached', read_back_confirmed: false } });
    case 'listIngestExceptions': return req();
    case 'getIngestException': return req({ params: { exception_id: S.exceptionId } });
    case 'assignIngestException': return req({ params: { exception_id: S.exceptionId }, headers: idem, body: { result_id: S.resultId } });
    case 'reapplyIngestException': return req({ params: { exception_id: S.exceptionId }, body: {} });
    case 'discardIngestException': return req({ params: { exception_id: S.exceptionId }, body: { reason_code: 'duplicate' } });
    case 'listQcResults': return req();
    case 'captureQcResult': return req({ headers: idem, body: { centre_id: S.centre, instrument_id: S.instrumentId, analyte_id: S.analyteId, control_id_raw: 'QC-L1', value_numeric: '4.2',
      instrument_result_time: '2026-06-15T04:00:00.000Z' } });
    case 'listQcHolds': return req();
    case 'releaseQcHold': return req({ params: { hold_id: S.holdId }, body: { comment: 'Probe release (SYNTHETIC)' } });
    case 'getLabSettings': return req();
    case 'updateLabSettings': return req({ headers: ifm, body: { label_width_mm: 50, label_height_mm: 25, label_copies_default: 1, label_renderer: 'html_svg', host_query_requires_received: true, ingest_auto_receive: false,
      critical_notification_blocks_approval: true, recollection_default: true, delta_check_enabled: true, history_days: 730 } });
    case 'listDeltaCheckRules': return req({ query: { analyte_id: S.analyteId } });   // ruling C2: lab.yaml:5109-5113 analyte_id filter, so S's row cannot fall off the capped page
    case 'createDeltaCheckRule': return req({ headers: idem, body: { analyte_id: S.analyteId, window_seconds: 86400, unit_code: 'g/L', abs_threshold: 5 } });
    case 'versionDeltaCheckRule': return req({ params: { rule_id: S.ruleId }, headers: im, body: { window_seconds: 86400, unit_code: 'g/L', abs_threshold: 6 } });
    case 'deactivateDeltaCheckRule': return req({ params: { rule_id: S.ruleId }, headers: ifm, body: {} });
    case 'listLabCodedSet': return req({ params: { set_name: 'rejection_reasons' } });
    case 'upsertLabCode': return req({ params: { set_name: 'rejection_reasons', code: S.codeOnlyHere }, headers: ifm, body: { display: 'Probe code (SYNTHETIC)', sort_order: 1, is_active: true } });
    default: throw new Error(`no probe request for ${id}`);
  }
}

// ---------------------------------------------------------------- owner-side truth
/** every tenant-scoped table of schema lab that the probes cover (a probe that must not touch tenant B compares these before and after). */
export const LAB_TENANT_TABLES = ['lab_settings', 'barcode_counters', 'delta_check_rules', 'orders', 'specimens', 'specimen_transitions', 'order_tests', 'qc_holds', 'results', 'result_observations', 'result_versions',
  'result_attachments', 'verifications', 'approvals', 'critical_value_log', 'critical_notifications', 'order_readiness', 'report_releases', 'worksheets', 'worksheet_items', 'ingest_log', 'ingest_exceptions',
  'qc_results', 'module_submissions', 'cs_rejection_reasons', 'cs_return_reasons', 'cs_amendment_reasons', 'cs_exception_discard_reasons'] as const;
/** md5 over every row of every tenant table of `tenant` (superuser, no RLS) + the audit/event counters. */
export async function snapshot(tenant: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of LAB_TENANT_TABLES) out[t] = (await owner(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS h FROM lab.${t} x WHERE tenant_id = $1`, [tenant]))[0].h;
  out['access_log'] = (await owner('SELECT count(*)::text AS h FROM audit.access_log WHERE tenant_id = $1', [tenant]))[0].h;
  return out;
}
