// BL-T22 probe kit (helper, not a test): one registry of every C4 operation (contracts/openapi/frontdesk.yaml F-ops + billing.yaml B-ops),
// a schema-driven sample builder, a recording fake tx and the ctx a handler receives. Synthetic data only.
// The core pipeline (schema / auth / x-permission / aal2 / membership re-validation / RLS) is not re-run here: these probes pin what the
// HANDLERS promise when the database shows them nothing (RLS-faithful: tenant B rows are invisible to tenant A) and what the contracts declare.
import { join } from 'node:path';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { handlers as billingHandlers } from '../../handlers/index.js';
import { handlers as frontdeskHandlers } from '../../../frontdesk/handlers/index.js';

export const TENANT_A = '0190c422-0000-7000-8000-0000000000a1';
export const TENANT_B = '0190c422-0000-7000-8000-0000000000b1';
export const ACTOR_A = '0190c422-0000-7000-8000-00000000a0c1';
export const MEMBERSHIP_A = '0190c422-0000-7000-8000-00000000a0d1';
export const CENTRE_A1 = '0190c422-0000-7000-8000-00000000a201';
/** Every id that belongs to tenant B: path params, body ids, array members. All share this prefix so a leak is greppable. */
export const B_ID = '0190c422-0000-7000-8000-00000000b0';
export const bId = (n: number) => `${B_ID}${String(n).padStart(2, '0')}`;

export type Mod = 'billing' | 'frontdesk';
export interface OpInfo {
  readonly mod: Mod; readonly id: string; readonly method: string; readonly path: string; readonly permission: string;
  readonly idempotency: string; readonly pathParams: string[]; readonly isList: boolean; readonly op: any; readonly spec: any;
}

const specs: Record<Mod, any> = {
  billing: loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'billing.yaml')),
  frontdesk: loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'frontdesk.yaml')),
};
export const handlerMap: Record<Mod, Record<string, any>> = { billing: billingHandlers as any, frontdesk: frontdeskHandlers as any };

export function deref(spec: any, node: any): any {
  let n = node;
  for (let i = 0; i < 20 && n && typeof n === 'object' && typeof n.$ref === 'string'; i++) {
    n = n.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
  }
  return n;
}

export const ALL_OPS: OpInfo[] = (['frontdesk', 'billing'] as Mod[]).flatMap((mod) => {
  const spec = specs[mod];
  return Object.entries<any>(spec.paths).flatMap(([path, item]) =>
    ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId).map((method) => {
      const op = item[method];
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: any) => deref(spec, p));
      return {
        mod, id: op.operationId as string, method, path, permission: op['x-permission'] as string, idempotency: String(op['x-idempotency'] ?? ''),
        pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
        isList: method === 'get' && params.some((p: any) => p?.name === 'cursor'), op, spec,
      } satisfies OpInfo;
    }));
});

/** Schema-driven minimal valid sample; every uuid becomes a tenant-B id so a body can never name an a-object by accident. */
export function sample(spec: any, schema: any, depth = 0, name = ''): any {
  const s = deref(spec, schema);
  if (!s || depth > 6) return undefined;
  if (s.example !== undefined) return s.example;
  if (s.enum) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: any) => sample(spec, x, depth + 1, name)));
  if (s.oneOf || s.anyOf) return sample(spec, (s.oneOf ?? s.anyOf)[0], depth + 1, name);
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  if (t === 'object' || s.properties) {
    const o: Record<string, unknown> = {};
    for (const k of s.required ?? []) o[k] = sample(spec, s.properties?.[k], depth + 1, k);
    return o;
  }
  if (t === 'array') return [sample(spec, s.items, depth + 1, name), sample(spec, s.items, depth + 1, name)].slice(0, Math.max(1, s.minItems ?? 1));
  if (t === 'integer' || t === 'number') return Math.max(s.minimum ?? 1, 1);
  if (t === 'boolean') return false;
  if (s.format === 'uuid' || /(^|_)id$/.test(name)) return bId(1);
  const PATTERNS: Record<string, string> = { '^[0-9]{4}/[0-9]{2}$': '2083/84', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$': '2026-11-08', '^[0-9]{4}-(0[1-9]|1[0-2])$': '2026-10',
    '^\\+[1-9][0-9]{7,14}$': '+9779800000000', '^[0-9a-f]{64}$': 'a'.repeat(64), '^[A-Za-z0-9+/]*={0,2}$': 'QUJD' };
  if (s.pattern && PATTERNS[s.pattern]) return PATTERNS[s.pattern];
  if (s.format === 'date-time') return '2026-11-08T06:00:00.000Z';
  if (s.format === 'date') return '2026-11-08';
  return 'x'.repeat(Math.max(s.minLength ?? 1, 1));
}

/** LD-105: valid minimal bodies where the sample builder's 'x' / {} fails a handler's own validation before the tenant lookup runs. */
const BODY_FOR: Record<string, unknown> = {
  updatePatient: { full_name: 'Synthetic Patient' },
  searchPatients: { query: 'Demo', mode: 'auto', limit: 20 },
};
export function requestFor(o: OpInfo, over: { body?: unknown; query?: Record<string, unknown> } = {}) {
  const params = Object.fromEntries(o.pathParams.map((p, i) => [p, p.endsWith('_id') ? bId(10 + i) : (deref(o.spec, o.op.parameters?.find((x: any) => deref(o.spec, x)?.name === p))?.schema?.enum?.[0] ?? 'x')]));
  const content = deref(o.spec, o.op.requestBody)?.content;
  const schema = content?.['application/json']?.schema ?? content?.['multipart/form-data']?.schema;
  return {
    params, query: over.query ?? {}, headers: { 'idempotency-key': '0190c422-0000-7000-8000-00000000f001', 'if-match': '"1"' },
    body: over.body !== undefined ? over.body : o.id in BODY_FOR ? BODY_FOR[o.id] : schema ? sample(o.spec, schema) : undefined,
  };
}

export interface Stmt { text: string; values: unknown[] }
/** RLS-faithful fake: every table read is empty (tenant B rows are invisible to tenant A), every statement is recorded. */
export function spyTx(rowsFor: (text: string, values: unknown[]) => any[] = () => []) {
  const stmts: Stmt[] = [];
  const tx = { async query(text: string, values: unknown[] = []) { stmts.push({ text, values }); const rows = rowsFor(text, values); return { rows, rowCount: rows.length }; } };
  return { tx, stmts };
}

/** Ports as tenant A sees tenant B: every method refuses with common.not_found (the FrontdeskPort / BillingPort / CatalogPort / IdentityPort cross-tenant promise). */
export async function notFoundPorts() {
  const { LimsError } = await import('../../../../core/errors.js');
  const port = new Proxy({}, { get: () => async () => { throw new LimsError('common.not_found'); } });
  return new Proxy({}, { get: () => port });
}

export interface LogCapture { lines: string[]; ctxLog: any }
export function captureLogs(): LogCapture & { restore(): void } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')); };
  const ctxLog: any = new Proxy({}, { get: () => (...a: unknown[]) => push(...a) });
  const orig = { out: process.stdout.write, err: process.stderr.write, log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  process.stdout.write = ((c: any) => { push(String(c)); return true; }) as never;
  process.stderr.write = ((c: any) => { push(String(c)); return true; }) as never;
  console.log = console.warn = console.error = console.info = console.debug = push as never;
  return { lines, ctxLog, restore() { process.stdout.write = orig.out; process.stderr.write = orig.err; Object.assign(console, { log: orig.log, warn: orig.warn, error: orig.error, info: orig.info, debug: orig.debug }); } };
}
export const safeJson = (x: unknown): string => { try { return JSON.stringify(x, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, ...v } : typeof v === 'bigint' ? String(v) : v)); } catch { return String(x); } };

/** BL-T22-ruling a (LD-98): tenant A's OWN working IdentityPort. assertRole resolves; getActor is scoped to CENTRE_A1. Every other port still refuses with common.not_found. */
export async function tenantAPorts(scope: { all?: boolean; centreIds?: string[] } = { centreIds: [CENTRE_A1] }) {
  const base: any = await notFoundPorts();
  // LD-105: readBrandingAsset exists (printInvoice, printCreditNote); tenant B's asset ids are still refused with common.not_found.
  const identity = { assertRole: async () => undefined, readBrandingAsset: async (_c: unknown, i: { assetId?: string }) => { if (String(i?.assetId ?? '').includes(B_ID)) { const { LimsError } = await import('../../../../core/errors.js'); throw new LimsError('common.not_found'); } return { kind: 'logo', mimeType: 'image/png', base64: 'QUJD' }; }, getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu', releaseRequiresPayment: true }), getActor: async () => ({ displayName: 'Synthetic Tester', centreScope: scope }) };
  return new Proxy({}, { get: (_t, k) => (k === 'IdentityPort' ? identity : base[k]) });
}
/** Tenant-bound core lookups (ctx.core.membership / centre / branch): tenant B's ids (B_ID prefix) are common.not_found, tenant A's resolve. */
const tenantBound = (make: (id: string) => unknown) => async (_c: unknown, a: Record<string, string>) => {
  const id = Object.values(a ?? {})[0] ?? '';
  if (String(id).includes(B_ID)) { const { LimsError } = await import('../../../../core/errors.js'); throw new LimsError('common.not_found'); }
  return make(String(id));
};

export async function ctxFor(tenantId: string, tx: unknown, o: Record<string, unknown> = {}) {
  return {
    operationId: 'probe', tenantId, requestId: '0190c422-0000-7000-8000-0000000000e1', now: () => new Date('2026-11-08T06:00:00.000Z'), tx,
    actor: { type: 'user', id: ACTOR_A, membershipId: MEMBERSHIP_A }, ports: await tenantAPorts(), audit: { access: async () => undefined },
    events: { publish: async () => undefined },
    core: {
      membership: tenantBound(() => ({ displayName: 'Synthetic Tester' })),
      centre: tenantBound((id) => ({ id, branchId: '0190c422-0000-7000-8000-00000000a301', phoneDisplay: '+977-1-0000000' })),
      branch: tenantBound(() => ({ branchCode: 'KTM' })),
    },
    storage: { delete: async () => undefined },
    // LD-105: uploads.accept exists (uploadTrf); tenant B ids must still be refused with no DB write.
    uploads: { accept: async (_f: unknown, opts: { objectPath?: string }) => ({ objectPath: opts?.objectPath ?? 'q/x', sha256: 'a'.repeat(64), byteSize: 3, mime: 'application/pdf' }) },
    download: { stream: async () => undefined },
    ...o,
  } as any;
}

/** BL-T22-ruling b (LD-98): BL-T21 payment intents are Phase 1.5 (06-IMPLEMENTATION-PLAN BL-T21 row), not built in v1. They must never answer 2xx (REQ-SEC-099). */
export const DEFERRED_PHASE_1_5 = ['createPaymentIntent', 'verifyPaymentIntent'] as const;
export const isDeferred = (id: string) => (DEFERRED_PHASE_1_5 as readonly string[]).includes(id);

/** Runs one handler; returns {result} or {error}. A non-LimsError (TypeError etc.) is returned as-is so the test names it. */
export async function run(o: OpInfo, ctx: any, req = requestFor(o)): Promise<{ result?: any; error?: any }> {
  // LD-105: anonymisePatient fails closed unless centreScope.all === true (REQ-SEC-139); tenant A's actor gets it so the call reaches the tenant lookup (tenant B id => not_found).
  if (o.id === 'anonymisePatient') ctx = { ...ctx, ports: await tenantAPorts({ all: true }) };
  try { return { result: await handlerMap[o.mod][o.id](req, ctx) }; } catch (error) { return { error }; }
}
