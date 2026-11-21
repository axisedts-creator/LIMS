// SEC-AUTHZ-5 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1 approved design): behaviour matrix of the catalog operations that the classifier snapshot
// shows as `unguarded` (46), `guarded-other` (29), or `stub` although a handler exists at runtime (12: the generated masters handlers of
// masters.handlers.ts: departments, specimen types, containers, methods). Each handler is called directly (the central stage 8a is NOT in play),
// so what is proven here is the handler's OWN guard: ctx.ports.IdentityPort.assertRole(ctx, { permission }) BEFORE any data is read or written.
// Synthetic data only. Pinned interface: the guard is the call `ctx.ports.IdentityPort.assertRole(ctx, { permission })` (the one the ranges, price-tool
// and instrument-map handlers already use); it throws LimsError auth.forbidden | auth.mfa_required | identity.support_session_required and the
// handler lets it through unchanged (no new error code). It runs before validation, If-Match parsing, the events port and any tx access.
// Expected permission = the operation's contract x-permission, unless the operation is in services/api/src/core/pipeline/authz-exceptions.json
// (then its handlerPermission) or is named in a SEC-AUTHZ-5 change request (.orchestra/cr/SEC-AUTHZ-5*.md: wrong contract x-permission, for C3).
// Per-kind operations (imports / exports, 08 A13 P-10): the contract floor is catalog.test.read, the service then asserts the kind permission
// (price_list.manage, referrer.manage, ...). The handler must ask the floor (or the exception permission) FIRST; the kind permission stays.
// "Keep working": every default-pack role that holds the x-permission of a read operation is not denied by the handler's own guards
// (contracts/permissions.yaml, so front desk, lab technologist, pathologist and finance keep their catalog reads). Nothing is widened.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { handlers } from '../handlers/index.js';

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const spec: any = parse(readFileSync(join(ROOT, 'contracts', 'openapi', 'catalog.yaml'), 'utf8'));
const xPerm: Record<string, string> = {};
for (const item of Object.values<any>(spec.paths)) {
  for (const op of Object.values<any>(item)) if (op && typeof op === 'object' && op.operationId && op['x-permission']) xPerm[op.operationId] = op['x-permission'];
}
const packs: any = parse(readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8'));
const roleGrants = new Map<string, Set<string>>();
for (const p of packs.permissions as Array<{ code: string; roles?: string[] }>) for (const r of p.roles ?? []) (roleGrants.get(r) ?? roleGrants.set(r, new Set()).get(r)!).add(p.code);
const holders = (perm: string): string[] => (packs.permissions as Array<{ code: string; roles?: string[] }>).find((p) => p.code === perm)?.roles ?? [];

const exceptionsPath = join(ROOT, 'services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json');
const exceptions: Array<{ operationId: string; handlerPermission: string }> = existsSync(exceptionsPath) ? JSON.parse(readFileSync(exceptionsPath, 'utf8')) : [];
const crDir = join(ROOT, '.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-5.*\.md$/.test(f)).map((f) => readFileSync(join(crDir, f), 'utf8')).join('\n') : '';

// Snapshot (fresh classifier run at the start of SEC-AUTHZ-5): class unguarded.
export const UNGUARDED_CATALOG = [
  'getCatalogRevision', 'searchOrderables', 'resolveOrderablesPreview', 'getCatalogHealthReport',
  'listUnits', 'createUnit', 'updateUnit', 'listValueSets', 'createValueSet', 'updateValueSet',
  'listTests', 'createTest', 'getTestDetail', 'updateTest', 'replaceTestSpecimenRequirements', 'setTestTatTargets',
  'createAnalyte', 'getAnalyte', 'updateAnalyte', 'createAnalyteVersionDraft', 'updateAnalyteVersionDraft', 'discardAnalyteVersionDraft',
  'validateFormula', 'previewReferenceRange',
  'listPanels', 'createPanel', 'getPanelDetail', 'updatePanel', 'replacePanelMembers',
  'listCommentCodes', 'createCommentCode', 'updateCommentCode', 'listTestCategories', 'createTestCategory', 'updateTestCategory',
  'searchDoctors', 'listDoctors', 'createDoctor', 'getDoctor', 'updateDoctor', 'verifyDoctor', 'mergeDoctor',
  'listCreditParties', 'createCreditParty', 'getCreditParty', 'updateCreditParty',
] as const;
// class guarded-other: the classifier saw another permission in reachable code (a sibling privileged branch, or the per-kind service asserts).
export const GUARDED_OTHER_CATALOG = [
  'listReferenceRangeSets', 'createReferenceRangeSetDraft', 'getReferenceRangeSet', 'replaceReferenceRangeSetBands', 'discardReferenceRangeSetDraft',
  'listCriticalLimitSets', 'createCriticalLimitSetDraft', 'getCriticalLimitSet', 'replaceCriticalLimitSetBands', 'discardCriticalLimitSetDraft',
  'listPriceLists', 'getPriceListDetail', 'listPriceListItems', 'quotePrices', 'listSurchargeRules', 'listTaxTypes', 'listTaxRules',
  'downloadImportTemplate', 'createImport', 'listImports', 'getImport', 'listImportIssues', 'downloadImportReport', 'commitImport', 'discardImport',
  'createExport', 'listExports', 'getExport', 'downloadExportFile',
] as const;
// class stub for the classifier (handlers are generated in a loop) but real at runtime.
export const GENERATED_MASTERS = [
  'listDepartments', 'createDepartment', 'updateDepartment', 'listSpecimenTypes', 'createSpecimenType', 'updateSpecimenType',
  'listContainers', 'createContainer', 'updateContainer', 'listMethods', 'createMethod', 'updateMethod',
] as const;
export const GROUP = [...UNGUARDED_CATALOG, ...GUARDED_OTHER_CATALOG, ...GENERATED_MASTERS] as const;
const PER_KIND = new Set(['downloadImportTemplate', 'createImport', 'listImports', 'getImport', 'listImportIssues', 'downloadImportReport', 'commitImport', 'discardImport',
  'createExport', 'listExports', 'getExport', 'downloadExportFile']);

const expectedPermission = (op: string): string | undefined => {
  const ex = exceptions.find((e) => e.operationId === op);
  if (ex) return ex.handlerPermission;
  if (new RegExp(`\\b${op}\\b`).test(crText)) return undefined; // contract x-permission wrong: CR written, exactness not checked
  return xPerm[op];
};

const TENANT = '0190a000-0000-7000-8000-00000000aaaa';
const ACTOR = '0190a000-0000-7000-8000-000000004001';
const ID = '0190a000-0000-7000-8000-000000009001';
const req = {
  params: {
    id: ID, unit_id: ID, value_set_id: ID, comment_code_id: ID, category_id: ID, test_id: ID, analyte_id: ID, version_id: ID, analyte_version_id: ID, set_id: ID,
    panel_id: ID, doctor_id: ID, credit_party_id: ID, price_list_id: ID, price_list_version_id: ID, surcharge_rule_id: ID, tax_type_id: ID, tax_rule_id: ID,
    import_id: ID, export_id: ID, kind: 'catalog_master',
  },
  query: {}, headers: { 'if-match': '"1"' }, body: {},
};

function rig(actorType: string, assertRole: (ctx: any, r: { permission: string }) => Promise<unknown>, withPort = true) {
  const log: string[] = [];
  const query = vi.fn(async () => { log.push('data'); return { rows: [], rowCount: 0 }; });
  const asserted: string[] = [];
  const assert = vi.fn(async (ctx: any, r: { permission: string }) => { log.push('assert'); asserted.push(r?.permission); return assertRole(ctx, r); });
  // any access to the transaction or to the events port counts as data access: a denied request must touch neither.
  const touch = (name: string) => new Proxy({}, {
    get: (_t, p) => { if (typeof p === 'symbol' || p === 'then') return undefined; log.push('data'); return p === 'query' ? query : vi.fn(async () => { log.push(name); return { rows: [], rowCount: 0 }; }); },
  });
  const ctx: any = {
    tenantId: TENANT, actor: { type: actorType, id: ACTOR, membershipId: ID }, sessionId: ID, requestId: ID, now: () => new Date('2026-11-19T00:00:00Z'),
    tx: touch('tx'), events: touch('events'), ports: withPort ? { IdentityPort: { assertRole: assert } } : {}, audit: { access: vi.fn(async () => undefined) },
  };
  return { ctx, log, query, assert, asserted };
}
const run = async (op: string, ctx: any) => {
  try { await (handlers as Record<string, any>)[op](req, ctx); return undefined; } catch (e) { return e as any; }
};
const denyAll = (code = 'auth.forbidden') => async () => { throw new LimsError(code); };
const grantOnly = (granted: Set<string>) => async (_c: any, r: { permission: string }) => { if (!granted.has(r.permission)) throw new LimsError('auth.forbidden'); };
const noData = (r: ReturnType<typeof rig>, op: string) => expect(r.log.filter((x) => x !== 'assert'), `${op}: no data read or written before/without the guard`).toEqual([]);

describe('SEC-AUTHZ-5 catalog: the snapshot list is real', () => {
  it('has 87 distinct operations, each in the catalog contract with a runtime handler and a catalog.* x-permission', () => {
    expect(UNGUARDED_CATALOG.length).toBe(46);
    expect(GUARDED_OTHER_CATALOG.length).toBe(29);
    expect(new Set(GROUP).size).toBe(87);
    for (const op of GROUP) {
      expect(typeof (handlers as Record<string, unknown>)[op], op).toBe('function');
      expect(xPerm[op], op).toMatch(/^catalog\./);
    }
  });
});

describe('SEC-AUTHZ-5 catalog: user without the permission is denied before any data is read or written', () => {
  it.each(GROUP)('%s: assertRole denies -> auth.forbidden, repository and events spies not called', async (op) => {
    const r = rig('user', denyAll());
    const err = await run(op, r.ctx);
    expect(err, `${op} must reject`).toBeInstanceOf(LimsError);
    expect(err.code).toBe('auth.forbidden');
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    noData(r, op);
  });

  it.each(['auth.mfa_required', 'identity.support_session_required'])('createUnit, listPriceLists, createImport and publish-free range reads pass %s through unchanged (no new error code)', async (code) => {
    for (const op of ['createUnit', 'listPriceLists', 'createImport', 'listReferenceRangeSets', 'mergeDoctor']) {
      const r = rig('user', denyAll(code));
      const err = await run(op, r.ctx);
      expect(err?.code, op).toBe(code);
      noData(r, op);
    }
  });

  it('a failing IdentityPort (dependency down) fails closed: the handler rejects and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', async () => { throw new Error('identity store unavailable'); });
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject when assertRole fails`).toBeDefined();
      noData(r, op);
    }
  });

  it('no IdentityPort in the context fails closed: the handler rejects with auth.unauthenticated (the catalog convention) and reads nothing', async () => {
    for (const op of GROUP) {
      const r = rig('user', denyAll(), false);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject without a port`).toBeInstanceOf(LimsError);
      expect(err.code, op).toBe('auth.unauthenticated');
      noData(r, op);
    }
  });

  it('a user holding every catalog permission EXCEPT the one needed is denied (no adjacent permission is enough)', async () => {
    const all = new Set([...Object.values(xPerm), ...exceptions.map((e) => e.handlerPermission), 'catalog.test.manage', 'catalog.price_list.manage', 'catalog.referrer.manage']);
    for (const op of GROUP) {
      const want = expectedPermission(op);
      if (!want) continue;
      const r = rig('user', grantOnly(new Set([...all].filter((p) => p !== want))));
      const err = await run(op, r.ctx);
      expect(err?.code, `${op} must be denied without ${want}`).toBe('auth.forbidden');
      noData(r, op);
    }
  });
});

describe('SEC-AUTHZ-5 catalog: user with exactly the permission reaches the handler', () => {
  it.each(GROUP)('%s: the first guard asks the declared permission; with exactly that grant the guard does not deny', async (op) => {
    const want = expectedPermission(op);
    const r = rig('user', want ? grantOnly(new Set([want])) : async () => undefined);
    const err = await run(op, r.ctx);
    expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
    expect(r.log[0], 'guard before any data access').toBe('assert');
    if (want) expect(r.asserted[0], `${op} asks ${want} first`).toBe(want);
    if (want && !PER_KIND.has(op)) expect(new Set(r.asserted), `${op} asks exactly ${want}`).toEqual(new Set([want]));
    // per-kind operations may be denied later by their kind permission (price_list.manage, ...): that is the existing P-10 check, not this guard.
    if (!PER_KIND.has(op)) expect(err?.code, `${op} must not be denied by its own guard`).not.toBe('auth.forbidden');
  });
});

describe('SEC-AUTHZ-5 catalog: the default role packs keep their catalog reads (nothing is widened, nothing is narrowed)', () => {
  const READS = GROUP.filter((op) => /\.read$/.test(xPerm[op] ?? '') && !PER_KIND.has(op) && !exceptions.some((e) => e.operationId === op));
  it('the matrix covers reads for front desk, lab technologist, pathologist, finance and centre staff', () => {
    const roles = new Set(READS.flatMap((op) => holders(xPerm[op]!)));
    for (const role of ['front_desk', 'lab_technologist', 'pathologist', 'finance', 'tenant_admin', 'lab_manager']) expect(roles.has(role), role).toBe(true);
    expect(READS.length).toBeGreaterThan(20);
  });
  for (const role of ['tenant_admin', 'lab_manager', 'front_desk', 'lab_technologist', 'pathologist', 'finance', 'centre_staff']) {
    it(`${role}: every read operation whose x-permission the role holds is not denied by the handler's own guards`, async () => {
      const grants = roleGrants.get(role) ?? new Set<string>();
      for (const op of READS.filter((o) => grants.has(xPerm[o]!))) {
        const r = rig('user', grantOnly(grants));
        const err = await run(op, r.ctx);
        expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
        expect(err?.code, `${op} must work for ${role} (holds ${xPerm[op]})`).not.toBe('auth.forbidden');
      }
    });
  }
  it('an exception row is only for an operation whose handler really needs another permission: every role holding the x-permission of an excepted read also holds the handler permission', () => {
    for (const e of exceptions.filter((x) => GROUP.includes(x.operationId as never) && /\.read$/.test(xPerm[x.operationId] ?? ''))) {
      for (const role of holders(xPerm[e.operationId]!)) {
        expect(roleGrants.get(role)?.has(e.handlerPermission), `${e.operationId}: ${role} holds ${xPerm[e.operationId]} but not ${e.handlerPermission} (a read would break; correct the contract with a C3 change request instead)`).toBe(true);
      }
    }
  });
});

describe('SEC-AUTHZ-5 catalog: patient, partner and portal actors are denied on staff operations', () => {
  // A realistic assertRole: only 'user' (staff) actors can hold a tenant permission. The handler must not read data either way.
  const staffOnly = async (ctx: any) => { if (ctx?.actor?.type !== 'user') throw new LimsError('auth.forbidden'); };
  for (const kind of ['patient', 'partner', 'portal']) {
    it.each(GROUP)(`${kind} actor: %s rejected, no data read`, async (op) => {
      const r = rig(kind, staffOnly);
      const err = await run(op, r.ctx);
      expect(err, `${op} must reject a ${kind} actor`).toBeInstanceOf(LimsError);
      expect(['auth.forbidden', 'auth.unauthenticated']).toContain(err.code);
      expect(r.assert, `${op} must ask assertRole`).toHaveBeenCalled();
      noData(r, op);
    });
  }
});

describe('SEC-AUTHZ-5 catalog: named permissions of the contract are asked as written', () => {
  it.each([
    ['createUnit', 'catalog.test.manage'], ['listUnits', 'catalog.test.read'], ['createTest', 'catalog.test.manage'], ['listTests', 'catalog.test.read'],
    ['createPanel', 'catalog.test.manage'], ['listReferenceRangeSets', 'catalog.test.read'], ['createReferenceRangeSetDraft', 'catalog.test.manage'],
    ['listPriceLists', 'catalog.price_list.read'], ['quotePrices', 'catalog.price_list.read'], ['createCreditParty', 'catalog.price_list.manage'],
    ['listDoctors', 'catalog.referrer.read'], ['mergeDoctor', 'catalog.referrer.manage'], ['createDepartment', 'catalog.test.manage'],
  ])('%s asks %s (and nothing wider) and is denied without it', async (op, perm) => {
    if (expectedPermission(op) !== perm) return; // exception or CR: covered by the matrix above
    const r = rig('user', grantOnly(new Set(['catalog.referrer.export', 'catalog.instrument_code_map.manage'])));
    const err = await run(op, r.ctx);
    expect(err?.code).toBe('auth.forbidden');
    expect(r.asserted[0]).toBe(perm);
    noData(r, op);
  });
});
