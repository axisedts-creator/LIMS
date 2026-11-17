// C16.T-B1 — worker side of the bookable catalogue: task `engagement.sync_bookable_items`, nightly cron `engagement.sync_bookable_items_nightly`, consumer `catalog.changed.v1`
// (06-PLAN row T-B1; 02-TRD §7.2 catalog.changed.v1 row, §8.1, §8.2; PRD US-EN-26.2 / 26.3; CR-C16-013 ACCEPTED, EVENT_CONSUMERS.engagement already lists catalog.changed.v1 -> the consumer is ACTIVE).
// done_when: "price snapshot from tenant default; no-price handled; consumer inactive until CR-C16-013" -> CR-C16-013 is ACCEPTED in 08, so the T-01 fail-closed stub must now really run.
// tests: "integration; consumer duplicate/unknown-entity tests". Fails now: the three manifest entries are T-01 stubs (throw "not implemented") and the nightly task/cron row do not exist.
//
// SEAMS (through the WorkerManifest only; no file/function names are pinned): manifest.tasks['engagement.sync_bookable_items'] / ['engagement.sync_bookable_items_nightly'] (payload {tenant_id}),
//   manifest.subscriptions['catalog.changed.v1'](envelope, ctx) with envelope {event_id, event_type, tenant_id, payload:{catalog_revision, entity_type, entity_id, change_kind, effective_from}}, manifest.crontab.
//   ctx = worker JobContext (system actor, tx, now(), ports {CatalogPort}). DB through ctx.tx.query: engagement.bookable_items + `SELECT app.enqueue_job($1 id,$2 payload,$3 job_key,$4 run_at,$5 max_attempts)`.
//   Sync, per bookable item (tenant-scoped): getTest/getPanel by orderable_kind (inactive -> is_active=false), priceFor({orderableId, context:{}, priority:'routine', at: now}); catalog.no_price -> price columns NULL;
//   synced_at = now. Cron 01:40 Asia/Kathmandu (UTC+05:45) = 19:55 UTC -> `55 19 * * *`, per_tenant; it only enqueues the sync (job_key bookable:<tenant_id>, max_attempts 5).
//   Consumer: entity_type in {test, panel, price_list, global_reference} OR an unknown value -> enqueue the sync with job_key bookable:<tenant_id>, run_at = now + 60 s (debounce); other known types are ignored.
//   ASSUMED (spec silent): sync never RE-activates an item staff switched off; an orderable that vanished from C3 (common.not_found) is deactivated and does not stop the other items; a transient port error fails the whole task (retry).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { ID, O, PL, TENANT_A, TENANT_B, makeBookableWorld, type BookableWorld as W } from '../../../../../api/src/modules/engagement/__tests__/bookable.world.js';

const SYNC = 'engagement.sync_bookable_items', NIGHTLY = 'engagement.sync_bookable_items_nightly', EVENT = 'catalog.changed.v1';
const task = (id: string) => manifest.tasks?.[id] as (p: any, c: any) => Promise<void>;
const consumer = () => manifest.subscriptions?.[EVENT] as (e: any, c: any) => Promise<void>;
const sync = (w: W, payload: unknown = { tenant_id: TENANT_A }, over: Record<string, any> = {}) => w.run(task(SYNC), payload, over);
const biz = (r: Record<string, any>) => ({ is_active: r['is_active'], price: r['indicative_price_paisa'], pl: r['price_list_id'], plv: r['price_list_version'], name: r['display_name'], code: r['code'], sex: r['sex_restriction'], kinds: r['booking_kinds'], sort: r['sort_order'] });
const seedAll = (w: W) => { w.item(O.CBC); w.item(O.GLU); w.item(O.WHP, { orderable_kind: 'panel' }); w.item(O.UNPRICED); w.item(O.CBC, { tenant_id: TENANT_B, indicative_price_paisa: 1, price_list_version: 1 }); };
let evSeq = 0;
const event = (w: W, entityType: string, over: Record<string, any> = {}) => ({ event_id: ID(0xe000 + ++evSeq), event_type: EVENT, tenant_id: TENANT_A,
  payload: { catalog_revision: 7, entity_type: entityType, entity_id: ID(0x101), change_kind: 'updated', effective_from: w.now(), ...over } });
const HOUR = 3_600_000;

describe('manifest: cron row + implemented entries (TRD §8.1, §8.2)', () => {
  it('the three T-B1 entries are no longer fail-closed stubs and the manifest still validates', () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(typeof task(SYNC)).toBe('function'); expect(typeof task(NIGHTLY)).toBe('function'); expect(typeof consumer()).toBe('function');
    expect(manifest.maxAttempts?.[SYNC]).toBe(5);
  });
  it('engagement.sync_bookable_items_nightly: per_tenant, 01:40 Asia/Kathmandu = 19:55 UTC', () => {
    const row = manifest.crontab?.find((c) => c.identifier === NIGHTLY);
    expect(row).toBeDefined(); expect(row!.tenantScope).toBe('per_tenant'); expect(row!.schedule).toBe('55 19 * * *');
  });
});

describe('nightly cron task: only enqueues', () => {
  it('enqueues exactly one sync {tenant_id} with job_key bookable:<tenant>, max_attempts 5; a second tick collapses; no CatalogPort call, no bookable_items write', async () => {
    const w = makeBookableWorld(); seedAll(w); await w.run(task(NIGHTLY), { tenant_id: TENANT_A }); await w.run(task(NIGHTLY), { tenant_id: TENANT_A });
    expect(w.jobs()).toHaveLength(1); expect(w.jobs(SYNC)[0]).toMatchObject({ payload: { tenant_id: TENANT_A }, jobKey: `bookable:${TENANT_A}`, maxAttempts: 5 });
    expect(w.catalog.calls).toEqual([]); expect(w.writes().filter((s) => /bookable_items/i.test(s.text))).toEqual([]);
  });
  it('payload tenant missing or different from the job tenant -> nothing enqueued (REQ-SEC-024)', async () => {
    const w = makeBookableWorld();
    for (const p of [{}, { tenant_id: TENANT_B }, { tenant_id: 'x' }, null]) await w.run(task(NIGHTLY), p);
    expect(w.jobs()).toEqual([]);
  });
});

describe('sync task (US-EN-26.2 / 26.3)', () => {
  it('prices are refreshed from the tenant default; every item gets synced_at = now; other tenants untouched; system actor; exact priceFor query', async () => {
    const w = makeBookableWorld(); seedAll(w); w.setCatalog(O.CBC, { paisa: 47500, listVersion: 4 }); w.advance(HOUR); await sync(w);
    expect(w.get(O.CBC)).toMatchObject({ indicative_price_paisa: 47500, price_list_id: PL, price_list_version: 4, is_active: true });
    expect(w.get(O.GLU)).toMatchObject({ indicative_price_paisa: 20000, price_list_version: 3 }); expect(w.get(O.WHP)).toMatchObject({ indicative_price_paisa: 250000, sex_restriction: 'female' });
    for (const id of [O.CBC, O.GLU, O.WHP, O.UNPRICED]) expect(Date.parse(w.get(id)['synced_at']), id).toBe(Date.parse(w.now()));
    expect(w.get(O.CBC, TENANT_B)).toMatchObject({ indicative_price_paisa: 1, price_list_version: 1 });
    const pf = w.catalog.calls.filter((c) => c.method === 'priceFor'); expect(pf.map((c) => c.input['orderableId']).sort()).toEqual([O.CBC, O.GLU, O.UNPRICED, O.WHP].sort());
    for (const c of pf) expect(c.input).toEqual({ orderableId: c.input['orderableId'], context: {}, priority: 'routine', at: w.now() });
    expect(w.catalog.calls.every((c) => c.actor === 'system')).toBe(true); expect(w.catalog.calls.some((c) => c.method === 'getPanel' && c.input['panelId'] === O.WHP)).toBe(true);
    expect(w.catalog.calls.some((c) => c.method === 'getTest' && c.input['testId'] === O.CBC)).toBe(true);
  });
  it('US-EN-26.2: items inactive in the catalogue (test AND panel) become non-bookable; active ones stay bookable', async () => {
    const w = makeBookableWorld(); seedAll(w); w.setCatalog(O.GLU, { isActive: false }); w.setCatalog(O.WHP, { isActive: false }); await sync(w);
    expect(w.get(O.GLU)['is_active']).toBe(false); expect(w.get(O.WHP)['is_active']).toBe(false); expect(w.get(O.CBC)['is_active']).toBe(true); expect(w.get(O.UNPRICED)['is_active']).toBe(true);
  });
  it('US-EN-26.3: a price that disappeared (catalog.no_price) becomes "no price" on the snapshot; the item stays bookable and the others are still refreshed', async () => {
    const w = makeBookableWorld(); seedAll(w); w.setCatalog(O.CBC, { paisa: undefined }); w.setCatalog(O.GLU, { paisa: 21000 }); await sync(w);
    expect(w.get(O.CBC)).toMatchObject({ indicative_price_paisa: null, price_list_id: null, price_list_version: null, is_active: true }); expect(w.get(O.GLU)['indicative_price_paisa']).toBe(21000);
  });
  it('a price that appears later is picked up for an item that had none', async () => {
    const w = makeBookableWorld(); seedAll(w); w.setCatalog(O.UNPRICED, { paisa: 9900, listVersion: 2 }); await sync(w);
    expect(w.get(O.UNPRICED)).toMatchObject({ indicative_price_paisa: 9900, price_list_id: PL, price_list_version: 2 });
  });
  it('ASSUMED: an item staff switched off stays off even though the catalogue entry is active', async () => {
    const w = makeBookableWorld(); w.item(O.CBC, { is_active: false }); await sync(w); expect(w.get(O.CBC)['is_active']).toBe(false);
  });
  it('ASSUMED: an orderable that no longer exists in C3 (common.not_found) is deactivated, the other items are still synced, the task resolves', async () => {
    const w = makeBookableWorld(); seedAll(w); const ghost = ID(0x777); w.item(O.GLU, { orderable_id: ghost, code: 'GHOST', display_name: 'Ghost' }); w.setCatalog(O.CBC, { paisa: 47500 });
    await expect(sync(w)).resolves.toBeUndefined(); expect(w.get(ghost)['is_active']).toBe(false); expect(w.get(O.CBC)['indicative_price_paisa']).toBe(47500);
  });
  it('a transient CatalogPort error fails the task (so the queue retries) and leaves every row as it was', async () => {
    const w = makeBookableWorld(); seedAll(w); w.setCatalog(O.GLU, { paisa: 21000 }); const before = structuredClone(w.t['items']); w.catalog.failNext = new Error('catalog unavailable');
    await expect(sync(w)).rejects.toThrow(); expect(w.t['items']).toEqual(before);
  });
  it('idempotent: running twice with no catalogue change leaves the same snapshot', async () => {
    const w = makeBookableWorld(); seedAll(w); await sync(w); const first = w.t['items']!.map(biz); w.advance(HOUR); await sync(w);
    expect(w.t['items']!.map(biz)).toEqual(first); expect(Date.parse(w.get(O.CBC)['synced_at'])).toBe(Date.parse(w.now()));
  });
  it('tenant guard: a payload for another tenant, or none, runs no query and no port call; every statement it does run binds the job tenant', async () => {
    const w = makeBookableWorld(); seedAll(w);
    for (const p of [{ tenant_id: TENANT_B }, {}, null, { tenant_id: 'x' }]) await sync(w, p);
    expect(w.catalog.calls).toEqual([]); expect(w.writes()).toEqual([]); expect(w.itemStmts()).toEqual([]);
    await sync(w); expect(w.itemStmts().length).toBeGreaterThan(0); for (const s of w.itemStmts()) expect(s.values, s.text).toContain(TENANT_A);
    expect(w.get(O.CBC, TENANT_B)['indicative_price_paisa']).toBe(1);
  });
  it('no bookable items -> resolves without a CatalogPort call', async () => {
    const w = makeBookableWorld(); await expect(sync(w)).resolves.toBeUndefined(); expect(w.catalog.calls).toEqual([]);
  });
});

describe('consumer catalog.changed.v1 (CR-C16-013, TRD §7.2)', () => {
  const consume = (w: W, e: unknown) => w.run((p, c) => consumer()(p, c), e);
  it.each(['test', 'panel', 'price_list', 'global_reference'])('entity_type %s -> ONE debounced sync: job_key bookable:<tenant>, run_at now + 60 s, payload {tenant_id}, max_attempts 5', async (type) => {
    const w = makeBookableWorld(); await consume(w, event(w, type));
    expect(w.jobs()).toHaveLength(1); const j = w.jobs(SYNC)[0]!; expect(j).toMatchObject({ payload: { tenant_id: TENANT_A }, jobKey: `bookable:${TENANT_A}`, maxAttempts: 5 });
    expect(new Date(j['runAt'] as any).getTime()).toBe(Date.parse(w.now()) + 60_000);
    expect(w.catalog.calls).toEqual([]); expect(w.writes().filter((s) => /bookable_items/i.test(s.text))).toEqual([]);   // the consumer never calls C3 or touches the snapshot itself
  });
  it('unknown entity_type (x-extensible, 08 A13 P-4) also enqueues the sync (safe default)', async () => {
    const w = makeBookableWorld(); await consume(w, event(w, 'loyalty_tier')); await consume(w, event(w, 'some_future_entity_v9', { entity_id: ID(0xabc) }));
    expect(w.jobs(SYNC)).toHaveLength(1); expect(w.jobs(SYNC)[0]).toMatchObject({ jobKey: `bookable:${TENANT_A}` });
  });
  it.each(['department', 'specimen_type', 'container', 'analyte', 'reference_range', 'critical_limit', 'comment_code', 'doctor', 'credit_party', 'surcharge_rule', 'tat_target',
    'instrument_code_map', 'method', 'unit', 'value_set', 'tax_rule', 'catalog_import'])('other known entity_type %s is ignored: nothing enqueued, nothing written', async (type) => {
    const w = makeBookableWorld(); await consume(w, event(w, type)); expect(w.jobs()).toEqual([]); expect(w.writes()).toEqual([]); expect(w.catalog.calls).toEqual([]);
  });
  it('duplicate delivery (same event twice) and a burst of distinct events inside the window -> still ONE job', async () => {
    const w = makeBookableWorld(); const e = event(w, 'price_list'); await consume(w, e); await consume(w, structuredClone(e));
    for (let i = 0; i < 10; i++) { w.advance(1000); await consume(w, event(w, i % 2 ? 'test' : 'panel', { entity_id: ID(0x500 + i) })); }
    expect(w.jobs(SYNC)).toHaveLength(1);
  });
  it('the job tenant comes from the job context, never from a different tenant_id inside the payload', async () => {
    const w = makeBookableWorld(); await consume(w, event(w, 'test', { tenant_id: TENANT_B })); for (const j of w.jobs(SYNC)) { expect(j['payload']).toEqual({ tenant_id: TENANT_A }); expect(j['jobKey']).toBe(`bookable:${TENANT_A}`); }
  });
});
