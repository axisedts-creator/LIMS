// T-10: #14 printSpecimenLabels (label data + the ONLY label_print_count / last_label_printed_at / access-log `specimen_label.print` point) and
// #14a requestOrderLabelPrint (readiness only: writes nothing — 08 A13 D-4, no key, no counter, no access log). 02-TRD §4.6, §5.1 rows 14/14a.
// Runs in the caller's transaction (ctx.tx): a failure after counting rolls count + audit back. Tenant/actor from ctx only (REQ-SEC-024).
import { LimsError } from '../../../core/errors.js';
import { getLabSettings } from '../repository/labSettings.repo.js';
import { getOrder } from '../repository/orders.repo.js';
import { bumpLabelPrint, listSpecimensByOrder, listSpecimensWithOrderByIds, listTestLabelsOfSpecimens } from '../repository/specimens.repo.js';
import { bad, BULK_MAX, repoCtx, role, scopeOf, specimenCtx, strict, UUID, uuidParam, visible, type Obj, type SpecimenCtx } from './specimen.service.js';

const PRINT = 'lab.specimen.label_print';
const MAX_CODES = 4;                         // [CONV] 02-TRD §4.6 "up to 4 test codes then +n"
const LABELS_ROUTE = 'staff.lab.order_labels';
interface Result { readonly status: number; readonly body: unknown }
type Demo = { fullName?: string; sex?: string; ageAtOrder?: { years?: number; months?: number; days?: number } };
type Ctx = SpecimenCtx & { readonly ports: SpecimenCtx['ports'] & { readonly IdentityPort: { getTenantSettings?(ctx: unknown, i: { keys: readonly string[] }): Promise<{ timezone?: unknown } | undefined> } } & { readonly FrontdeskPort?: {
  getPatientDemographicsBatch?(ctx: unknown, i: { patientIds: string[]; purpose: string }): Promise<readonly (Demo & { patientId: string })[]>;
  getOrderSummary(ctx: unknown, i: { orderId: string }): Promise<unknown>;
} } };

/** "43Y/F": years, else months, else days (+ sex initial). Only FrontdeskPort data (never stored by C5, 02-TRD §4 patient_display). */
export function ageSex(d: Demo): string {
  const a = d.ageAtOrder ?? {};
  const age = (a.years ?? 0) > 0 ? `${a.years}Y` : (a.months ?? 0) > 0 ? `${a.months}M` : a.days !== undefined ? `${a.days}D` : '';
  const s = typeof d.sex === 'string' && d.sex ? d.sex[0]!.toUpperCase() : '';
  return [age, s].filter(Boolean).join('/').slice(0, 32);
}

/** Calendar date of an instant in the tenant timezone (fallback UTC). */
async function dateIn(c: Ctx, iso: string): Promise<string> {
  let tz = 'UTC';
  try { const s = await c.ports.IdentityPort.getTenantSettings?.(c, { keys: ['timezone'] }); if (typeof s?.timezone === 'string') tz = s.timezone; } catch { /* tz stays UTC */ }
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
}

function parseBody(body: unknown): { orderId?: string; ids?: string[]; copies?: number } {
  const b = strict(body, ['order_id', 'specimen_ids', 'copies']);
  if ((b['order_id'] === undefined) === (b['specimen_ids'] === undefined)) throw bad('/order_id', '/specimen_ids');      // exactly one
  const out: { orderId?: string; ids?: string[]; copies?: number } = {};
  if (b['order_id'] !== undefined) {
    if (typeof b['order_id'] !== 'string' || !UUID.test(b['order_id'])) throw bad('/order_id');
    out.orderId = b['order_id'].toLowerCase();
  } else {
    const a = b['specimen_ids'];
    if (!Array.isArray(a) || a.length < 1 || a.length > BULK_MAX || a.some((x) => typeof x !== 'string' || !UUID.test(x))) throw bad('/specimen_ids');
    out.ids = [...new Set((a as string[]).map((x) => x.toLowerCase()))];
  }
  if (b['copies'] !== undefined) {
    const n = b['copies'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 5) throw bad('/copies');
    out.copies = n;
  }
  return out;
}

// ---- #14 ----
export async function printSpecimenLabels(hctx: unknown, body: unknown): Promise<Result> {
  const c = specimenCtx(hctx) as Ctx;
  await role(c, PRINT);
  const p = parseBody(body);
  const rc = repoCtx(c);
  const scope = await scopeOf(c);
  const settings = await getLabSettings(rc);                                          // missing row = column defaults (05 §1)
  const size = { width_mm: Number(settings?.['label_width_mm'] ?? 50), height_mm: Number(settings?.['label_height_mm'] ?? 25) };
  const copiesDefault = Number(settings?.['label_copies_default'] ?? 1);

  const errors: { id: string; code: string }[] = [];
  let rows: Obj[];
  if (p.orderId) {
    const order = await getOrder(rc, p.orderId);
    if (!order || !visible(scope, order)) throw new LimsError('common.not_found');    // other tenant / centre: never 403
    rows = (await listSpecimensByOrder(rc, p.orderId)).map((r) => ({ ...r, registration_no: order['registration_no'] }));
  } else {
    const found = new Map((await listSpecimensWithOrderByIds(rc, p.ids!)).map((r) => [r['id'] as string, r]));
    rows = [];
    for (const id of p.ids!) {
      const r = found.get(id);
      if (!r || !visible(scope, r)) errors.push({ id, code: 'common.not_found' });    // P-04: invisible = absent
      else rows.push(r);
    }
  }
  const active = rows.filter((r) => r['is_active'] === true);
  for (const r of rows) if (r['is_active'] !== true) errors.push({ id: r['id'], code: 'lab.specimen_inactive' });    // AC-02.5: per id, nothing written for it

  const tests = new Map<string, { code: string; urgent: boolean }[]>();
  for (const t of await listTestLabelsOfSpecimens(rc, active.map((r) => r['id']))) {
    (tests.get(t['specimen_id']) ?? tests.set(t['specimen_id'], []).get(t['specimen_id'])!).push({ code: t['test_code'], urgent: t['priority'] === 'urgent' });
  }
  const demos = new Map<string, Demo>();
  const patientIds = [...new Set(active.map((r) => r['patient_id'] as string))];
  if (patientIds.length) {
    const port = c.ports.FrontdeskPort?.getPatientDemographicsBatch;
    if (!port) throw new LimsError('common.internal');
    for (const d of await port.call(c.ports.FrontdeskPort, c, { patientIds, purpose: 'label_print' })) demos.set(d.patientId, d);
  }

  const labels: Obj[] = [];
  for (const r of active) {
    const d = demos.get(r['patient_id']);
    if (!d || typeof d.fullName !== 'string') { errors.push({ id: r['id'], code: 'common.not_found' }); continue; }    // patient not visible: no label, no count
    const t = tests.get(r['id']) ?? [];
    labels.push({
      specimen_id: r['id'], barcode: r['barcode'], patient_name: d.fullName.slice(0, 200), age_sex: ageSex(d), registration_no: r['registration_no'],
      specimen_type_code: r['specimen_type_code'], ...(r['container_code'] ? { container_code: r['container_code'] } : {}),
      ...(r['collected_at'] ? { collected_on: await dateIn(c, new Date(r['collected_at']).toISOString()) } : {}),
      test_codes: t.slice(0, MAX_CODES).map((x) => x.code), more_tests: Math.max(0, t.length - MAX_CODES), urgent: t.some((x) => x.urgent),
      copies: p.copies ?? copiesDefault,
    });
  }

  // counter + access log: only here, once per printed specimen (not per copy); ids sorted so concurrent prints lock rows in one order
  const printed = labels.map((l) => l['specimen_id'] as string).sort();
  const written = new Set(await bumpLabelPrint(rc, printed, c.now().toISOString()));
  const byId = new Map(active.map((r) => [r['id'] as string, r]));
  for (const id of printed) {
    if (!written.has(id)) throw new LimsError('common.internal');
    // [CONV] detail carries no barcode / name / PHI (07-SECURITY S-10)
    await c.audit.access({ action: 'specimen_label.print', entityType: 'specimen', entityId: id, centreId: byId.get(id)!['centre_id'], outcome: 'allowed' });
  }
  return { status: 200, body: { labels, errors, size, label_copies_default: copiesDefault } };
}

// ---- #14a ----
export async function requestOrderLabelPrint(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  const c = specimenCtx(hctx) as Ctx;
  await role(c, PRINT);
  const orderId = uuidParam(params, 'order_id');
  strict(body === undefined ? {} : body, []);                                          // `{}` only
  const rc = repoCtx(c);
  const order = await getOrder(rc, orderId);
  if (order && !visible(await scopeOf(c), order)) throw new LimsError('common.not_found');
  const specimens = order ? await listSpecimensByOrder(rc, orderId) : [];
  if (!order || specimens.length === 0) {
    // lab.orders row not there yet (consumer still running) vs. an order the caller can never see: only the Frontdesk port knows (RLS-scoped; throws common.not_found).
    if (!order) await c.ports.FrontdeskPort?.getOrderSummary(c, { orderId });
    throw new LimsError('common.version_conflict', 'specimens not created yet');       // 08 A2.10; retry needs no key; nothing written
  }
  return { status: 200, body: { order_id: orderId, labels_route: LABELS_ROUTE,
    specimens: specimens.map((s) => ({ specimen_id: s['id'], barcode: s['barcode'], outcome: s['is_active'] === true ? 'ready' : 'inactive' })) } };
}
