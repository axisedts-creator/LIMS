// Module contract + autoloader (02-TRD §6.3). Every check is a boot failure that names the module and the offender.
// Operations-typed handlers land with codegen (T0C); the full HandlerContext is T0D-18 (LD-133).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import type { AccessLogEntry } from './audit/access.js';
import type { BffKind } from './auth/bff-key.js';
import type { Tx, TxFn, TxInput } from './db/tx.js';
import type { PortRegistry } from './ports/registry.js';
import type { RateLimitTier } from './ratelimit/index.js';

export const MODULE_NAMES = [
  'core', 'identity', 'audit', 'catalog', 'frontdesk', 'billing', 'lab', 'instruments', 'reporting', 'analytics',
  'quality', 'micro', 'anatomic', 'inventory', 'partners', 'smartreport', 'payments', 'engagement', 'homecollection',
] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

export interface HandlerResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface HandlerRequest {
  readonly params: unknown;
  readonly query: unknown;
  readonly headers: unknown;
  readonly body: unknown;
}
/**
 * 02-TRD §6.3 HandlerContext, built per request by core/pipeline (LD-133, T0D-18): RequestContext (IC §4.1: tenantId, actor,
 * requestId, tx, now, ports) + the core members. tenantId/actor/tx are undefined on a public operation without a tenant (§6.2 stage 7).
 * [CONV] members typed `unknown` until @lims/contracts / codegen types are imported here (T0C).
 */
export interface HandlerContext {
  readonly tenantId?: string | undefined;
  // LD-133: `type` optional in the TYPE only (modules identity/lab/smartreport narrow actor to { id }); the pipeline always sets it.
  readonly actor?: { readonly type?: string; readonly id: string; readonly membershipId?: string; readonly supportSessionId?: string } | undefined;
  readonly requestId: string;
  /** LD-241 / CR-C2-004: platform session only (claims.scope platform, platform_role platform_*); absent for every other session. */
  readonly platformRole?: string;
  /** LD-241: the claims' aal, platform session only (PlatformAuthz privileged codes need aal2). */
  readonly aal?: 'aal1' | 'aal2';
  /** LD-267 PLATFORM-WIRE-1: claims.platform_staff_id, platform session only (key absent when missing / not a UUID). */
  readonly platformStaffId?: string;
  /** LD-267 / CR-C2-T21: claims.lims_session_id, platform session only (key absent when missing / not a UUID). */
  readonly platformSessionId?: string;
  /** LD-133: `| object` in the TYPE only (lab/smartreport type tx as object); the pipeline always hands the Tx of requestTx. */
  readonly tx?: Tx | object | undefined;
  /**
   * Runtime: `() => IsoUtc` (IC §4.1; transaction start). LD-133: optional `any` in the TYPE only, because module lab declares
   * `now?: () => Date` while smartreport uses the string (.orchestra/cr/T0D-18.md).
   */
  readonly now?: any;
  /** LD-133: `any`/optional in the TYPE only (modules narrow ports to the ports they consume); runtime value is a PortRegistry view. */
  readonly ports?: PortRegistry | any;
  readonly db: {
    /** SAVEPOINT inside the request transaction. LD-133: optional in the TYPE only (identity narrows db to identityAuthTx). */
    tx?<T>(fn: (ctx: HandlerContext) => Promise<T>): Promise<T>;
    /** 08 A25 D-212 (§6.2 stage 7): identity + x-context identity_auth + LIMS_CORE_IDENTITY_AUTH_OPS only; the core's own operation is used. */
    identityAuthTx?<T>(input: TxInput, fn: TxFn<T>): Promise<T>;
    /** LD-267 PLATFORM-WIRE-1 (02-TRD §6.3, D-214): platform session only; identity + x-context platform + allowlisted operationId, on this request's tx. */
    withTenantScope?<T>(tx: unknown, tenantId: string, fn: () => Promise<T>): Promise<T>;
  };
  readonly core: unknown;
  /** LD-133: optional / entry widened in the TYPE only (lab declares access(e: Record<string, unknown>)). */
  readonly audit?: { access(entry: AccessLogEntry | Record<string, unknown>): Promise<void> };
  readonly events: unknown;
  /** LD-133: optional in the TYPE only (identity declares it optional). */
  readonly rateLimit?: { consume(tier: RateLimitTier, key: string): Promise<void> };
  readonly uploads: unknown;
  readonly files: unknown;
  readonly storage: unknown;
  readonly log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
  readonly services: unknown;
  /** LD-190 / CR-C9-T26-002: CoreMetrics { inc, set, observe } (label values validated by createMetrics DEFS). Optional in the TYPE only. */
  readonly metrics?: {
    inc(name: any, labels?: Record<string, string | number>, by?: number): void;
    set(name: any, value: number, labels?: Record<string, string | number>): void;
    observe(name: any, value: number, labels?: Record<string, string | number>): void;
  } | undefined;
  readonly operationId: string;
  /** 08 A25 P-61 (02-TRD §6.4); modules never parse a header. */
  readonly clientIp: string;
  /** LD-206 / AUTH-BFF-1: verified X-Lims-Bff-Key kind; undefined when the header is absent or not valid. */
  readonly bffKey?: BffKind | undefined;
  readonly download: unknown;
  /** LD-133: optional in the TYPE only (identity declares it optional). */
  commitOnError?(): void;
  /** disables the 40001/40P01 whole-request retry for this request (§6.4). */
  noRetry(): void;
}
export type Handler = (req: HandlerRequest, ctx: HandlerContext) => Promise<HandlerResult>;

export interface ModuleManifest {
  readonly name: ModuleName;
  readonly openapi: `contracts/openapi/${string}.yaml`;
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly createServices?: (deps: unknown) => unknown;
  readonly ports?: Readonly<Record<string, unknown>>;
  readonly produces: readonly string[];
  readonly systemPermissions?: readonly string[];
  readonly claimsResolver?: unknown;
  readonly authResolvers?: Readonly<Record<string, unknown>>;
  /**
   * LD-325 (T0B-BOOTGATE-1): spec operationIds whose handler has not merged yet; each answers 501 operation_pending after
   * auth and the pipeline. T0C contract tasks add ids, T0B handler tasks remove them. Production boot refuses a non empty list.
   */
  readonly pendingOperations?: readonly string[];
}

/** PORT_OWNERS from IC §4 headings, as listed in 02-TRD §6.3. */
export const PORT_OWNERS: Readonly<Record<string, ModuleName>> = Object.freeze({
  CatalogPort: 'catalog', FrontdeskPort: 'frontdesk', BillingPort: 'billing', LabPort: 'lab', ReportingPort: 'reporting',
  NotificationPort: 'reporting', IdentityPort: 'identity', PaymentProviderPort: 'payments', SmartReportPort: 'smartreport',
  QualityPort: 'quality', BillingCommandPort: 'billing', RenderPort: 'reporting', EngagementPort: 'engagement',
});

/** authResolvers key -> the only module allowed to supply it (02-TRD §6.3). */
export const AUTH_RESOLVER_OWNERS: Readonly<Record<string, ModuleName>> = {
  deviceToken: 'instruments', portalSession: 'reporting', paymentCallback: 'payments',
  patientPreAuth: 'engagement', queueDisplayToken: 'engagement',
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const DEFAULT_MODULES_DIR = join(import.meta.dirname, '..', 'modules');

let producers: Readonly<Record<string, readonly string[]>> | undefined;
/**
 * EVENT_PRODUCERS (IC §3.25), read from the `producer` const of contracts/events/*.schema.json.
 * [CONV] until gen-event-types emits contracts/ports/generated/events.ts (T0C); then import that instead.
 */
export function eventProducers(): Readonly<Record<string, readonly string[]>> {
  if (producers) return producers;
  const dir = join(REPO_ROOT, 'contracts', 'events');
  const out: Record<string, string[]> = {};
  for (const f of readdirSync(dir)) {
    if (f.startsWith('_') || !f.endsWith('.schema.json')) continue;
    const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const props = (s.allOf ?? []).map((p: any) => p?.properties).find((p: any) => p?.producer?.const);
    const type = props?.event_type?.const;
    const producer = props?.producer?.const;
    if (typeof type !== 'string' || typeof producer !== 'string') throw new Error(`events: ${f} has no event_type/producer const`);
    (out[producer] ??= []).push(type);
  }
  return (producers = Object.freeze(out));
}

/** operationIds declared by an OpenAPI document. */
export function operationIds(spec: any): string[] {
  const ids: string[] = [];
  for (const item of Object.values<any>(spec?.paths ?? {})) {
    for (const m of HTTP_METHODS) if (item?.[m]?.operationId) ids.push(item[m].operationId);
  }
  return ids;
}

/**
 * AC-0D-1.2 kept (LD-325, T0B-BOOTGATE-1): handlers plus pendingOperations cover the spec operationId set; every handler key
 * is a spec operationId; every pending id is a spec operationId. Returns the stale pending ids (they also have a handler:
 * the handler wins, the caller warns; a stale entry never breaks boot because handler lanes may merge first).
 */
export function checkHandlers(name: string, spec: any, handlers: unknown, pending: unknown = []): string[] {
  if (!handlers || typeof handlers !== 'object') throw new Error(`module ${name}: handlers missing`);
  if (!Array.isArray(pending) || !pending.every((p) => typeof p === 'string')) throw new Error(`module ${name}: pendingOperations must be a string array`);
  if (new Set(pending).size !== pending.length) throw new Error(`module ${name}: duplicate entry in pendingOperations`);
  const ops = operationIds(spec);
  const opSet = new Set(ops);
  if (opSet.size !== ops.length) throw new Error(`module ${name}: duplicate operationId in spec`);
  for (const p of pending) {
    if (!opSet.has(p)) throw new Error(`module ${name}: pendingOperations entry ${p} has no operationId in ${name} spec`);
  }
  const has = (op: string) => Object.hasOwn(handlers, op) && typeof (handlers as any)[op] === 'function';
  for (const op of ops) {
    if (!has(op) && !pending.includes(op)) throw new Error(`module ${name}: missing handler for operationId ${op}`);
  }
  for (const k of Object.keys(handlers)) {
    if (!opSet.has(k)) throw new Error(`module ${name}: handler ${k} has no operationId in ${name} spec`);
  }
  return pending.filter(has);
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

export interface LoadedModule {
  readonly manifest: ModuleManifest;
  readonly spec: any;
  /** LD-325: pending ids that also have a handler (bootstrap warns once per id). */
  readonly stalePending: readonly string[];
}

export function loadSpec(file: string): any {
  return bundleRefs(parse(readFileSync(file, 'utf8')), dirname(file));
}

/**
 * Cross-file refs (`_common.yaml#/components/responses/X`) -> local: the target, and the same-file refs it uses, are
 * copied under the same pointer and the ref becomes `#/...` (glue gets one self-contained document).
 * A local component with the same pointer is a boot failure, never silently shadowed.
 */
function bundleRefs(spec: any, dir: string): any {
  const docs = new Map<string, any>();
  const placed = new Map<string, string>(); // pointer -> source file
  const get = (doc: any, ptr: string) => ptr.slice(2).split('/').reduce((o, k) => o?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], doc);
  const place = (file: string, ptr: string) => {
    if (placed.has(ptr)) {
      if (placed.get(ptr) !== file) throw new Error(`spec: $ref ${file}${ptr} collides with ${placed.get(ptr)}${ptr}`);
      return;
    }
    const local = get(spec, ptr);
    // LD-53 (1), CR-C2-020 option A: a local node that is exactly `{ $ref: <this file + this pointer> }` is an alias of
    // the very target being placed; it is replaced by the cloned target below. Any other local node still collides.
    const alias = local && typeof local === 'object' && Object.keys(local).length === 1 && local.$ref === `${file}${ptr}`;
    if (local !== undefined && !alias) throw new Error(`spec: $ref ${file}${ptr} collides with a local definition`);
    const v = get(docs.get(file), ptr);
    if (v === undefined) throw new Error(`spec: unresolved $ref ${file}${ptr}`);
    const keys = ptr.slice(2).split('/');
    let o = spec;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)!] = structuredClone(v);
    placed.set(ptr, file);
    visit(o[keys.at(-1)!], file);
  };
  const visit = (node: any, from?: string) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const [f, ptr = ''] = node.$ref.split('#') as [string, string?];
      const file = f || from;
      if (!file) return; // local ref of the spec itself
      if (!docs.has(file)) docs.set(file, parse(readFileSync(join(dir, file), 'utf8')));
      // place before rewriting: the alias check needs this node's original $ref (LD-53 (1)).
      place(file, `#${ptr}`);
      node.$ref = `#${ptr}`;
      return;
    }
    for (const v of Object.values(node)) visit(v, from);
  };
  visit(spec);
  return spec;
}

/** Validate one imported manifest found in directory `dir` (02-TRD §6.3). */
export function validateManifest(dir: string, m: any, repoRoot: string): LoadedModule {
  if (!m || typeof m !== 'object') throw new Error(`module ${dir}: index.ts exports no manifest`);
  if (m.name !== dir) throw new Error(`module ${dir}: manifest.name ${String(m.name)} must equal its directory ${dir}`);
  // 'core' is mounted by the core itself (§8), never from the modules directory.
  if (dir === 'core' || !(MODULE_NAMES as readonly string[]).includes(dir)) throw new Error(`module ${dir}: not a loadable ModuleName`);
  const expected = `contracts/openapi/${dir}.yaml`;
  if (m.openapi !== expected) throw new Error(`module ${dir}: openapi must be ${expected}, got ${String(m.openapi)}`);
  const file = join(repoRoot, expected);
  if (!existsSync(file)) throw new Error(`module ${dir}: spec file ${expected} not found`);

  const want = eventProducers()[dir] ?? [];
  if (!Array.isArray(m.produces) || !sameSet(m.produces, want)) {
    throw new Error(`module ${dir}: produces must equal EVENT_PRODUCERS[${dir}] = [${want.join(', ')}]`);
  }
  if (m.claimsResolver !== undefined && dir !== 'identity') {
    throw new Error(`module ${dir}: claimsResolver is accepted only from module identity`);
  }
  for (const k of Object.keys(m.authResolvers ?? {})) {
    if (AUTH_RESOLVER_OWNERS[k] !== dir) throw new Error(`module ${dir}: authResolvers.${k} is not allowed from this module`);
  }
  for (const p of Object.keys(m.ports ?? {})) {
    if (PORT_OWNERS[p] !== dir) throw new Error(`module ${dir}: port ${p} is not owned by this module (PORT_OWNERS)`);
  }
  const spec = loadSpec(file);
  const stalePending = checkHandlers(dir, spec, m.handlers, m.pendingOperations ?? []);
  return { manifest: m, spec, stalePending };
}

/** `<modulesDir>/*\/index.ts` — no central list. A missing directory means no modules. */
export async function autoload(modulesDir: string, repoRoot: string): Promise<LoadedModule[]> {
  if (!existsSync(modulesDir)) return [];
  const out: LoadedModule[] = [];
  for (const e of readdirSync(modulesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const index = join(modulesDir, e.name, 'index.ts');
    if (!e.isDirectory() || !existsSync(index)) continue;
    const mod = await import(pathToFileURL(index).href);
    out.push(validateManifest(e.name, mod.manifest, repoRoot));
  }
  return out;
}
