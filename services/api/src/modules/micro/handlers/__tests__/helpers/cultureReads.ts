// C10 T-07 test helper — ctx builder with hand-written fakes (IdentityPort, CatalogPort, LabPort, core.memberships.list, core.user, audit.access) + ajv over micro.yaml.
// Shared by culture.reads.test.ts (scripted tx, no DB) and culture.reads.integration.test.ts (live tx under RLS).
// Synthetic data only.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { LimsError } from '../../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../../core/module.js';
import { handlers } from '../../index.js';

export type Row = Record<string, any>;

export const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'micro.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
/** Errors of `x` against components.schemas.<name> of micro.yaml (empty = valid). */
export const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
};
/** Errors of `x` against the 200 JSON response schema of one operation. */
export const responseErrors = (operationId: string, x: unknown): string[] => {
  for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) {
    if (op?.operationId !== operationId) continue;
    const v = ajv.compile({ ...op.responses['200'].content['application/json'].schema, components: spec.components });
    return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
  }
  throw new Error(`no operation ${operationId}`);
};
export const specOps = (): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId) out[op.operationId] = op;
  return out;
};

export const READ = 'micro.culture.read';
export const WORK = 'micro.culture.work';
export const MANAGE = 'micro.config.manage';
export const LAB_READ = 'lab.result.read';
export const LAB_AMEND = 'lab.result.amend';

export const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

export interface CtxOpts {
  tenantId: string;
  tx: unknown;
  actor?: Row;
  /** permissions the viewer holds: assertRole accepts exactly these; getActor().permissions lists them */
  grants: readonly string[];
  /** membership id -> display name returned by core.memberships.list (an id that is absent is "not returned") */
  members?: Record<string, string>;
  /** user id -> display name returned by core.user (an id that is absent rejects common.not_found) */
  users?: Record<string, string>;
  /** CatalogPort.getTest */
  tests?: Record<string, { code: string; name: string }>;
  /** LabPort.getOrderResults result (default: no items) */
  lab?: (input: Row) => unknown;
  labThrows?: unknown;
  centreScope?: { all: boolean; centreIds: string[] };
}
export interface Calls { assertRole: Row[]; access: Row[]; members: Row[]; users: Row[]; tests: Row[]; lab: Row[]; getSignatories: number; getActor: number }

export function mkCtx(o: CtxOpts): { ctx: any; calls: Calls } {
  const calls: Calls = { assertRole: [], access: [], members: [], users: [], tests: [], lab: [], getSignatories: 0, getActor: 0 };
  const members = o.members ?? {};
  const users = o.users ?? {};
  const ctx: any = {
    operationId: 'op', clientIp: '203.0.113.9', requestId: '0190c607-0000-7000-8000-000000009001', now: () => new Date('2026-11-05T05:00:00.000Z'),
    log: { info() {}, warn() {}, error() {}, child() { return this; } }, metrics: { inc() {} },
    tenantId: o.tenantId, tx: o.tx,
    actor: o.actor ?? { type: 'user', id: '01a1b34e-1000-7eee-9d29-d7ca59a10001', membershipId: '01a1a98a-ac40-7000-8000-00000000a500' },
    audit: { async access(...a: unknown[]) { calls.access.push(structuredClone(a[a.length - 1] as Row)); } },
    events: { publish: async () => ({ eventId: 'e', duplicate: false }) },
    core: {
      async user(...a: unknown[]) {
        const i = a[a.length - 1] as Row; calls.users.push(structuredClone(i));
        const n = users[i['userId']]; if (n === undefined) throw new LimsError('common.not_found');
        return { id: i['userId'], displayName: n, isActive: true };
      },
      memberships: {
        async list(...a: unknown[]) {
          const i = a[a.length - 1] as Row; calls.members.push(structuredClone(i));
          const ids: string[] | undefined = i['membershipIds'];
          if (ids && ids.length > 200) throw new LimsError('common.validation_failed');   // core-repo/index.ts:138: <= 200 ids per call (02-TRD.md:317)
          return Object.entries(members).filter(([id]) => ids === undefined || ids.includes(id))
            .map(([membershipId, displayName]) => ({ membershipId, displayName, roleCodes: [], allCentres: false, isActive: true }));
        },
      },
    },
    ports: {
      IdentityPort: {
        async assertRole(_c: unknown, x: Row) { calls.assertRole.push(structuredClone(x)); if (!o.grants.includes(x['permission'])) throw new LimsError('auth.forbidden'); },
        async getActor() { calls.getActor++; return { actor: { type: 'user', id: 'x' }, permissions: [...o.grants], centreScope: o.centreScope ?? { all: true, centreIds: [] }, isLocked: false }; },
        async getSignatories() { calls.getSignatories++; return []; },
      },
      CatalogPort: {
        async getTest(_c: unknown, i: Row) {
          calls.tests.push(structuredClone(i));
          const t = o.tests?.[i['testId']]; if (!t) throw new LimsError('catalog.test_not_found');
          return { id: i['testId'], code: t.code, name: t.name, isActive: true, revision: 1, analytes: [], workflowType: 'microbiology', specimenTypeCodes: ['urine'] };
        },
      },
      LabPort: {
        async getOrderResults(_c: unknown, i: Row) {
          calls.lab.push(structuredClone(i));
          if (o.labThrows) throw o.labThrows;
          return o.lab ? o.lab(i) : { orderId: i['orderId'], specimens: [], items: [], approvedSetHash: 'h' };
        },
      },
    },
  };
  return { ctx, calls };
}

export const run = (op: string, req: Row, ctx: unknown): Promise<any> =>
  (handlers as unknown as Record<string, (r: unknown, c: unknown) => Promise<unknown>>)[op]!({ params: {}, query: {}, headers: {}, body: undefined, ...req }, ctx) as Promise<any>;
