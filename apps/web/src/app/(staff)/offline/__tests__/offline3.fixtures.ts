// T0D-OFFLINE-3 shared fixtures (tester-owned; not a test file). Synthetic data only.
//
// CONTRACT chosen by the tester where the brief gives no name (writer: follow it, or dispute in .orchestra/notes/T0D-OFFLINE-3-dispute-*.md).
// Facts that come from main and are NOT negotiable (read the server code, do not guess):
//   * provisional numbers: services/api/src/core/sync/engine.ts provisionalNumber(deviceId, opId, doc)
//       = `OFF-${deviceId minus dashes, first 8}-${opId minus dashes}-${doc}`.toUpperCase();  doc = 'INV' (invoice), 'RC' (first receipt), 'RC2', 'RC3'.. (more
//       payment rows of one registration), 'RC' (billing.record_receipt). The server mapping answers provisional_number with exactly that string, so the device MUST print it.
//   * the op envelope key `reserved_numbers: { patient_id?: int, lab_codes?: int[] }` (registration.create_order and accession.receive only) is how block numbers reach
//       the server (assertReservedInDeviceBlocks). core/offline/outbox.ts OperationInput and engine.ts WIRE_KEYS must carry it (additive).
//   * the registration payload is the strict CreateRegistrationRequest (frontdesk.yaml): quote_fingerprint is 64 lowercase hex; payments use amount_received_paisa;
//       no key outside that schema (reserved ids, lab codes, provisional numbers stay in the LOCAL record only).
//
// Modules the writer creates under apps/web/src/core/offline/ (re-exported from index.ts), tests import them dynamically from '@/core/offline/<file>':
//   numbers.ts  provisionalNumber(deviceId, opId, doc), createNumbers({ store, deviceId, fetch?, baseUrl?, now?, sizes?: { lab_code?, patient_id? } }) ->
//                 reserve(series, { centreId? }) -> { ok: true, remaining } | { ok: false, code? }       POST /v1/core/sync/number-blocks, Idempotency-Key, default sizes 200 / 100
//                 next(series) -> { value: string, number: number | null, provisional: boolean, mark?: 'PENDING' }   block number, else OFF-... + mark 'PENDING'
//                 remaining(series) -> { left, size, warn }      warn = left <= 20 % of the size of the last reserved block
//   flows.ts    createOfflineFlows({ store, outbox, prefetcher, numbers, deviceId, permissions, now? }) ->
//                 searchPatients(q), searchTests(q), quote(input), registerOrder(input), recordReceipt(input), markCollected(input), receiveSpecimen(input),
//                 localOrder(id), statusOf(id), statusMap(), display(number), numbers
//   guards.ts   ONLINE_ONLY_ACTIONS, onlineOnlyReason(action, online)
//   ui/OfflineProvider.tsx  OfflineProvider gains an optional `flows` prop; new hooks useOfflineFlows() (null without a provider) and useOnlineOnly(action)
//   ui/OfflineParts.tsx     PendingSyncBadge, DocNumber, IssuedOfflineWatermark, BlockWarning
// Reference data is read from the encrypted 'refdata' store exactly as core/offline/prefetch.ts writes it (key `${entity_type}:${id}`, the read API document as value).
import { vi } from 'vitest';
import { DEVICE, USER, fakeLocks, fakeServer, rawCounts, rawDump, unlockedStore, T0 } from '@/core/offline/__tests__/offline1.helpers';

export { DEVICE, USER, T0, rawCounts, rawDump };
export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE = U(3);
export const PAT_NAME = 'Asha Verma'; // synthetic
export const PAT_PHONE = '+9779800000042'; // synthetic
export const PERMS = ['sync.use', 'frontdesk.registration.create', 'frontdesk.patient.read', 'billing.payment.record', 'lab.specimen.collect', 'lab.specimen.receive'];

export const PAT = { id: U(2), patient_code: 'P-000001', full_name: PAT_NAME, sex: 'female', phone_e164: PAT_PHONE, version: 4 };
export const PAT2 = { id: U(4), patient_code: 'P-000002', full_name: 'Ravi Kumar', sex: 'male', phone_e164: '+9779811111111', version: 1 };
export const T_CBC = { id: U(101), code: 'CBC', name: 'Complete blood count', kind: 'test' };
export const T_LIPID = { id: U(102), code: 'LIPID', name: 'Lipid profile', kind: 'test' };
export const T_TSH = { id: U(103), code: 'TSH', name: 'Thyroid stimulating hormone', kind: 'test' };
/** CR needed (see the tests note): the pull whitelist gives price_list_version rows without prices. The tests assume the cached version document also holds
 *  the lines and the role discount limit: items[{ orderable_id, unit_price_paisa }] and discount_limit_percent_bp. */
export const PRICE = {
  id: U(200), price_list_id: U(201), version_no: 3, status: 'published', effective_from: '2026-11-01T00:00:00.000Z', item_count: 3, version: 1,
  items: [{ orderable_id: T_CBC.id, unit_price_paisa: 60000 }, { orderable_id: T_LIPID.id, unit_price_paisa: 90000 }, { orderable_id: T_TSH.id, unit_price_paisa: 40000 }],
  discount_limit_percent_bp: 1000,
};
export const OLD_PRICE = { ...PRICE, id: U(199), version_no: 2, status: 'superseded', effective_from: '2026-10-01T00:00:00.000Z', items: [{ orderable_id: T_CBC.id, unit_price_paisa: 50000 }] };

export const prov = (opId: string, doc: string, device = DEVICE) => `OFF-${device.replace(/-/g, '').slice(0, 8)}-${opId.replace(/-/g, '')}-${doc}`.toUpperCase();
export const regInput = (over: Record<string, unknown> = {}) => ({
  centre_id: CENTRE, patient: { patient_id: PAT.id }, visit_type: 'opd', billing_mode: 'cash',
  items: [{ orderable_id: T_CBC.id }, { orderable_id: T_LIPID.id }], // 60000 + 90000
  payments: [{ method_code: 'cash', amount_received_paisa: 150000 }], ...over,
});
export const newPatient = (over: Record<string, unknown> = {}) => ({ full_name: 'Meena Thapa', sex: 'female', phone_e164: '+9779822222222', consents: { processing: true }, ...over }); // synthetic

type Result = { op_id: string; status: string; error_code?: string; conflict_id?: string; number_mappings?: unknown[]; skew_flag: boolean };
/** A stateful stand-in for the server: gap free final numbers in ARRIVAL order, op_id idempotency (a replay answers duplicate with the first mappings), blocks that never overlap. */
export function simServer() {
  const sim = {
    applied: new Map<string, { mappings: unknown[] }>(), arrival: [] as string[], inv: 0, rc: 0,
    next: { lab_code: 1001, patient_id: 5001 } as Record<string, number>, blocks: [] as Array<Record<string, unknown>>,
    rules: [] as Array<(op: any) => Partial<Result> | undefined>, dropResponses: 0, refuseBlocks: null as string | null,
  };
  const finalInv = () => `INV-${String(++sim.inv).padStart(6, '0')}`;
  const finalRc = () => `RC-${String(++sim.rc).padStart(6, '0')}`;
  function apply(op: any): Result {
    const prev = sim.applied.get(op.op_id);
    if (prev) return { op_id: op.op_id, status: 'duplicate', number_mappings: prev.mappings, skew_flag: false };
    for (const r of sim.rules) { const x = r(op); if (x) return { op_id: op.op_id, skew_flag: false, status: 'rejected', ...x }; }
    const mappings: unknown[] = [];
    if (op.op_type === 'registration.create_order') {
      mappings.push({ document_type: 'invoice', provisional_number: prov(op.op_id, 'INV'), final_number: finalInv() });
      (op.payload?.payments ?? []).forEach((_p: unknown, i: number) => mappings.push({ document_type: 'receipt', provisional_number: prov(op.op_id, i ? `RC${i + 1}` : 'RC'), final_number: finalRc() }));
    } else if (op.op_type === 'billing.record_receipt') mappings.push({ document_type: 'receipt', provisional_number: prov(op.op_id, 'RC'), final_number: finalRc() });
    sim.applied.set(op.op_id, { mappings }); sim.arrival.push(op.op_id);
    return { op_id: op.op_id, status: 'accepted', ...(mappings.length ? { number_mappings: mappings } : {}), skew_flag: false };
  }
  const server = fakeServer({
    'POST /v1/core/sync/batches': ({ body }) => {
      const results = body.operations.map(apply);
      if (sim.dropResponses > 0) { sim.dropResponses--; return 'throw'; } // applied, but the answer never arrives
      return { status: 200, body: { results } };
    },
    'POST /v1/core/sync/number-blocks': ({ body }) => {
      if (sim.refuseBlocks) return { status: 422, body: { code: sim.refuseBlocks } };
      const from = sim.next[body.series]!; const to = from + body.size - 1; sim.next[body.series] = to + 1;
      sim.blocks.push(body);
      return { status: 201, body: { block: { id: U(300 + sim.blocks.length), device_id: body.device_id, series: body.series, from_value: from, to_value: to, issued_at: new Date(T0).toISOString(), skipped_count: 0 }, remaining_size: body.size } };
    },
  });
  return Object.assign(server, { sim });
}
export type Sim = ReturnType<typeof simServer>;

export async function seedCache(store: { put: (n: string, k: string, v: unknown) => Promise<unknown> }, over: { prices?: unknown[] } = {}) {
  for (const p of [PAT, PAT2]) await store.put('refdata', `patient:${p.id}`, p);
  for (const t of [T_CBC, T_LIPID, T_TSH]) await store.put('refdata', `test:${t.id}`, t);
  for (const v of over.prices ?? [OLD_PRICE, PRICE]) await store.put('refdata', `price_list_version:${(v as { id: string }).id}`, v);
}

export async function createEnv(o: { permissions?: readonly string[]; sizes?: { lab_code?: number; patient_id?: number }; sim?: Sim; seed?: boolean; blocks?: boolean } = {}) {
  const env = await unlockedStore();
  const sim = o.sim ?? simServer();
  const { createOutbox } = await import('@/core/offline/outbox');
  const { createSyncEngine } = await import('@/core/offline/engine');
  const { createPrefetcher } = await import('@/core/offline/prefetch');
  const { createNumbers } = await import('@/core/offline/numbers');
  const { createOfflineFlows } = await import('@/core/offline/flows');
  const outbox = createOutbox(env.store, { deviceId: DEVICE, userId: USER, now: env.c.now });
  const engine = createSyncEngine({ outbox, fetch: sim.fetch, deviceId: DEVICE, now: env.c.now, random: () => 0.5, locks: fakeLocks(), baseDelayMs: 1000, maxDelayMs: 300_000 } as never);
  const prefetcher = createPrefetcher({ store: env.store, deviceId: DEVICE, permissions: PERMS, fetch: sim.fetch, now: env.c.now });
  const numbers = createNumbers({ store: env.store, deviceId: DEVICE, fetch: sim.fetch, now: env.c.now, ...(o.sizes ? { sizes: o.sizes } : {}) } as never);
  const flows = createOfflineFlows({ store: env.store, outbox, prefetcher, numbers, deviceId: DEVICE, permissions: o.permissions ?? PERMS, now: env.c.now } as never);
  if (o.seed !== false) await seedCache(env.store as never);
  if (o.blocks !== false) { await numbers.reserve('lab_code'); await numbers.reserve('patient_id'); } // reserved while online, like the real device
  const drain = async () => { const r = await engine.drain(); return r; };
  const pendingOps = () => outbox.pending() as Promise<Array<{ op_id: string; op_type: string; entity_id?: string; base_version?: number; payload: any; reserved_numbers?: any; device_created_at: string }>>;
  return { ...env, sim, outbox, engine, prefetcher, numbers, flows: flows as any, drain, pendingOps, vi };
}
export type Env = Awaited<ReturnType<typeof createEnv>>;

/** the wire body of every operation the server has seen, in arrival order */
export const sentOps = (sim: Sim) => sim.batches.flatMap((b) => b.body.operations as Array<{ op_id: string; op_type: string; payload: any; reserved_numbers?: any }>);
