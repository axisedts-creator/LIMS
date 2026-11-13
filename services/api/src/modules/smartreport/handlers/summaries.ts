// #27 listSmartSummaries, #28 getSmartSummary, #29 getCurrentSmartSummary, #30 buildSmartSummary, #31 approveSmartSummary, #32 rejectSmartSummary
// (02-TRD §5 #27-#32, §4.10, §5.1; 03-APP-FLOW §1.2 S2-S4, §2.5, §2.6, E5). Authorise FIRST (tenant-wide), then again with the summary's / order's centre once it is known.
// Tenant comes from ctx only. Every state change is updateSummary(expected = If-Match) + one append-only summary_reviews row in the same transaction.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { displayNames, isUuid, mapDbError, checkVersion } from '../library.service.js';
import { listItemDto, reviewInputDto, summaryView } from '../mappers/summary.dto.js';
import * as bindingsRepo from '../repository/bindings.repo.js';
import * as codedSetsRepo from '../repository/codedSets.repo.js';
import type { RepoCtx, Row } from '../repository/common.repo.js';
import * as reviewsRepo from '../repository/reviews.repo.js';
import * as summariesRepo from '../repository/summaries.repo.js';
import { srMetrics } from '../metrics.js';
import { buildOrGet, type BuildCtx } from '../summary.service.js';
import { fieldError, ifMatch, nfc, param, parseBody, query, validationFailed } from './libraryInput.js';
import { authorise, invalidField, type SrCtx } from './shared.js';

const READ = 'smartreport.summary.read';
const APPROVE = 'smartreport.summary.approve';

/** What these handlers use of the request context (02-CV §6.3); the typed core context only carries a subset today. */
type K = Omit<SrCtx, 'ports' | 'actor'> & {
  readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly ports: {
    readonly IdentityPort: {
      getActor(c: never): Promise<{ permissions: readonly string[]; centreScope: { all: boolean; centreIds: readonly string[] } }>;
      getTenantSettings(c: never, i: { keys: string[] }): Promise<{ featureFlags?: Record<string, unknown> } | undefined>;
    };
    readonly FrontdeskPort: any; readonly LabPort: any; readonly CatalogPort: any;
  };
  readonly audit: { access(e: { action: string; entityType: string; entityId?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
  commitOnError(): void;
  now?(): string;
};
const kOf = (ctx: unknown): K => ctx as K;
const srOf = (k: K): SrCtx => k as unknown as SrCtx;
const rcOf = (k: K): RepoCtx => ({ tx: k.tx, tenantId: k.tenantId, actorId: k.actor.id });
const nowOf = (k: K): string => (typeof k.now === 'function' ? k.now() : new Date().toISOString());
const notFound = (): LimsError => new LimsError('common.not_found');

/** Trigger errors of the summaries table become API errors; everything else goes through the library mapping (23505, 23514, ...). */
const sumMapped = (h: Handler): Handler => async (req, ctx) => {
  try { return await h(req, ctx); } catch (e) {
    const o = e as { code?: unknown; message?: unknown } | null;
    if (!(e instanceof LimsError) && o?.code === 'P0001' && String(o.message).includes('invalid_transition')) throw new LimsError('smartreport.summary_invalid_transition');
    throw mapDbError(e);
  }
};

async function loadSummary(rc: RepoCtx, id: unknown): Promise<Row> {
  const row = isUuid(id) ? await summariesRepo.getSummary(rc, id) : null;
  if (!row || row.tenant_id !== rc.tenantId) throw notFound();
  return row;
}
const membershipOf = (k: K): string => { if (!k.actor.membershipId) throw new LimsError('auth.forbidden'); return k.actor.membershipId; };

// ---------------------------------------------------------------- the view (field allowlist REQ-SEC-081, 03-APP-FLOW §2.6)
/** One approved result per input, as the reviewer sees it: values from LabPort at read time, band + group from the stored content. */
async function reviewInputs(k: K, row: Row): Promise<Record<string, unknown>[]> {
  const lab = await k.ports.LabPort.getOrderResults(k, { orderId: row.order_id, scope: 'approved' });
  const results: Row[] = (lab.items as Row[]).flatMap((i) => i.results as Row[]);
  const latest = new Map<string, string>();
  for (const r of results) { const cur = latest.get(r.testId); if (cur === undefined || Date.parse(r.approvedAt) > Date.parse(cur)) latest.set(r.testId, r.approvedAt); }
  const names = new Map<string, string>();
  for (const [testId, asOf] of latest) for (const a of (await k.ports.CatalogPort.getTest(k, { testId, asOf })).analytes as Row[]) names.set(a.id, a.name);
  const c = row.content as Row;
  const group = new Map<string, string>((c.panels as Row[]).flatMap((p) => (p.resultIds as string[]).map((id) => [id, p.panelCode as string] as const)));
  const band = new Map<string, string>((c.deranged as Row[]).map((d) => [d.resultId as string, d.severity as string]));
  // ponytail: the contract caps review_inputs at 500; a summary with more approved results shows the first 500 (the build refuses > 2000 anyway).
  return results.slice(0, 500).map((r) => reviewInputDto(r, names.get(r.analyteId) ?? '', band.get(r.resultId) ?? 'in_range', group.get(r.resultId)));
}

async function view(k: K, rc: RepoCtx, row: Row, o: { approver?: boolean } = {}): Promise<Record<string, unknown>> {
  const approver = o.approver ?? (await k.ports.IdentityPort.getActor(k as never)).permissions.includes(APPROVE);
  const [order, reviews, bindings, settings] = await Promise.all([
    k.ports.FrontdeskPort.getOrderSummary(k, { orderId: row.order_id }), reviewsRepo.listSummaryReviews(rc, row.id), bindingsRepo.listBindingsBySummary(rc, row.id),
    k.ports.IdentityPort.getTenantSettings(k as never, { keys: ['featureFlags'] }),
  ]);
  const names = await displayNames(k as never, [row.approved_by_membership_id, row.rejected_by_membership_id, ...reviews.map((r) => r.actor_membership_id)]);
  const inputs = approver && row.status === 'draft' ? await reviewInputs(k, row) : undefined;
  return summaryView(row, {
    registrationNo: order.registrationNo, names, reviews, reportVersionNos: bindings.map((b) => Number(b.report_version_no)), llmEnabled: settings?.featureFlags?.smart_report_llm === true, approver, reviewInputs: inputs,
  });
}

/** #28 / #29 tail: centre check, view, then ONE access-log row (only for a view that was served: AC-21.2). */
async function serve(k: K, row: Row | null): Promise<{ status: number; body: unknown }> {
  if (!row || row.tenant_id !== k.tenantId) throw notFound();
  await authorise(srOf(k), READ, row.centre_id);
  const body = await view(k, rcOf(k), row);
  await k.audit.access({ action: 'smart_summary.view', entityType: 'smart_summary', entityId: row.id, outcome: 'allowed' });
  return { status: 200, body };
}

// ---------------------------------------------------------------- #27
const STATUS = /^(draft|approved|rejected|superseded)(,(draft|approved|rejected|superseded)){0,3}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
const PAGE_MAX = 1000; // ponytail: the queue filters, merges and pages in memory over the oldest 1000 rows per (status, centre). Push into SQL when queues approach that.
const ms = (v: unknown): number => new Date(v as string).getTime();
const isoParam = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) throw invalidField(name);
  return Date.parse(v);
};
const encodeCursor = (r: Row): string => Buffer.from(JSON.stringify({ b: new Date(r.built_at).toISOString(), i: r.id })).toString('base64url');
function decodeCursor(raw: string): { b: number; i: string } {
  try {
    if (raw.length > 512) throw new Error('shape');
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { b?: unknown; i?: unknown };
    if (typeof o?.b === 'string' && ISO.test(o.b) && typeof o.i === 'string' && isUuid(o.i)) return { b: Date.parse(o.b), i: o.i };
  } catch { /* fall through */ }
  throw new LimsError('common.invalid_cursor');
}

export const listSmartSummaries: Handler = async (req, ctx) => {
  const k = kOf(ctx);
  const rc = await authorise(srOf(k), READ);
  const q = query(req);
  const statuses = new Set<string>();
  if (q.status === undefined) statuses.add('draft');
  else if (typeof q.status === 'string' && q.status.length <= 64 && STATUS.test(q.status)) q.status.split(',').forEach((s) => statuses.add(s));
  else throw invalidField('status');
  if (q.centre_id !== undefined && !isUuid(q.centre_id)) throw invalidField('centre_id');
  const from = isoParam(q.built_at_from, 'built_at_from');
  const to = isoParam(q.built_at_to, 'built_at_to');
  if (q.has_critical !== undefined && q.has_critical !== 'true' && q.has_critical !== 'false') throw invalidField('has_critical');
  if (q.sort !== undefined && q.sort !== 'built_at' && q.sort !== '-built_at') throw invalidField('sort');
  const raw = q.limit === undefined ? 50 : typeof q.limit === 'string' && /^[0-9]{1,4}$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!Number.isInteger(raw) || raw < 1 || raw > 200) throw invalidField('limit');
  const after = q.cursor === undefined ? undefined : typeof q.cursor === 'string' ? decodeCursor(q.cursor) : (() => { throw new LimsError('common.invalid_cursor'); })();
  const desc = q.sort === '-built_at';

  // a centre-scoped actor only ever reads their own centres (RLS is the backstop)
  const scope = (await k.ports.IdentityPort.getActor(k as never)).centreScope;
  const centres: (string | undefined)[] = scope.all ? [q.centre_id as string | undefined]
    : (q.centre_id === undefined ? [...scope.centreIds] : scope.centreIds.includes(q.centre_id as string) ? [q.centre_id as string] : []);
  const lists = await Promise.all([...statuses].flatMap((status) => centres.map((centreId) => summariesRepo.listReviewQueue(rc, { status, centreId, limit: PAGE_MAX }))));
  if (statuses.size === 1 && statuses.has('draft') && scope.all && q.centre_id === undefined) {            // whole tenant draft queue read: refresh the draft gauges (02-TRD §12)
    const drafts = lists.flat();
    if (drafts.length < PAGE_MAX) srMetrics.drafts(k, k.tenantId, drafts.length, drafts.length === 0 ? 0 : (Date.parse(nowOf(k)) - Math.min(...drafts.map((r) => ms(r.built_at)))) / 1000);
  }
  const dir = desc ? -1 : 1;
  const cmp = (a: Row, b: Row): number => dir * (ms(a.built_at) - ms(b.built_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rows = lists.flat()
    .filter((r) => (from === undefined || ms(r.built_at) >= from) && (to === undefined || ms(r.built_at) <= to)
      && (q.has_critical === undefined || (q.has_critical === 'true') === (r.critical_count > 0)))
    .sort(cmp)
    .filter((r) => after === undefined || cmp(r, { built_at: new Date(after.b).toISOString(), id: after.i }) > 0);
  const page = rows.slice(0, raw);
  const reg = new Map<string, string>();
  await Promise.all([...new Set(page.map((r) => r.order_id as string))].map(async (orderId) => { reg.set(orderId, (await k.ports.FrontdeskPort.getOrderSummary(k, { orderId })).registrationNo); }));
  const last = page[page.length - 1];
  return { status: 200, body: { data: page.map((r) => listItemDto(r, reg.get(r.order_id) ?? '')), page: { limit: raw, ...(rows.length > raw && last ? { next_cursor: encodeCursor(last) } : {}) } } };
};

// ---------------------------------------------------------------- #28 / #29
export const getSmartSummary: Handler = async (req, ctx) => {
  const k = kOf(ctx);
  const rc = await authorise(srOf(k), READ);
  const id = param(req, 'summary_id');
  return serve(k, isUuid(id) ? await summariesRepo.getSummary(rc, id) : null);
};

export const getCurrentSmartSummary: Handler = async (req, ctx) => {
  const k = kOf(ctx);
  const rc = await authorise(srOf(k), READ);
  const orderId = param(req, 'order_id');
  return serve(k, isUuid(orderId) ? await summariesRepo.getLiveSummaryByOrder(rc, orderId) : null);
};

// ---------------------------------------------------------------- #30
export const buildSmartSummary: Handler = sumMapped(async (req, ctx) => {
  const k = kOf(ctx);
  const rc = await authorise(srOf(k), APPROVE);
  const settings = await k.ports.IdentityPort.getTenantSettings(k as never, { keys: ['featureFlags'] });
  if (settings?.featureFlags?.smart_report !== true) throw new LimsError('smartreport.feature_disabled');
  const b = parseBody<{ mode: 'current' | 'rebuild_with_active_library' }>(req.body, { mode: { t: 'enum', of: ['current', 'rebuild_with_active_library'], req: true } });
  const orderId = param(req, 'order_id');
  if (!isUuid(orderId)) throw notFound();
  const order = await k.ports.FrontdeskPort.getOrderSummary(k, { orderId });                    // not visible -> common.not_found
  await authorise(srOf(k), APPROVE, order.centreId);
  const { summary, created } = await buildOrGet({ ...k, now: () => nowOf(k) } as unknown as BuildCtx, { orderId, mode: b.mode });
  return { status: created ? 201 : 200, body: await view(k, rc, summary, { approver: true }) };
});

// ---------------------------------------------------------------- #31 (S2 / S3)
export const approveSmartSummary: Handler = sumMapped(async (req, ctx) => {
  const k = kOf(ctx);
  const rc = await authorise(srOf(k), APPROVE);                                                    // privileged: IdentityPort re-validates aal2
  const expected = ifMatch(req.headers)!;
  const b = parseBody<{ use_llm_text?: boolean }>(req.body, { attestation: { t: 'true', req: true }, use_llm_text: { t: 'bool' } });
  const membershipId = membershipOf(k);
  const first = await loadSummary(rc, param(req, 'summary_id'));
  await authorise(srOf(k), APPROVE, first.centre_id);
  // TRD §4.10 / E5: one writer per order. The row is re-read under the lock, so a concurrent build / supersede is seen before the checks.
  await k.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('smartreport:' || $1::text || ':' || $2::text, 0))`, [k.tenantId, first.order_id]);
  const row = await loadSummary(rc, first.id);
  checkVersion(row, expected);
  if (row.status === 'superseded') throw new LimsError('smartreport.summary_superseded');
  if (row.status !== 'draft') throw new LimsError('smartreport.summary_invalid_transition');
  if (b.use_llm_text === true && row.llm_overlay == null) throw validationFailed([fieldError('/use_llm_text')]);

  const lab = await k.ports.LabPort.getOrderResults(k, { orderId: row.order_id, scope: 'approved' });
  const now = nowOf(k);
  if (lab.approvedSetHash !== row.approved_set_hash) {                                             // S3: the results moved on since the build
    await summariesRepo.updateSummary(rc, row.id, row.version, { status: 'superseded', superseded_at: now, superseded_reason: 'results_changed' });
    k.commitOnError();                                                                             // the supersede survives the 409
    throw new LimsError('smartreport.summary_superseded');
  }
  const updated = await summariesRepo.updateSummary(rc, row.id, expected, { status: 'approved', approved_at: now, approved_by_membership_id: membershipId, use_llm_text: b.use_llm_text ?? false });
  await reviewsRepo.insertSummaryReview(rc, { id: uuidv7(), centre_id: row.centre_id, summary_id: row.id, action: 'approved', actor_membership_id: membershipId });
  srMetrics.review(k, 'approved');
  srMetrics.draftAge(k, (Date.parse(now) - ms(row.built_at)) / 1000);                              // observed at approval (02-TRD §12)
  return { status: 200, body: await view(k, rc, updated, { approver: true }) };
});

// ---------------------------------------------------------------- #32 (S4)
export const rejectSmartSummary: Handler = sumMapped(async (req, ctx) => {
  const k = kOf(ctx);
  const rc = await authorise(srOf(k), APPROVE);
  const expected = ifMatch(req.headers)!;
  const b = parseBody<{ reason_code: string; comment?: string }>(
    req.body, { reason_code: { t: 'str', min: 1, max: 100, re: /^[a-z][a-z0-9_]{0,99}$/, req: true }, comment: { t: 'str', max: 500 } },
    (x, errs) => { if (x.reason_code === 'other' && (typeof x.comment !== 'string' || x.comment.trim() === '')) errs.push(fieldError('/comment', 'common.field_required', 'Field required')); });
  const membershipId = membershipOf(k);
  const row = await loadSummary(rc, param(req, 'summary_id'));
  await authorise(srOf(k), APPROVE, row.centre_id);
  if (!(await codedSetsRepo.listRejectReasons(rc)).some((r) => r.code === b.reason_code)) throw validationFailed([fieldError('/reason_code')]);
  checkVersion(row, expected);
  if (row.status !== 'draft') throw new LimsError('smartreport.summary_invalid_transition');
  const comment = nfc(b.comment);
  const updated = await summariesRepo.updateSummary(rc, row.id, expected, {
    status: 'rejected', rejected_at: nowOf(k), rejected_by_membership_id: membershipId, reject_reason_code: b.reason_code, reject_comment: comment ?? null,
  });
  await reviewsRepo.insertSummaryReview(rc, {
    id: uuidv7(), centre_id: row.centre_id, summary_id: row.id, action: 'rejected', reason_code: b.reason_code, ...(comment !== undefined ? { comment } : {}), actor_membership_id: membershipId,
  });
  srMetrics.review(k, 'rejected');
  return { status: 200, body: await view(k, rc, updated, { approver: true }) };
});
