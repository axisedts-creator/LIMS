// C14 T03 test helpers (not a test file): actors, calling, DTO shape checks. Repository emulators/state live in t03.fakes.ts. Synthetic data only.
// Handlers #23–#26 and #35 run for real through the handlers map with the REAL fake IdentityPort (role -> permission grants of contracts/permissions.yaml).
//
// SEAMS pinned here (spec leaves them open):
//   Handler ctx (CV §6.3): ctx.tenantId, ctx.actor.id, ctx.tx, ctx.ports.IdentityPort.
//   Handlers build RepoCtx { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id } and reach the database ONLY through the repositories
//   (ctx.tx.query throws in these tests). The tenant id never comes from request input.
//   Authorisation: IdentityPort.assertRole(ctx, { permission }) FIRST — before any repository call — tenant-wide (no centreId).
//   #23/#24/#25/#35 permission smartreport.template.manage; #26 smartreport.summary.read (08 A19 P-43).
//   Responses exactly as contracts/openapi/smartreport.yaml DenyTerm / CodedSet (additionalProperties false: no tenant_id, term_folded, created_*, system*).
import { vi } from 'vitest';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { handlers } from '../index.js';
import { SEED, TA, TB, UUID } from './t03.fakes.js';

export * from './t03.fakes.js';

const members = (): MembershipRow[] => {
  const out: MembershipRow[] = [];
  let n = 0x7000;
  for (const [t, key] of [[TA, 'A'], [TB, 'B']] as const) {
    const mk = (persona: string, roles: string[], o: Partial<MembershipRow> = {}) => out.push({
      id: idFor(SEED, n++), tenantId: t, actorId: actorIdFor(key, 'user', persona), actorType: 'user', displayName: `Test ${key}-${persona}`, roles,
      centreScope: { all: true, centreIds: [] }, branchIds: [], mfaLevel: 'aal2', isLocked: false, status: 'active', email: `${persona}.${key}@example.com`, version: 1, ...o,
    });
    mk('lab_manager', ['lab_manager']);
    mk('lab_manager_c1', ['lab_manager'], { centreScope: { all: false, centreIds: [idFor(SEED, 0xc1)] } });
    mk('front_desk', ['front_desk'], { centreScope: { all: false, centreIds: [idFor(SEED, 0xc1)] } });
    mk('pathologist', ['pathologist']);
    mk('lab_technologist', ['lab_technologist']);
    mk('revoked_lab_manager', ['lab_manager'], { status: 'deactivated' });
  }
  return out;
};
export type Persona = 'lab_manager' | 'lab_manager_c1' | 'front_desk' | 'pathologist' | 'lab_technologist' | 'revoked_lab_manager' | 'ghost';

export function makeCtx(persona: Persona, operationId: string, tenant: 'A' | 'B' = 'A') {
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: members() } }) as any;
  const asserted: { permission: string; centreId?: string }[] = [];
  const orig = identity.assertRole.bind(identity);
  identity.assertRole = async (c: unknown, r: { permission: string; centreId?: string }) => { asserted.push(r); return orig(c, r); };
  const ctx: any = {
    ...makeCtxFor()(`${tenant}:user:${persona}`),
    operationId, clientIp: '127.0.0.1',
    ports: { IdentityPort: identity },
    tx: { query: vi.fn(async () => { throw new Error('handlers must reach the database only through the repositories'); }) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, metrics: { inc: vi.fn() },
  };
  return { ctx, asserted };
}

export const request = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: o.params ?? {}, query: o.query ?? {}, headers: o.headers ?? {}, body: o.body ?? {} });
export const ifMatch = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
export function call(operationId: string, persona: Persona, req: ReturnType<typeof request>, tenant: 'A' | 'B' = 'A') {
  const { ctx, asserted } = makeCtx(persona, operationId, tenant);
  const h = (handlers as Record<string, (r: unknown, c: unknown) => Promise<any>>)[operationId];
  return { run: () => h!(req, ctx), asserted, ctx };
}
export async function fails(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected the operation to be refused, but it answered');
}
export const codeOf = (e: unknown): string | undefined => (e instanceof LimsError ? e.code : undefined);

const DENY_KEYS = ['id', 'term', 'language', 'scope', 'reason', 'is_active', 'version'];
export function denyTermDtoProblems(x: any): string[] {
  const p: string[] = [];
  if (!x || typeof x !== 'object') return ['not an object'];
  for (const k of Object.keys(x)) if (!DENY_KEYS.includes(k)) p.push(`extra key ${k}`);
  for (const k of ['term', 'language', 'scope', 'is_active']) if (!(k in x)) p.push(`missing ${k}`);
  if (typeof x.term !== 'string' || x.term.length < 2 || x.term.length > 60) p.push('term');
  if (!['en', 'ne', 'any'].includes(x.language)) p.push('language');
  if (!['global', 'tenant'].includes(x.scope)) p.push('scope');
  if (typeof x.is_active !== 'boolean') p.push('is_active');
  if ('reason' in x && (typeof x.reason !== 'string' || x.reason.length > 200)) p.push('reason (null is not allowed: omit it)');
  if (x.scope === 'tenant') { if (!UUID.test(String(x.id))) p.push('tenant id'); if (!Number.isInteger(x.version) || x.version < 1) p.push('tenant version'); }
  if (x.scope === 'global' && ('id' in x || 'version' in x)) p.push('global term must not expose id/version (not addressable)');
  return p;
}
export function codedSetProblems(x: any, setCode: string): string[] {
  const p: string[] = [];
  if (!x || typeof x !== 'object') return ['not an object'];
  if (JSON.stringify(Object.keys(x).sort()) !== JSON.stringify(['items', 'set_code'])) p.push(`keys ${Object.keys(x).sort()}`);
  if (x.set_code !== setCode) p.push('set_code');
  if (!Array.isArray(x.items)) return [...p, 'items'];
  for (const it of x.items) {
    if (JSON.stringify(Object.keys(it).sort()) !== JSON.stringify(['code', 'display', 'is_active', 'sort_order'])) p.push(`item keys ${Object.keys(it).sort()}`);
    if (it.is_active !== true) p.push(`inactive item served ${it.code}`);
  }
  return p;
}
