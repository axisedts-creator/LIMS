// C13 T10 — manifest line -> C4 order (02-TRD §6.2 BookingOrderInput, §8.1 partners.convert_manifest_line; 03-APP-FLOW §2.2 LS5-LS7, §4.2 steps 1-6; US-06.3-06.8, US-06.10).
// The worker task (services/worker/src/jobs/partners/tasks/partners.convert_manifest_line.ts) is a thin wrapper over convertLine().
// One delivery = one transaction (ctx.tx). The FrontdeskPort call runs inside ctx.db.tx (a savepoint): when C4 throws, whatever it wrote is rolled back
// before the line is marked conversion_failed (08 A19 P-44, 07-SECURITY ST18). Business failure (by error CODE) -> conversion_failed, resolve (no retry);
// anything else -> rethrow the original error (the queue retries; nothing is committed, the line stays converting). No patient data is logged.
import type { BookingOrderInput } from '../../../../../../contracts/ports/FrontdeskPort.js';
import { lineConversion, M, observe } from './observability.js';

type Row = Record<string, any>;
type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> };
type FrontdeskLike = { createOrderFromBooking(ctx: unknown, input: BookingOrderInput): Promise<{ orderId: string; registrationNo: string }> };
export interface ConversionCtx {
  readonly tenantId: string | undefined;
  readonly actor: { readonly id: string };
  readonly tx: Q;
  readonly db: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly ports: Record<string, unknown>;
  now(): string;
  readonly metrics?: unknown; // T23 (same seam as report.service.ts); emitted through service/observability.ts, which never throws
}

/** errors.yaml code shape only (bounded label); anything else (plain Error, message, host) is dropped. */
const boundedCode = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : undefined;
};

const pad = (n: number): string => String(n).padStart(2, '0');
/** pg `date` arrives as local midnight (as mappers/manifest.dto.ts); strings pass through. */
const day = (v: Date | string): string => (typeof v === 'string' ? v.slice(0, 10) : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`);
const has = (v: unknown): boolean => v !== null && v !== undefined;

/** TRD §6.2, exactly. Pure. Keys without a value are omitted. clinical_note / collected_at / manifest notes are not sent (D-102).
 *  referrerDoctorId = mapped catalog_doctor_id of line.referrer_id (TRD: `referrerId` = mapped doctor, else omitted). */
export function buildBookingOrderInput(line: Row, partner: Row, manifest: Row, referrerDoctorId?: string | null): BookingOrderInput {
  const patient: BookingOrderInput['patient'] = has(line['resolved_patient_id'])
    ? { patientId: line['resolved_patient_id'] }
    : { newPatient: {
      fullName: line['patient_full_name'], sex: line['patient_sex'],
      ...(has(line['patient_birth_on']) ? { birthOn: day(line['patient_birth_on']) } : { ageYears: Number(line['patient_age_years']) }),
      ...(has(line['patient_phone_e164']) ? { phoneE164: line['patient_phone_e164'] } : {}),
      consents: { sms: line['consent_sms'] === true, whatsapp: line['consent_whatsapp'] === true, email: line['consent_email'] === true, shareWithReferrer: line['consent_share_with_referrer'] === true, consentTextVersion: line['consent_text_version'] },
    } };
  return {
    source: 'partner_manifest', sourceRefId: line['id'], patient,
    branchId: manifest['receiving_branch_id'], centreId: manifest['receiving_centre_id'],
    ...(referrerDoctorId ? { referrerId: referrerDoctorId } : {}),
    creditPartyId: partner['credit_party_id'], partnerId: partner['id'],
    orderableIds: [...line['orderable_ids']], priority: line['priority'], confirmImmediately: true,
    idempotencyKey: `partners:${line['id']}:v${Number(line['conversion_attempt'])}`, // per conversion attempt, not per queue attempt (US-06.6)
  };
}

/** Business failure = C4 / catalog refusal of THIS input (classified by code: the port throws the contracts LimsError, not core's). */
export const isBusinessFailure = (e: unknown): e is { code: string } => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('frontdesk.') || code.startsWith('catalog.') || code === 'common.validation_failed');
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** TRD §8.1 / 03-APP-FLOW §4.2. Payload {tenant_id, line_id, attempt}: ids only; partner / centre / credit party come from the locked rows. */
export async function convertLine(payload: Record<string, unknown>, ctx: ConversionCtx): Promise<void> {
  const t = ctx.tenantId; const lineId = payload['line_id']; const attempt = payload['attempt'];
  // [CONV] a malformed payload is a producer bug: reject (retry -> dead-letter, visible) instead of silently acking. Ids only in the message.
  if (typeof lineId !== 'string' || !UUID.test(lineId) || !Number.isInteger(attempt) || (attempt as number) < 1) throw new Error('partners.convert_manifest_line: malformed payload');
  if (!t || payload['tenant_id'] !== t) return; // another tenant's job: no-op (US-06.10)
  const tx = ctx.tx;
  // 1. lock the line FIRST: a duplicate delivery waits here, then sees `converted` and stops
  const line = (await tx.query('SELECT * FROM partners.manifest_lines WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [t, lineId])).rows[0];
  if (!line || line['state'] !== 'converting' || Number(line['conversion_attempt']) !== attempt) return; // stale / duplicate (US-06.4)
  const manifest = (await tx.query('SELECT * FROM partners.manifests WHERE tenant_id = $1 AND id = $2', [t, line['manifest_id']])).rows[0];
  const partner = manifest && (await tx.query('SELECT id, credit_party_id FROM partners.partners WHERE tenant_id = $1 AND id = $2', [t, manifest['partner_id']])).rows[0];
  if (!manifest || !partner) throw new Error('partners.convert_manifest_line: manifest or partner row missing'); // FK-guaranteed; infra if it ever happens

  // 2. referrer rule (03-APP-FLOW §4.2 step 2)
  let doctorId: string | null = null;
  if (has(line['referrer_id'])) {
    const ref = (await tx.query('SELECT mapping_state, catalog_doctor_id FROM partners.partner_referrers WHERE tenant_id = $1 AND id = $2', [t, line['referrer_id']])).rows[0];
    doctorId = ref?.['mapping_state'] === 'mapped' && has(ref['catalog_doctor_id']) ? ref['catalog_doctor_id'] : null;
    if (!doctorId) {
      const s = (await tx.query('SELECT require_mapped_referrer FROM partners.settings WHERE tenant_id = $1', [t])).rows[0];
      if (s?.['require_mapped_referrer'] === true) { lineConversion(ctx, 'failed_business', 'partners.referrer_not_mapped'); return fail(ctx, t, lineId, 'partners.referrer_not_mapped'); } // LS6, no port call
    }
  }

  // 3. port call inside a savepoint (P-44)
  const input = buildBookingOrderInput(line, partner, manifest, doctorId);
  const port = ctx.ports['FrontdeskPort'] as FrontdeskLike;
  let order: { orderId: string; registrationNo: string; replayed?: boolean };
  const t0 = performance.now(); // T23: real clock (ctx.now() is the job's logical time); one duration per attempt that reached the port and finished
  try {
    order = await ctx.db.tx((c) => port.createOrderFromBooking(c, input));
  } catch (e) {
    if (isBusinessFailure(e)) { observe(ctx, M.conversionDuration, (performance.now() - t0) / 1000); lineConversion(ctx, 'failed_business', e.code); return fail(ctx, t, lineId, e.code); } // LS6: savepoint already rolled back by the throw
    lineConversion(ctx, 'failed_infra', boundedCode(e)); // T23: no message / host in a label
    throw e; // LS: stays converting; the queue retries with backoff (US-06.8)
  }
  observe(ctx, M.conversionDuration, (performance.now() - t0) / 1000);
  lineConversion(ctx, order.replayed === true ? 'replayed' : 'converted'); // T23: the port answered replayed:true = an earlier committed call

  // 4. LS5 + one tracking row (replay of the same key returns the same order: ON CONFLICT keeps one row)
  const now = ctx.now();
  await tx.query(
    "UPDATE partners.manifest_lines SET state = 'converted', order_id = $3, registration_no = $4, converted_at = $5, failure_code = NULL, failed_at = NULL, version = version + 1, updated_at = now(), updated_by = $6 "
    + "WHERE tenant_id = $1 AND id = $2 AND state = 'converting'",
    [t, lineId, order.orderId, order.registrationNo, now, ctx.actor.id]);
  await tx.query(
    'INSERT INTO partners.order_tracking (tenant_id, order_id, partner_id, line_id, manifest_id, receiving_centre_id, registration_no, tracking_status, registered_at, last_event_at, created_by, updated_by) '
    + "VALUES ($1, $2, $3, $4, $5, $6, $7, 'registered', $8, $8, $9, $9) ON CONFLICT DO NOTHING",
    [t, order.orderId, partner['id'], lineId, manifest['id'], manifest['receiving_centre_id'], order.registrationNo, now, ctx.actor.id]);
}

async function fail(ctx: ConversionCtx, t: string, lineId: string, code: string): Promise<void> {
  await ctx.tx.query(
    "UPDATE partners.manifest_lines SET state = 'conversion_failed', failure_code = $3, failed_at = $4, version = version + 1, updated_at = now(), updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND state = 'converting'",
    [t, lineId, code, ctx.now(), ctx.actor.id]);
}
