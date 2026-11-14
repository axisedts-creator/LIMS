// C14 T11 repository emulators + world state + ctx builder (not a test file). Loaded by vi.mock factories, so it must NOT import the handlers or the service.
// Emulates what T02's repositories + the DB give the library lifecycle (05-SCHEMA §2-§5): tenant filter from rc.tenantId, column allow-lists, optimistic update
// (common.version_conflict | common.not_found), list = ACTIVE rows only unless includeInactive, unique indexes (23505), FKs (23503), CHECKs (23514),
// the draft-only trigger (P0001 'immutable_row'), the transition trigger ('invalid_transition') and the open/approved partial unique indexes.
// The transaction emulator only accepts `pg_advisory_xact_lock` statements through ctx.tx.query: every other read/write MUST go through a repository.
// Synthetic data only.
import { vi } from 'vitest';
import { createFakeCatalogPort } from '../../../../../../packages/fakes/src/CatalogPort.fake';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../packages/fakes/src/IdentityPort.fake';
import { TENANTS, actorIdFor, idFor } from '../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../core/errors.js';
import { GLOBAL_DENY, type LibInput } from './t10.fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 }); // handlers are imported cold; generous budget like the other probe suites

type Row = Record<string, any>;
export const SEED = 1;
export const TA = TENANTS.A;
export const TB = TENANTS.B;
export const uid = (n: number): string => `01900000-7200-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const T0 = new Date('2026-11-01T00:00:00.000Z');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 05-SCHEMA §2.1 defaults are not needed exactly; these satisfy every range of LibraryParams (02-TRD §5.1). */
export const PARAMS = {
  score_enabled: true, credit_in_range_bp: 10000, credit_borderline_bp: 7500, credit_out_of_range_bp: 2500, credit_critical_bp: 0, min_groups_scored: 2,
  band_good_min: 80, band_fair_min: 60, critical_forces_needs_attention: true, borderline_fraction_bp: 1000, min_mapped_results: 3, trend_enabled: true,
  trend_max_points: 4, trend_lookback_days: 365, trend_stable_bp: 500, trends_max: 3, advice_max_blocks: 5, followup_max: 3,
};
export const ANALYTE = { a1: uid(0x901), a2: uid(0x902), b1: uid(0x950) };   // a1/a2 belong to tenant A, b1 to tenant B
export const VER = (n: number): string => uid(0x100 + n);                     // tenant A versions
export const VERB = uid(0x1b1);                                               // tenant B draft

export const world = {
  versions: [] as Row[], blocks: [] as Row[], rules: [] as Row[], mappings: [] as Row[], groupSettings: [] as Row[], reviews: [] as Row[], summaries: [] as Row[],
  tenantTerms: [] as Row[], globalTerms: [] as Row[], organGroups: [] as Row[], analytes: { A: new Set<string>(), B: new Set<string>() },
  calls: [] as { fn: string; tenantId?: string; args: unknown[] }[], writes: [] as string[], coreCalls: [] as { fn: string; input: any; tenantId: string }[],
  seq: 0,
  /** reverseLists: lists come back in the opposite order (hash must not depend on row order). raceOpenInsert: the open-draft unique index fires although the pre-check passed. */
  opts: { reverseLists: false, raceOpenInsert: false },
};
export const callsOf = (...fns: string[]) => world.calls.filter((c) => fns.includes(c.fn));
export const writesOf = (re: RegExp) => world.writes.filter((w) => re.test(w));

interface Rc { tenantId: string; actorId: string }
const note = (fn: string, rc: Rc | undefined, ...args: unknown[]) => world.calls.push({ fn, ...(rc ? { tenantId: rc.tenantId } : {}), args });
const pgErr = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const mine = (rows: Row[], rc: Rc) => rows.filter((r) => r.tenant_id === rc.tenantId);
const act = (rows: Row[], o?: { includeInactive?: boolean }) => rows.filter((r) => o?.includeInactive === true || r.is_active);
const out = (rows: Row[]): Row[] => (world.opts.reverseLists ? [...rows].reverse() : rows).map((r) => ({ ...r }));
const cols = (s: string): string[] => s.split(/\s+/);
const without = (a: string[], ...x: string[]) => a.filter((c) => !x.includes(c));

const LIFECYCLE = cols('status submitted_at submitted_by_membership_id approved_at approved_by_membership_id approval_note returned_at returned_by_membership_id return_comment retired_at');
const LIB_INS = cols(`id version_no language formula_version score_enabled credit_in_range_bp credit_borderline_bp credit_out_of_range_bp credit_critical_bp
  min_groups_scored band_good_min band_fair_min critical_forces_needs_attention borderline_fraction_bp min_mapped_results trend_enabled trend_max_points
  trend_lookback_days trend_stable_bp trends_max advice_max_blocks followup_max source_version_id change_summary content_sha256 is_active`);
const LIB_UPD = without([...LIB_INS, ...LIFECYCLE], 'id', 'version_no', 'source_version_id');
const BLOCK_INS = cols('id library_version_id block_key kind text_en text_ne note is_active');
const RULE_INS = cols('id library_version_id rule_kind trigger_kind analyte_id group_code direction min_severity priority block_id block_kind suggested_test_id interval_days is_active');
const MAP_INS = cols('id library_version_id analyte_id group_code include_in_score trend_enabled borderline_fraction_bp trend_stable_bp sort_order is_active');
const GRP_INS = cols('id library_version_id group_code display_en display_ne score_weight sort_order is_shown is_active');
const REVIEW_INS = cols('id library_version_id action comment content_sha256 actor_membership_id');

const OPEN = ['draft', 'in_review'];
const ALLOWED_NEXT: Record<string, string[]> = { draft: ['in_review'], in_review: ['draft', 'approved'], approved: ['retired'], retired: [] };

function insert(name: string, table: Row[], allow: string[], rc: Rc, row: Row, defaults: Row, check: (r: Row) => void): Row {
  world.writes.push(name); note(name, rc, row);
  const bad = Object.keys(row).filter((k) => !allow.includes(k));
  if (bad.length) throw new Error(`${name}: column(s) not allowed: ${bad.join(', ')}`);
  const given = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  const r: Row = { id: uid(0x9000 + ++world.seq), ...defaults, ...given, tenant_id: rc.tenantId, version: 1, created_at: T0, created_by: rc.actorId, updated_at: T0, updated_by: rc.actorId };
  check(r); table.push(r); return { ...r };
}
function update(name: string, table: Row[], allow: string[], rc: Rc, id: string, expected: number, patch: Row, check: (before: Row, after: Row) => void): Row {
  world.writes.push(name); note(name, rc, id, expected, patch);
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const bad = keys.filter((k) => !allow.includes(k));
  if (bad.length) throw new Error(`${name}: column(s) not allowed: ${bad.join(', ')}`);
  if (keys.length === 0) throw new Error(`${name}: empty patch`);
  const r = table.find((x) => x.tenant_id === rc.tenantId && x.id === id);
  if (!r) throw new LimsError('common.not_found');
  if (r.version !== expected) throw new LimsError('common.version_conflict');
  const next: Row = { ...r, ...Object.fromEntries(keys.map((k) => [k, patch[k]])), version: r.version + 1, updated_at: T0, updated_by: rc.actorId };
  check(r, next); Object.assign(r, next); return { ...r };
}
const parentDraft = (rc: Rc, lv: string): void => {
  const p = world.versions.find((v) => v.tenant_id === rc.tenantId && v.id === lv);
  if (!p) throw pgErr('23503', 'library fk');
  if (p.status !== 'draft') throw pgErr('P0001', 'immutable_row');          // 05-SCHEMA §4: child edit when the parent is not draft
};
const parentOfRow = (rc: Rc, r: Row): void => parentDraft(rc, r.library_version_id);

export const libraryRepoFake = {
  insertLibraryVersion: vi.fn(async (rc: Rc, row: Row) => insert('insertLibraryVersion', world.versions, LIB_INS, rc, row,
    { status: 'draft', language: 'en', formula_version: 'hs-1', ...PARAMS, source_version_id: null, change_summary: null, content_sha256: null, submitted_at: null,
      submitted_by_membership_id: null, approved_at: null, approved_by_membership_id: null, approval_note: null, returned_at: null, returned_by_membership_id: null,
      return_comment: null, retired_at: null, is_active: true },
    (r) => {
      if (world.versions.some((v) => v.tenant_id === r.tenant_id && v.version_no === r.version_no)) throw pgErr('23505', 'library_versions__tenant_id_version_no__uq');
      if (world.opts.raceOpenInsert || world.versions.some((v) => v.tenant_id === r.tenant_id && OPEN.includes(v.status))) throw pgErr('23505', 'library_versions__tenant_id__open__p_uq');
    })),
  getLibraryVersion: vi.fn(async (rc: Rc, id: string) => { note('getLibraryVersion', rc, id); const r = mine(world.versions, rc).find((v) => v.id === id); return r ? { ...r } : null; }),
  updateLibraryVersion: vi.fn(async (rc: Rc, id: string, expected: number, patch: Row) => update('updateLibraryVersion', world.versions, LIB_UPD, rc, id, expected, patch, (before, after) => {
    if (before.status !== 'draft' && Object.keys(patch).some((k) => !LIFECYCLE.includes(k))) throw pgErr('P0001', 'immutable_row');   // content frozen outside draft
    if (after.status !== before.status && !ALLOWED_NEXT[before.status]!.includes(after.status)) throw pgErr('P0001', 'invalid_transition');
    if (after.status !== 'draft' && !/^[0-9a-f]{64}$/.test(String(after.content_sha256))) throw pgErr('23514', 'library_versions__hash__ck');
    if (['approved', 'retired'].includes(after.status) && (after.approved_at == null || after.approved_by_membership_id == null)) throw pgErr('23514', 'library_versions__approved_fields__ck');
    if (after.status === 'retired' && after.retired_at == null) throw pgErr('23514', 'library_versions__retired_fields__ck');
    if (after.status === 'approved' && world.versions.some((v) => v.tenant_id === rc.tenantId && v.id !== id && v.status === 'approved')) throw pgErr('23505', 'library_versions__tenant_id__approved__p_uq');
    if (after.status === 'draft' && before.status !== 'draft' && world.versions.some((v) => v.tenant_id === rc.tenantId && v.id !== id && OPEN.includes(v.status))) throw pgErr('23505', 'open');
  })),
  getOpenLibraryVersion: vi.fn(async (rc: Rc) => { note('getOpenLibraryVersion', rc); const r = mine(world.versions, rc).find((v) => OPEN.includes(v.status)); return r ? { ...r } : null; }),
  getApprovedLibraryVersion: vi.fn(async (rc: Rc) => { note('getApprovedLibraryVersion', rc); const r = mine(world.versions, rc).find((v) => v.status === 'approved'); return r ? { ...r } : null; }),
  listLibraryVersions: vi.fn(async (rc: Rc, o?: { limit: number }) => {
    note('listLibraryVersions', rc, o);
    return mine(world.versions, rc).sort((a, b) => b.version_no - a.version_no).slice(0, o?.limit ?? 1000).map((r) => ({ ...r }));
  }),
};

export const blocksRepoFake = {
  insertBlock: vi.fn(async (rc: Rc, row: Row) => insert('insertBlock', world.blocks, BLOCK_INS, rc, row, { text_en: null, text_ne: null, note: null, is_active: true }, (r) => {
    parentOfRow(rc, r);
    if (world.blocks.some((b) => b.tenant_id === r.tenant_id && b.library_version_id === r.library_version_id && b.block_key === r.block_key && b.is_active && r.is_active)) throw pgErr('23505', 'template_blocks__tenant_id_lib_key__p_uq');
    if (r.text_en == null && r.text_ne == null) throw pgErr('23514', 'template_blocks__text__ck');
    if ([r.text_en, r.text_ne].some((t) => t != null && [...t].length > 600) || (r.note != null && [...r.note].length > 500)) throw pgErr('23514', 'template_blocks__text__ck');
  })),
  getBlock: vi.fn(async (rc: Rc, id: string) => { note('getBlock', rc, id); const r = mine(world.blocks, rc).find((b) => b.id === id); return r ? { ...r } : null; }),
  updateBlock: vi.fn(async (rc: Rc, id: string, expected: number, patch: Row) => update('updateBlock', world.blocks, without(BLOCK_INS, 'id', 'library_version_id'), rc, id, expected, patch, (before, after) => {
    parentOfRow(rc, before);
    if (after.is_active && world.blocks.some((b) => b.id !== id && b.tenant_id === rc.tenantId && b.library_version_id === before.library_version_id && b.block_key === after.block_key && b.is_active)) throw pgErr('23505', 'template_blocks__tenant_id_lib_key__p_uq');
    if (after.text_en == null && after.text_ne == null) throw pgErr('23514', 'template_blocks__text__ck');
  })),
  listBlocks: vi.fn(async (rc: Rc, lv: string, o?: { includeInactive?: boolean }) => {
    note('listBlocks', rc, lv, o);
    return out(act(mine(world.blocks, rc).filter((b) => b.library_version_id === lv), o).sort((a, b) => a.block_key.localeCompare(b.block_key)));
  }),
};

const ruleChecks = (r: Row, rc: Rc): void => {
  parentOfRow(rc, r);
  const blk = world.blocks.find((b) => b.tenant_id === rc.tenantId && b.library_version_id === r.library_version_id && b.id === r.block_id && b.kind === r.block_kind);
  if (!blk) throw pgErr('23503', 'rules__block__fk');
  if (r.block_kind !== r.rule_kind) throw pgErr('23514', 'rules__kind__ck');
  const has = (k: string) => r[k] !== null && r[k] !== undefined;
  const okTrigger = (r.trigger_kind === 'analyte' && has('analyte_id') && !has('group_code') && has('min_severity'))
    || (r.trigger_kind === 'group' && has('group_code') && !has('analyte_id') && has('min_severity'))
    || (r.trigger_kind === 'any' && !has('analyte_id') && !has('group_code') && has('min_severity'))
    || (r.trigger_kind === 'all_in_range' && !has('analyte_id') && !has('group_code') && !has('min_severity') && r.direction === 'any' && r.rule_kind === 'advice');
  if (!okTrigger) throw pgErr('23514', 'rules__trigger_fields__ck');
  const okFollow = (r.rule_kind === 'followup' && has('suggested_test_id') && Number.isInteger(r.interval_days) && r.interval_days >= 1 && r.interval_days <= 730)
    || (r.rule_kind !== 'followup' && !has('suggested_test_id') && !has('interval_days'));
  if (!okFollow) throw pgErr('23514', 'rules__followup_fields__ck');
  if (has('analyte_id') && !world.analytes[rc.tenantId === TA ? 'A' : 'B'].has(r.analyte_id)) throw pgErr('23503', 'rules__analyte__fk');
};
export const rulesRepoFake = {
  insertRule: vi.fn(async (rc: Rc, row: Row) => insert('insertRule', world.rules, RULE_INS, rc, row,
    { analyte_id: null, group_code: null, min_severity: null, suggested_test_id: null, interval_days: null, is_active: true }, (r) => ruleChecks(r, rc))),
  getRule: vi.fn(async (rc: Rc, id: string) => { note('getRule', rc, id); const r = mine(world.rules, rc).find((b) => b.id === id); return r ? { ...r } : null; }),
  updateRule: vi.fn(async (rc: Rc, id: string, expected: number, patch: Row) => update('updateRule', world.rules, without(RULE_INS, 'id', 'library_version_id'), rc, id, expected, patch, (before, after) => {
    if (after.is_active === false && before.is_active === true && Object.keys(patch).length === 1) { parentOfRow(rc, before); return; }   // deactivation: no re-check of the combination
    ruleChecks(after, rc);
  })),
  listRules: vi.fn(async (rc: Rc, lv: string, o?: { includeInactive?: boolean }) => {
    note('listRules', rc, lv, o);
    return out(act(mine(world.rules, rc).filter((r) => r.library_version_id === lv), o).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)));
  }),
  listRulesByKind: vi.fn(async (rc: Rc, lv: string, kind: string, o?: { includeInactive?: boolean }) => {
    note('listRulesByKind', rc, lv, kind, o);
    return out(act(mine(world.rules, rc).filter((r) => r.library_version_id === lv && r.rule_kind === kind), o).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)));
  }),
};

export const mappingsRepoFake = {
  insertMapping: vi.fn(async (rc: Rc, row: Row) => insert('insertMapping', world.mappings, MAP_INS, rc, row,
    { include_in_score: true, trend_enabled: false, borderline_fraction_bp: null, trend_stable_bp: null, sort_order: 100, is_active: true }, (r) => {
      parentOfRow(rc, r);
      if (!world.analytes[rc.tenantId === TA ? 'A' : 'B'].has(r.analyte_id)) throw pgErr('23503', 'analyte_groups__analyte__fk');      // composite FK to catalog.analytes (tenant_id, id)
      if (!world.organGroups.some((g) => g.code === r.group_code)) throw pgErr('23503', 'analyte_groups__group__fk');
      if (world.mappings.some((m) => m.tenant_id === r.tenant_id && m.library_version_id === r.library_version_id && m.analyte_id === r.analyte_id && m.is_active && r.is_active)) throw pgErr('23505', 'analyte_groups__tenant_id_lib_analyte__p_uq');
    })),
  getMapping: vi.fn(async (rc: Rc, id: string) => { note('getMapping', rc, id); const r = mine(world.mappings, rc).find((b) => b.id === id); return r ? { ...r } : null; }),
  updateMapping: vi.fn(async (rc: Rc, id: string, expected: number, patch: Row) => update('updateMapping', world.mappings, without(MAP_INS, 'id', 'library_version_id', 'analyte_id'), rc, id, expected, patch, (before, after) => {
    parentOfRow(rc, before);
    if (!world.organGroups.some((g) => g.code === after.group_code)) throw pgErr('23503', 'analyte_groups__group__fk');
  })),
  listMappings: vi.fn(async (rc: Rc, lv: string, o?: { includeInactive?: boolean }) => {
    note('listMappings', rc, lv, o);
    return out(act(mine(world.mappings, rc).filter((r) => r.library_version_id === lv), o).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)));
  }),
};

export const groupsRepoFake = {
  insertGroupSetting: vi.fn(async (rc: Rc, row: Row) => insert('insertGroupSetting', world.groupSettings, GRP_INS, rc, row, { display_ne: null, score_weight: 1, sort_order: 100, is_shown: true, is_active: true }, (r) => {
    parentOfRow(rc, r);
    if (world.groupSettings.some((g) => g.tenant_id === r.tenant_id && g.library_version_id === r.library_version_id && g.group_code === r.group_code)) throw pgErr('23505', 'group_settings__tenant_id_lib_group__uq');
  })),
  getGroupSetting: vi.fn(async (rc: Rc, id: string) => { note('getGroupSetting', rc, id); const r = mine(world.groupSettings, rc).find((b) => b.id === id); return r ? { ...r } : null; }),
  updateGroupSetting: vi.fn(async (rc: Rc, id: string, expected: number, patch: Row) => update('updateGroupSetting', world.groupSettings, without(GRP_INS, 'id', 'library_version_id', 'group_code'), rc, id, expected, patch, (before) => parentOfRow(rc, before))),
  listGroupSettings: vi.fn(async (rc: Rc, lv: string, o?: { includeInactive?: boolean }) => {
    note('listGroupSettings', rc, lv, o);
    return out(act(mine(world.groupSettings, rc).filter((r) => r.library_version_id === lv), o).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)));
  }),
};

export const reviewsRepoFake = {
  insertLibraryReview: vi.fn(async (rc: Rc, row: Row) => {
    const r = insert('insertLibraryReview', world.reviews, REVIEW_INS, rc, row, { comment: null, content_sha256: null, actor_membership_id: null }, (x) => {
      if (!['submitted', 'returned', 'approved', 'retired'].includes(x.action)) throw pgErr('23514', 'library_reviews__action__ck');
      if (x.comment != null && [...x.comment].length > 1000) throw pgErr('23514', 'library_reviews__comment__ck');
    });
    world.reviews[world.reviews.length - 1]!.seq = ++world.seq; return r;
  }),
  listLibraryReviews: vi.fn(async (rc: Rc, lv: string) => { note('listLibraryReviews', rc, lv); return mine(world.reviews, rc).filter((r) => r.library_version_id === lv).map((r) => ({ ...r })); }),
  insertSummaryReview: vi.fn(async () => { throw new Error('library lifecycle must not touch summary_reviews'); }),
  listSummaryReviews: vi.fn(async () => { throw new Error('library lifecycle must not touch summary_reviews'); }),
};

export const codedSetsRepoFake = {
  listOrganGroups: vi.fn(async (rc: Rc) => { note('listOrganGroups', rc); return world.organGroups.filter((r) => r.is_active).sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code)).map((r) => ({ ...r })); }),
  listRejectReasons: vi.fn(async () => []),
};
export const denyTermsRepoFake = {
  listDenyTerms: vi.fn(async (rc: Rc, o?: { includeInactive?: boolean }) => { note('listDenyTerms', rc, o); return out(act(mine(world.tenantTerms, rc), o)); }),
  listGlobalDenyTerms: vi.fn(async (rc: Rc) => { note('listGlobalDenyTerms', rc); return world.globalTerms.filter((t) => t.is_active).map((r) => ({ ...r })); }),
  getDenyTerm: vi.fn(async () => null),
  insertDenyTerm: vi.fn(async () => { throw new Error('library lifecycle must not write deny terms'); }),
  updateDenyTerm: vi.fn(async () => { throw new Error('library lifecycle must not write deny terms'); }),
};

// ---------------------------------------------------------------- fixtures
export const ORGAN_GROUPS: [string, string, number][] = [['blood_counts', 'Blood counts', 10], ['glucose', 'Blood sugar', 20], ['lipids', 'Cholesterol and lipids', 30],
  ['liver', 'Liver', 40], ['kidney', 'Kidney', 50], ['electrolytes', 'Electrolytes', 60], ['thyroid', 'Thyroid', 70], ['iron', 'Iron studies', 80], ['vitamins', 'Vitamins', 90],
  ['inflammation', 'Inflammation', 100], ['hormones', 'Hormones', 110], ['immunology', 'Immunology and serology', 120], ['urine', 'Urine examination', 130],
  ['stool', 'Stool examination', 140], ['vitals', 'Body measurements', 150], ['other', 'Other', 900]];

export function seed(): void {
  world.versions = []; world.blocks = []; world.rules = []; world.mappings = []; world.groupSettings = []; world.reviews = []; world.summaries = [];
  world.calls = []; world.writes = []; world.coreCalls = []; world.seq = 0; world.opts.reverseLists = false; world.opts.raceOpenInsert = false;
  world.organGroups = [{ code: 'retired_group', display: 'Retired', sort_order: 1, is_active: false }, ...ORGAN_GROUPS.map(([code, display, sort_order]) => ({ code, display, sort_order, is_active: true }))];
  world.analytes = { A: new Set([ANALYTE.a1, ANALYTE.a2]), B: new Set([ANALYTE.b1]) };
  world.tenantTerms = [];
  world.globalTerms = GLOBAL_DENY.map((t) => ({ tenant_id: null, term: t, term_folded: t.toLocaleLowerCase('und'), language: 'any', is_active: true }));
}

export const versionRow = (tenantId: string, id: string, o: Row = {}): Row => ({
  id, tenant_id: tenantId, version_no: 1, status: 'draft', language: 'en', formula_version: 'hs-1', ...PARAMS, source_version_id: null, change_summary: null, content_sha256: null,
  submitted_at: null, submitted_by_membership_id: null, approved_at: null, approved_by_membership_id: null, approval_note: null, returned_at: null, returned_by_membership_id: null,
  return_comment: null, retired_at: null, is_active: true, version: 1, created_at: T0, created_by: actorIdFor('A', 'user', 'pathologist'), updated_at: T0, updated_by: actorIdFor('A', 'user', 'pathologist'), ...o,
});
const child = (tenantId: string, versionId: string, o: Row): Row => ({ tenant_id: tenantId, library_version_id: versionId, is_active: true, version: 1, created_at: T0, created_by: actorIdFor('A', 'user', 'pathologist'), updated_at: T0, updated_by: actorIdFor('A', 'user', 'pathologist'), ...o });

/** Same library with fresh ids (two versions of one tenant must not share row ids). */
export function reid(lib: LibInput, salt: number): LibInput {
  const m = new Map<string, string>(); let n = 0;
  const f = (id: string): string => { if (!m.has(id)) m.set(id, uid(salt * 0x100 + n++)); return m.get(id)!; };
  return { ...lib, blocks: lib.blocks.map((b) => ({ ...b, id: f(b.id) })), rules: lib.rules.map((r) => ({ ...r, id: f(r.id), blockId: f(r.blockId) })), mappings: lib.mappings.map((x) => ({ ...x, id: f(x.id) })) };
}

/** Puts a version + its children (from a T10 LibInput, fixed ids) into the world. `groups` also adds one group setting per organ group. */
export function loadLibrary(tenantId: string, versionId: string, lib: LibInput, o: Row & { groups?: boolean } = {}): void {
  const { groups, ...extra } = o;
  world.versions.push(versionRow(tenantId, versionId, { language: lib.language, score_enabled: lib.scoreEnabled, ...extra }));
  for (const b of lib.blocks) world.blocks.push(child(tenantId, versionId, { id: b.id, block_key: b.blockKey, kind: b.kind, text_en: b.textEn ?? null, text_ne: b.textNe ?? null, note: null }));
  for (const r of lib.rules) world.rules.push(child(tenantId, versionId, { id: r.id, rule_kind: r.ruleKind, trigger_kind: r.triggerKind, analyte_id: r.analyteId ?? null, group_code: r.groupCode ?? null,
    direction: r.direction, min_severity: r.minSeverity ?? null, priority: r.priority, block_id: r.blockId, block_kind: r.blockKind, suggested_test_id: r.suggestedTestId ?? null, interval_days: r.intervalDays ?? null }));
  for (const m of lib.mappings) world.mappings.push(child(tenantId, versionId, { id: m.id, analyte_id: m.analyteId, group_code: m.groupCode, include_in_score: true, trend_enabled: false, borderline_fraction_bp: null, trend_stable_bp: null, sort_order: 100 }));
  if (groups) for (const g of world.organGroups.filter((x) => x.is_active)) world.groupSettings.push(child(tenantId, versionId, { id: uid(0x7000 + world.groupSettings.length), group_code: g.code, display_en: g.display, display_ne: null, score_weight: 1, sort_order: g.sort_order, is_shown: true }));
}

// ---------------------------------------------------------------- transaction rollback emulation (the core rolls the request transaction back when a handler throws)
export const snapshot = (): string => JSON.stringify({ v: world.versions, b: world.blocks, r: world.rules, m: world.mappings, g: world.groupSettings, rv: world.reviews, s: world.summaries });
export function restore(s: string): void {
  const revive = (rows: Row[]): Row[] => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && /_at$/.test(k) ? new Date(v) : v])));
  const d = JSON.parse(s);
  world.versions = revive(d.v); world.blocks = revive(d.b); world.rules = revive(d.r); world.mappings = revive(d.m); world.groupSettings = revive(d.g); world.reviews = revive(d.rv); world.summaries = revive(d.s);
}

// ---------------------------------------------------------------- personas, ctx
export type Persona = 'pathologist' | 'pathologist_aal1' | 'lab_manager' | 'front_desk' | 'lab_technologist' | 'revoked_pathologist' | 'ghost';
const PERSONAS: [Persona, string[], Partial<MembershipRow>][] = [
  ['pathologist', ['pathologist'], {}], ['pathologist_aal1', ['pathologist'], { mfaLevel: 'aal1' }], ['lab_manager', ['lab_manager'], {}],
  ['front_desk', ['front_desk'], { centreScope: { all: false, centreIds: [idFor(SEED, 0xc1)] } }], ['lab_technologist', ['lab_technologist'], {}],
  ['revoked_pathologist', ['pathologist'], { status: 'deactivated' }],
];
export const MID: Record<'A' | 'B', Record<string, string>> = { A: {}, B: {} };
const MEMBERS: MembershipRow[] = [];
{
  let n = 0x7500;
  for (const [tenantId, key] of [[TA, 'A'], [TB, 'B']] as const) for (const [persona, roles, o] of PERSONAS) {
    const id = idFor(SEED, n++); MID[key][persona] = id;
    MEMBERS.push({ id, tenantId, actorId: actorIdFor(key, 'user', persona), actorType: 'user', displayName: `Test ${key}-${persona}`, roles, centreScope: { all: true, centreIds: [] }, branchIds: [],
      mfaLevel: 'aal2', isLocked: false, status: 'active', email: `${persona}.${key}@example.com`, version: 1, ...o });
  }
}
export const nameOf = (tenant: 'A' | 'B', persona: Persona): string => `Test ${tenant}-${persona}`;

export function makeCtx(persona: Persona, operationId: string, tenant: 'A' | 'B' = 'A', o: { names?: boolean } = {}) {
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: MEMBERS.map((m) => ({ ...m })) } }) as any;
  const asserted: { permission: string; centreId?: string }[] = [];
  const orig = identity.assertRole.bind(identity);
  identity.assertRole = async (c: unknown, r: { permission: string; centreId?: string }) => { asserted.push(r); note('assertRole', undefined, r.permission); return orig(c, r); };
  const tenantId = tenant === 'A' ? TA : TB;
  const base: any = makeCtxFor()(`${tenant}:user:${persona}`);
  const tx: any = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (/pg_advisory_xact_lock/i.test(String(text))) { world.calls.push({ fn: 'lock', tenantId, args: [String(text), values ?? []] }); return { rows: [] }; }
      throw new Error('handlers/services must reach the database only through the repositories (and the advisory lock)');
    }),
    async savepoint(fn: (t: unknown) => Promise<unknown>) { return fn(tx); },
  };
  const ctx: any = {
    ...base, operationId, clientIp: '127.0.0.1', tx,
    actor: { ...base.actor, ...(MID[tenant][persona] ? { membershipId: MID[tenant][persona] } : {}) },
    ports: { IdentityPort: identity, CatalogPort: createFakeCatalogPort({ seed: SEED }) },
    core: {
      memberships: {
        list: vi.fn(async (_c: unknown, input: { membershipIds?: string[]; activeOnly?: boolean }) => {
          world.coreCalls.push({ fn: 'memberships.list', input, tenantId });
          if (o.names === false) return [];
          return MEMBERS.filter((m) => m.tenantId === tenantId && (input.membershipIds ?? []).includes(m.id)).map((m) => ({ membershipId: m.id, displayName: m.displayName }));
        }),
      },
    },
    commitOnError: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, metrics: { inc: vi.fn() },
  };
  return { ctx, asserted };
}
export { LimsError };
