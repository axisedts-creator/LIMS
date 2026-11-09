// T15 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open — the writer must match them or raise a dispute:
//
//   ../org.service.ts   exports `createOrgService(deps?: { repo?: OrgRepo })` -> { listBranches, createBranch, updateBranch, deactivateBranch, reactivateBranch,
//                       listCentres, createCentre, updateCentre, deactivateCentre, reactivateCentre }, each `(ctx, input) => Promise<{ status, body, version? }>`
//                       (same convention as role.service.ts). T15 owns no repository file, so the DEFAULT repo (SQL on ctx.tx, explicit `tenant_id = $n`
//                       on every statement) lives inside org.service.ts; tests inject the FakeRepo below.
//   ctx = { tenantId, actor{type,id,membershipId}, requestId, tx }  — tenant and actor come ONLY from ctx, never from input.
//   inputs (camelCase):
//     listBranches{isActive?} · createBranch{code,name,addressText?,phone?,isProcessingLab?}
//     updateBranch{branchId,expectedVersion|undefined,name?,addressText?,phone?,isProcessingLab?,unset?} · deactivateBranch/reactivateBranch{branchId,expectedVersion|undefined}
//     listCentres{branchId?,kind?,isActive?} · createCentre{code,name,branchId,kind,addressText?,phone?}
//     updateCentre{centreId,expectedVersion|undefined,name?,branchId?,kind?,addressText?,phone?,unset?} · deactivateCentre/reactivateCentre{centreId,expectedVersion|undefined}
//   expectedVersion undefined -> 428 common.precondition_required; 0 / non-integer -> 400 common.validation_failed; stale -> 409 common.version_conflict.
//   bodies = Branch / Centre / BranchList / CentreList of contracts/openapi/identity.yaml ({data:[...]} for lists); create -> 201 + version 1.
//   handlers: ../handlers/{listBranches,createBranch,updateBranch,deactivateBranch,reactivateBranch,listCentres,createCentre,updateCentre,deactivateCentre,reactivateCentre}.ts
//   wired into handlers/index.ts (ETag = `"<version>"` on single-resource responses).
import { vi } from 'vitest';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1);
export const USER = idN(0xd1), MEM = idN(0xd2), REQ_ID = idN(0xe1);
export const BR_A1 = idN(0x301), BR_A2 = idN(0x302), BR_A_OFF = idN(0x303), BR_B1 = idN(0x3b1);
export const CE_A1 = idN(0x401), CE_A2 = idN(0x402), CE_B1 = idN(0x4b1);
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export type Kind = 'own' | 'franchise' | 'home_collection';
export type BranchRow = { id: string; code: string; name: string; address_text: string | null; phone: string | null; is_processing_lab: boolean; is_active: boolean; version: number };
export type CentreRow = { id: string; code: string; name: string; branch_id: string; kind: Kind; address_text: string | null; phone: string | null; is_active: boolean; version: number };
type Patch = { name?: string; addressText?: string; phone?: string; unset: string[]; actorId: string };

/** OrgRepo seam. Every method takes (tx, tenantId, ...). The in-memory fake below records `calls` (method, tx, tenantId) and mutations in `writes`. */
export interface OrgRepo {
  listBranches(tx: unknown, tenantId: string, q: { isActive?: boolean }): Promise<BranchRow[]>;
  /** RLS-invisible / other tenant -> undefined. May lock the row (FOR SHARE / FOR UPDATE). */
  findBranch(tx: unknown, tenantId: string, branchId: string): Promise<BranchRow | undefined>;
  /** duplicate (tenant_id, branch_code) -> throws an error with `code: '23505'` */
  insertBranch(tx: unknown, tenantId: string, r: { id: string; code: string; name: string; addressText?: string; phone?: string; isProcessingLab: boolean; actorId: string }): Promise<BranchRow>;
  /** undefined = version mismatch */
  updateBranch(tx: unknown, tenantId: string, branchId: string, expectedVersion: number, p: Patch & { isProcessingLab?: boolean }): Promise<BranchRow | undefined>;
  setBranchActive(tx: unknown, tenantId: string, branchId: string, expectedVersion: number, active: boolean, o: { actorId: string }): Promise<BranchRow | undefined>;
  countActiveCentres(tx: unknown, tenantId: string, branchId: string): Promise<number>;
  listCentres(tx: unknown, tenantId: string, q: { branchId?: string; kind?: string; isActive?: boolean }): Promise<CentreRow[]>;
  findCentre(tx: unknown, tenantId: string, centreId: string): Promise<CentreRow | undefined>;
  /** duplicate (tenant_id, centre_code) -> throws an error with `code: '23505'` */
  insertCentre(tx: unknown, tenantId: string, r: { id: string; code: string; name: string; branchId: string; kind: Kind; addressText?: string; phone?: string; actorId: string }): Promise<CentreRow>;
  updateCentre(tx: unknown, tenantId: string, centreId: string, expectedVersion: number, p: Patch & { branchId?: string; kind?: Kind }): Promise<CentreRow | undefined>;
  setCentreActive(tx: unknown, tenantId: string, centreId: string, expectedVersion: number, active: boolean, o: { actorId: string }): Promise<CentreRow | undefined>;
}

export const branch = (o: Partial<BranchRow> & { id: string; code: string }): BranchRow =>
  ({ name: `Branch ${o.code}`, address_text: null, phone: null, is_processing_lab: true, is_active: true, version: 1, ...o });
export const centre = (o: Partial<CentreRow> & { id: string; code: string; branch_id: string }): CentreRow =>
  ({ name: `Centre ${o.code}`, kind: 'own', address_text: null, phone: null, is_active: true, version: 1, ...o });

export function makeRepo(seed: { branches?: Record<string, BranchRow[]>; centres?: Record<string, CentreRow[]> } = {}) {
  const state = {
    branches: new Map<string, BranchRow[]>(Object.entries(seed.branches ?? { [TENANT_A]: [], [TENANT_B]: [] }).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
    centres: new Map<string, CentreRow[]>(Object.entries(seed.centres ?? { [TENANT_A]: [], [TENANT_B]: [] }).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
  };
  const calls: Array<{ m: string; tx: unknown; tenantId: string; args: unknown[] }> = [];
  const writes: string[] = [];
  const fail: Record<string, Error | undefined> = {};
  const bs = (t: string) => state.branches.get(t) ?? [];
  const cs = (t: string) => state.centres.get(t) ?? [];
  const rec = (m: string, tx: unknown, tenantId: string, ...args: unknown[]) => { calls.push({ m, tx, tenantId, args }); if (fail[m]) throw fail[m]; };
  const w = (m: string) => writes.push(m);
  const dup = () => Object.assign(new Error('duplicate key'), { code: '23505' });
  const apply = (r: Record<string, any>, p: Patch & Record<string, any>) => {
    for (const [k, col] of [['name', 'name'], ['addressText', 'address_text'], ['phone', 'phone'], ['isProcessingLab', 'is_processing_lab'], ['branchId', 'branch_id'], ['kind', 'kind']] as const) if (p[k] !== undefined) r[col] = p[k];
    for (const u of p.unset) r[u] = null;
    r['version'] += 1;
  };
  const repo: OrgRepo = {
    async listBranches(tx, t, q) { rec('listBranches', tx, t, q); return bs(t).filter((r) => q.isActive === undefined || r.is_active === q.isActive).map((r) => ({ ...r })); },
    async findBranch(tx, t, id) { rec('findBranch', tx, t, id); const r = bs(t).find((x) => x.id === id); return r && { ...r }; },
    async insertBranch(tx, t, r) {
      rec('insertBranch', tx, t, r); w('insertBranch');
      if (bs(t).some((x) => x.code === r.code)) throw dup();
      const row = branch({ id: r.id, code: r.code, name: r.name, address_text: r.addressText ?? null, phone: r.phone ?? null, is_processing_lab: r.isProcessingLab });
      state.branches.set(t, [...bs(t), row]); return { ...row };
    },
    async updateBranch(tx, t, id, v, p) {
      rec('updateBranch', tx, t, id, v, p); w('updateBranch');
      const r = bs(t).find((x) => x.id === id); if (!r || r.version !== v) return undefined; apply(r, p); return { ...r };
    },
    async setBranchActive(tx, t, id, v, active, o) {
      rec('setBranchActive', tx, t, id, v, active, o); w('setBranchActive');
      const r = bs(t).find((x) => x.id === id); if (!r || r.version !== v) return undefined; r.is_active = active; r.version += 1; return { ...r };
    },
    async countActiveCentres(tx, t, id) { rec('countActiveCentres', tx, t, id); return cs(t).filter((c) => c.branch_id === id && c.is_active).length; },
    async listCentres(tx, t, q) {
      rec('listCentres', tx, t, q);
      return cs(t).filter((c) => (q.branchId === undefined || c.branch_id === q.branchId) && (q.kind === undefined || c.kind === q.kind) && (q.isActive === undefined || c.is_active === q.isActive)).map((c) => ({ ...c }));
    },
    async findCentre(tx, t, id) { rec('findCentre', tx, t, id); const r = cs(t).find((x) => x.id === id); return r && { ...r }; },
    async insertCentre(tx, t, r) {
      rec('insertCentre', tx, t, r); w('insertCentre');
      if (cs(t).some((x) => x.code === r.code)) throw dup();
      const row = centre({ id: r.id, code: r.code, name: r.name, branch_id: r.branchId, kind: r.kind, address_text: r.addressText ?? null, phone: r.phone ?? null });
      state.centres.set(t, [...cs(t), row]); return { ...row };
    },
    async updateCentre(tx, t, id, v, p) {
      rec('updateCentre', tx, t, id, v, p); w('updateCentre');
      const r = cs(t).find((x) => x.id === id); if (!r || r.version !== v) return undefined; apply(r, p); return { ...r };
    },
    async setCentreActive(tx, t, id, v, active, o) {
      rec('setCentreActive', tx, t, id, v, active, o); w('setCentreActive');
      const r = cs(t).find((x) => x.id === id); if (!r || r.version !== v) return undefined; r.is_active = active; r.version += 1; return { ...r };
    },
  };
  return { repo, state, calls, writes, fail, branchRow: (t: string, id: string) => bs(t).find((r) => r.id === id), centreRow: (t: string, id: string) => cs(t).find((r) => r.id === id) };
}

export function makeCtx(o: { tenantId?: string } = {}) {
  const access = vi.fn(async (_e: Record<string, unknown>) => undefined);
  const tx = { __tx: 'T15-request-tx', query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const ctx = { tenantId: o.tenantId ?? TENANT_A, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, tx, audit: { access } };
  return { ctx, access, tx };
}
