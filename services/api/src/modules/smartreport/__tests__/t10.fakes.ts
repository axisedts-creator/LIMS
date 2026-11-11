// C14 T10 repository emulators + ctx builder (not a test file). Loaded by vi.mock factories, so it must NOT import library.service.
// Emulators follow the T02 repository SEAMS: tenant filter from rc.tenantId, list = active rows only unless includeInactive === true, snake_case DDL columns, writes recorded.
import { vi } from 'vitest';
import { createFakeCatalogPort } from '../../../../../../packages/fakes/src/CatalogPort.fake';
import { TENANTS, idFor } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import type { LibInput } from './t10.fixtures.js';

export const SEED = 1;
export const TA = TENANTS.A;
export const TB = TENANTS.B;
type Row = Record<string, any>;
export const VA = idFor(SEED, 0x7a01);   // tenant A draft version
export const VB = idFor(SEED, 0x7b01);   // tenant B draft version
export const world = {
  versions: [] as Row[], blocks: [] as Row[], rules: [] as Row[], mappings: [] as Row[], tenantTerms: [] as Row[], globalTerms: [] as Row[],
  calls: [] as { fn: string; tenantId?: string; args: unknown[] }[], writes: [] as string[],
  markers: [] as string[], catalogCalls: [] as { input: any; inSavepoint: boolean; tenantId: string }[], spDepth: 0,
};
export const callsOf = (...fns: string[]) => world.calls.filter((c) => fns.includes(c.fn));

interface Rc { tenantId: string; actorId: string }
const note = (fn: string, rc: Rc, ...args: unknown[]) => world.calls.push({ fn, tenantId: rc.tenantId, args });
const mine = (rows: Row[], rc: Rc) => rows.filter((r) => r.tenant_id === rc.tenantId);
const act = (rows: Row[], o?: { includeInactive?: boolean }) => rows.filter((r) => o?.includeInactive === true || r.is_active);
const copy = (rs: Row[]) => rs.map((r) => ({ ...r }));
const writer = (name: string) => vi.fn(async (rc: Rc, ...a: unknown[]) => { world.writes.push(name); note(name, rc, ...a); throw new Error(`${name}: validation must not write`); });

export const libraryRepoFake = {
  getLibraryVersion: vi.fn(async (rc: Rc, id: string) => { note('getLibraryVersion', rc, id); const r = mine(world.versions, rc).find((v) => v.id === id); return r ? { ...r } : null; }),
  insertLibraryVersion: writer('insertLibraryVersion'), updateLibraryVersion: writer('updateLibraryVersion'),
  getOpenLibraryVersion: vi.fn(async () => null), getApprovedLibraryVersion: vi.fn(async () => null), listLibraryVersions: vi.fn(async () => []),
};
export const blocksRepoFake = {
  listBlocks: vi.fn(async (rc: Rc, lv: string, o?: { includeInactive?: boolean }) => { note('listBlocks', rc, lv, o); return copy(act(mine(world.blocks, rc).filter((b) => b.library_version_id === lv), o)); }),
  getBlock: vi.fn(async () => null), insertBlock: writer('insertBlock'), updateBlock: writer('updateBlock'),
};
export const rulesRepoFake = {
  listRules: vi.fn(async (rc: Rc, lv: string, o?: { includeInactive?: boolean }) => { note('listRules', rc, lv, o); return copy(act(mine(world.rules, rc).filter((b) => b.library_version_id === lv), o)); }),
  listRulesByKind: vi.fn(async (rc: Rc, lv: string, kind: string, o?: { includeInactive?: boolean }) => { note('listRulesByKind', rc, lv, kind, o); return copy(act(mine(world.rules, rc).filter((b) => b.library_version_id === lv && b.rule_kind === kind), o)); }),
  getRule: vi.fn(async () => null), insertRule: writer('insertRule'), updateRule: writer('updateRule'),
};
export const mappingsRepoFake = {
  listMappings: vi.fn(async (rc: Rc, lv: string, o?: { includeInactive?: boolean }) => { note('listMappings', rc, lv, o); return copy(act(mine(world.mappings, rc).filter((b) => b.library_version_id === lv), o)); }),
  getMapping: vi.fn(async () => null), insertMapping: writer('insertMapping'), updateMapping: writer('updateMapping'),
};
export const denyTermsRepoFake = {
  listDenyTerms: vi.fn(async (rc: Rc, o?: { includeInactive?: boolean }) => { note('listDenyTerms', rc, o); return copy(act(mine(world.tenantTerms, rc), o)); }),
  listGlobalDenyTerms: vi.fn(async (rc: Rc) => { note('listGlobalDenyTerms', rc); return copy(world.globalTerms.filter((t) => t.is_active)); }),
  getDenyTerm: vi.fn(async () => null), insertDenyTerm: writer('insertDenyTerm'), updateDenyTerm: writer('updateDenyTerm'),
};
/** Lenient: if the service also reads group settings / coded sets, it gets empty lists instead of the real repository (which would hit ctx.tx). */
export const groupsRepoFake = { listGroupSettings: vi.fn(async () => []), getGroupSetting: vi.fn(async () => null), insertGroupSetting: writer('insertGroupSetting'), updateGroupSetting: writer('updateGroupSetting'), listAnalyteGroups: vi.fn(async () => []) };
export const codedSetsRepoFake = { listOrganGroups: vi.fn(async () => []), listRejectReasons: vi.fn(async () => []) };

const STAMP = '2026-11-01T00:00:00.000Z';
export const rowsFor = (tenantId: string, versionId: string, lib: LibInput, o: { status?: string } = {}) => ({
  version: { id: versionId, tenant_id: tenantId, version_no: 1, status: o.status ?? 'draft', language: lib.language, score_enabled: lib.scoreEnabled, version: 1, is_active: true, created_at: STAMP },
  blocks: lib.blocks.map((b) => ({ id: b.id, tenant_id: tenantId, library_version_id: versionId, block_key: b.blockKey, kind: b.kind, text_en: b.textEn ?? null, text_ne: b.textNe ?? null, is_active: true, version: 1 })),
  rules: lib.rules.map((r) => ({ id: r.id, tenant_id: tenantId, library_version_id: versionId, rule_kind: r.ruleKind, trigger_kind: r.triggerKind, analyte_id: r.analyteId ?? null, group_code: r.groupCode ?? null,
    direction: r.direction, min_severity: r.minSeverity ?? null, priority: r.priority, block_id: r.blockId, block_kind: r.blockKind, suggested_test_id: r.suggestedTestId ?? null, interval_days: r.intervalDays ?? null, is_active: true, version: 1 })),
  mappings: lib.mappings.map((m) => ({ id: m.id, tenant_id: tenantId, library_version_id: versionId, analyte_id: m.analyteId, group_code: m.groupCode, include_in_score: true, trend_enabled: false, sort_order: 100, is_active: true, version: 1 })),
});
export function load(tenantId: string, versionId: string, lib: LibInput, o: { status?: string } = {}) {
  const r = rowsFor(tenantId, versionId, lib, o);
  world.versions.push(r.version); world.blocks.push(...r.blocks); world.rules.push(...r.rules); world.mappings.push(...r.mappings);
}
const term = (tenant_id: string | null, t: string, o: Row = {}): Row => ({ tenant_id, term: t, term_folded: t.toLocaleLowerCase('und'), language: 'en', is_active: true, ...o });

export let catalog: ReturnType<typeof createFakeCatalogPort>;
export const TEST = { active: idFor(SEED, 100), inactive: idFor(SEED, 107), otherTenant: idFor(SEED, 106), unknown: idFor(SEED, 0xdead), glu: idFor(SEED, 101) };

export function seed(globalTerms: string[]): void {
  world.versions = []; world.blocks = []; world.rules = []; world.mappings = []; world.calls = []; world.writes = []; world.markers = []; world.catalogCalls = []; world.spDepth = 0;
  world.tenantTerms = [term(TA, 'zeta term'), term(TA, 'old term', { is_active: false }), term(TB, 'b-only-term')];
  world.globalTerms = globalTerms.map((t) => term(null, t, { language: 'any' }));
  catalog = createFakeCatalogPort({ seed: SEED });
}

/** Transaction emulator: savepoint(fn) rolls the marker rows back when fn throws (SAVEPOINT / ROLLBACK TO), keeps them otherwise. */
export function makeCtx(tenant: 'A' | 'B' = 'A', persona = 'pathologist') {
  const mkTx = (inSavepoint: boolean): any => ({
    inSavepoint,
    query: vi.fn(async () => { throw new Error('the service must reach the database only through the repositories'); }),
    async savepoint(fn: (tx: any) => Promise<unknown>) {
      const before = [...world.markers];
      world.spDepth++;
      try { return await fn(mkTx(true)); } catch (e) { world.markers = before; throw e; } finally { world.spDepth--; }
    },
  });
  const tx = mkTx(false);
  const catalogWrapper = {
    async getTest(c: any, input: any) {
      world.catalogCalls.push({ input, inSavepoint: Boolean(c?.tx?.inSavepoint) && world.spDepth > 0, tenantId: c?.tenantId });
      world.markers.push(`marker:${input?.testId}`);        // the port "writes a row" before it may fail (08 A19 P-44)
      return catalog.getTest(c, input);
    },
  };
  const ctx: any = { ...makeCtxFor()(`${tenant}:user:${persona}`), tx, ports: { CatalogPort: catalogWrapper }, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, metrics: { inc: vi.fn() } };
  return { ctx };
}
export { LimsError };
