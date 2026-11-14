// C6-T18 test helpers (not a test file). Synthetic data only. Builds on outsourced.helpers.ts: its fake tx now models reporting.report_templates and
// reporting.report_template_versions, including the two partial unique indexes (one draft / one published per template -> 23505) and the
// app.enforce_mutable_columns trigger on non-draft versions (only status/updated_at/updated_by/version may change -> P0001).
// Same modelling limits as the other fakes: `col = $n` / `col = 'lit'` filters, VALUES inserts, `SET col = $n | version + 1 | COALESCE($n, col) | now()` updates;
// NO joins, `= ANY($n)`, ORDER BY or aggregates: the implementation looks rows up by (tenant_id, id) / (tenant_id, template_id) and sorts in JS.
import { createHash } from 'node:crypto';
import { DEFAULT_TEMPLATE_CONFIG } from '../domain/templates.js';
import { MEM, NOW, REPORT_1, TENANT_A, TENANT_B, USER, idN, makeApiCtx, makeDb, makeStorage, type FakeDb, type Row, type Seed } from './outsourced.helpers.js';

export { MEM, NOW, REPORT_1, TENANT_A, TENANT_B, USER, idN };
export const TPL_PUB = idN(0x8101);        // tenant A, laboratory: published v1, no draft
export const TPL_DRAFT = idN(0x8102);      // tenant A, laboratory: draft v1 only (never published)
export const TPL_BOTH = idN(0x8103);       // tenant A, laboratory: v1 published + v2 draft
export const TPL_NARR = idN(0x8104);       // tenant A, narrative family: published v1
export const TPL_BAD_DRAFT = idN(0x8105);  // tenant A: published v1 + a v2 draft whose stored config is INVALID (disclaimer > 200)
export const TPL_B = idN(0x81b1);          // tenant B: draft v1 + published? (draft only)
export const TPL_NONE = idN(0x81ff);       // exists nowhere
export const V = (tpl: number, no: number) => idN(0x9000 + tpl * 0x10 + no);   // version row id: V(1,2) = template 0x8101, version_no 2

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
/** A schema-valid config differing from the default in one visible way. */
export const cfg = (tag = 'A', over: Record<string, unknown> = {}): any => ({ ...structuredClone(DEFAULT_TEMPLATE_CONFIG), disclaimers: [`Synthetic disclaimer ${tag}`], ...over });
/** Mutable deep copy of a valid config for building invalid variants. */
export const base = (): any => structuredClone(cfg('base'));

export function tplRow(id: string, o: Row = {}): Row {
  return { tenant_id: TENANT_A, id, family: 'laboratory', name: `Synthetic template ${id.slice(-4)}`, current_version_id: null, is_default: false, version: 1, is_active: true, created_by: USER, updated_by: USER, ...o };
}
export function verRow(tpl: string, tplNo: number, no: number, status: 'draft' | 'published' | 'retired', config: any, o: Row = {}): Row {
  return {
    tenant_id: TENANT_A, id: V(tplNo, no), template_id: tpl, version_no: no, status, config, config_sha256: sha256hex(JSON.stringify(config)), version: 1, is_active: true,
    published_at: status === 'draft' ? null : '2026-11-01T08:00:00.000Z', published_by: status === 'draft' ? null : USER, created_by: USER, updated_by: USER, ...o,
  };
}
export const CFG_V1 = cfg('v1');
export const CFG_V2 = cfg('v2');
export const CFG_BAD = { ...cfg('bad'), disclaimers: ['x'.repeat(201)] };

export function seedAll(extra: Seed = {}): Seed {
  return {
    report_templates: [
      tplRow(TPL_PUB, { name: 'Published only', current_version_id: V(1, 1), version: 2 }),
      tplRow(TPL_DRAFT, { name: 'Draft only', version: 1 }),
      tplRow(TPL_BOTH, { name: 'Published and draft', current_version_id: V(3, 1), version: 4 }),
      tplRow(TPL_NARR, { name: 'Narrative layout', family: 'narrative', current_version_id: V(4, 1), version: 2 }),
      tplRow(TPL_BAD_DRAFT, { name: 'Bad draft', current_version_id: V(5, 1), version: 3 }),
      tplRow(TPL_B, { tenant_id: TENANT_B, name: 'Tenant B template', version: 1 }),
    ],
    report_template_versions: [
      verRow(TPL_PUB, 1, 1, 'published', CFG_V1, { version: 1 }),
      verRow(TPL_DRAFT, 2, 1, 'draft', CFG_V1),
      verRow(TPL_BOTH, 3, 1, 'published', CFG_V1),
      verRow(TPL_BOTH, 3, 2, 'draft', CFG_V2, { version: 3 }),
      verRow(TPL_NARR, 4, 1, 'published', CFG_V1),
      verRow(TPL_BAD_DRAFT, 5, 1, 'published', CFG_V1),
      verRow(TPL_BAD_DRAFT, 5, 2, 'draft', CFG_BAD),
      { ...verRow(TPL_B, 0x1b, 1, 'draft', CFG_V1), tenant_id: TENANT_B, template_id: TPL_B, id: idN(0x9b01) },
    ],
    ...extra,
  };
}

export function env(operationId: string, manifest: any, seed: Seed = seedAll(), over: Record<string, unknown> = {}) {
  const db = makeDb(seed); const storage = makeStorage();
  const c = makeApiCtx(db, storage, over);
  const noop = { info() {}, warn() {}, error() {} };
  return { db, storage, ...c, hctx: { ...c.ctx, operationId, clientIp: '203.0.113.9', log: noop, manifest } };
}
export const ifm = (v: unknown) => ({ 'if-match': `"${v}"` });
export const tplRows = (db: FakeDb) => db.store['report_templates']!;
export const verRows = (db: FakeDb, tpl?: string) => db.store['report_template_versions']!.filter((v) => tpl === undefined || v['template_id'] === tpl).sort((a, b) => a['version_no'] - b['version_no']);
export const tplOf = (db: FakeDb, id: string) => tplRows(db).find((t) => t['id'] === id)!;
export const verOf = (db: FakeDb, tpl: string, no: number) => verRows(db, tpl).find((v) => v['version_no'] === no);
export const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
/** jsonb as bound by the repo: an object or a JSON string. */
export const storedConfig = (r: Row): any => asJson(r['config']);
