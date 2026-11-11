// Branches + collection centres (02-TRD §5.5; 03-APP-FLOW §5; 01-PRD AC-C1.1-C1.3; 07-SECURITY P-2, P-3).
// Tenant and actor come from ctx only. Every SQL statement names tenant_id explicitly on top of RLS (REQ-SEC-040).
// Master data is never deleted (02-CV §5.6); deactivation leaves memberships alone. No cap on counts (AC-C1.3).
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export interface OrgCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly requestId?: string;
  readonly tx: unknown;
}
export interface Result { status: number; body: any; version?: number }

export type Kind = 'own' | 'franchise' | 'home_collection';
export type BranchRow = { id: string; code: string; name: string; address_text: string | null; phone: string | null; is_processing_lab: boolean; is_active: boolean; version: number };
export type CentreRow = { id: string; code: string; name: string; branch_id: string; kind: Kind; address_text: string | null; phone: string | null; is_active: boolean; version: number };
type Patch = { name?: string; addressText?: string; phone?: string; unset: string[]; actorId: string };

export interface OrgRepo {
  listBranches(tx: unknown, tenantId: string, q: { isActive?: boolean }): Promise<BranchRow[]>;
  /** Locks the row FOR UPDATE: serialises centre create/move against deactivateBranch. */
  findBranch(tx: unknown, tenantId: string, branchId: string): Promise<BranchRow | undefined>;
  insertBranch(tx: unknown, tenantId: string, r: { id: string; code: string; name: string; addressText?: string; phone?: string; isProcessingLab: boolean; actorId: string }): Promise<BranchRow>;
  updateBranch(tx: unknown, tenantId: string, branchId: string, expectedVersion: number, p: Patch & { isProcessingLab?: boolean }): Promise<BranchRow | undefined>;
  setBranchActive(tx: unknown, tenantId: string, branchId: string, expectedVersion: number, active: boolean, o: { actorId: string }): Promise<BranchRow | undefined>;
  countActiveCentres(tx: unknown, tenantId: string, branchId: string): Promise<number>;
  listCentres(tx: unknown, tenantId: string, q: { branchId?: string; kind?: string; isActive?: boolean }): Promise<CentreRow[]>;
  findCentre(tx: unknown, tenantId: string, centreId: string): Promise<CentreRow | undefined>;
  insertCentre(tx: unknown, tenantId: string, r: { id: string; code: string; name: string; branchId: string; kind: Kind; addressText?: string; phone?: string; actorId: string }): Promise<CentreRow>;
  updateCentre(tx: unknown, tenantId: string, centreId: string, expectedVersion: number, p: Patch & { branchId?: string; kind?: Kind }): Promise<CentreRow | undefined>;
  setCentreActive(tx: unknown, tenantId: string, centreId: string, expectedVersion: number, active: boolean, o: { actorId: string }): Promise<CentreRow | undefined>;
}

type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

/** Default repo: SQL on the request tx. Patches use COALESCE for "absent = keep" and a text[] of columns to clear (unset). */
export function createOrgRepo(): OrgRepo {
  const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;
  return {
    listBranches: (tx, t, f) => q(tx, `SELECT id, branch_code AS code, name, address_text, phone_display AS phone, is_processing_lab, is_active, version FROM core.branches
      WHERE tenant_id = $1 AND (is_active = $2::boolean OR $2::boolean IS NULL) ORDER BY branch_code`, [t, f.isActive ?? null]),
    // ponytail: FOR UPDATE serialises every centre create/move on one branch; FOR KEY SHARE + FOR UPDATE in deactivate if that ever contends.
    findBranch: async (tx, t, id) => (await q(tx, `SELECT id, branch_code AS code, name, address_text, phone_display AS phone, is_processing_lab, is_active, version
      FROM core.branches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [t, id]))[0],
    insertBranch: async (tx, t, r) => (await q(tx, `INSERT INTO core.branches (id, tenant_id, branch_code, name, address_text, phone_display, is_processing_lab, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $8) RETURNING id, branch_code AS code, name, address_text, phone_display AS phone, is_processing_lab, is_active, version`,
      [t, r.id, r.code, r.name, r.addressText ?? null, r.phone ?? null, r.isProcessingLab, r.actorId]))[0],
    updateBranch: async (tx, t, id, v, p) => (await q(tx, `UPDATE core.branches SET name = COALESCE($4, name),
        address_text = CASE WHEN 'address_text' = ANY($8::text[]) THEN NULL ELSE COALESCE($5, address_text) END,
        phone_display = CASE WHEN 'phone' = ANY($8::text[]) THEN NULL ELSE COALESCE($6, phone_display) END,
        is_processing_lab = COALESCE($7, is_processing_lab), version = version + 1, updated_at = now(), updated_by = $9
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, branch_code AS code, name, address_text, phone_display AS phone, is_processing_lab, is_active, version`,
      [t, id, v, p.name ?? null, p.addressText ?? null, p.phone ?? null, p.isProcessingLab ?? null, p.unset, p.actorId]))[0],
    setBranchActive: async (tx, t, id, v, active, o) => (await q(tx, `UPDATE core.branches SET is_active = $4, version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, branch_code AS code, name, address_text, phone_display AS phone, is_processing_lab, is_active, version`, [t, id, v, active, o.actorId]))[0],
    countActiveCentres: async (tx, t, id) => (await q(tx, `SELECT count(*)::int AS n FROM core.collection_centres WHERE tenant_id = $1 AND branch_id = $2 AND is_active`, [t, id]))[0]?.n ?? 0,
    listCentres: (tx, t, f) => q(tx, `SELECT id, centre_code AS code, name, branch_id, centre_kind AS kind, address_text, phone_display AS phone, is_active, version FROM core.collection_centres
      WHERE tenant_id = $1 AND (branch_id = $2::uuid OR $2::uuid IS NULL) AND (centre_kind = $3::text OR $3::text IS NULL)
        AND (is_active = $4::boolean OR $4::boolean IS NULL) ORDER BY centre_code`, [t, f.branchId ?? null, f.kind ?? null, f.isActive ?? null]),
    findCentre: async (tx, t, id) => (await q(tx, `SELECT id, centre_code AS code, name, branch_id, centre_kind AS kind, address_text, phone_display AS phone, is_active, version
      FROM core.collection_centres WHERE tenant_id = $1 AND id = $2`, [t, id]))[0],
    insertCentre: async (tx, t, r) => (await q(tx, `INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, address_text, phone_display, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id, centre_code AS code, name, branch_id, centre_kind AS kind, address_text, phone_display AS phone, is_active, version`,
      [t, r.id, r.branchId, r.code, r.name, r.kind, r.addressText ?? null, r.phone ?? null, r.actorId]))[0],
    updateCentre: async (tx, t, id, v, p) => (await q(tx, `UPDATE core.collection_centres SET name = COALESCE($4, name), branch_id = COALESCE($5::uuid, branch_id),
        centre_kind = COALESCE($6, centre_kind),
        address_text = CASE WHEN 'address_text' = ANY($9::text[]) THEN NULL ELSE COALESCE($7, address_text) END,
        phone_display = CASE WHEN 'phone' = ANY($9::text[]) THEN NULL ELSE COALESCE($8, phone_display) END,
        version = version + 1, updated_at = now(), updated_by = $10
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, centre_code AS code, name, branch_id, centre_kind AS kind, address_text, phone_display AS phone, is_active, version`,
      [t, id, v, p.name ?? null, p.branchId ?? null, p.kind ?? null, p.addressText ?? null, p.phone ?? null, p.unset, p.actorId]))[0],
    setCentreActive: async (tx, t, id, v, active, o) => (await q(tx, `UPDATE core.collection_centres SET is_active = $4, version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, centre_code AS code, name, branch_id, centre_kind AS kind, address_text, phone_display AS phone, is_active, version`, [t, id, v, active, o.actorId]))[0],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[A-Za-z0-9-]{1,16}$/;
const KINDS: readonly string[] = ['own', 'franchise', 'home_collection'];
const UNSETTABLE: readonly string[] = ['address_text', 'phone'];

const failAt = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
function scope(ctx: OrgCtx) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
function expected(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) failAt('/If-Match');
  return v as number;
}
const idOf = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw new LimsError('common.not_found'); return v; };
const str = (v: unknown, path: string, max: number, required = false): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.length < 1 || v.length > max) failAt(path);
  return v as string;
};
const codeOf = (v: unknown) => { if (typeof v !== 'string' || !CODE.test(v)) failAt('/code'); return v as string; };
const kindOf = (v: unknown, required: boolean): Kind | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !KINDS.includes(v)) failAt('/kind');
  return v as Kind;
};
const uuidField = (v: unknown, path: string, required: boolean): string | undefined => {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) failAt(path);
  return v as string;
};
const boolOf = (v: unknown, path: string) => { if (v !== undefined && typeof v !== 'boolean') failAt(path); return v as boolean | undefined; };
const unsetOf = (v: unknown): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 2 || new Set(v).size !== v.length || !v.every((x) => typeof x === 'string' && UNSETTABLE.includes(x))) failAt('/unset');
  return [...(v as string[])];
};
const defined = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
const isDup = (e: unknown) => (e as { code?: unknown })?.code === '23505';

const toBranch = (r: BranchRow) => ({
  branch_id: r.id, code: r.code, name: r.name, ...(r.address_text == null ? {} : { address_text: r.address_text }), ...(r.phone == null ? {} : { phone: r.phone }),
  is_processing_lab: r.is_processing_lab, is_active: r.is_active, version: r.version,
});
const toCentre = (r: CentreRow) => ({
  centre_id: r.id, code: r.code, name: r.name, branch_id: r.branch_id, kind: r.kind,
  ...(r.address_text == null ? {} : { address_text: r.address_text }), ...(r.phone == null ? {} : { phone: r.phone }), is_active: r.is_active, version: r.version,
});

export function createOrgService(deps: { repo?: OrgRepo } = {}) {
  const repo = deps.repo ?? createOrgRepo();
  type S = ReturnType<typeof scope>;

  const loadBranch = async (s: S, id: string) => { const r = await repo.findBranch(s.tx, s.tenantId, id); if (!r) throw new LimsError('common.not_found'); return r; };
  const loadCentre = async (s: S, id: string) => { const r = await repo.findCentre(s.tx, s.tenantId, id); if (!r) throw new LimsError('common.not_found'); return r; };
  /** P-2: unknown, other-tenant and inactive branch all answer the same (locks the branch row). */
  const activeBranch = async (s: S, id: string) => {
    const b = await repo.findBranch(s.tx, s.tenantId, id);
    if (!b?.is_active) throw new LimsError('identity.centre_inactive');
  };
  const branchOut = (r: BranchRow | undefined, status = 200): Result => { if (!r) throw new LimsError('common.version_conflict'); return { status, body: toBranch(r), version: r.version }; };
  const centreOut = (r: CentreRow | undefined, status = 200): Result => { if (!r) throw new LimsError('common.version_conflict'); return { status, body: toCentre(r), version: r.version }; };

  async function setBranch(ctx: OrgCtx, input: { branchId?: unknown; expectedVersion?: unknown }, active: boolean): Promise<Result> {
    const s = scope(ctx); const v = expected(input?.expectedVersion); const id = idOf(input?.branchId);
    const cur = await loadBranch(s, id);
    if (cur.version !== v) throw new LimsError('common.version_conflict');
    if (!active && (await repo.countActiveCentres(s.tx, s.tenantId, id)) > 0) throw new LimsError('identity.centre_inactive', 'branch has active centres');
    return branchOut(await repo.setBranchActive(s.tx, s.tenantId, id, v, active, { actorId: s.actorId }));
  }
  async function setCentre(ctx: OrgCtx, input: { centreId?: unknown; expectedVersion?: unknown }, active: boolean): Promise<Result> {
    const s = scope(ctx); const v = expected(input?.expectedVersion); const id = idOf(input?.centreId);
    const cur = await loadCentre(s, id);
    if (cur.version !== v) throw new LimsError('common.version_conflict');
    if (active) await activeBranch(s, cur.branch_id);   // no active centre under an inactive branch: 409 centre_inactive (LD-64, CR .orchestra/cr/T15.md)
    return centreOut(await repo.setCentreActive(s.tx, s.tenantId, id, v, active, { actorId: s.actorId }));
  }

  return {
    async listBranches(ctx: OrgCtx, input: { isActive?: unknown } = {}): Promise<Result> {
      const s = scope(ctx); const isActive = boolOf(input?.isActive, '/is_active');
      const rows = await repo.listBranches(s.tx, s.tenantId, defined({ isActive }));
      return { status: 200, body: { data: rows.map(toBranch) } };
    },

    async createBranch(ctx: OrgCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const code = codeOf(input?.['code']); const name = str(input['name'], '/name', 120, true)!;
      const addressText = str(input['addressText'], '/address_text', 300); const phone = str(input['phone'], '/phone', 30);
      const isProcessingLab = boolOf(input['isProcessingLab'], '/is_processing_lab') ?? true;
      try {
        return branchOut(await repo.insertBranch(s.tx, s.tenantId, { id: uuidv7(), code, name, ...defined({ addressText, phone }), isProcessingLab, actorId: s.actorId }), 201);
      } catch (e) { if (isDup(e)) throw new LimsError('identity.code_duplicate'); throw e; }
    },

    async updateBranch(ctx: OrgCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx); const v = expected(input?.['expectedVersion']);
      const p = {
        ...defined({
          name: str(input['name'], '/name', 120), addressText: str(input['addressText'], '/address_text', 300), phone: str(input['phone'], '/phone', 30),
          isProcessingLab: boolOf(input['isProcessingLab'], '/is_processing_lab'),
        }),
        unset: unsetOf(input['unset']), actorId: s.actorId,
      };
      const id = idOf(input['branchId']);
      const cur = await loadBranch(s, id);
      if (cur.version !== v) throw new LimsError('common.version_conflict');
      return branchOut(await repo.updateBranch(s.tx, s.tenantId, id, v, p));
    },

    deactivateBranch: (ctx: OrgCtx, input: { branchId?: unknown; expectedVersion?: unknown }) => setBranch(ctx, input, false),
    reactivateBranch: (ctx: OrgCtx, input: { branchId?: unknown; expectedVersion?: unknown }) => setBranch(ctx, input, true),

    async listCentres(ctx: OrgCtx, input: { branchId?: unknown; kind?: unknown; isActive?: unknown } = {}): Promise<Result> {
      const s = scope(ctx);
      const f = defined({ branchId: uuidField(input?.branchId, '/branch_id', false), kind: kindOf(input?.kind, false), isActive: boolOf(input?.isActive, '/is_active') });
      const rows = await repo.listCentres(s.tx, s.tenantId, f);
      return { status: 200, body: { data: rows.map(toCentre) } };
    },

    async createCentre(ctx: OrgCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const code = codeOf(input?.['code']); const name = str(input['name'], '/name', 120, true)!;
      const branchId = uuidField(input['branchId'], '/branch_id', true)!; const kind = kindOf(input['kind'], true)!;
      const addressText = str(input['addressText'], '/address_text', 300); const phone = str(input['phone'], '/phone', 30);
      await activeBranch(s, branchId);
      try {
        return centreOut(await repo.insertCentre(s.tx, s.tenantId, { id: uuidv7(), code, name, branchId, kind, ...defined({ addressText, phone }), actorId: s.actorId }), 201);
      } catch (e) { if (isDup(e)) throw new LimsError('identity.code_duplicate'); throw e; }
    },

    async updateCentre(ctx: OrgCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx); const v = expected(input?.['expectedVersion']);
      const p = {
        ...defined({
          name: str(input['name'], '/name', 120), branchId: uuidField(input['branchId'], '/branch_id', false), kind: kindOf(input['kind'], false),
          addressText: str(input['addressText'], '/address_text', 300), phone: str(input['phone'], '/phone', 30),
        }),
        unset: unsetOf(input['unset']), actorId: s.actorId,
      };
      const id = idOf(input['centreId']);
      const cur = await loadCentre(s, id);
      if (cur.version !== v) throw new LimsError('common.version_conflict');
      if (p.branchId !== undefined && p.branchId !== cur.branch_id) await activeBranch(s, p.branchId);   // only a CHANGE of branch is checked
      return centreOut(await repo.updateCentre(s.tx, s.tenantId, id, v, p));
    },

    deactivateCentre: (ctx: OrgCtx, input: { centreId?: unknown; expectedVersion?: unknown }) => setCentre(ctx, input, false),
    reactivateCentre: (ctx: OrgCtx, input: { centreId?: unknown; expectedVersion?: unknown }) => setCentre(ctx, input, true),
  };
}
export type OrgService = ReturnType<typeof createOrgService>;
