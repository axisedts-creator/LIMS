// C11.T-27 — CR-C11-011 consumer logic: lab.result.approved.v1 / lab.result.amended.v1 -> case_items.lab_approved_version_no (02-TRD §8.2 consumers table, 03-IC §3.10/§3.11).
// AC-13.1/13.2/13.4 (awaiting_lab queue), 07-SECURITY (tenant from ctx, never from the payload; non-anatomic results are a no-op).
// Drives the REAL service on IN-MEMORY repositories (vi.mock of the T-04 repository signatures). The worker wrapper owns event_inbox + envelope validation; the service runs no raw SQL.
//
// SEAMS (names chosen here, writer follows):
//   ../service/labresult.service.ts   export async function onResultApproved(ctx, env): Promise<void>   (k = payload.result_version_no; time = payload.approved_at)
//                                     export async function onResultAmended(ctx, env): Promise<void>    (k = payload.new_version_no;    time = payload.amended_at)
//   ../repository/submissions.repo.ts NEW  maxItemVersionForLabResult(tx, { tenantId, labResultId, labVersionNo }) -> { case_item_id, max_item_version_no } | undefined
//                                     = SELECT case_item_id, max(item_version_no) FROM anatomic.item_submissions WHERE tenant_id AND lab_result_id AND lab_version_no GROUP BY case_item_id
//   ../repository/cases.repo.ts       getCaseItem(tx,{tenantId,id}) and updateCaseItem(tx,{tenantId,id,expectedVersion,actorId,patch}) (both exist, T-04). `greatest()` is computed in the service:
//                                     patch.lab_approved_version_no = max(current, m). A stale updateCaseItem (undefined) is re-read and re-evaluated, never dropped and never thrown.
// Fails now: ../service/labresult.service.js does not exist.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  items: new Map<string, Row>(), subs: [] as Row[], updates: [] as Row[], maxCalls: [] as Row[], onBeforeUpdate: undefined as undefined | ((id: string) => void),
}));

vi.mock('../repository/submissions.repo.js', () => ({
  async maxItemVersionForLabResult(_tx: any, i: { tenantId: string; labResultId: string; labVersionNo: number }) {
    S.maxCalls.push(i);
    const hit = S.subs.filter((s) => s['tenant_id'] === i.tenantId && s['lab_result_id'] === i.labResultId && s['lab_version_no'] === i.labVersionNo);
    if (hit.length === 0) return undefined;
    const by = new Map<string, number>();
    for (const s of hit) by.set(s['case_item_id'], Math.max(by.get(s['case_item_id']) ?? 0, s['item_version_no']));
    const [case_item_id, max_item_version_no] = [...by][0]!;
    return { case_item_id, max_item_version_no };
  },
}));
vi.mock('../repository/cases.repo.js', () => ({
  async getCaseItem(_tx: any, i: { tenantId: string; id: string }) {
    const r = S.items.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined;
  },
  async updateCaseItem(_tx: any, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.onBeforeUpdate?.(i.id);
    const r = S.items.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    for (const k of Object.keys(i.patch)) if (!['lab_approved_version_no', 'lab_approved_at', 'role', 'is_active'].includes(k)) throw new Error(`column ${k} is not updatable`);
    Object.assign(r, i.patch, { version: r['version'] + 1, updated_by: i.actorId });
    S.updates.push({ id: i.id, patch: i.patch });
    return { ...r };
  },
}));

const { onResultApproved, onResultAmended } = await import('../service/labresult.service.js');

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(0xaaaa), OTHER = id(0xbbbb), ACTOR = id(0xa11), RESULT = id(0xa0001), ITEM = id(0xc1), ITEM_B = id(0xc2), CASE = id(0xca), ORDER_ITEM = id(0x60001);
const T0 = '2026-11-05T04:30:00.000Z', T1 = '2026-11-06T05:00:00.000Z', T2 = '2026-11-07T05:00:00.000Z';
let evSeq = 0;

const seedItem = (over: Row = {}): Row => { const r = { id: ITEM, tenant_id: TENANT, case_id: CASE, role: 'primary', is_active: true, lab_approved_version_no: 0, lab_approved_at: null, version: 1, ...over }; S.items.set(r['id'], r); return r; };
const seedSub = (item_version_no: number, lab_version_no = 1, over: Row = {}) =>
  S.subs.push({ tenant_id: TENANT, case_item_id: ITEM, lab_result_id: RESULT, item_version_no, lab_version_no, ...over });
const approvedEnv = (p: Row = {}, over: Row = {}): any => ({ event_id: id(0xe0000 + ++evSeq), event_type: 'lab.result.approved.v1', tenant_id: TENANT, occurred_at: T0, actor: { type: 'user', id: id(0xa1) },
  idempotency_key: `${RESULT}:approved:1`, producer: 'lab', aggregate: { type: 'result', id: RESULT, seq: 1 }, request_id: id(0xf2),
  payload: { result_id: RESULT, result_version_no: 1, order_id: id(0x50001), order_item_id: ORDER_ITEM, test_id: id(0x70001), analyte_id: id(0x80001), department_id: id(0x150001), approved_at: T0, approved_by_membership_id: id(0x30003), ...p }, ...over });
const amendedEnv = (p: Row = {}, over: Row = {}): any => ({ event_id: id(0xe0000 + ++evSeq), event_type: 'lab.result.amended.v1', tenant_id: TENANT, occurred_at: T1, actor: { type: 'user', id: id(0xa1) },
  idempotency_key: `${RESULT}:amended:2`, producer: 'lab', aggregate: { type: 'result', id: RESULT, seq: 2 }, request_id: id(0xf2),
  payload: { result_id: RESULT, previous_version_no: 1, new_version_no: 2, order_id: id(0x50001), order_item_id: ORDER_ITEM, test_id: id(0x70001), analyte_id: id(0x80001), amendment_reason_code: 'transcription_error', amended_at: T1, amended_by_membership_id: id(0x30003), ...p }, ...over });
function makeCtx(tenantId = TENANT): any {
  const ctx: any = { tenantId, actor: { type: 'system', id: ACTOR }, requestId: id(0xf1), tx: { query: async () => { throw new Error('raw SQL in labresult.service — use the repositories (02-TRD §3.1); the inbox row belongs to the worker wrapper'); } },
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } }, metrics: { inc() {} }, now: () => T2, attempt: 1, maxAttempts: 10, jobId: '1' };
  ctx.db = { tx: (fn: any) => fn(ctx) };
  return ctx;
}
/** The awaiting_lab predicate of cases.repo.ts QUEUES.awaiting_lab (CR-C11-011), evaluated on the in-memory rows (signed_out case assumed). */
const awaitingLab = (): boolean => [...S.items.values()].some((ci) => {
  if (!ci['is_active'] || ci['role'] !== 'primary') return false;
  const mine = S.subs.filter((s) => s['case_item_id'] === ci['id']);
  return mine.length > 0 && ci['lab_approved_version_no'] < Math.max(...mine.map((s) => s['item_version_no']));
});
const approved = () => S.items.get(ITEM)!['lab_approved_version_no'];

beforeEach(() => { S.items.clear(); S.subs.length = 0; S.updates.length = 0; S.maxCalls.length = 0; S.onBeforeUpdate = undefined; evSeq = 0; });

describe('lab.result.approved.v1 → lab_approved_version_no (02-TRD §8.2)', () => {
  it('AC-13.1: revised twice before approval (item v1,v2,v3 all lab_version_no 1), then approved → lab_approved_version_no = 3 and awaiting_lab is empty', async () => {
    seedItem(); seedSub(1); seedSub(2); seedSub(3);
    expect(awaitingLab()).toBe(true);                       // sanity: signed out, nothing approved yet
    await onResultApproved(makeCtx(), approvedEnv());
    expect(approved()).toBe(3);                             // max(item_version_no) where lab_version_no = result_version_no (1)
    expect(S.items.get(ITEM)!['lab_approved_at']).toBe(T0); // approved_at
    expect(awaitingLab()).toBe(false);
    expect(S.maxCalls).toEqual([{ tenantId: TENANT, labResultId: RESULT, labVersionNo: 1 }]);
  });

  it('AC-13.1: a revision signed out AFTER the approval stays awaiting (approved only covers what existed at the time)', async () => {
    seedItem(); seedSub(1); seedSub(2);
    await onResultApproved(makeCtx(), approvedEnv());
    expect(approved()).toBe(2);
    seedSub(3);                                             // later revision, no new approval event yet
    expect(awaitingLab()).toBe(true);
  });

  it('single submission approved → lab_approved_version_no = 1', async () => {
    seedItem(); seedSub(1);
    await onResultApproved(makeCtx(), approvedEnv());
    expect(approved()).toBe(1);
    expect(awaitingLab()).toBe(false);
  });

  it('duplicate delivery of the same event is harmless: value unchanged, no throw', async () => {
    seedItem(); seedSub(1); seedSub(2);
    const e = approvedEnv();
    await onResultApproved(makeCtx(), e);
    await expect(onResultApproved(makeCtx(), e)).resolves.toBeUndefined();
    expect(approved()).toBe(2);
  });

  it('non-anatomic result (no item_submissions row for result_id) → no-op: nothing written, no error', async () => {
    seedItem(); seedSub(1, 1, { lab_result_id: id(0xdead) });
    await expect(onResultApproved(makeCtx(), approvedEnv())).resolves.toBeUndefined();
    expect(S.updates).toEqual([]);
    expect(approved()).toBe(0);
  });

  it('result with submissions but none at lab_version_no = k → no-op', async () => {
    seedItem(); seedSub(1, 2);
    await onResultApproved(makeCtx(), approvedEnv());
    expect(S.updates).toEqual([]);
  });

  it('add-on result payload without specimen_id (08 A13 D-2) is handled; the handler reads only result_id and the version fields', async () => {
    seedItem(); seedSub(1);
    const e = approvedEnv();
    expect(e.payload).not.toHaveProperty('specimen_id');
    await onResultApproved(makeCtx(), e);
    expect(approved()).toBe(1);
  });
});

describe('lab.result.amended.v1 → lab_approved_version_no', () => {
  it("amended: item v4 submitted with lab_version_no 2 → lab_approved_version_no = 4 (the amendment's item_version_no), lab_approved_at = amended_at", async () => {
    seedItem(); seedSub(1); seedSub(2); seedSub(3);
    await onResultApproved(makeCtx(), approvedEnv());
    expect(approved()).toBe(3);
    seedSub(4, 2);
    expect(awaitingLab()).toBe(true);
    await onResultAmended(makeCtx(), amendedEnv());
    expect(approved()).toBe(4);
    expect(S.items.get(ITEM)!['lab_approved_at']).toBe(T1);
    expect(awaitingLab()).toBe(false);
    expect(S.maxCalls.at(-1)).toEqual({ tenantId: TENANT, labResultId: RESULT, labVersionNo: 2 });  // k = new_version_no
  });

  it('second amendment (new_version_no 3) picks the latest item_version_no among rows with lab_version_no 3', async () => {
    seedItem({ lab_approved_version_no: 4 }); seedSub(1); seedSub(4, 2); seedSub(5, 3); seedSub(6, 3);
    await onResultAmended(makeCtx(), amendedEnv({ previous_version_no: 2, new_version_no: 3 }));
    expect(approved()).toBe(6);
  });

  it('amended event for a non-anatomic result → no-op', async () => {
    seedItem(); seedSub(1);
    await expect(onResultAmended(makeCtx(), amendedEnv({ result_id: id(0xbeef) }))).resolves.toBeUndefined();
    expect(S.updates).toEqual([]);
  });
});

describe('out-of-order, duplicate and concurrent delivery (greatest())', () => {
  it('amended (k=2 → 4) delivered BEFORE approved (k=1 → 3): the later approved event must not lower the value', async () => {
    seedItem(); seedSub(1); seedSub(2); seedSub(3); seedSub(4, 2);
    await onResultAmended(makeCtx(), amendedEnv());
    expect(approved()).toBe(4);
    await onResultApproved(makeCtx(), approvedEnv());
    expect(approved()).toBe(4);
    expect(awaitingLab()).toBe(false);
  });

  it('a stale approved delivery after a higher value never lowers lab_approved_version_no', async () => {
    seedItem({ lab_approved_version_no: 5, lab_approved_at: T1 }); seedSub(1); seedSub(2);
    await onResultApproved(makeCtx(), approvedEnv());
    expect(approved()).toBe(5);
  });

  it('optimistic-lock loss (another tx raised the row between read and write) is re-read, not dropped and not thrown: concurrent 3 vs delivered 2 → 3; concurrent 2 vs delivered 3 → 3', async () => {
    seedItem(); seedSub(1); seedSub(2);
    let once = true;
    S.onBeforeUpdate = (itemId) => { if (once) { once = false; const r = S.items.get(itemId)!; r['lab_approved_version_no'] = 3; r['version'] += 1; } };
    await expect(onResultApproved(makeCtx(), approvedEnv())).resolves.toBeUndefined();
    expect(approved()).toBe(3);

    S.items.clear(); S.subs.length = 0; seedItem(); seedSub(1); seedSub(2); seedSub(3); once = true;
    S.onBeforeUpdate = (itemId) => { if (once) { once = false; const r = S.items.get(itemId)!; r['lab_approved_version_no'] = 2; r['version'] += 1; } };
    await onResultApproved(makeCtx(), approvedEnv());
    expect(approved()).toBe(3);
  });

  it('two concurrent deliveries (approved and amended) end at the greatest value', async () => {
    seedItem(); seedSub(1); seedSub(2); seedSub(3, 2);
    await Promise.all([onResultAmended(makeCtx(), amendedEnv()), onResultApproved(makeCtx(), approvedEnv())]);
    expect(approved()).toBe(3);
  });
});

describe('tenant isolation (07-SECURITY)', () => {
  it("the tenant comes from ctx, never the payload: another tenant's item_submissions / case_items with the same result_id are untouched", async () => {
    seedItem(); seedSub(1);
    S.items.set(ITEM_B, { id: ITEM_B, tenant_id: OTHER, case_id: id(0xcb), role: 'primary', is_active: true, lab_approved_version_no: 0, lab_approved_at: null, version: 1 });
    S.subs.push({ tenant_id: OTHER, case_item_id: ITEM_B, lab_result_id: RESULT, item_version_no: 9, lab_version_no: 1 });
    await onResultApproved(makeCtx(TENANT), approvedEnv({ tenant_id: OTHER }));   // unknown payload field is ignored; ctx.tenantId wins
    expect(S.items.get(ITEM)!['lab_approved_version_no']).toBe(1);
    expect(S.items.get(ITEM_B)!['lab_approved_version_no']).toBe(0);
    expect(S.maxCalls.every((c) => c['tenantId'] === TENANT)).toBe(true);
    expect(S.updates.every((u) => u['id'] === ITEM)).toBe(true);
  });

  it('the service writes only lab_approved_version_no and lab_approved_at (no role / is_active / other columns)', async () => {
    seedItem(); seedSub(1);
    await onResultApproved(makeCtx(), approvedEnv());
    expect(Object.keys(S.updates[0]!['patch']).sort()).toEqual(['lab_approved_at', 'lab_approved_version_no']);
  });
});
