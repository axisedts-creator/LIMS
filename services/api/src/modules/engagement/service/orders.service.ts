// E20 listMyOrders, E21 getMyOrder (patient actor) over the read model engagement.patient_orders / _order_specimens / _reports (02-TRD §4.4 read-time filters, §4.6 ETag, §5 E20/E21, §9.1;
// 01-PRD US-EN-07.5-7; 07-SECURITY P-L1, REQ-SEC-024). Read-only; plain SQL (no JOIN); every statement binds tenant_id besides RLS.
// Visibility (done here as well as by PAT_VIS RLS): only the caller's ACTIVE links (suspended / revoked hide the patient), visible_at >= link.visible_from, reports released_at >= visible_from,
// and (E20 list only, TRD §4.4) cancelled orders for 30 days after the cancellation was projected (updated_at); E21 shows them (deep links keep working). A foreign / hidden / unknown order is the same 404 (no existence oracle; a 304 is never sent for it).
// [CONV] profile_id = the link id, patient_id never leaves the service. [CONV] ETag = "<status_version>.<max specimen status_seq>.<report count>" (quoted); the body etag is the same value.
// [CONV] Specimens whose stage is ignored (discarded, domain/stage.ts) are neither listed nor counted; the rejection reason never leaves the service (PRD US-EN-07.4).
import { LimsError } from '../../../core/errors.js';
import { specimenStage, type SpecimenStatus } from '../domain/stage.js';
import { invalid, isUuid, type SlotCtx } from './slot.service.js';

export interface OrdersCtx extends SlotCtx { readonly claims?: { readonly membership_id?: unknown } }
type Out = { status: number; body?: Record<string, unknown>; etag?: string };
type Row = Record<string, any>;

const DAY = 86_400_000;
const CANCELLED_DAYS = 30; // TRD §4.4
const MAX_ROWS = 1000; // ponytail: the read model keeps at most ~1,000 orders per patient (backfill cap, TRD §4.4); paging is done over that window, move the keyset into SQL if it ever grows
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200;
const STAGES = ['registered', 'sample_collected', 'in_lab', 'partial_report', 'report_ready', 'recollection_needed', 'cancelled'];
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;

const iso = (v: unknown): string => new Date(v as string).toISOString();
const ms = (v: unknown): number => new Date(v as string).getTime();
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const notFound = (): never => { throw new LimsError('common.not_found'); };

export function scope(ctx: OrdersCtx): { tx: any; tenantId: string; nowMs: number; membershipId: string } {
  const m = ctx?.claims?.membership_id;
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx || typeof ctx.now !== 'function') throw new LimsError('auth.unauthenticated');
  if (ctx.actor.type !== 'patient' || typeof m !== 'string') throw new LimsError('auth.forbidden');
  return { tx: ctx.tx, tenantId: ctx.tenantId, nowMs: ms(ctx.now()), membershipId: m };
}

export interface Link { id: string; patientId: string; visibleFrom: string | null }
/** The caller's own ACTIVE links, bound to the caller's account (membership from the signed claims, never from input). */
export async function myLinks(tx: any, tenantId: string, membershipId: string): Promise<Link[]> {
  const acc = (await tx.query("SELECT id FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status <> 'deleted'", [tenantId, membershipId])).rows[0];
  if (!acc) return [];
  const { rows } = await tx.query("SELECT id, patient_id, visible_from FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = 'active'", [tenantId, acc['id']]);
  return rows.map((r: Row) => ({ id: r['id'], patientId: r['patient_id'], visibleFrom: r['visible_from'] == null ? null : iso(r['visible_from']) }));
}

const hiddenCancelled = (o: Row, nowMs: number): boolean => o['order_status'] === 'cancelled' && ms(o['updated_at']) < nowMs - CANCELLED_DAYS * DAY;
const shownAt = (o: Row): string => iso(o['registered_at'] ?? o['visible_at']); // pre_registered rows have no registered_at yet: fall back to visible_at
const centreCols = 'order_id, patient_id, source, booking_id, centre_id, order_status, registered_at, visible_at, stage, payment_due, balance_due_paisa, status_version, updated_at';

async function specimenRows(tx: any, tenantId: string, orderIds: string[]): Promise<Row[]> {
  if (orderIds.length === 0) return [];
  return (await tx.query('SELECT order_id, ordinal, status, status_seq, recollection_required, collected_at, received_at FROM engagement.patient_order_specimens WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY ordinal', [tenantId, orderIds])).rows;
}
const specimenView = (s: Row): { stage: string | null } => ({ stage: specimenStage(s['status'] as SpecimenStatus, { recollectionRequired: s['recollection_required'] === true }) });

function orderDto(o: Row, link: Link, specimenCount: number, reportCount: number, centreName?: string): Record<string, unknown> {
  const due = o['payment_due'] === true;
  return {
    order_id: o['order_id'], profile_id: link.id, registered_at: shownAt(o), stage: o['stage'], payment_due: due,
    ...(due && o['balance_due_paisa'] != null ? { balance_due: { amount_paisa: Number(o['balance_due_paisa']), currency: 'NPR' } } : {}),
    specimen_count: specimenCount, report_count: reportCount,
    ...(centreName ? { centre_display_name: centreName } : {}), ...(o['booking_id'] ? { booking_id: o['booking_id'] } : {}),
  };
}

async function centreNames(tx: any, tenantId: string, centreIds: string[]): Promise<Map<string, string>> {
  if (centreIds.length === 0) return new Map();
  const { rows } = await tx.query('SELECT centre_id, display_name FROM engagement.booking_centres WHERE tenant_id = $1 AND centre_id = ANY($2::uuid[])', [tenantId, centreIds]);
  return new Map(rows.map((r: Row) => [r['centre_id'] as string, r['display_name'] as string]));
}

function parseList(q: Record<string, any>): { profileId?: string; stage?: string; limit: number; after?: { t: number; id: string } } {
  const out: { profileId?: string; stage?: string; limit: number; after?: { t: number; id: string } } = { limit: DEFAULT_LIMIT };
  if (q['profile_id'] !== undefined) { if (!isUuid(q['profile_id'])) invalid('/profile_id'); out.profileId = q['profile_id']; }
  if (q['stage'] !== undefined) { if (typeof q['stage'] !== 'string' || !STAGES.includes(q['stage'])) invalid('/stage'); out.stage = q['stage']; }
  if (q['sort'] !== undefined && q['sort'] !== '-registered_at') invalid('/sort');
  if (q['limit'] !== undefined) { const n = Number(q['limit']); if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) invalid('/limit'); out.limit = n; }
  if (q['cursor'] !== undefined) {
    const [t, id] = typeof q['cursor'] === 'string' && CURSOR.test(q['cursor']) ? Buffer.from(q['cursor'], 'base64url').toString('utf8').split('|') : [];
    if (!t || !Number.isFinite(Date.parse(t)) || !isUuid(id)) invalid('/cursor');
    out.after = { t: Date.parse(t!), id: id! };
  }
  return out;
}

export function createOrdersService() {
  return {
    /** E20. */
    async list(ctx: OrdersCtx, req: { query: unknown }): Promise<Out> {
      const { tx, tenantId, nowMs, membershipId } = scope(ctx);
      const p = parseList(obj(req.query));
      let links = await myLinks(tx, tenantId, membershipId);
      if (p.profileId) links = links.filter((l) => l.id === p.profileId); // a foreign profile_id matches nothing (never an error that tells it exists)
      const byPatient = new Map(links.map((l) => [l.patientId, l]));
      // one query per distinct visible_from (usually just one: NULL = full history)
      const groups = new Map<string, Link[]>(); for (const l of links) groups.set(l.visibleFrom ?? '', [...(groups.get(l.visibleFrom ?? '') ?? []), l]);
      const found: Row[] = [];
      for (const [from, ls] of groups) {
        const vals: unknown[] = [tenantId, ls.map((l) => l.patientId)]; let extra = '';
        if (from) { vals.push(from); extra += ` AND visible_at >= $${vals.length}`; }
        if (p.stage) { vals.push(p.stage); extra += ` AND stage = $${vals.length}`; }
        found.push(...(await tx.query(`SELECT ${centreCols} FROM engagement.patient_orders WHERE tenant_id = $1 AND patient_id = ANY($2::uuid[])${extra} ORDER BY registered_at DESC, order_id LIMIT ${MAX_ROWS}`, vals)).rows);
      }
      const key = (o: Row) => ms(shownAt(o));
      let rows = found.filter((o) => !hiddenCancelled(o, nowMs)).sort((a, b) => key(b) - key(a) || (a['order_id'] < b['order_id'] ? -1 : a['order_id'] > b['order_id'] ? 1 : 0));
      if (p.after) { const { t, id } = p.after; rows = rows.filter((o) => key(o) < t || (key(o) === t && o['order_id'] > id)); }
      const more = rows.length > p.limit; const page = rows.slice(0, p.limit); const ids = page.map((o) => o['order_id'] as string);
      const specimens = await specimenRows(tx, tenantId, ids);
      const reports: Row[] = ids.length === 0 ? [] : (await tx.query('SELECT order_id, released_at FROM engagement.patient_reports WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids])).rows;
      const centres = await centreNames(tx, tenantId, [...new Set(page.map((o) => o['centre_id'] as string))]);
      const data = page.map((o) => {
        const link = byPatient.get(o['patient_id'])!;
        const sc = specimens.filter((s) => s['order_id'] === o['order_id'] && specimenView(s).stage !== null).length;
        const rc = reports.filter((r) => r['order_id'] === o['order_id'] && (!link.visibleFrom || ms(r['released_at']) >= ms(link.visibleFrom))).length;
        return orderDto(o, link, sc, rc, centres.get(o['centre_id']));
      });
      const last = page[page.length - 1];
      return { status: 200, body: { data, page: { limit: p.limit, ...(more && last ? { next_cursor: Buffer.from(`${shownAt(last)}|${last['order_id']}`).toString('base64url') } : {}) } } };
    },

    /** E21: 200 + ETag, or 304 when If-None-Match equals the current ETag (a hidden order is 404 before any ETag comparison). */
    async get(ctx: OrdersCtx, req: { orderId: unknown; headers: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = scope(ctx);
      if (!isUuid(req.orderId)) return invalid('/order_id');
      const links = await myLinks(tx, tenantId, membershipId);
      const o = (await tx.query(`SELECT ${centreCols} FROM engagement.patient_orders WHERE tenant_id = $1 AND order_id = $2`, [tenantId, req.orderId])).rows[0];
      const link = o ? links.find((l) => l.patientId === o['patient_id']) : undefined;
      if (!o || !link || (link.visibleFrom && ms(o['visible_at']) < ms(link.visibleFrom))) return notFound(); // no 30-day cancelled hide here: TRD §4.4 scopes it to E20 (review T-P2 #1)
      const specimens = await specimenRows(tx, tenantId, [o['order_id']]);
      const vals: unknown[] = [tenantId, o['order_id']]; let from = '';
      if (link.visibleFrom) { vals.push(link.visibleFrom); from = ' AND released_at >= $3'; }
      const reports: Row[] = (await tx.query(`SELECT report_id, version_no, order_id, report_kind, status, released_at, panel_names, smart_summary_available, supersedes_version_no FROM engagement.patient_reports WHERE tenant_id = $1 AND order_id = $2${from} ORDER BY released_at DESC, report_id, version_no`, vals)).rows;
      const etag = `"${o['status_version']}.${specimens.reduce((m, s) => Math.max(m, Number(s['status_seq'])), 0)}.${reports.length}"`;
      const sent = Object.entries(obj(req.headers)).find(([k]) => k.toLowerCase() === 'if-none-match')?.[1];
      if (sent === etag) return { status: 304, etag };
      const shown = specimens.map((s) => ({ s, stage: specimenView(s).stage })).filter((x): x is { s: Row; stage: string } => x.stage !== null);
      const centre = (await centreNames(tx, tenantId, [o['centre_id']])).get(o['centre_id']);
      return {
        status: 200, etag,
        body: {
          ...orderDto(o, link, shown.length, reports.length, centre),
          specimens: shown.map(({ s, stage }) => ({ specimen_ref: Number(s['ordinal']), stage, ...(s['collected_at'] ? { collected_at: iso(s['collected_at']) } : {}), ...(s['received_at'] ? { received_at: iso(s['received_at']) } : {}) })),
          reports: reports.map((r) => ({
            report_id: r['report_id'], version_no: Number(r['version_no']), order_id: r['order_id'], profile_id: link.id, kind: r['report_kind'], status: r['status'], released_at: iso(r['released_at']),
            panel_names: r['panel_names'] ?? [], smart_summary_available: r['smart_summary_available'] === true, ...(r['supersedes_version_no'] != null ? { supersedes_version_no: Number(r['supersedes_version_no']) } : {}),
          })),
          etag,
        },
      };
    },
  };
}
export type OrdersService = ReturnType<typeof createOrdersService>;
