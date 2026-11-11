// #5-#8 template blocks, #9-#12 rules, #13-#15 analyte -> organ group mappings, #16-#17 group settings of a library version (02-TRD §5; 03-APP-FLOW §1.1 L2, §2.1 step 2; 05-SCHEMA §3.7).
// Reads work on any status; every write needs a DRAFT parent (service check first, DB trigger as backstop), bumps the parent version, and removals deactivate (never DELETE, 08 A17 P-18(a)).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Handler } from '../../../core/module.js';
import { assertEditable, type LibraryStatus } from '../domain/library.state.js';
import { checkVersion, isUuid, loadVersion, touchParent } from '../library.service.js';
import { blockDto, groupSettingDto, mappingDto, ruleDto } from '../mappers/library.dto.js';
import * as blocksRepo from '../repository/blocks.repo.js';
import * as codedSetsRepo from '../repository/codedSets.repo.js';
import type { RepoCtx, Row } from '../repository/common.repo.js';
import * as groupsRepo from '../repository/groups.repo.js';
import * as mappingsRepo from '../repository/mappings.repo.js';
import * as rulesRepo from '../repository/rules.repo.js';
import { fieldError, ifMatch, mapped, nfc, param, parseBody, query, type Schema, validationFailed } from './libraryInput.js';
import { authorise, invalidField, type SrCtx } from './shared.js';

const MANAGE = 'smartreport.template.manage';
const KINDS = ['deranged', 'advice', 'followup', 'disclaimer', 'score_explanation'];
const GROUP_CODE = /^[a-z][a-z0-9_]{0,99}$/;
const rcOf = async (ctx: unknown): Promise<RepoCtx> => authorise(ctx as SrCtx, MANAGE);
const notFound = (): LimsError => new LimsError('common.not_found');
const invalid = (path: string, message: string): LimsError => new LimsError('smartreport.library_invalid', undefined, [fieldError(path, 'common.field_invalid', message)]);
/** The child row must exist for this tenant, belong to this version and be active (a removed row is gone). */
const mine = (row: Row | null, versionId: string): Row => { if (!row || row.library_version_id !== versionId || row.is_active !== true) throw notFound(); return row; };
const writable = async (rc: RepoCtx, req: { params: unknown }): Promise<Row> => {
  const v = await loadVersion(rc, param(req, 'library_version_id'));
  assertEditable(v.status as LibraryStatus);
  return v;
};
const noContent = { status: 204 } as const;

// ---------------------------------------------------------------- blocks
const BLOCK: Schema = {
  block_key: { t: 'str', max: 80, re: /^[a-z][a-z0-9_.]{2,79}$/, req: true }, kind: { t: 'enum', of: KINDS, req: true },
  text_en: { t: 'str', min: 1, max: 600 }, text_ne: { t: 'str', min: 1, max: 600 }, note: { t: 'str', max: 500 },
};
interface BlockIn { block_key: string; kind: string; text_en?: string; text_ne?: string; note?: string }
const parseBlock = (body: unknown): BlockIn => {
  const b = parseBody<BlockIn>(body, BLOCK, (x, errs) => { if (x.text_en === undefined && x.text_ne === undefined) errs.push(fieldError('/text_en', 'common.field_required', 'Field required')); });
  return { block_key: b.block_key, kind: b.kind, ...(b.text_en !== undefined ? { text_en: nfc(b.text_en)! } : {}), ...(b.text_ne !== undefined ? { text_ne: nfc(b.text_ne)! } : {}), ...(b.note !== undefined ? { note: nfc(b.note)! } : {}) };
};

export const listSmartTemplateBlocks: Handler = async (req, ctx) => {
  const rc = await rcOf(ctx);
  const v = await loadVersion(rc, param(req, 'library_version_id'));
  const kind = query(req).kind;
  if (kind !== undefined && (typeof kind !== 'string' || !KINDS.includes(kind))) throw invalidField('kind');
  return { status: 200, body: { data: (await blocksRepo.listBlocks(rc, v.id)).filter((b) => kind === undefined || b.kind === kind).map(blockDto) } };
};

export const createSmartTemplateBlock: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const v = await writable(rc, req);
  const b = parseBlock(req.body);
  if ((await blocksRepo.listBlocks(rc, v.id)).some((x) => x.block_key === b.block_key)) throw invalid('/block_key', 'Block key already in use');
  const row = await blocksRepo.insertBlock(rc, { id: uuidv7(), library_version_id: v.id, ...b });
  await touchParent(rc, v);
  return { status: 201, body: blockDto(row) };
});

export const replaceSmartTemplateBlock: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const expected = ifMatch(req.headers)!;
  const v = await writable(rc, req);
  const id = param(req, 'block_id');
  const cur = mine(isUuid(id) ? await blocksRepo.getBlock(rc, id) : null, v.id);
  const b = parseBlock(req.body);
  if (b.block_key !== cur.block_key) throw invalid('/block_key', 'block_key is immutable');
  if (b.kind !== cur.kind) throw invalid('/kind', 'kind is immutable');
  checkVersion(cur, expected);
  const row = await blocksRepo.updateBlock(rc, cur.id, expected, { text_en: b.text_en ?? null, text_ne: b.text_ne ?? null, note: b.note ?? null }); // PUT = replace: omitted texts are cleared
  await touchParent(rc, v);
  return { status: 200, body: blockDto(row) };
});

export const deleteSmartTemplateBlock: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const expected = ifMatch(req.headers)!;
  const v = await writable(rc, req);
  const id = param(req, 'block_id');
  const cur = mine(isUuid(id) ? await blocksRepo.getBlock(rc, id) : null, v.id);
  checkVersion(cur, expected);
  if ((await rulesRepo.listRules(rc, v.id)).some((r) => r.block_id === cur.id)) throw invalid('/block_id', 'Block is used by an active rule');
  await blocksRepo.updateBlock(rc, cur.id, expected, { is_active: false });
  await touchParent(rc, v);
  return noContent;
});

// ---------------------------------------------------------------- rules
const RULE: Schema = {
  rule_kind: { t: 'enum', of: ['deranged', 'advice', 'followup'], req: true }, trigger_kind: { t: 'enum', of: ['analyte', 'group', 'any', 'all_in_range'], req: true },
  analyte_id: { t: 'uuid' }, group_code: { t: 'str', min: 1, max: 100, re: GROUP_CODE }, direction: { t: 'enum', of: ['low', 'high', 'abnormal', 'any'], req: true },
  min_severity: { t: 'enum', of: ['borderline', 'out_of_range', 'critical'] }, priority: { t: 'int', min: 1, max: 999 }, block_id: { t: 'uuid', req: true },
  suggested_test_id: { t: 'uuid' }, interval_days: { t: 'int', min: 1, max: 730 },
};
/** Combination rules = the DB CHECKs of 05-SCHEMA §3.7, mirrored so the caller gets a pointer instead of a constraint error. */
function ruleCombination(r: Record<string, any>, errs: FieldError[]): void {
  const has = (k: string): boolean => r[k] !== undefined;
  const bad = (k: string): void => { errs.push(fieldError(`/${k}`)); };
  const need = (k: string): void => { if (!has(k)) errs.push(fieldError(`/${k}`, 'common.field_required', 'Field required')); };
  if (r.trigger_kind === 'all_in_range') {
    if (r.rule_kind !== 'advice') bad('trigger_kind');
    for (const k of ['analyte_id', 'group_code', 'min_severity']) if (has(k)) bad(k);
    if (r.direction !== 'any') bad('direction');
  } else {
    if (r.trigger_kind === 'analyte') { need('analyte_id'); if (has('group_code')) bad('group_code'); }
    else if (r.trigger_kind === 'group') { need('group_code'); if (has('analyte_id')) bad('analyte_id'); }
    else for (const k of ['analyte_id', 'group_code']) if (has(k)) bad(k);
    need('min_severity');
  }
  for (const k of ['suggested_test_id', 'interval_days']) { if (r.rule_kind === 'followup') need(k); else if (has(k)) bad(k); }
}
interface RuleIn { rule_kind: string; trigger_kind: string; analyte_id?: string; group_code?: string; direction: string; min_severity?: string; priority?: number; block_id: string; suggested_test_id?: string; interval_days?: number }

/** Body + the references that need a read: an active organ group, an active block of THIS version with the same kind (else 400 /block_id, no existence oracle). */
async function parseRule(rc: RepoCtx, versionId: string, body: unknown): Promise<{ row: Record<string, unknown> }> {
  const r = parseBody<RuleIn>(body, RULE, ruleCombination);
  if (r.group_code !== undefined && !(await codedSetsRepo.listOrganGroups(rc)).some((g) => g.code === r.group_code && g.is_active !== false)) throw validationFailed([fieldError('/group_code')]);
  const blk = await blocksRepo.getBlock(rc, r.block_id);
  if (!blk || blk.library_version_id !== versionId || blk.is_active !== true || blk.kind !== r.rule_kind) throw validationFailed([fieldError('/block_id')]);
  return {
    row: {
      rule_kind: r.rule_kind, trigger_kind: r.trigger_kind, analyte_id: r.analyte_id ?? null, group_code: r.group_code ?? null, direction: r.direction, min_severity: r.min_severity ?? null,
      priority: r.priority ?? 100, block_id: r.block_id, block_kind: blk.kind, suggested_test_id: r.suggested_test_id ?? null, interval_days: r.interval_days ?? null,
    },
  };
}

export const listSmartRules: Handler = async (req, ctx) => {
  const rc = await rcOf(ctx);
  const v = await loadVersion(rc, param(req, 'library_version_id'));
  const kind = query(req).rule_kind;
  if (kind !== undefined && (typeof kind !== 'string' || !['deranged', 'advice', 'followup'].includes(kind))) throw invalidField('rule_kind');
  return { status: 200, body: { data: (await rulesRepo.listRules(rc, v.id)).filter((r) => kind === undefined || r.rule_kind === kind).map(ruleDto) } };
};

export const createSmartRule: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const v = await writable(rc, req);
  const { row } = await parseRule(rc, v.id, req.body);
  const created = await rulesRepo.insertRule(rc, { id: uuidv7(), library_version_id: v.id, ...row });
  await touchParent(rc, v);
  return { status: 201, body: ruleDto(created) };
});

export const replaceSmartRule: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const expected = ifMatch(req.headers)!;
  const v = await writable(rc, req);
  const id = param(req, 'rule_id');
  const cur = mine(isUuid(id) ? await rulesRepo.getRule(rc, id) : null, v.id);
  const { row } = await parseRule(rc, v.id, req.body);
  checkVersion(cur, expected);
  const updated = await rulesRepo.updateRule(rc, cur.id, expected, row);
  await touchParent(rc, v);
  return { status: 200, body: ruleDto(updated) };
});

export const deleteSmartRule: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const expected = ifMatch(req.headers)!;
  const v = await writable(rc, req);
  const id = param(req, 'rule_id');
  const cur = mine(isUuid(id) ? await rulesRepo.getRule(rc, id) : null, v.id);
  checkVersion(cur, expected);
  await rulesRepo.updateRule(rc, cur.id, expected, { is_active: false });
  await touchParent(rc, v);
  return noContent;
});

// ---------------------------------------------------------------- analyte -> group mappings
const MAPPING: Schema = {
  group_code: { t: 'str', min: 1, max: 100, re: GROUP_CODE, req: true }, include_in_score: { t: 'bool' }, trend_enabled: { t: 'bool' },
  borderline_fraction_bp: { t: 'int', min: 0, max: 2500 }, trend_stable_bp: { t: 'int', min: 0, max: 5000 }, sort_order: { t: 'int', min: 0, max: 9999 },
};

export const listSmartAnalyteGroups: Handler = async (req, ctx) => {
  const rc = await rcOf(ctx);
  const v = await loadVersion(rc, param(req, 'library_version_id'));
  return { status: 200, body: { data: (await mappingsRepo.listMappings(rc, v.id)).map(mappingDto) } };
};

export const putSmartAnalyteGroup: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const expected = ifMatch(req.headers, false);          // required only when the mapping already exists
  const v = await writable(rc, req);
  const analyteId = param(req, 'analyte_id');
  if (!isUuid(analyteId)) throw notFound();
  const b = parseBody<{ group_code: string; include_in_score?: boolean; trend_enabled?: boolean; borderline_fraction_bp?: number; trend_stable_bp?: number; sort_order?: number }>(req.body, MAPPING);
  if (!(await codedSetsRepo.listOrganGroups(rc)).some((g) => g.code === b.group_code && g.is_active !== false)) throw validationFailed([fieldError('/group_code')]);
  const fields = {
    group_code: b.group_code, include_in_score: b.include_in_score ?? true, trend_enabled: b.trend_enabled ?? false, borderline_fraction_bp: b.borderline_fraction_bp ?? null,
    trend_stable_bp: b.trend_stable_bp ?? null, sort_order: b.sort_order ?? 100,
  };
  const cur = (await mappingsRepo.listMappings(rc, v.id)).find((m) => m.analyte_id === analyteId);   // PUT = replace: exactly one ACTIVE group per analyte (AC-04.3)
  if (cur) {
    if (expected === undefined) throw new LimsError('common.precondition_required');
    checkVersion(cur, expected);
    const updated = await mappingsRepo.updateMapping(rc, cur.id, expected, fields);
    await touchParent(rc, v);
    return { status: 200, body: mappingDto(updated) };
  }
  const created = await mappingsRepo.insertMapping(rc, { id: uuidv7(), library_version_id: v.id, analyte_id: analyteId, ...fields });   // an analyte of another tenant fails the FK -> 404
  await touchParent(rc, v);
  return { status: 201, body: mappingDto(created) };
});

export const deleteSmartAnalyteGroup: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const expected = ifMatch(req.headers)!;
  const v = await writable(rc, req);
  const analyteId = param(req, 'analyte_id');
  const cur = isUuid(analyteId) ? (await mappingsRepo.listMappings(rc, v.id)).find((m) => m.analyte_id === analyteId) : undefined;
  if (!cur) throw notFound();
  checkVersion(cur, expected);
  await mappingsRepo.updateMapping(rc, cur.id, expected, { is_active: false });
  await touchParent(rc, v);
  return noContent;
});

// ---------------------------------------------------------------- group settings
const GROUP_SETTING: Schema = {
  display_en: { t: 'str', min: 1, max: 60, req: true }, display_ne: { t: 'str', max: 60 }, score_weight: { t: 'int', min: 0, max: 10, req: true },
  sort_order: { t: 'int', min: 0, max: 9999, req: true }, is_shown: { t: 'bool', req: true },
};

export const listSmartGroupSettings: Handler = async (req, ctx) => {
  const rc = await rcOf(ctx);
  const v = await loadVersion(rc, param(req, 'library_version_id'));
  return { status: 200, body: { data: (await groupsRepo.listGroupSettings(rc, v.id)).map(groupSettingDto) } };
};

export const putSmartGroupSetting: Handler = mapped(async (req, ctx) => {
  const rc = await rcOf(ctx);
  const expected = ifMatch(req.headers)!;
  const v = await writable(rc, req);
  const code = param(req, 'group_code');
  const cur = typeof code === 'string' && GROUP_CODE.test(code) ? (await groupsRepo.listGroupSettings(rc, v.id)).find((g) => g.group_code === code) : undefined;
  if (!cur) throw notFound();
  const b = parseBody<{ display_en: string; display_ne?: string; score_weight: number; sort_order: number; is_shown: boolean }>(req.body, GROUP_SETTING);
  checkVersion(cur, expected);
  const updated = await groupsRepo.updateGroupSetting(rc, cur.id, expected, {
    display_en: nfc(b.display_en), display_ne: nfc(b.display_ne) ?? null, score_weight: b.score_weight, sort_order: b.sort_order, is_shown: b.is_shown,
  });
  await touchParent(rc, v);
  return { status: 200, body: groupSettingDto(updated) };
});
