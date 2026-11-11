// T-27: reporting.report.released.v1 consumer (A8, 02-TRD §7.2 row 9, "one rule") + status board read (#17, 02-TRD §5.2 row 17; 03-APP-FLOW §1.5; PRD AC-18.1..18.4).
// Both run in one transaction of the caller (job tx / request tx): any throw rolls everything back (retry / dead letter, never a half-applied release).
// REQ-SEC-024: tenant and actor come from ctx only; every statement filters tenant_id (repository) on top of RLS.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/specimen.mapper.js';
import { insertReleaseOnce, lockApprovedSpecimensOfItems, markOrderTestsReported, maxReleasedVersion, orderExists, pageStatusBoard } from '../repository/reportReleases.repo.js';
import { ageSex } from './label.service.js';
import { bad, emitStatus, ISO_MS, repoCtx, role, scopeOf, specimenCtx, step, strict, UUID, type Obj, type SpecimenCtx } from './specimen.service.js';

// ====================================================================== A8 consumer ======================================================================
export interface ReportReleasedEnvelope {
  readonly event_id: string;
  readonly payload: {
    readonly report_id: string; readonly version_no: number; readonly order_id: string; readonly report_kind: string; readonly released_at: string;
    readonly release_basis: string; readonly order_item_ids?: readonly string[];
  };
}
export interface ReportReleasedCtx {
  readonly tenantId: string;
  readonly actor: { readonly type?: string; readonly id: string };
  readonly tx: SpecimenCtx['tx'];
  readonly events: SpecimenCtx['events'];
  now(): Date;
  readonly log?: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void };
}

/**
 * The one rule (02-TRD §7.2 / PRD AC-18.3), always after recording the release (report_kind as received, no closed CHECK — 08 A13 P-4):
 *  - preliminary: recorded only (no S10, no reported_at, no event);
 *  - partial: S10 + reported_at only for the listed order_item_ids (absent list: no change);
 *  - final / amended / addendum / any other kind: S10 + reported_at for the listed items, or for all items of the order when the list is absent.
 * S10 = approved -> reported of the active `approved` specimens, reported_at = payload.released_at. Order tests keep status `approved` (the CHECK has no `reported`).
 * Redelivery (same report_id + version_no) is a no-op; an older version_no than one already recorded is recorded but moves nothing; an order that does not exist for the tenant is skipped.
 */
export async function applyReportReleased(ctx: ReportReleasedCtx, env: ReportReleasedEnvelope): Promise<void> {
  const c = ctx as unknown as SpecimenCtx;
  const rc = repoCtx(c);
  const p = env.payload;
  if (!(await orderExists(rc, p.order_id))) { ctx.log?.warn?.('report released: order not found for tenant, skipped', { order_id: p.order_id }); return; }   // P-11: another tenant's order is absent under RLS
  const newest = await maxReleasedVersion(rc, p.report_id);
  const items = Array.isArray(p.order_item_ids) ? [...new Set(p.order_item_ids)] : null;
  const row = await insertReleaseOnce(rc, { id: uuidv7(), orderId: p.order_id, reportId: p.report_id, versionNo: p.version_no, reportKind: p.report_kind, releasedAt: p.released_at,
    releaseBasis: p.release_basis, orderItemIds: items, eventId: env.event_id });
  if (!row) return;                                                                          // redelivery: the release already moved the specimens
  if (newest !== null && newest > p.version_no) return;                                      // an older version of the report never moves anything
  if (p.report_kind === 'preliminary') return;
  if (p.report_kind === 'partial' && items === null) return;
  const at = new Date(p.released_at).toISOString();
  for (const sp of await lockApprovedSpecimensOfItems(rc, p.order_id, items)) {
    const s10 = await step(c, sp, Number(sp['version']), 'reported', { reported_at: at }, at);
    await emitStatus(c, s10.updated, 'approved', 'reported', at);
  }
  await markOrderTestsReported(rc, p.order_id, items, at);
}

// ====================================================================== #17 getStatusBoard ======================================================================
const P_BOARD = 'lab.status_board.read';
const DAY_MS = 86_400_000;
const STATUSES = ['collected', 'in_lab', 'ready', 'printed', 'waiting'];
const SORT = '-registered_at';
type Demo = { patientId: string; fullName?: string; sex?: string; ageAtOrder?: { years?: number; months?: number; days?: number } & Obj; patientCode?: string };
type BoardCtx = SpecimenCtx & { readonly ports: SpecimenCtx['ports'] & { readonly FrontdeskPort?: {
  getPatientDemographicsBatch?(ctx: unknown, i: { patientIds: string[]; purpose: string }): Promise<readonly Demo[]>;
} } };

function parseBoardQuery(q: unknown) {
  const b = strict(q, ['centre_id', 'registered_at_from', 'registered_at_to', 'board_status', 'cursor', 'limit']);
  const instant = (k: string): string | undefined => {
    const x = b[k];
    if (x === undefined) return undefined;
    if (typeof x !== 'string' || !ISO_MS.test(x) || Number.isNaN(Date.parse(x)) || new Date(x).toISOString() !== x) throw bad(`/${k}`);
    return x;
  };
  const from = instant('registered_at_from');
  if (from === undefined) throw bad('/registered_at_from');
  const to = instant('registered_at_to') ?? new Date(Date.parse(from) + 7 * DAY_MS).toISOString();
  const span = Date.parse(to) - Date.parse(from);
  if (span < 0 || span > 7 * DAY_MS) throw bad('/registered_at_to');                       // S-11 / REQ-SEC-100: [CONV] span <= 7 days
  let centreId: string | undefined;
  if (b['centre_id'] !== undefined) { if (typeof b['centre_id'] !== 'string' || !UUID.test(b['centre_id'])) throw bad('/centre_id'); centreId = b['centre_id'].toLowerCase(); }
  let statuses: string[] | undefined;
  if (b['board_status'] !== undefined) {
    const parts = typeof b['board_status'] === 'string' && b['board_status'].length <= 200 ? b['board_status'].split(',') : [];
    if (parts.length === 0 || !parts.every((s) => STATUSES.includes(s))) throw bad('/board_status');
    statuses = [...new Set(parts)];
  }
  const raw = b['limit'];
  const limit = raw === undefined ? 50 : typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw bad('/limit');
  const after = b['cursor'] === undefined ? undefined : decodeCursor(b['cursor'], SORT);
  return { from, to, centreId, statuses, limit: limit as number, after };
}

export async function getStatusBoard(hctx: unknown, query: unknown): Promise<{ status: number; body: unknown }> {
  const c = specimenCtx(hctx) as BoardCtx;
  await role(c, P_BOARD);
  const q = parseBoardQuery(query);                                                          // before any query or port call
  const scope = await scopeOf(c);                                                            // no scope = no centre (fail closed): the SQL gets an empty list
  const rows = await pageStatusBoard(repoCtx(c), { from: q.from, to: q.to, ...(q.centreId ? { centreId: q.centreId } : {}), ...(scope.all ? {} : { scopeCentreIds: scope.centreIds }) },
    { limit: q.limit, ...(q.statuses ? { statuses: q.statuses } : {}), ...(q.after ? { after: q.after } : {}) });
  const page = rows.slice(0, q.limit);
  const demos = new Map<string, Demo>();
  const patientIds = [...new Set(page.map((r) => r['patient_id'] as string))];
  if (patientIds.length) {
    const port = c.ports.FrontdeskPort?.getPatientDemographicsBatch;
    if (!port) throw new LimsError('common.internal');
    for (const d of await port.call(c.ports.FrontdeskPort, c, { patientIds, purpose: 'lab_display' })) demos.set(d.patientId, d);   // CR-C5-003: one batch call per page, never stored
  }
  const last = page[page.length - 1];
  return { status: 200, body: {
    data: page.map((r) => {
      const d = demos.get(r['patient_id']);
      return {
        order_id: r['order_id'], registration_no: r['registration_no'],
        // a patient FrontdeskPort does not return is shown as a placeholder (the order must stay on the board), never guessed
        patient_display: { full_name: typeof d?.fullName === 'string' ? d.fullName.slice(0, 200) : '—', age_sex: d ? ageSex(d) : '', patient_code: typeof d?.patientCode === 'string' ? d.patientCode.slice(0, 40) : '' },
        centre_id: r['centre_id'], board_status: r['board_status'], rejected_specimens: Number(r['rejected_specimens']),
        ...(r['last_released_at'] ? { last_released_at: new Date(r['last_released_at']).toISOString() } : {}), priority: r['priority'],
      };
    }),
    page: { limit: q.limit, ...(rows.length > q.limit && last ? { next_cursor: encodeCursor(SORT, last['sort_key'], last['order_id']) } : {}) },
  } };
}
