// C16 T-PERF1 — seed generator for the 02-TRD §12 load test. Synthetic data only (LD-184: tester-owned test-folder file).
// generateSeed({ scale, rngSeed }) -> { scale, counts, tenants, probe }. Deterministic per rngSeed; scale is 1 (one lab) or 10 (N = 10 labs).
// Inputs (TRD §12 / 04 §14): 500 patients/day/lab, 40 % use the app (ASSUMPTION), 20 centres per lab, 1 display per centre,
// 1 order per patient, 3 specimens per order (C0-TRD §10.1). Counts are linear in scale (10x = exactly ten times 1x).
// Id scheme (shared with consumer.pgbench.sql): tenant 00000000-…-<n>, patient 00000001-…-<n>, order 00000002-…-<n>, specimen 00000003-…-<n>.
// Output feeds the k6 env: probe.order_id -> ORDER_ID, probe.profile_id -> PROFILE_ID, probe.centre_id -> CENTRE_ID, probe.orderable_id -> ORDERABLE_ID.

const PER_LAB = { centres: 20, displays: 20, patients: 500, orders: 500 };
const APP_SHARE = 0.4;
const SPECIMENS_PER_ORDER = 3;

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (rng, n) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');
const uuid = (rng) => `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-8${hex(rng, 3)}-${hex(rng, 12)}`;
const keyed = (kind, n) => `0000000${kind}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function generateSeed({ scale, rngSeed }) {
  if (scale !== 1 && scale !== 10) throw new Error(`scale must be 1 or 10, got ${scale}`);
  if (!Number.isInteger(rngSeed)) throw new Error('rngSeed must be an integer');
  const rng = mulberry32(rngSeed);
  const patients = PER_LAB.patients * scale;
  const orders = PER_LAB.orders * scale;
  const counts = {
    labs: scale,
    centres: PER_LAB.centres * scale,
    displays: PER_LAB.displays * scale,
    patients,
    linked_patients: Math.floor(patients * APP_SHARE),
    orders,
    specimens: orders * SPECIMENS_PER_ORDER,
  };
  const tenants = Array.from({ length: scale }, (_, i) => ({ id: keyed(0, i + 1), name: `Synthetic Lab ${i + 1}` }));
  const o = 1 + Math.floor(rng() * orders);
  const probe = { order_id: keyed(2, o), profile_id: keyed(1, o), centre_id: uuid(rng), orderable_id: uuid(rng) };
  return { scale, counts, tenants, probe };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('seed.mjs')) {
  const scale = Number(process.argv[2] ?? 1);
  const rngSeed = Number(process.argv[3] ?? 1);
  console.log(JSON.stringify(generateSeed({ scale, rngSeed }), null, 2));
}
