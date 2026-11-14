// C16.T-B1 — staff bookable catalogue S12 listBookableItems, S13 upsertBookableItem, S14 syncBookableItems (06-PLAN row T-B1; 02-TRD §5 S12-S14, §7 CatalogPort rows, §8.1;
// 05-SCHEMA bookable_items; PRD US-EN-26.1 / 26.3; 04-UI-UX W5). Fails now: handlers/index.ts maps the three operations to the T-01 placeholder (common.service_unavailable).
// done_when: "price snapshot from tenant default; no-price handled".
//
// SEAMS (same convention as reminder.handlers.test.ts): handlers[op](req:{params,query,headers,body}, ctx) -> {status, body}; errors are thrown LimsError(code).
//   ctx = {tenantId, actor, tx, now(), ports:{IdentityPort, CatalogPort}}. Permission = IdentityPort.assertRole(ctx,{permission:'engagement.bookable_item.manage'}) BEFORE any tx.query / port call.
//   CatalogPort is called in the caller's context: getTest({testId}) / getPanel({panelId}) by `orderable_kind`, then priceFor({orderableId, context:{}, priority:'routine', at: ctx.now()}) (tenant default).
//   S13 stores a SNAPSHOT: code, display_name, sex_restriction (panels), indicative_price_paisa / price_list_id / price_list_version, synced_at = now; name/code/price are NEVER taken from the request body.
//   If-Match absent = create (a second create of the same orderable -> 409), present = update with the optimistic version check (stale -> 409 common.version_conflict, unknown -> 404 common.not_found).
//   catalog.no_price -> saved with NULL price columns (US-EN-26.3). catalog.test_inactive / common.not_found from the port propagate. Any other port error propagates and nothing is written.
//   S12: tenant-scoped rows ordered sort_order, display_name, id; filters is_active (bound), query (bound search string over code/display_name, never interpolated), keyset cursor over (sort_order, display_name, id).
//   S14: 202 {} and ONE `app.enqueue_job('engagement.sync_bookable_items', {tenant_id}, 'bookable:<tenant_id>', run_at, 5)`; the request itself never calls the CatalogPort.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ID, O, PL, TENANT_A, TENANT_B, makeBookableWorld, type BookableWorld as W } from '../../__tests__/bookable.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const MANAGE = 'engagement.bookable_item.manage';
const call = (op: string, w: W, req: Record<string, any>, over: Record<string, any> = {}) => (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, w.staffCtx(over));
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return { code: e.code as string, status: e.statusCode as number }; } return { code: 'RESOLVED', status: 0 }; };
const code = async (p: Promise<unknown>) => (await fail(p)).code;
const body = (over: Record<string, any> = {}) => ({ orderable_kind: 'test', booking_kinds: ['centre_visit'], sort_order: 10, is_active: true, ...over });
const put = (w: W, id: string, b: unknown, headers: Record<string, string> = { 'idempotency-key': 'k-0001' }) => call('upsertBookableItem', w, { params: { orderable_id: id }, body: b, headers });
const list = (w: W, query: Record<string, any> = {}) => call('listBookableItems', w, { query });

describe('contract sanity (spec is the source of the permission)', () => {
  it('x-permission floors', () => { for (const op of ['listBookableItems', 'upsertBookableItem', 'syncBookableItems']) expect(opOf(op)['x-permission'], op).toBe(MANAGE); });
});

describe('S13 upsertBookableItem — create (US-EN-26.1)', () => {
  it('200: name/kind from CatalogPort.getTest, tenant-default indicative price snapshot, schema-valid StaffBookableItem, ONE insert, authorised first', async () => {
    const w = makeBookableWorld(); const res = await put(w, O.CBC, body());
    expect(res.status).toBe(200); expect(schemaErrors('StaffBookableItem', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ orderable_id: O.CBC, kind: 'test', code: 'CBC', display_name: 'Complete Blood Count', indicative_price: { amount_paisa: 45000, currency: 'NPR' },
      booking_kinds: ['centre_visit'], is_active: true, price_source: 'tenant_default', version: 1 });
    expect(Date.parse(res.body.synced_at)).toBe(Date.parse(w.now())); expect(res.body).not.toHaveProperty('tenant_id');
    expect(w.t['items']).toHaveLength(1);
    expect(w.t['items']![0]).toMatchObject({ tenant_id: TENANT_A, orderable_id: O.CBC, orderable_kind: 'test', code: 'CBC', display_name: 'Complete Blood Count', indicative_price_paisa: 45000, price_list_id: PL,
      price_list_version: 3, booking_kinds: ['centre_visit'], sort_order: 10, is_active: true, version: 1, created_by: ID(0x7a1) });
    expect(w.writes()).toHaveLength(1);
    expect(w.identity.asserted[0]).toMatchObject({ permission: MANAGE, at: 0 });
    const calls = w.catalog.calls; expect(calls.map((c) => c.method)).toEqual(['getTest', 'priceFor']);
    expect(calls[0]!.input).toMatchObject({ testId: O.CBC });
    expect(calls[1]!.input).toEqual({ orderableId: O.CBC, context: {}, priority: 'routine', at: w.now() });
  });
  it('panel: getPanel (not getTest), sex restriction of the package is copied from the catalogue', async () => {
    const w = makeBookableWorld(); const res = await put(w, O.WHP, body({ orderable_kind: 'panel', booking_kinds: ['centre_visit', 'home_collection'] }));
    expect(res.status).toBe(200); expect(schemaErrors('StaffBookableItem', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ kind: 'panel', code: 'WHP', sex_restriction: 'female', indicative_price: { amount_paisa: 250000 } });
    expect(w.t['items']![0]).toMatchObject({ orderable_kind: 'panel', sex_restriction: 'female' });
    expect(w.catalog.calls.map((c) => c.method)).toEqual(['getPanel', 'priceFor']); expect(w.catalog.calls[0]!.input).toMatchObject({ panelId: O.WHP });
  });
  it('US-EN-26.3 catalog.no_price: saved WITHOUT a price (null columns, no indicative_price), still 200 and schema-valid', async () => {
    const w = makeBookableWorld(); const res = await put(w, O.UNPRICED, body());
    expect(res.status).toBe(200); expect(schemaErrors('StaffBookableItem', res.body)).toEqual([]); expect(res.body.indicative_price).toBeUndefined();
    expect(w.t['items']).toHaveLength(1); expect(w.t['items']![0]).toMatchObject({ code: 'UNP', indicative_price_paisa: null, price_list_id: null, price_list_version: null, is_active: true });
    expect(w.t['items']![0]!['synced_at']).not.toBeNull();
  });
  it('inactive test (is_active true requested) -> 409 catalog.test_inactive propagated, zero writes', async () => {
    const w = makeBookableWorld(); const e = await fail(put(w, O.LFT_INACTIVE, body()));
    expect(e).toEqual({ code: 'catalog.test_inactive', status: 409 }); expect(w.writes()).toEqual([]);
  });
  it('unknown orderable and a kind that does not match the catalogue (CBC sent as panel) -> 404 common.not_found, zero writes', async () => {
    const w = makeBookableWorld();
    expect(await code(put(w, O.UNKNOWN, body()))).toBe('common.not_found');
    expect(await code(put(w, O.CBC, body({ orderable_kind: 'panel' })))).toBe('common.not_found');
    expect(await code(put(w, O.WHP, body({ orderable_kind: 'test' })))).toBe('common.not_found');
    expect(w.writes()).toEqual([]);
  });
  it('a priceFor failure other than catalog.no_price is NOT swallowed as "no price": the request fails and nothing is stored', async () => {
    const w = makeBookableWorld(); w.setCatalog(O.CBC, { priceError: new Error('catalog unavailable') });
    const c = await code(put(w, O.CBC, body())); expect(c).not.toBe('RESOLVED'); expect(c).not.toBe('catalog.no_price'); expect(w.t['items']).toEqual([]);
    expect(w.catalog.calls.map((x) => x.method)).toContain('priceFor');   // it got as far as the price lookup (not just the T-01 placeholder refusing)
  });
  it('body is validated: missing/extra/mistyped fields -> 400 common.validation_failed, zero writes, zero CatalogPort calls (mass assignment: code, display_name, price, tenant_id, version never accepted)', async () => {
    const w = makeBookableWorld();
    const bad: unknown[] = [{ ...body(), code: 'HACK' }, { ...body(), display_name: 'x' }, { ...body(), indicative_price_paisa: 1 }, { ...body(), indicative_price: { amount_paisa: 1, currency: 'NPR' } }, { ...body(), tenant_id: TENANT_B },
      { ...body(), version: 9 }, { ...body(), sex_restriction: 'male' }, { ...body(), id: ID(1) },
      body({ orderable_kind: 'bundle' }), body({ orderable_kind: undefined }), body({ booking_kinds: [] }), body({ booking_kinds: ['centre_visit', 'home_collection', 'centre_visit'] }), body({ booking_kinds: ['centre_visit', 'centre_visit'] }),
      body({ booking_kinds: ['pickup'] }), body({ booking_kinds: 'centre_visit' }), body({ booking_kinds: undefined }), body({ sort_order: -1 }), body({ sort_order: 10000 }), body({ sort_order: 1.5 }), body({ sort_order: '10' }),
      body({ sort_order: undefined }), body({ is_active: 'yes' }), body({ is_active: undefined }), null, 'x', []];
    for (const b of bad) expect(await code(put(w, O.CBC, b)), JSON.stringify(b)).toBe('common.validation_failed');
    expect(['common.validation_failed', 'common.not_found']).toContain(await code(put(w, "1'; DROP TABLE x;--", body())));
    expect(w.writes()).toEqual([]); expect(w.catalog.calls).toEqual([]);
  });
  it('permission: assertRole(engagement.bookable_item.manage) refused -> auth.forbidden, not a single statement, no CatalogPort call', async () => {
    const w = makeBookableWorld(); w.identity.deny.add(MANAGE);
    expect(await code(put(w, O.CBC, body()))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]); expect(w.catalog.calls).toEqual([]);
  });
});

describe('S13 upsertBookableItem — update, versioning, tenancy', () => {
  it('If-Match "1" -> 200 version 2; staff fields change, the snapshot is refreshed from the catalogue (new price), name/code never from the body', async () => {
    const w = makeBookableWorld(); const r = w.item(O.CBC, { indicative_price_paisa: 1, display_name: 'Stale Name' }); w.setCatalog(O.CBC, { paisa: 47500, listVersion: 4 }); w.advance(60_000);
    const res = await put(w, O.CBC, body({ booking_kinds: ['home_collection'], sort_order: 5, is_active: false }), { 'idempotency-key': 'k-0002', 'if-match': '"1"' });
    expect(res.status).toBe(200); expect(schemaErrors('StaffBookableItem', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ orderable_id: O.CBC, display_name: 'Complete Blood Count', indicative_price: { amount_paisa: 47500 }, booking_kinds: ['home_collection'], is_active: false, version: 2 });
    expect(w.get(O.CBC)).toMatchObject({ id: r['id'], version: 2, sort_order: 5, is_active: false, price_list_version: 4, indicative_price_paisa: 47500, synced_at: w.now() }); expect(w.t['items']).toHaveLength(1);
  });
  it('stale If-Match -> 409 common.version_conflict, row unchanged; If-Match for an orderable that was never added -> 404 common.not_found', async () => {
    const w = makeBookableWorld(); w.item(O.CBC);
    expect(await fail(put(w, O.CBC, body({ sort_order: 7 }), { 'idempotency-key': 'k-3', 'if-match': '"7"' }))).toEqual({ code: 'common.version_conflict', status: 409 });
    expect(w.get(O.CBC)).toMatchObject({ version: 1, sort_order: 100 });
    expect(await code(put(w, O.GLU, body(), { 'idempotency-key': 'k-4', 'if-match': '"1"' }))).toBe('common.not_found'); expect(w.t['items']).toHaveLength(1);
  });
  it('second create of the same orderable (no If-Match) -> 409, never two rows, row unchanged', async () => {
    const w = makeBookableWorld(); w.item(O.CBC, { sort_order: 100 }); const e = await fail(put(w, O.CBC, body({ sort_order: 1 })));
    expect(e.status).toBe(409); expect(w.t['items']).toHaveLength(1); expect(w.get(O.CBC)['sort_order']).toBe(100);
  });
  it('TENANT B row: update with If-Match -> 404 (never 409/403), B row untouched; creating the same orderable in tenant A is independent of B', async () => {
    const w = makeBookableWorld(); const b = w.item(O.CBC, { tenant_id: TENANT_B, sort_order: 77 });
    expect(await code(put(w, O.CBC, body(), { 'idempotency-key': 'k-5', 'if-match': '"1"' }))).toBe('common.not_found'); expect(b['sort_order']).toBe(77); expect(b['version']).toBe(1);
    expect((await put(w, O.CBC, body(), { 'idempotency-key': 'k-6' })).status).toBe(200); expect(w.t['items']).toHaveLength(2); expect(b['version']).toBe(1);
  });
  it('every statement on engagement.bookable_items binds the session tenant id (REQ-SEC-024)', async () => {
    const w = makeBookableWorld(); w.item(O.GLU); await put(w, O.CBC, body()); await put(w, O.GLU, body(), { 'idempotency-key': 'k-7', 'if-match': '"1"' }); await list(w);
    expect(w.itemStmts().length).toBeGreaterThan(0); for (const s of w.itemStmts()) expect(s.values, s.text).toContain(TENANT_A);
  });
});

describe('S12 listBookableItems', () => {
  const seed = (w: W) => { w.item(O.GLU, { sort_order: 20 }); w.item(O.CBC, { sort_order: 10 }); w.item(O.WHP, { sort_order: 10, display_name: "A Women's Package" }); w.item(O.ANAEMIA, { sort_order: 30, is_active: false }); w.item(O.CBC, { tenant_id: TENANT_B, display_name: 'Tenant B Only' }); };
  it('200 {data, page}: schema-valid StaffBookableItems of the session tenant only, ordered sort_order, display_name; authorised first', async () => {
    const w = makeBookableWorld(); seed(w); const res = await list(w);
    expect(res.status).toBe(200); expect(res.body.data.every((x: any) => schemaErrors('StaffBookableItem', x).length === 0)).toBe(true); expect(res.body.page).toHaveProperty('limit');
    expect(res.body.data.map((x: any) => x.code)).toEqual(['WHP', 'CBC', 'GLU', 'ANAEMIA']); expect(JSON.stringify(res.body)).not.toContain('Tenant B Only'); expect(w.identity.asserted[0]).toMatchObject({ permission: MANAGE, at: 0 });
    expect(res.body.data.find((x: any) => x.code === 'CBC')).toMatchObject({ indicative_price: { amount_paisa: 45000, currency: 'NPR' }, version: 1 });
  });
  it('is_active filter; query matches code or display name case-insensitively; the search string is bound, never part of the SQL text', async () => {
    const w = makeBookableWorld(); seed(w);
    expect((await list(w, { is_active: true })).body.data.map((x: any) => x.code)).toEqual(['WHP', 'CBC', 'GLU']); expect((await list(w, { is_active: false })).body.data.map((x: any) => x.code)).toEqual(['ANAEMIA']);
    expect((await list(w, { query: 'cbc' })).body.data.map((x: any) => x.code)).toEqual(['CBC']); expect((await list(w, { query: 'glucose' })).body.data.map((x: any) => x.code)).toEqual(['GLU']);
    const evil = "x'; DROP TABLE bookable_items;--"; expect((await list(w, { query: evil })).body.data).toEqual([]);
    for (const s of w.itemStmts()) expect(s.text).not.toContain('DROP TABLE');
  });
  it('limit + cursor walk every row exactly once in order; the last page has no next_cursor', async () => {
    const w = makeBookableWorld(); seed(w); const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await list(w, { limit: 2, ...(cursor ? { cursor } : {}) }); expect(res.body.data.length).toBeLessThanOrEqual(2); seen.push(...res.body.data.map((x: any) => x.code));
      cursor = res.body.page.next_cursor; if (!cursor) break;
    }
    expect(cursor).toBeUndefined(); expect(seen).toEqual(['WHP', 'CBC', 'GLU', 'ANAEMIA']);
  });
  it('bad query params (query > 40 chars, limit 0 / 201 / text, is_active text, garbage cursor) -> 400 common.validation_failed; permission refused -> auth.forbidden before any statement', async () => {
    const w = makeBookableWorld(); seed(w);
    for (const q of [{ query: 'a'.repeat(41) }, { limit: 0 }, { limit: 201 }, { limit: 'many' }, { is_active: 'maybe' }, { cursor: '%%%not-a-cursor' }]) expect(await code(list(w, q as any)), JSON.stringify(q)).toBe('common.validation_failed');
    const w2 = makeBookableWorld(); w2.identity.deny.add(MANAGE); expect(await code(list(w2))).toBe('auth.forbidden'); expect(w2.stmts).toEqual([]);
  });
});

describe('S14 syncBookableItems', () => {
  const sync = (w: W, over: Record<string, any> = {}) => call('syncBookableItems', w, { headers: {} }, over);
  it('202 {}: enqueues exactly one engagement.sync_bookable_items {tenant_id} with job_key bookable:<tenant>, max_attempts 5; no CatalogPort call, no bookable_items write', async () => {
    const w = makeBookableWorld(); w.item(O.CBC); const res = await sync(w);
    expect(res.status).toBe(202); expect(res.body).toEqual({}); expect(w.identity.asserted[0]).toMatchObject({ permission: MANAGE, at: 0 });
    expect(w.jobs()).toHaveLength(1); expect(w.jobs('engagement.sync_bookable_items')[0]).toMatchObject({ payload: { tenant_id: TENANT_A }, jobKey: `bookable:${TENANT_A}`, maxAttempts: 5 });
    expect(w.catalog.calls).toEqual([]); expect(w.writes().filter((s) => /bookable_items/i.test(s.text))).toEqual([]);
  });
  it('clicking twice collapses in the queue (same job_key); permission refused -> auth.forbidden, nothing enqueued', async () => {
    const w = makeBookableWorld(); await sync(w); await sync(w); expect(w.jobs('engagement.sync_bookable_items')).toHaveLength(1);
    const w2 = makeBookableWorld(); w2.identity.deny.add(MANAGE); expect(await code(sync(w2))).toBe('auth.forbidden'); expect(w2.stmts).toEqual([]); expect(w2.jobs()).toEqual([]);
  });
});
