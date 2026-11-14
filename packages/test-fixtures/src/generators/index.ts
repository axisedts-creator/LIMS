// @lims/test-fixtures `generators/*` (C0 02-TRD §3.5; AC-0C-3.2; REQ-SEC-136). Pure + seeded: same input -> same data.
// Volume: 1x = 500 patients/day (04 §14), 10x = 5000/day. Feature chunks' domain generators are added in the contract wave.
import { createSeededUuidv7, isUuidv7 } from '../../../shared-ts/src/uuidv7/index.ts';

/** Phone prefix for every generated number (one fixed non-Nepali prefix; TRD §3.5). */
export const SAFE_PHONE_PREFIX = '+999';
/** Where/when the prefix was checked against the ITU-T E.164 assigned-codes list (TRD §3.5). */
export const SAFE_PHONE_PREFIX_SOURCE = {
  url: 'https://www.itu.int/pub/T-SP-E.164D',
  // LD-22 (2026-11-07): fetched https://www.itu.int/dms_pub/itu-t/opb/sp/T-SP-E.164D-2016-PDF-E.pdf on this date.
  checkedOn: '2026-11-07',
  note: 'ITU-T E.164 assigned country codes, Annex to ITU OB 1114 (position 15 Dec 2016), numerical list p.9: "999 Reserved for future global service" - not assigned to any country or operator, so no real subscriber. Edition is the latest found on the ITU page (2016); re-check if ITU publishes a newer list.',
} as const;

export const PATIENTS_PER_DAY = { '1x': 500, '10x': 5000 } as const;
export type Scale = keyof typeof PATIENTS_PER_DAY;

export interface Patient { readonly id: string; readonly tenantId: string; readonly name: string; readonly email: string; readonly phone: string }
export interface Order { readonly id: string; readonly tenantId: string; readonly patientId: string }
export interface Specimen { readonly id: string; readonly tenantId: string; readonly orderId: string }
export interface Result { readonly id: string; readonly tenantId: string; readonly specimenId: string }
export interface Invoice { readonly id: string; readonly tenantId: string; readonly orderId: string }
export interface Dataset {
  readonly patients: Patient[]; readonly orders: Order[]; readonly specimens: Specimen[];
  readonly results: Result[]; readonly invoices: Invoice[];
}

/** Fixed epoch for generated ids: 2026-01-01T00:00:00Z (never the wall clock). */
const START_MS = 1767225600000;

/** FNV-1a over the tenant id, so the same seed in two tenants gives disjoint id streams. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32 [CONV] for small per-row choices (counts); ids come from the seeded UUIDv7 fake. */
function prng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

export function generateDataset(opts: { seed: number; tenantId: string; scale: Scale; days?: number }): Dataset {
  const { seed, tenantId, scale, days = 1 } = opts;
  if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer');
  if (!isUuidv7(tenantId)) throw new RangeError('tenantId must be a UUIDv7');
  if (!Object.hasOwn(PATIENTS_PER_DAY, scale)) throw new RangeError(`scale must be one of ${Object.keys(PATIENTS_PER_DAY).join(', ')}`);
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('days must be a positive integer');

  const mixed = (seed ^ hash32(tenantId)) >>> 0;
  const id = createSeededUuidv7({ seed: mixed, startMs: START_MS });
  const pick = prng(mixed ^ 0x5bd1e995);
  const d: Dataset = { patients: [], orders: [], specimens: [], results: [], invoices: [] };
  const n = PATIENTS_PER_DAY[scale] * days;

  for (let i = 1; i <= n; i++) {
    const seq = String(i).padStart(4, '0');
    const patient: Patient = {
      id: id(), tenantId,
      name: `Test Patient ${seq}`,
      email: `test.patient.${seq}@example.invalid`,
      // +999 then 9 digits from the patient number: unique per dataset, never Nepali-looking.
      phone: `${SAFE_PHONE_PREFIX}${String(i).padStart(9, '0')}`,
    };
    d.patients.push(patient);
    const order: Order = { id: id(), tenantId, patientId: patient.id };
    d.orders.push(order);
    d.invoices.push({ id: id(), tenantId, orderId: order.id });
    for (let s = 1 + pick(2); s > 0; s--) {
      const specimen: Specimen = { id: id(), tenantId, orderId: order.id };
      d.specimens.push(specimen);
      for (let r = 1 + pick(3); r > 0; r--) d.results.push({ id: id(), tenantId, specimenId: specimen.id });
    }
  }
  return d;
}
