// C9 T-25 probe kit (helper, not a test) — 07-SECURITY §5 S-01..S-22. Synthetic data only.
// Two halves, same convention as C5 T-32 (lab/__tests__/probes/kit.ts) and C10 T-25 (micro/__tests__/probes):
//  (1) DB-less: the REAL manifest handlers of quality.yaml driven through the REAL IdentityPort (identity/ports/IdentityPort.impl.ts) over a scripted repo + an empty tx. Nothing here is a model of
//      the port: aal2 / privileged re-validation / role grants are decided by the production code from contracts/permissions.yaml.
//  (2) Live PG17 (RLS on): LIMS_TEST_DATABASE_URL (role lims_api) + LIMS_TEST_ADMIN_DATABASE_URL (superuser). Without them the live files skip; under LIMS_T25_REQUIRE_DB=1 "database is provided" FAILS.
// ASSUMED (seams the spec leaves open): staff actors are modelled as claims { membership_id, aal } + core.memberships row (what IdentityPort reads); centre-restricted RLS actors are `device` claims with
// centre_id (app.current_centre_ids(), db/migrations 20261105000400); LIMS_QUALITY_ENABLED=true is set BEFORE the manifest import (phase switch is read at load, ruling C9.T-15).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { uuidv7 } from '../../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { createIdentityPort } from '../../../identity/ports/IdentityPort.impl.js';

export const T = 120_000;
export const fileText = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

// ---------------------------------------------------------------- ids
export const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
export const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const CENTRE_A1 = '01a1a98a-ac40-7000-8000-00000000a201';
export const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';
export const CENTRE_B1 = '01a1a98a-ac40-7000-8000-00000000b201';
export const uid = (): string => uuidv7();
export const NOW = '2026-11-14T10:00:00.000Z';

// ---------------------------------------------------------------- the contract (from quality.yaml / permissions.yaml, never from the handlers)
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/quality.yaml'));
export const SPEC = spec;
export interface OpInfo { id: string; method: string; path: string; permission: string; pathParams: string[]; hasBody: boolean; isWrite: boolean; isList: boolean; operation: any }
export const OPS: OpInfo[] = Object.entries<any>(spec.paths).flatMap(([path, item]) =>
  ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId).map((method) => {
    const op = item[method];
    const params: any[] = [...(item.parameters ?? []), ...(op.parameters ?? [])];
    return { id: op.operationId as string, method, path, permission: op['x-permission'] as string, pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
      hasBody: Boolean(op.requestBody), isWrite: method !== 'get', isList: method === 'get' && params.some((p) => p?.$ref?.endsWith('/Cursor') || p?.name === 'cursor'), operation: op } satisfies OpInfo;
  }));
export const opById = (id: string): OpInfo => OPS.find((o) => o.id === id)!;

/** 07-SECURITY S-08 / REQ-SEC-062: the seven aal2 operations (#37, #39, #40, #41, #43, #44, #45) by operationId (02-TRD §5 numbering). */
export const MANAGE_OPS = ['createAutoverifyVersion', 'replaceAutoverifyDraft', 'startAutoverifySimulation', 'stopAutoverifySimulation', 'activateAutoverifyVersion', 'retireAutoverifyVersion',
  'discardAutoverifyDraft'] as const;

const permsText = fileText('contracts/permissions.yaml');
export interface PermRow { code: string; privileged: boolean; roles: string[] }
export const QUALITY_GRANTS: PermRow[] = [...permsText.matchAll(/code:\s*(quality\.[a-z_.]+),\s*privileged:\s*(true|false),\s*roles:\s*\[([^\]]*)\]/g)]
  .map((m) => ({ code: m[1]!, privileged: m[2] === 'true', roles: m[3]!.split(',').map((r) => r.trim()).filter(Boolean) }));
export const ALL_ROLES: string[] = [...new Set([...permsText.matchAll(/roles:\s*\[([^\]]*)\]/g)].flatMap((m) => m[1]!.split(',').map((r) => r.trim()).filter(Boolean)))].sort();
export const grantsOfRole = (role: string): string[] => QUALITY_GRANTS.filter((p) => p.roles.includes(role)).map((p) => p.code);
export const ALL_QUALITY_PERMS: string[] = QUALITY_GRANTS.map((p) => p.code);

// ---------------------------------------------------------------- DB-less half: real handlers + real IdentityPort
export type Row = Record<string, any>;
export interface Who {
  tenant?: string;
  actorType?: 'user' | 'partner' | 'portal' | 'patient' | 'device' | 'system';
  permissions?: string[];            // permissions on the core.memberships row (what a role would grant); default = none
  aal?: unknown;                     // value of the verified `aal` claim as issued
  status?: 'active' | 'deactivated'; // membership state at call time (revoked after token issue = 'deactivated')
  lockedAt?: string | null;
  noMembership?: boolean;            // membership row gone / belongs to somebody else
  claims?: Row;
  rows?: (text: string, values: unknown[]) => Row[] | undefined;   // scripted SELECT results (default: every statement returns no rows = "RLS hides it")
}
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500';
const USER = '01a1a98a-ac40-7000-8000-00000000a600';

export function makeHarness(who: Who = {}, operationId = 'probe') {
  const tenant = who.tenant ?? TENANT_A;
  const actorType = who.actorType ?? 'user';
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const audits: Row[] = [];
  const logs: string[] = [];
  const repo: any = {
    async claims() { return { membership_id: MEMBERSHIP, aal: who.aal, ...(actorType === 'partner' ? { partner_role: 'partner_admin' } : {}), ...(who.claims ?? {}) }; },
    async membership(_c: unknown, i: { membershipId: string }) {
      if (who.noMembership) return undefined;
      return { membershipId: i.membershipId, userId: USER, tenantId: tenant, actorId: USER, actorType: 'user', status: who.status ?? 'active', lockedAt: who.lockedAt ?? null, displayName: 'Synthetic Tester',
        email: null, roleCodes: [], permissions: who.permissions ?? [], allCentres: true, centreIds: [], branchIds: [], mfaEnrolled: true, version: 1 };
    },
    async supportSession() { return undefined; },
    async tenantStatus() { return 'active'; },
    async tenantSettings() { return undefined; },   // port falls back to the §7.3 defaults
  };
  const port = createIdentityPort({ repo, systemActorPermissions: () => [], metrics: { authzDecision() {} } });
  const sink = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
  const ctx: any = {
    operationId, clientIp: '203.0.113.9', tenantId: tenant, actor: { type: actorType, id: USER, ...(actorType === 'user' || actorType === 'partner' ? { membershipId: MEMBERSHIP } : {}) },
    requestId: uid(), now: () => NOW,
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); const rows = who.rows?.(text, values) ?? []; return { rows, rowCount: rows.length }; } },
    ports: { IdentityPort: port, CatalogPort: { getTest: async () => { throw new LimsError('common.not_found'); } } },
    audit: { access: async (e: Row) => { audits.push(e); } },
    log: { info: sink, warn: sink, error: sink, debug: sink },
  };
  return { ctx, queries, audits, logs };
}
export type Harness = ReturnType<typeof makeHarness>;

const deref = (s: any): any => {
  let cur = s;
  for (let i = 0; i < 20 && cur?.$ref; i++) cur = String(cur.$ref).replace(/^#\//, '').split('/').reduce((n: any, k: string) => n?.[k], spec);
  return cur;
};
/** the smallest body that satisfies the request schema (required properties only; first enum value, example, or a value of the declared type/format). Hand-overrides win. */
export function minimalValue(schema: any, depth = 0): any {
  const s = deref(schema);
  if (!s || depth > 8) return {};
  if (s.example !== undefined) return structuredClone(s.example);
  if (s.default !== undefined) return structuredClone(s.default);
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: any) => minimalValue(x, depth + 1)));
  if (s.oneOf || s.anyOf) return minimalValue((s.oneOf ?? s.anyOf)[0], depth + 1);
  switch (s.type) {
    case 'string':
      if (s.format === 'uuid') return uid();
      if (s.format === 'date-time') return NOW;
      if (s.format === 'date') return '2026-11-14';
      return 'x'.repeat(Math.max(1, s.minLength ?? 1));
    case 'integer': return s.minimum ?? 1;
    case 'number': return s.minimum ?? 1;
    case 'boolean': return false;
    case 'array': return Array.from({ length: s.minItems ?? 0 }, () => minimalValue(s.items, depth + 1));
    default: {
      const out: Row = {};
      for (const k of s.required ?? []) out[k] = minimalValue(s.properties?.[k], depth + 1);
      return out;
    }
  }
}
/** bodies whose domain rules (not the schema) need a specific value: sum(composition.count) = controls_per_run (05-SCHEMA), reason codes of 05-SCHEMA §3 seeds. */
const BODY_OVERRIDES: Record<string, () => unknown> = {
  createQcPlanVersion: () => ({ params: { controls_per_run: 2, composition: [{ level_id: uid(), count: 2 }] }, change_reason: 'synthetic probe' }),
  excludeQcObservation: () => ({ reason_code: 'wrong_material' }),
};
export const minimalBody = (op: OpInfo): unknown => (BODY_OVERRIDES[op.id] ? BODY_OVERRIDES[op.id]!() : op.hasBody ? minimalValue(op.operation.requestBody?.content?.['application/json']?.schema) : undefined);

/** a request as the core pipeline delivers it after schema validation: every path id a UUID (enum / Code params valid), If-Match present, body `{}` when the operation has one. */
export function requestFor(op: OpInfo, o: { ids?: Record<string, string>; body?: unknown; query?: Row } = {}): { params: Row; query: Row; headers: Row; body: unknown } {
  const setName = (spec.components.parameters.SetName.schema.enum as string[])[0]!;
  const params: Row = {};
  for (const p of op.pathParams) params[p] = o.ids?.[p] ?? (p === 'set_name' ? setName : p === 'code' ? 'CODE-1' : uid());
  return { params, query: o.query ?? {}, headers: { 'if-match': '"1"', 'idempotency-key': uid() }, body: o.body ?? minimalBody(op) };
}

export interface Fired { reply?: { status: number; body?: any; headers?: Row }; error?: { code?: string; statusCode?: number; message?: string; detail?: string; [k: string]: unknown } }
export async function fire(handler: (...a: any[]) => Promise<any>, req: unknown, ctx: unknown): Promise<Fired> {
  try { return { reply: await handler(req, ctx) }; } catch (e: any) { return { error: e }; }
}
/** everything the caller could see of an error (code, message, detail, field errors) as one string, for "does not echo" checks. */
export const seen = (e: unknown): string => {
  const x = e as Row;
  return JSON.stringify({ code: x?.code, message: x?.message, detail: x?.detail, errors: x?.errors, fields: x?.fieldErrors });
};

let manifestP: Promise<any> | undefined;
/** the quality manifest with the phase switch ON (read once at module load). */
export async function loadManifest(): Promise<any> {
  const { vi } = await import('vitest');
  vi.stubEnv('LIMS_QUALITY_ENABLED', 'true');
  return (manifestP ??= import('../../index.js').then((m) => m.manifest));
}

// ---------------------------------------------------------------- live half: real PG17 under RLS
export const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
export const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
export const live = Boolean(API_URL && ADMIN_URL);
export const requireDb = process.env['LIMS_T25_REQUIRE_DB'] === '1';
let apiPool: pg.Pool | undefined;
let adminPool: pg.Pool | undefined;
export const api = (): pg.Pool => (apiPool ??= new pg.Pool({ connectionString: API_URL, max: 6 }));
export const admin = (): pg.Pool => (adminPool ??= new pg.Pool({ connectionString: ADMIN_URL, max: 4 }));
export const closePools = async (): Promise<void> => { await Promise.all([apiPool?.end(), adminPool?.end()]); apiPool = adminPool = undefined; };
export const claimsOf = (tenant: string, extra: Row = {}): string => JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'system', ...extra });
export const owner = async (text: string, values: unknown[] = []): Promise<any[]> => (await admin().query(text, values)).rows;

/** one tx on `pool` with the claims set (RLS applies on the api pool). A throw rolls back; `commit: false` always rolls back (probes that must leave no trace). */
export async function withClaims<R>(pool: pg.Pool, claims: string, fn: (c: pg.PoolClient) => Promise<R>, commit = true): Promise<R> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
    const out = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

/** 05-SCHEMA §1, copied verbatim: 26 tables = 24 tenant tables + the two global coded sets. */
export const G_CS_TABLES = ['quality.g_cs_corrective_actions', 'quality.g_cs_exclusion_reasons'] as const;
export const TENANT_TABLES = ['quality.settings', 'quality.cs_corrective_actions', 'quality.cs_exclusion_reasons', 'quality.control_materials', 'quality.control_levels', 'quality.control_lots',
  'quality.control_id_maps', 'quality.qc_plans', 'quality.qc_plan_versions', 'quality.qc_targets', 'quality.qc_runs', 'quality.qc_observations', 'quality.qc_corrective_actions',
  'quality.qc_run_reviews', 'quality.qc_activity', 'quality.sync_state', 'quality.autoverify_rule_sets', 'quality.autoverify_versions', 'quality.autoverify_decisions', 'quality.verification_log',
  'quality.tat_items', 'quality.tat_alert_events', 'quality.tat_alert_acks', 'quality.event_inbox'] as const;
export const CENTRE_TABLES = ['quality.tat_items', 'quality.tat_alert_events', 'quality.tat_alert_acks'] as const;
/** class A (append-only) tables of 05-SCHEMA §1 + qc_plan_versions (S-06: no UPDATE grant). */
export const A_TABLES = ['quality.qc_corrective_actions', 'quality.qc_run_reviews', 'quality.autoverify_decisions', 'quality.verification_log', 'quality.tat_alert_events', 'quality.tat_alert_acks',
  'quality.event_inbox'] as const;

// ---------------------------------------------------------------- seeding (generic over the catalog: no hand-kept column lists that could go stale)
async function checkLiterals(c: pg.PoolClient, schema: string, name: string): Promise<Record<string, string>> {
  const defs = (await c.query(`SELECT pg_get_constraintdef(con.oid) AS d FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE con.contype = 'c' AND n.nspname = $1 AND t.relname = $2`, [schema, name])).rows as { d: string }[];
  const out: Record<string, string> = {};
  for (const { d } of defs) for (const m of d.matchAll(/\(?(\w+)\)?(?:::text)? = ANY \(\(?ARRAY\['([^']+)'/g)) out[m[1]!] = m[2]!;
  return out;
}
let seqN = 0;
/** a complete row for `table`: `given` + every NOT NULL column without default auto-filled (first literal of a text CHECK ... IN list). Run with session_replication_role = replica. */
export async function buildRow(c: pg.PoolClient, table: string, given: Row): Promise<Row> {
  const [schema, name] = table.split('.') as [string, string];
  const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
    AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
  const lit = await checkLiterals(c, schema, name);
  const row: Row = { ...given };
  for (const { column_name, udt_name } of cols) {
    if (column_name in row) continue;
    row[column_name] = lit[column_name] ?? (udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : /^timestamp/.test(udt_name) ? new Date('2026-11-01T04:00:00Z')
      : udt_name === 'date' ? '2026-11-01' : /^jsonb?$/.test(udt_name) ? '[]' : udt_name === 'bytea' ? Buffer.from('00', 'hex') : `syn_${uid().slice(-10)}_${++seqN}`);
  }
  return row;
}
export const insertSql = (table: string, row: Row, tail = ''): { text: string; values: unknown[] } => {
  const keys = Object.keys(row);
  return { text: `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})${tail}`,
    values: keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) && !Buffer.isBuffer(row[k]) ? JSON.stringify(row[k]) : row[k])) };
};
/** insert one row as the superuser with FK/trigger checks off; returns the row actually inserted. */
export async function seedRow(table: string, given: Row): Promise<Row> {
  const c = await admin().connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const row = await buildRow(c, table, given);
    const q = insertSql(table, row);
    await c.query(q.text, q.values);
    await c.query('COMMIT');
    return row;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
