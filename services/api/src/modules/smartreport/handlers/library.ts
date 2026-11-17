// #1 listSmartLibraryVersions, #2 createSmartLibraryVersion, #3 getSmartLibraryVersion, #4 updateSmartLibraryVersion,
// #18 validateSmartLibraryVersion, #19 submitSmartLibraryVersion, #20 approveSmartLibraryVersion, #21 returnSmartLibraryVersion
// (02-TRD §5, §5.1; 03-APP-FLOW §1.1 L1-L5, §2.1). Authorise FIRST (tenant-wide, no centreId); #20/#21 need the privileged smartreport.template.approve (aal2 re-validated by IdentityPort).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { assertEditable, type LibraryStatus } from '../domain/library.state.js';
import {
  approveVersion, checkVersion, createVersion, displayNames, isUuid, loadVersion, returnVersion, submitVersion, validateLibraryVersion, versionView, type LibraryCtx,
} from '../library.service.js';
import { issueDto, PARAM_KEYS, versionSummaryDto } from '../mappers/library.dto.js';
import * as libraryRepo from '../repository/library.repo.js';
import { assertNoBody, fieldError, ifMatch, mapped, nfc, param, parseBody, query, type Schema } from './libraryInput.js';
import { authorise, invalidField, type SrCtx } from './shared.js';

const MANAGE = 'smartreport.template.manage';
const APPROVE = 'smartreport.template.approve';
type C = SrCtx & LibraryCtx;
const c = (ctx: unknown): C => ctx as C;

const STATUSES = ['draft', 'in_review', 'approved', 'retired'];
const PAGE_MAX = 1000; // ponytail: a tenant's version history is small; filter + cursor run in memory over the newest 1000. Push into SQL if histories ever approach that.
const encodeCursor = (versionNo: number): string => Buffer.from(JSON.stringify({ v: versionNo })).toString('base64url');
function decodeCursor(raw: unknown): number {
  try {
    if (typeof raw !== 'string' || raw.length > 512) throw new Error('shape');
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof o?.v === 'number' && Number.isInteger(o.v) && o.v >= 1 && o.v <= 2_147_483_647) return o.v;
  } catch { /* fall through */ }
  throw new LimsError('common.invalid_cursor');
}

// ---------------------------------------------------------------- #1
export const listSmartLibraryVersions: Handler = async (req, ctx) => {
  const rc = await authorise(ctx as SrCtx, MANAGE);
  const q = query(req);
  let statuses: Set<string> | undefined;
  if (q.status !== undefined) {
    const parts = typeof q.status === 'string' && q.status.length <= 64 ? q.status.split(',') : [];
    if (parts.length < 1 || parts.length > 4 || parts.some((s) => !STATUSES.includes(s))) throw invalidField('status');
    statuses = new Set(parts);
  }
  if (q.sort !== undefined && q.sort !== '-version_no') throw invalidField('sort');
  const raw = q.limit === undefined ? 50 : typeof q.limit === 'string' && /^[0-9]{1,4}$/.test(q.limit) ? Number(q.limit) : q.limit;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 200) throw invalidField('limit');
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  const rows = (await libraryRepo.listLibraryVersions(rc, { limit: PAGE_MAX })).filter((r) => (!statuses || statuses.has(r.status)) && (after === undefined || Number(r.version_no) < after));
  const page = rows.slice(0, raw);
  const names = await displayNames(c(ctx), page.map((r) => r.approved_by_membership_id));
  const last = page[page.length - 1];
  return { status: 200, body: { data: page.map((r) => versionSummaryDto(r, names)), page: { limit: raw, ...(rows.length > raw && last ? { next_cursor: encodeCursor(Number(last.version_no)) } : {}) } } };
};

// ---------------------------------------------------------------- #2
const CREATE: Schema = {
  source: { t: 'enum', of: ['starter', 'clone_active', 'clone_version'], req: true }, source_version_id: { t: 'uuid' }, change_summary: { t: 'str', max: 500 },
};
export const createSmartLibraryVersion: Handler = mapped(async (req, ctx) => {
  await authorise(ctx as SrCtx, MANAGE);
  const b = parseBody<{ source: 'starter' | 'clone_active' | 'clone_version'; source_version_id?: string; change_summary?: string }>(req.body, CREATE, (x, errs) => {
    if (x.source === 'clone_version' && x.source_version_id === undefined) errs.push(fieldError('/source_version_id', 'common.field_required', 'Field required'));
    if (x.source !== 'clone_version' && x.source_version_id !== undefined) errs.push(fieldError('/source_version_id'));
  });
  const row = await createVersion(c(ctx), {
    source: b.source, ...(b.source_version_id !== undefined ? { sourceVersionId: b.source_version_id } : {}), ...(b.change_summary !== undefined ? { changeSummary: nfc(b.change_summary)! } : {}),
  });
  return { status: 201, body: await versionView(c(ctx), row) };
});

// ---------------------------------------------------------------- #3
export const getSmartLibraryVersion: Handler = async (req, ctx) => {
  const rc = await authorise(ctx as SrCtx, MANAGE);
  return { status: 200, body: await versionView(c(ctx), await loadVersion(rc, param(req, 'library_version_id'))) };
};

// ---------------------------------------------------------------- #4 (TRD §5.1 ranges; DB CHECKs are the backstop)
const int = (min: number, max: number): Schema[string] => ({ t: 'int', min, max });
const PARAMS: Schema = {
  score_enabled: { t: 'bool' }, credit_in_range_bp: int(0, 10000), credit_borderline_bp: int(0, 10000), credit_out_of_range_bp: int(0, 10000), credit_critical_bp: int(0, 10000),
  min_groups_scored: int(1, 20), band_good_min: int(1, 100), band_fair_min: int(0, 99), critical_forces_needs_attention: { t: 'bool' }, borderline_fraction_bp: int(0, 2500),
  min_mapped_results: int(1, 50), trend_enabled: { t: 'bool' }, trend_max_points: int(2, 6), trend_lookback_days: int(30, 3650), trend_stable_bp: int(0, 5000), trends_max: int(0, 12),
  advice_max_blocks: int(0, 10), followup_max: int(0, 5),
};
const PATCH: Schema = { language: { t: 'enum', of: ['en', 'ne'] }, change_summary: { t: 'str', max: 500 }, params: { t: 'obj', fields: PARAMS } };

export const updateSmartLibraryVersion: Handler = mapped(async (req, ctx) => {
  const rc = await authorise(ctx as SrCtx, MANAGE);
  const expected = ifMatch(req.headers)!;
  const v = await loadVersion(rc, param(req, 'library_version_id'));
  assertEditable(v.status as LibraryStatus);
  checkVersion(v, expected);
  const b = parseBody<{ language?: string; change_summary?: string; params?: Record<string, unknown> }>(req.body, PATCH, (x, errs) => {
    const merged = { ...v, ...(x.params as object | undefined) };
    if (Number(merged.band_fair_min) >= Number(merged.band_good_min)) errs.push(fieldError('/params/band_fair_min'));
  });
  const patch: Record<string, unknown> = { content_sha256: null }; // a draft edit invalidates any earlier hash and guarantees a non-empty patch
  if (b.language !== undefined) patch.language = b.language;
  if (b.change_summary !== undefined) patch.change_summary = nfc(b.change_summary);
  for (const k of PARAM_KEYS) if (b.params?.[k] !== undefined) patch[k] = b.params[k];
  return { status: 200, body: await versionView(c(ctx), await libraryRepo.updateLibraryVersion(rc, v.id, expected, patch)) };
});

// ---------------------------------------------------------------- #18
export const validateSmartLibraryVersion: Handler = async (req, ctx) => {
  await authorise(ctx as SrCtx, MANAGE);
  assertNoBody(req.body);
  const id = param(req, 'library_version_id');
  if (!isUuid(id)) throw new LimsError('common.not_found');
  const report = await validateLibraryVersion(c(ctx), id);
  return { status: 200, body: { valid: report.valid, issues: [...report.errors, ...report.warnings].map(issueDto) } };
};

// ---------------------------------------------------------------- #19
export const submitSmartLibraryVersion: Handler = mapped(async (req, ctx) => {
  await authorise(ctx as SrCtx, MANAGE);
  const expected = ifMatch(req.headers)!;
  assertNoBody(req.body);
  return { status: 200, body: await versionView(c(ctx), await submitVersion(c(ctx), param(req, 'library_version_id'), expected)) };
});

// ---------------------------------------------------------------- #20
export const approveSmartLibraryVersion: Handler = mapped(async (req, ctx) => {
  await authorise(ctx as SrCtx, APPROVE);
  const expected = ifMatch(req.headers)!;
  const b = parseBody<{ note?: string }>(req.body, { attestation: { t: 'true', req: true }, note: { t: 'str', max: 500 } });
  const row = await approveVersion(c(ctx), param(req, 'library_version_id'), expected, nfc(b.note));
  return { status: 200, body: await versionView(c(ctx), row) };
});

// ---------------------------------------------------------------- #21
export const returnSmartLibraryVersion: Handler = mapped(async (req, ctx) => {
  await authorise(ctx as SrCtx, APPROVE);
  const expected = ifMatch(req.headers)!;
  const b = parseBody<{ comment: string }>(req.body, { comment: { t: 'str', min: 1, max: 1000, req: true } });
  const row = await returnVersion(c(ctx), param(req, 'library_version_id'), expected, nfc(b.comment)!);
  return { status: 200, body: await versionView(c(ctx), row) };
});
