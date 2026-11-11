// FD-T11: FrontdeskPort implementation (03-IC §4.3 + 08 §4.14; 02-TRD §6.1). The manifest object `frontdeskPort` has exactly the five IC methods.
// Called by other modules with a STRICT RequestContext (ctx.tx, ISO-string ctx.now(), ctx.ports): everything runs in the caller's tx under RLS with an explicit tenant filter.
// The port writes no access-log row (the calling user-facing action does, IC §4.3 invariant) and logs nothing. Authorisation order: actor kind first, then purpose permission, then input checks.
// Errors are codes with fixed text: never a name, phone or submitted value (07-SECURITY).
import { LimsError } from '../../../core/errors.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { dateOnly } from '../mappers/patient.dto.js';
import { listConsentsByPatient } from '../repository/consents.repo.js';
import { listOrderItemsByOrder } from '../repository/orderItems.repo.js';
import { getOrderById, latestAgeByPatients } from '../repository/orders.repo.js';
import { getPatientsByIds } from '../repository/patients.repo.js';
import { createOrderFromBooking, createSelfRegisteredPatient, dateCtx, forbidden, staffCtx, UUID, type PortCtx } from '../service/booking.service.js';
import { derivedStatus } from '../service/order.service.js';
import { bad, isObj, todayIn } from '../service/patient.service.js';
import { ageParts } from '../service/registration.service.js';

type Obj = Record<string, any>;
type Field = 'fullName' | 'sex' | 'ageAtOrder' | 'birthOn' | 'patientCode' | 'phoneE164' | 'email' | 'consents';
interface PurposeRule {
  readonly fields: readonly Field[];
  /** user actors need ONE of these; null = users are never allowed (system always is: its manifest list is not modelled) */
  readonly users: readonly string[] | null;
  /** non-staff actor kind that may ask for this purpose (TRD §6.1 table) */
  readonly extra?: 'device' | 'portal' | 'partner';
  readonly mask?: boolean;
}
const RULES = {
  report_render: { fields: ['fullName', 'sex', 'ageAtOrder', 'birthOn', 'patientCode'], users: ['reporting.report.read'] },
  label_print: { fields: ['fullName', 'sex', 'ageAtOrder', 'patientCode'], users: ['lab.specimen.label_print'] },
  // [CONV] TRD §6.1 says "system only" yet IC/08 case (15) has a user caller: such a user needs frontdesk.patient.read, fail closed until CR-C4-FD-T11-001 (.orchestra/cr/FD-T11.md) is ruled.
  notification: { fields: ['phoneE164', 'email', 'consents'], users: [P.patientRead] },
  instrument_host_query: { fields: ['sex', 'ageAtOrder'], users: null, extra: 'device' },
  portal_display: { fields: ['fullName', 'sex', 'ageAtOrder'], users: null, extra: 'portal', mask: true },
  partner_display: { fields: ['fullName', 'sex', 'ageAtOrder'], users: null, extra: 'partner', mask: true },
  smart_report: { fields: ['sex', 'ageAtOrder'], users: ['smartreport.summary.read'] },
  home_visit: { fields: ['fullName', 'phoneE164', 'consents', 'birthOn', 'sex'], users: ['homecollection.visit.read'] },
  result_evaluation: { fields: ['sex', 'ageAtOrder', 'birthOn'], users: ['lab.result.enter', 'lab.result.verify'] },
  lab_display: { fields: ['fullName', 'sex', 'ageAtOrder', 'patientCode'], users: ['lab.worklist.read', 'lab.status_board.read'] },
  patient_app_link: { fields: ['fullName', 'sex', 'birthOn', 'phoneE164'], users: ['engagement.link.issue'] },
} as const satisfies Record<string, PurposeRule>;
type Purpose = keyof typeof RULES;
const isPurpose = (v: unknown): v is Purpose => typeof v === 'string' && Object.hasOwn(RULES, v);

/** Actor kind, purpose, then the user's permission: any ONE alternative is enough; the last refusal is rethrown. */
async function authorisePurpose(ctx: unknown, purpose: unknown): Promise<{ c: PortCtx; purpose: Purpose }> {
  const probe = (ctx as { actor?: { type?: unknown } } | null)?.actor?.type;
  const rule: PurposeRule | undefined = isPurpose(purpose) ? RULES[purpose] : undefined;
  const c = staffCtx(ctx, rule?.extra && probe === rule.extra ? [rule.extra] : ['user', 'system']);
  if (!rule || !isPurpose(purpose)) throw bad('/purpose');
  if (c.actor.type === 'user') {
    if (!rule.users) throw forbidden();
    let refusal: unknown = forbidden();
    for (const permission of rule.users) {
      try { await c.ports.IdentityPort.assertRole(c, { permission }); return { c, purpose }; } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== 'auth.forbidden') throw e;
        refusal = e;
      }
    }
    throw refusal;
  }
  return { c, purpose };
}

const maskName = (n: string): string => n.trim().split(/\s+/u).filter(Boolean).map((w) => `${[...w][0]!.toUpperCase()}.`).join(' ');
const iso = (v: unknown): string | undefined => (v == null ? undefined : new Date(v as string).toISOString());

/** One patient row -> the purpose's allowlist (+ patientId, status for every purpose); a field outside the list is never built. */
function demographics(row: Obj, purpose: Purpose, system: boolean, consent: Obj | undefined, age: { years: number; months: number; days: number } | undefined): Obj {
  const rule: PurposeRule = RULES[purpose];
  const anonymised = row['anonymised_at'] != null;
  const out: Obj = { patientId: row['id'], status: anonymised ? 'anonymised' : 'active' };
  const present = (k: string, v: unknown) => { if (v !== null && v !== undefined) out[k] = v; };
  const userNotification = purpose === 'notification' && !system;       // CR-C6-015: consents + contactPresence only
  for (const f of rule.fields) {
    if (userNotification && (f === 'phoneE164' || f === 'email')) continue;
    switch (f) {
      case 'fullName': if (!anonymised) present('fullName', rule.mask ? maskName(String(row['full_name'] ?? '')) || undefined : row['full_name']); break;
      case 'sex': out['sex'] = row['sex']; break;
      case 'patientCode': out['patientCode'] = row['patient_code']; break;
      case 'birthOn': present('birthOn', dateOnly(row['birth_on'])); break;
      case 'phoneE164': present('phoneE164', row['phone_e164']); break;
      case 'email': present('email', row['email']); break;
      case 'ageAtOrder': present('ageAtOrder', age); break;
      case 'consents':
        out['consents'] = { sms: !anonymised && consent?.['sms'] === true, whatsapp: !anonymised && consent?.['whatsapp'] === true, email: !anonymised && consent?.['email'] === true,
          shareWithReferrer: !anonymised && consent?.['share_with_referrer'] === true, consentTextVersion: String(consent?.['consent_text_version'] ?? '') };
        break;
    }
  }
  if (userNotification) out['contactPresence'] = { phone: row['phone_e164'] != null, email: row['email'] != null };
  return out;
}

async function load(c: PortCtx, purpose: Purpose, ids: readonly string[]): Promise<Obj[]> {
  const rows = await getPatientsByIds(c.tx, c.tenantId, ids);
  const rule: PurposeRule = RULES[purpose];
  const needAge = rule.fields.includes('ageAtOrder');
  const snapshots = needAge ? await latestAgeByPatients(c.tx, c.tenantId, rows.map((r) => r['id'])) : new Map();
  const tz = (await c.ports.IdentityPort.getTenantSettings(c, { keys: ['timezone'] }))?.timezone;
  const today = todayIn(typeof tz === 'string' ? tz : 'Asia/Kathmandu', new Date(c.now()));
  const system = c.actor.type !== 'user';
  const out: Obj[] = [];
  for (const r of rows) {
    const consent = rule.fields.includes('consents') ? (await listConsentsByPatient(c.tx, c.tenantId, r['id']))[0] : undefined;
    const birth = dateOnly(r['birth_on']);
    out.push(demographics(r, purpose, system, consent, snapshots.get(r['id']) ?? (birth ? ageParts(birth, today) : undefined)));
  }
  return out;
}

async function getPatientDemographics(ctx: unknown, input: unknown): Promise<Obj> {
  const { c, purpose } = await authorisePurpose(ctx, isObj(input) ? input['purpose'] : undefined);
  const id = (input as Obj)['patientId'];
  if (typeof id !== 'string' || !UUID.test(id)) throw bad('/patientId');
  const [r] = await load(c, purpose, [id]);
  if (!r) throw new LimsError('common.not_found');
  return r;
}

async function getPatientDemographicsBatch(ctx: unknown, input: unknown): Promise<Obj[]> {
  const { c, purpose } = await authorisePurpose(ctx, isObj(input) ? input['purpose'] : undefined);
  const ids = (input as Obj)['patientIds'];
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((x) => typeof x === 'string' && UUID.test(x))) throw bad('/patientIds');
  return load(c, purpose, [...new Set(ids as string[])]);
}

async function getOrderSummary(ctx: unknown, input: unknown): Promise<Obj> {
  const c = staffCtx(ctx);
  if (c.actor.type === 'user') await c.ports.IdentityPort.assertRole(c, { permission: P.orderRead });
  const id = isObj(input) ? input['orderId'] : undefined;
  if (typeof id !== 'string' || !UUID.test(id)) throw bad('/orderId');
  const o = await getOrderById(c.tx, c.tenantId, id);
  if (!o) throw new LimsError('common.not_found');
  if (c.actor.type === 'user') {        // a centre-scoped user never sees another centre's order: 404, not 403
    const s = (await c.ports.IdentityPort.getActor(c)).centreScope;
    if (s?.all !== true && !(s?.centreIds ?? []).includes(o['centre_id'])) throw new LimsError('common.not_found');
  }
  const items = await listOrderItemsByOrder(c.tx, c.tenantId, id);
  const status = await derivedStatus(dateCtx(c) as never, o, new Set(items.filter((i) => i['status'] === 'active').map((i) => i['id'])));
  const opt = (k: string, v: unknown) => (v == null ? {} : { [k]: v });
  return {
    orderId: o['id'], registrationNo: o['registration_no'], patientId: o['patient_id'], branchId: o['branch_id'], centreId: o['centre_id'], visitType: o['visit_type'], billingMode: o['billing_mode'],
    ...opt('creditPartyId', o['credit_party_id']), ...opt('referrerId', o['referrer_id']), priority: o['priority'], status, source: o['source'], ...opt('sourceRefId', o['source_ref_id']),
    items: items.map((i) => ({ orderItemId: i['id'], orderableId: i['orderable_id'], orderableKind: i['orderable_kind'], testIds: i['test_ids'] ?? [], priority: i['priority'], status: i['status'], outsourced: i['outsourced'] === true })),
    ...opt('registeredAt', iso(o['registered_at'])), version: Number(o['version']), ...opt('partnerId', o['partner_id']),
  };
}

export const frontdeskPort = { getOrderSummary, getPatientDemographics, createOrderFromBooking, getPatientDemographicsBatch, createSelfRegisteredPatient } as const;
