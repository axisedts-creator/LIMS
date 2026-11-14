// C17 mutation type registry + payload validators. Mirrors contracts/openapi/homecollection.yaml Mutation* payloads
// (additionalProperties:false; _common.yaml Uuid/Uuidv7/Code/DecimalString). Pure, never throws: device input is untrusted.
export type MutationType =
  | 'visit.arrived' | 'visit.identity_checked' | 'visit.consent_recorded' | 'specimen.collected' | 'specimen.not_collected'
  | 'payment.captured' | 'visit.completed' | 'visit.failed' | 'handover.recorded';
export const MUTATION_TYPES: readonly MutationType[] = [
  'visit.arrived', 'visit.identity_checked', 'visit.consent_recorded', 'specimen.collected', 'specimen.not_collected',
  'payment.captured', 'visit.completed', 'visit.failed', 'handover.recorded',
];
export type MutationValidation = { ok: true } | { ok: false; errors: readonly string[] };

export const isMutationType = (x: unknown): x is MutationType => typeof x === 'string' && (MUTATION_TYPES as readonly string[]).includes(x);
export const mutationRequiresVisitId = (type: MutationType): boolean => type !== 'handover.recorded';

type Obj = Record<string, unknown>;
type Check = (v: unknown) => boolean;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (min: number, max: number, re?: RegExp): Check => (v) => typeof v === 'string' && v.length >= min && v.length <= max && (!re || re.test(v));
const int = (min: number, max: number): Check => (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const oneOf = (...vals: string[]): Check => (v) => typeof v === 'string' && vals.includes(v);
const bool: Check = (v) => typeof v === 'boolean';
const uuid = str(36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const uuidv7 = str(36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const code = str(1, 100, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const decimal = str(1, 40, /^-?[0-9]+(\.[0-9]+)?$/);
const reasonCode = str(1, 64, /^[a-z0-9_]{1,64}$/);
const text200 = str(1, 200);

/** Closed object: every key in `req` must be present, every other key must be in `opt`; each value passes its check. */
const shape = (req: Record<string, Check>, opt: Record<string, Check> = {}): Check => (v) => {
  if (!isObj(v)) return false;
  const all = { ...req, ...opt };
  return Object.keys(req).every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => Object.hasOwn(all, k) && all[k]!(v[k]));
};

const gps: Check = (v) => {
  if (!isObj(v) || !oneOf('off', 'denied', 'unavailable', 'ok')(v.status)) return false;
  if (v.status !== 'ok' && ('latitude' in v || 'longitude' in v || 'accuracy_m' in v)) return false;
  return shape({ status: oneOf('off', 'denied', 'unavailable', 'ok') }, { latitude: decimal, longitude: decimal, accuracy_m: int(0, 10000) })(v);
};
const money = shape({ amount_paisa: int(1, 50_000_000), currency: oneOf('NPR') });

const SCHEMAS: Record<MutationType, Check> = {
  'visit.arrived': shape({ gps }),
  'visit.identity_checked': shape({ name_check: oneOf('matches', 'mismatch'), second_identifier: oneOf('phone', 'birth_date'), second_check: oneOf('matches', 'mismatch') }),
  'visit.consent_recorded': shape({ consent_text_version: str(1, 40), given: bool }),
  'specimen.collected': shape({ specimen_id: uuid, scanned_barcode: str(1, 20, /^[A-Z0-9]{1,20}$/), scan_method: oneOf('camera', 'hid', 'manual'), specimen_type_code: code, gps }),
  'specimen.not_collected': shape({ specimen_id: uuid, reason_code: reasonCode }, { reason_text: text200 }),
  'payment.captured': shape({ order_id: uuid, payment_method_code: code, amount: money }, { reference: str(1, 100) }),
  'visit.completed': shape({ outcome: oneOf('collected', 'partial') }),
  'visit.failed': shape({ reason_code: reasonCode, gps }, { reason_text: text200 }),
  'handover.recorded': shape({
    handover_id: uuidv7, to_centre_id: uuid,
    specimen_ids: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 50 && v.every(uuid),
  }),
};

export function validateMutationPayload(type: unknown, payload: unknown): MutationValidation {
  if (!isMutationType(type)) return { ok: false, errors: ['type: unknown mutation type'] };
  if (!isObj(payload)) return { ok: false, errors: ['payload: must be an object'] };
  return SCHEMAS[type](payload) ? { ok: true } : { ok: false, errors: [`payload: does not match ${type}`] };
}
