// Module contract + autoloader (02-TRD §6.3). Every check is a boot failure that names the module and the offender.
// Types are the T0D-01 subset; Operations-typed handlers and the full HandlerContext land with codegen (T0C) and T0D-02..10.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

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
/** T0D-01 subset of HandlerContext (§6.3); auth/db/events/... are added by their tasks. */
export interface HandlerContext {
  readonly operationId: string;
  readonly log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
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
}

/** PORT_OWNERS from IC §4 headings, as listed in 02-TRD §6.3. */
export const PORT_OWNERS: Readonly<Record<string, ModuleName>> = Object.freeze({
  CatalogPort: 'catalog', FrontdeskPort: 'frontdesk', BillingPort: 'billing', LabPort: 'lab', ReportingPort: 'reporting',
  NotificationPort: 'reporting', IdentityPort: 'identity', PaymentProviderPort: 'payments', SmartReportPort: 'smartreport',
  QualityPort: 'quality', BillingCommandPort: 'billing', RenderPort: 'reporting', EngagementPort: 'engagement',
});

/** authResolvers key -> the only module allowed to supply it (02-TRD §6.3). */
const AUTH_RESOLVER_OWNERS: Readonly<Record<string, ModuleName>> = {
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

/** Handler key set must equal the spec operationId set (AC-0D-1.2). */
export function checkHandlers(name: string, spec: any, handlers: unknown): void {
  if (!handlers || typeof handlers !== 'object') throw new Error(`module ${name}: handlers missing`);
  const ops = operationIds(spec);
  const opSet = new Set(ops);
  if (opSet.size !== ops.length) throw new Error(`module ${name}: duplicate operationId in spec`);
  for (const op of ops) {
    if (!Object.hasOwn(handlers, op) || typeof (handlers as any)[op] !== 'function') throw new Error(`module ${name}: missing handler for operationId ${op}`);
  }
  for (const k of Object.keys(handlers)) {
    if (!opSet.has(k)) throw new Error(`module ${name}: handler ${k} has no operationId in ${name} spec`);
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

export interface LoadedModule {
  readonly manifest: ModuleManifest;
  readonly spec: any;
}

export function loadSpec(file: string): any {
  return parse(readFileSync(file, 'utf8'));
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
  checkHandlers(dir, spec, m.handlers);
  return { manifest: m, spec };
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
