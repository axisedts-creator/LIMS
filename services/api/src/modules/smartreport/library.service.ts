// Library lifecycle service (02-TRD §9.3-§9.4; 03-APP-FLOW §1.1 L1-L6, §2.1; 08 A19 P-44, D-108). Reads/writes ONLY through the repositories.
// No authorisation here: the handlers authorise first. validateLibraryVersion is read-only; V6 asks CatalogPort once per distinct follow-up test, each inside a savepoint (P-44).
import { readFileSync } from 'node:fs';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../core/errors.js';
import { contentSha256 } from './domain/engine.js';
import { type ValidationReport, validateLibrary } from './domain/library.validate.js';
import type { LibBlock, LibMapping, LibRule } from './domain/library.validate.js';
import { assertTransition, type LibraryStatus } from './domain/library.state.js';
import { type Counts, type Names, PARAM_KEYS, versionDto } from './mappers/library.dto.js';
import { srMetrics } from './metrics.js';
import * as blocksRepo from './repository/blocks.repo.js';
import * as codedSetsRepo from './repository/codedSets.repo.js';
import type { RepoCtx, Row } from './repository/common.repo.js';
import * as denyTermsRepo from './repository/denyTerms.repo.js';
import * as groupsRepo from './repository/groups.repo.js';
import * as libraryRepo from './repository/library.repo.js';
import * as mappingsRepo from './repository/mappings.repo.js';
import * as reviewsRepo from './repository/reviews.repo.js';
import * as rulesRepo from './repository/rules.repo.js';

interface SavepointTx { savepoint<T>(fn: (tx: never) => Promise<T>): Promise<T> }
export interface LibraryCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly tx: RepoCtx['tx'];
  readonly ports: { readonly CatalogPort: { getTest(ctx: never, input: { testId: string; requireActive: true }): Promise<unknown> } };
  readonly core?: { readonly memberships: { list(ctx: never, i: { membershipIds: readonly string[]; activeOnly: boolean }): Promise<readonly { membershipId: string; displayName: string }[]> } };
  readonly log?: { warn(o: object, m?: string): void };
  readonly metrics?: unknown;   // optional sink (T17-01); see ./metrics.ts
}

const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
export const rcOf = (ctx: LibraryCtx): RepoCtx => ({ tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id });
const nowIso = (): string => new Date().toISOString();

/** Port errors keep their code but become the API's LimsError. */
const asLimsError = (e: unknown): unknown => {
  const code = (e as { code?: unknown } | null)?.code;
  return !(e instanceof LimsError) && typeof code === 'string' ? new LimsError(code) : e;
};

/** DB errors -> API errors (05-SCHEMA §4 triggers, §5 unique indexes, FKs, CHECKs). LimsErrors and anything unknown pass through unchanged. */
export function mapDbError(e: unknown): unknown {
  if (e instanceof LimsError) return e;
  const o = e as { code?: unknown; message?: unknown; constraint?: unknown } | null;
  const code = typeof o?.code === 'string' ? o.code : '';
  const text = `${String(o?.constraint ?? '')} ${String(o?.message ?? '')}`;
  if (code === 'P0001' && /immutable_row/.test(text)) return new LimsError('common.immutable_record');
  if (code === 'P0001' && /invalid_transition/.test(text)) return new LimsError('smartreport.library_invalid_transition');
  if (code === '23505') return new LimsError(/library_versions/.test(text) ? 'smartreport.library_invalid_transition' : 'smartreport.library_invalid');
  if (code === '23503') return new LimsError('common.not_found');          // analyte FK (cross-tenant ids look unknown), library FK
  if (code === '23514') return new LimsError('common.validation_failed');
  return e;
}

/** Version of the authenticated tenant, else 404 (malformed id, unknown id and another tenant's id are indistinguishable). */
export async function loadVersion(rc: RepoCtx, id: unknown): Promise<Row> {
  const v = isUuid(id) ? await libraryRepo.getLibraryVersion(rc, id) : null;
  if (!v || v.tenant_id !== rc.tenantId) throw new LimsError('common.not_found');
  return v;
}
/** If-Match compared before any write, so a stale request writes nothing. */
export function checkVersion(row: Row, expected: number): void {
  if (Number(row.version) !== expected) throw new LimsError('common.version_conflict');
}
/** Any child change bumps the parent version (03-APP-FLOW L2); the stale content hash of a draft is cleared with it. */
export const touchParent = (rc: RepoCtx, v: Row): Promise<Row> => libraryRepo.updateLibraryVersion(rc, v.id, Number(v.version), { content_sha256: null });

function membershipOf(ctx: LibraryCtx): string {
  if (!ctx.actor.membershipId) throw new LimsError('auth.forbidden');
  return ctx.actor.membershipId;
}

/** P-17: names come from core.memberships.list only (one batched call, activeOnly=false). A failed lookup omits the names; it never fails the request. */
export async function displayNames(ctx: LibraryCtx, ids: Iterable<unknown>): Promise<Names> {
  const want = [...new Set([...ids].filter((x): x is string => typeof x === 'string'))];
  const out = new Map<string, string>();
  if (want.length === 0 || !ctx.core) return out;
  try {
    for (let i = 0; i < want.length; i += 200) {
      for (const m of await ctx.core.memberships.list(ctx as never, { membershipIds: want.slice(i, i + 200), activeOnly: false })) out.set(m.membershipId, m.displayName);
    }
  } catch { ctx.log?.warn({}, 'smartreport: membership display names unavailable'); }
  return out;
}

export async function countsOf(rc: RepoCtx, id: string): Promise<Counts> {
  const [b, r, m, g] = await Promise.all([blocksRepo.listBlocks(rc, id), rulesRepo.listRules(rc, id), mappingsRepo.listMappings(rc, id), groupsRepo.listGroupSettings(rc, id)]);
  return { blocks: b.length, rules: r.length, analyte_groups: m.length, groups_shown: g.filter((x) => x.is_shown === true).length };
}
export async function versionView(ctx: LibraryCtx, row: Row): Promise<Row> {
  const [counts, names] = await Promise.all([countsOf(rcOf(ctx), row.id), displayNames(ctx, [row.approved_by_membership_id])]);
  return versionDto(row, counts, names);
}

// ---------------------------------------------------------------- L1 create
interface Seed {
  language: 'en' | 'ne';
  blocks: { block_key: string; kind: string; text_en: string }[];
  rules: { rule_kind: string; trigger_kind: string; direction: string; min_severity?: string; priority: number; block_key: string }[];
}
let seedCache: Seed | undefined;
const starterSeed = (): Seed => (seedCache ??= JSON.parse(readFileSync(new URL('./seed/starter-library.v1.json', import.meta.url), 'utf8')) as Seed);

async function seedStarter(rc: RepoCtx, libraryVersionId: string): Promise<void> {
  const seed = starterSeed();
  const byKey = new Map<string, { id: string; kind: string }>();
  for (const b of seed.blocks) {
    const id = uuidv7();
    await blocksRepo.insertBlock(rc, { id, library_version_id: libraryVersionId, block_key: b.block_key, kind: b.kind, text_en: b.text_en });
    byKey.set(b.block_key, { id, kind: b.kind });
  }
  for (const r of seed.rules) {
    const b = byKey.get(r.block_key)!;
    await rulesRepo.insertRule(rc, {
      id: uuidv7(), library_version_id: libraryVersionId, rule_kind: r.rule_kind, trigger_kind: r.trigger_kind, direction: r.direction,
      ...(r.min_severity !== undefined ? { min_severity: r.min_severity } : {}), priority: r.priority, block_id: b.id, block_kind: b.kind,
    });
  }
  // one setting per ACTIVE organ group (05-SCHEMA §3.1); display_en is limited to 60 characters
  for (const g of await codedSetsRepo.listOrganGroups(rc)) {
    if (g.is_active === false) continue;
    await groupsRepo.insertGroupSetting(rc, { id: uuidv7(), library_version_id: libraryVersionId, group_code: g.code, display_en: [...String(g.display)].slice(0, 60).join(''), score_weight: 1, sort_order: g.sort_order, is_shown: true });
  }
}

/** Active rows of the source with NEW ids; rules are re-pointed at the new blocks (removed rows are not copied). */
async function cloneChildren(rc: RepoCtx, fromId: string, toId: string): Promise<void> {
  const [blocks, rules, mappings, groups] = await Promise.all([blocksRepo.listBlocks(rc, fromId), rulesRepo.listRules(rc, fromId), mappingsRepo.listMappings(rc, fromId), groupsRepo.listGroupSettings(rc, fromId)]);
  const ids = new Map<string, string>();
  for (const b of blocks) {
    const id = uuidv7(); ids.set(b.id, id);
    await blocksRepo.insertBlock(rc, { id, library_version_id: toId, block_key: b.block_key, kind: b.kind, text_en: b.text_en, text_ne: b.text_ne, note: b.note });
  }
  for (const r of rules) {
    const blockId = ids.get(r.block_id);
    if (blockId === undefined) throw new LimsError('common.internal', 'active rule points at an inactive block');
    await rulesRepo.insertRule(rc, {
      id: uuidv7(), library_version_id: toId, rule_kind: r.rule_kind, trigger_kind: r.trigger_kind, analyte_id: r.analyte_id, group_code: r.group_code, direction: r.direction,
      min_severity: r.min_severity, priority: r.priority, block_id: blockId, block_kind: r.block_kind, suggested_test_id: r.suggested_test_id, interval_days: r.interval_days,
    });
  }
  for (const m of mappings) {
    await mappingsRepo.insertMapping(rc, {
      id: uuidv7(), library_version_id: toId, analyte_id: m.analyte_id, group_code: m.group_code, include_in_score: m.include_in_score, trend_enabled: m.trend_enabled,
      borderline_fraction_bp: m.borderline_fraction_bp, trend_stable_bp: m.trend_stable_bp, sort_order: m.sort_order,
    });
  }
  for (const g of groups) {
    await groupsRepo.insertGroupSetting(rc, { id: uuidv7(), library_version_id: toId, group_code: g.group_code, display_en: g.display_en, display_ne: g.display_ne, score_weight: g.score_weight, sort_order: g.sort_order, is_shown: g.is_shown });
  }
}

export interface CreateInput { source: 'starter' | 'clone_active' | 'clone_version'; sourceVersionId?: string; changeSummary?: string }

/** L1: advisory lock first, then source, then the open-version guard, then max + 1 (the partial unique index is the backstop). */
export async function createVersion(ctx: LibraryCtx, input: CreateInput): Promise<Row> {
  const rc = rcOf(ctx);
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`smartreport:library:${ctx.tenantId}`]);
  let src: Row | null = null;
  if (input.source === 'clone_active') src = await libraryRepo.getApprovedLibraryVersion(rc);
  else if (input.source === 'clone_version') src = isUuid(input.sourceVersionId) ? await libraryRepo.getLibraryVersion(rc, input.sourceVersionId) : null;
  if (input.source !== 'starter' && (!src || src.tenant_id !== rc.tenantId)) throw new LimsError('common.not_found');
  if (await libraryRepo.getOpenLibraryVersion(rc)) throw new LimsError('smartreport.library_invalid_transition');
  const latest = (await libraryRepo.listLibraryVersions(rc, { limit: 1 }))[0];
  const row = await libraryRepo.insertLibraryVersion(rc, {
    id: uuidv7(), version_no: (latest ? Number(latest.version_no) : 0) + 1, language: src ? src.language : starterSeed().language,
    ...(src ? { ...Object.fromEntries(PARAM_KEYS.map((k) => [k, src![k]])), source_version_id: src.id } : {}),
    ...(input.changeSummary !== undefined ? { change_summary: input.changeSummary } : {}),
  });
  if (src) await cloneChildren(rc, src.id, row.id); else await seedStarter(rc, row.id);
  return row;
}

// ---------------------------------------------------------------- content hash (L3 / L5)
const by = <T>(a: readonly T[], key: (x: T) => string): T[] => [...a].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
const n = (x: unknown): unknown => x ?? null;

/** SHA-256 of the canonical JSON of the version's ACTIVE content: independent of row order, row ids and removed rows; any text/rule/param change changes it. */
export async function contentHash(rc: RepoCtx, v: Row): Promise<string> {
  const [blocks, rules, mappings, groups] = await Promise.all([blocksRepo.listBlocks(rc, v.id), rulesRepo.listRules(rc, v.id), mappingsRepo.listMappings(rc, v.id), groupsRepo.listGroupSettings(rc, v.id)]);
  const keyOf = new Map<string, string>(blocks.map((b) => [b.id as string, b.block_key as string]));
  const canon = (o: object): string => JSON.stringify(o);
  return contentSha256({
    formula_version: v.formula_version, language: v.language, params: Object.fromEntries(PARAM_KEYS.map((k) => [k, v[k]])),
    blocks: by(blocks.map((b) => ({ block_key: b.block_key, kind: b.kind, text_en: n(b.text_en), text_ne: n(b.text_ne), note: n(b.note) })), (b) => b.block_key as string),
    rules: by(rules.map((r) => ({
      rule_kind: r.rule_kind, trigger_kind: r.trigger_kind, analyte_id: n(r.analyte_id), group_code: n(r.group_code), direction: r.direction, min_severity: n(r.min_severity), priority: r.priority,
      block_key: n(keyOf.get(r.block_id)), suggested_test_id: n(r.suggested_test_id), interval_days: n(r.interval_days),
    })), canon),
    mappings: by(mappings.map((m) => ({ analyte_id: m.analyte_id, group_code: m.group_code, include_in_score: m.include_in_score, trend_enabled: m.trend_enabled,
      borderline_fraction_bp: n(m.borderline_fraction_bp), trend_stable_bp: n(m.trend_stable_bp), sort_order: m.sort_order })), (m) => m.analyte_id as string),
    groups: by(groups.map((g) => ({ group_code: g.group_code, display_en: g.display_en, display_ne: n(g.display_ne), score_weight: g.score_weight, sort_order: g.sort_order, is_shown: g.is_shown })), (g) => g.group_code as string),
  });
}

// ---------------------------------------------------------------- L3 / L4 / L5
/** L3: draft -> in_review. Validation errors -> 422 with the issues in errors[] (path = JSON pointer, message = issue code; never block text). */
export async function submitVersion(ctx: LibraryCtx, id: unknown, expected: number): Promise<Row> {
  const rc = rcOf(ctx);
  const actor = membershipOf(ctx);
  const v = await loadVersion(rc, id);
  assertTransition(v.status as LibraryStatus, 'in_review');
  checkVersion(v, expected);
  const report = await validateLibraryVersion(ctx, v.id);
  if (!report.valid) throw new LimsError('smartreport.library_invalid', undefined, report.errors.map((i) => ({ path: i.path, code: 'common.field_invalid', message: i.code })));
  const hash = await contentHash(rc, v);
  const row = await libraryRepo.updateLibraryVersion(rc, v.id, expected, { status: 'in_review', content_sha256: hash, submitted_at: nowIso(), submitted_by_membership_id: actor });
  await reviewsRepo.insertLibraryReview(rc, { id: uuidv7(), library_version_id: v.id, action: 'submitted', content_sha256: hash, actor_membership_id: actor });
  srMetrics.libraryTransition(ctx, 'in_review');
  return row;
}

/** L4: in_review -> draft. */
export async function returnVersion(ctx: LibraryCtx, id: unknown, expected: number, comment: string): Promise<Row> {
  const rc = rcOf(ctx);
  const actor = membershipOf(ctx);
  const v = await loadVersion(rc, id);
  assertTransition(v.status as LibraryStatus, 'draft');
  checkVersion(v, expected);
  const row = await libraryRepo.updateLibraryVersion(rc, v.id, expected, { status: 'draft', returned_at: nowIso(), returned_by_membership_id: actor, return_comment: comment });
  await reviewsRepo.insertLibraryReview(rc, { id: uuidv7(), library_version_id: v.id, action: 'returned', comment, content_sha256: opt(v.content_sha256), actor_membership_id: actor });
  srMetrics.libraryTransition(ctx, 'draft');
  return row;
}

/** L5/L6: recomputed hash must equal the stored one; the previous approved version is retired first (one approved version per tenant), then this one is approved. Same transaction. */
export async function approveVersion(ctx: LibraryCtx, id: unknown, expected: number, note: string | undefined): Promise<Row> {
  const rc = rcOf(ctx);
  const actor = membershipOf(ctx);
  const v = await loadVersion(rc, id);
  assertTransition(v.status as LibraryStatus, 'approved');
  checkVersion(v, expected);
  if (v.content_sha256 !== (await contentHash(rc, v))) throw new LimsError('smartreport.library_invalid_transition');
  const now = nowIso();
  const prev = await libraryRepo.getApprovedLibraryVersion(rc);
  if (prev && prev.id !== v.id) {
    await libraryRepo.updateLibraryVersion(rc, prev.id, Number(prev.version), { status: 'retired', retired_at: now });
    await reviewsRepo.insertLibraryReview(rc, { id: uuidv7(), library_version_id: prev.id, action: 'retired', content_sha256: opt(prev.content_sha256), actor_membership_id: actor });
    srMetrics.libraryTransition(ctx, 'retired');
  }
  const row = await libraryRepo.updateLibraryVersion(rc, v.id, expected, {
    status: 'approved', approved_at: now, approved_by_membership_id: actor, ...(note !== undefined ? { approval_note: note } : {}),
  });
  await reviewsRepo.insertLibraryReview(rc, { id: uuidv7(), library_version_id: v.id, action: 'approved', ...(note !== undefined ? { comment: note } : {}), content_sha256: v.content_sha256, actor_membership_id: actor });
  srMetrics.libraryTransition(ctx, 'approved');
  return row;
}

// ---------------------------------------------------------------- validate (read-only)
export async function validateLibraryVersion(ctx: LibraryCtx, libraryVersionId: string): Promise<ValidationReport> {
  const rc = rcOf(ctx);
  const version = await loadVersion(rc, libraryVersionId);

  const [blockRows, ruleRows, mappingRows, tenantTerms, globalTerms] = await Promise.all([
    blocksRepo.listBlocks(rc, libraryVersionId), rulesRepo.listRules(rc, libraryVersionId), mappingsRepo.listMappings(rc, libraryVersionId),
    denyTermsRepo.listDenyTerms(rc), denyTermsRepo.listGlobalDenyTerms(rc),
  ]);

  const rules: LibRule[] = ruleRows.map((r) => ({
    id: r.id, ruleKind: r.rule_kind, triggerKind: r.trigger_kind, direction: r.direction, priority: r.priority, blockId: r.block_id, blockKind: r.block_kind,
    ...(opt(r.analyte_id) !== undefined && { analyteId: r.analyte_id }), ...(opt(r.group_code) !== undefined && { groupCode: r.group_code }),
    ...(opt(r.min_severity) !== undefined && { minSeverity: r.min_severity }), ...(opt(r.suggested_test_id) !== undefined && { suggestedTestId: r.suggested_test_id }),
    ...(opt(r.interval_days) !== undefined && { intervalDays: r.interval_days }),
  }));
  const blocks: LibBlock[] = blockRows.map((b) => ({ id: b.id, blockKey: b.block_key, kind: b.kind, textEn: opt(b.text_en), textNe: opt(b.text_ne) }));
  const mappings: LibMapping[] = mappingRows.map((m) => ({ id: m.id, analyteId: m.analyte_id, groupCode: m.group_code }));

  // V6: a test the catalog calls inactive or cannot see is a finding; any other port error is not ours to swallow.
  const inactiveTestIds = new Set<string>();
  const tests = [...new Set(rules.flatMap((r) => (r.suggestedTestId === undefined ? [] : [r.suggestedTestId])))];
  for (const testId of tests) {
    try {
      await (ctx.tx as unknown as SavepointTx).savepoint((tx) => ctx.ports.CatalogPort.getTest({ ...ctx, tx } as never, { testId, requireActive: true }));
    } catch (e) {
      const err = asLimsError(e);
      if (err instanceof LimsError && (err.code === 'catalog.test_inactive' || err.code === 'common.not_found')) inactiveTestIds.add(testId);
      else throw err;
    }
  }

  return validateLibrary(
    { language: version.language, scoreEnabled: version.score_enabled, blocks, rules, mappings },
    // ponytail: V13 has no catalog source in the spec (no CatalogPort analyte-status method); empty set until CR-C14-T10a (.orchestra/cr/C14.T10.md) adds one.
    { denyTerms: [...globalTerms, ...tenantTerms].map((t) => ({ term: t.term })), inactiveTestIds, inactiveAnalyteIds: new Set() },
  );
}
