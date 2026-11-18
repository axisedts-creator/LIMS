// T0B-PRICETOOLS-1 commitPriceListImport + listPriceListImportBatches over a real PG17 under RLS (done_when 2, 4, 6, 7): the commit runs in ONE transaction, creates a DRAFT version only, converts rupees to paisa
// exactly, is idempotent (a second commit of the same batch creates nothing), loses a race cleanly, never touches the published version or posted orders, and writes audit lines.
// PINNED: the draft = the list's current version items overlaid with the file rows (file wins; items not in the file are carried over, nothing is lost silently).
// PINNED: a second commit of a committed batch with ANOTHER Idempotency-Key is 409 catalog.import_not_committable (contract + C3 AC-16.7) OR returns the first version (done_when 2); either way nothing is created.
import { beforeAll, describe, expect, it } from 'vitest';
import { NONE, READ, SYS_ACTOR, T, TENANT_A, TENANT_B, allBatches, auditOf, batchRow, commitOf, detail, dry, expectCode, itemRows, listSnapshot, mkList, mkTests, ownerRows, pcall, pfails, priceBook, priceMap, publishedList,
  rowsFor, schemaErrors, superTx, uid, versionRows, world, req, type TestRef } from './helpers.js';
import type { World } from '../testmgmt/helpers.js';

let w: World; let tests: TestRef[];
beforeAll(async () => { w = await world(TENANT_A); tests = await mkTests(w, 14); }, T);

const drafts = async (listId: string) => (await versionRows(listId)).filter((v: any) => v.status === 'draft');
const frontdeskSnap = async () => superTx(async (tx) => (await tx.query(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS h FROM frontdesk.order_items x`)).rows[0].h as string);

describe('commit: DRAFT only, exact paisa, one transaction', () => {
  it('creates ONE draft version (never published) holding the file prices; the batch becomes committed and points at it; the response is a PriceListVersion', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[0]!.id, paisa: 1000 }, { id: tests[1]!.id, paisa: 2000 }]);
    const d = await dry(pub.list.id, priceBook([{ code: tests[0]!.code, price: 12.5 }, { code: tests[2]!.code, price: 30 }]));
    const c = await commitOf(d.batch.id);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(schemaErrors('PriceListVersion', c.body)).toEqual([]);
    expect(c.body).toMatchObject({ price_list_id: pub.list.id, status: 'draft', source_import_id: d.batch.id, change_reason: 'synthetic yearly revision' });
    const vs = await versionRows(pub.list.id);
    expect(vs.map((v: any) => v.status), 'one published (unchanged) + one new draft').toEqual(['published', 'draft']);
    const pm = await priceMap(c.body.id);
    expect(pm[tests[0]!.code]).toBe(1250); expect(pm[tests[2]!.code]).toBe(3000);
    expect(pm[tests[1]!.code], 'an item not in the file is carried over from the current version').toBe(2000);
    expect(c.body.item_count).toBe(3);
    const b = await batchRow(d.batch.id);
    expect(b.status).toBe('committed'); expect(b.result_price_list_version_id).toBe(c.body.id);
  });
  it('the PUBLISHED version and its prices are byte-identical afterwards (orders already priced are never repriced); frontdesk order items are untouched', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[3]!.id, paisa: 4000 }]);
    const before = { items: (await itemRows(pub.versionId)).map((r: any) => `${r.orderable_id}:${r.unit_price_paisa}:${r.version}`).sort(), ver: (await versionRows(pub.list.id))[0], fd: await frontdeskSnap() };
    const d = await dry(pub.list.id, priceBook([{ code: tests[3]!.code, price: 99 }]));
    expect((await commitOf(d.batch.id)).status).toBe(201);
    expect((await itemRows(pub.versionId)).map((r: any) => `${r.orderable_id}:${r.unit_price_paisa}:${r.version}`).sort()).toEqual(before.items);
    const after = (await versionRows(pub.list.id))[0];
    expect([after.status, after.version, after.effective_from, after.effective_to]).toEqual([before.ver.status, before.ver.version, before.ver.effective_from, before.ver.effective_to]);
    expect(await frontdeskSnap(), 'posted order items never repriced').toBe(before.fd);
    expect((await detail(pub.list.id)).current_version.id, 'the current version is still the published one').toBe(pub.versionId);
  });
  it('rupees become integer paisa EXACTLY (float traps 19.99, 0.29, 4.35, 8.2, 1.15), text "12.50", zero and the 9999999.99 ceiling', { timeout: T }, async () => {
    const { list } = await mkList();
    const cases: Array<[number | string, number]> = [[19.99, 1999], [0.29, 29], [4.35, 435], [8.2, 820], [1.15, 115], ['12.50', 1250], [0, 0], [9999999.99, 999999999], [100, 10000], [0.07, 7]];
    const d = await dry(list.id, priceBook(cases.map(([p], i) => ({ code: tests[i]!.code, price: p }))));
    expect(d.errors).toEqual([]);
    const c = await commitOf(d.batch.id);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const pm = await priceMap(c.body.id);
    cases.forEach(([, paisa], i) => expect(pm[tests[i]!.code], `${cases[i]![0]}`).toBe(paisa));
  });
  it('the test name column of the file never renames a catalogue test', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook([{ code: tests[0]!.code, name: 'Hacked name', price: 5 }]));
    await commitOf(d.batch.id);
    const o = await ownerRows('catalog.orderables', 'id = $1', [tests[0]!.id]);
    expect(o[0].name).not.toBe('Hacked name');
  });
  it('a batch with errors cannot be committed: 409 catalog.import_not_committable, nothing created, the batch stays dry_run', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 5 }, { code: 'NOSUCH1', price: 5 }]));
    expect(d.batch.error_count).toBeGreaterThan(0);
    const before = await listSnapshot(list.id);
    expectCode(await pfails('commitPriceListImport', req({ params: { batch_id: d.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } })), 'catalog.import_not_committable', 409);
    expect(await listSnapshot(list.id)).toEqual(before);
    expect((await batchRow(d.batch.id)).status).toBe('dry_run');
  });
  it('a list that already has a draft: 409 common.version_conflict, nothing written, the batch stays dry_run and can be committed after the draft is gone', { timeout: T }, async () => {
    const { list } = await mkList();
    const d1 = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 5 }])); const d2 = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 6 }]));
    expect((await commitOf(d1.batch.id)).status).toBe(201);
    const before = await listSnapshot(list.id);
    expectCode(await pfails('commitPriceListImport', req({ params: { batch_id: d2.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } })), 'common.version_conflict', 409);
    expect(await listSnapshot(list.id)).toEqual(before);
    expect((await batchRow(d2.batch.id)).status).toBe('dry_run');
    expect(await drafts(list.id)).toHaveLength(1);
  });
  it('the file is re-hashed: a batch whose stored hash no longer matches its file is refused and creates nothing', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 5 }]));
    const versionsBefore = await versionRows(list.id); // createPriceList makes an empty draft v1 (ruling 1)
    await superTx(async (tx) => { await tx.query(`UPDATE catalog.price_list_import_batch SET file_sha256 = $2 WHERE id = $1`, [d.batch.id, 'f'.repeat(64)]); }, TENANT_A);
    const e = await pfails('commitPriceListImport', req({ params: { batch_id: d.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } }));
    expect(e.statusCode, `${e.code}`).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(await versionRows(list.id)).toEqual(versionsBefore);
  });
});

describe('idempotent and race safe (done_when 2, 7)', () => {
  it('a second commit of the same batch (another key) creates nothing: 409 catalog.import_not_committable or the first result; one draft, one set of items', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook(rowsFor(tests.slice(0, 3), () => 7)));
    const c1 = await commitOf(d.batch.id); expect(c1.status).toBe(201);
    const before = await listSnapshot(list.id);
    try {
      const c2 = await commitOf(d.batch.id);
      expect([200, 201], JSON.stringify(c2.body)).toContain(c2.status);
      expect(c2.body.id, 'the first result').toBe(c1.body.id);
    } catch (e: any) { expectCode(e, 'catalog.import_not_committable', 409); }
    expect(await listSnapshot(list.id), 'nothing created').toEqual(before);
    expect(await drafts(list.id)).toHaveLength(1);
    expect(await itemRows(c1.body.id)).toHaveLength(3);
  });
  it('CONCURRENCY: the same batch committed 6 times at once yields exactly one draft version and one set of items; every loser is a clean 409 or the first result', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook(rowsFor(tests.slice(0, 5), () => 9)));
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => commitOf(d.batch.id)));
    const ok = res.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(ok.length, 'at least the winner').toBeGreaterThanOrEqual(1);
    for (const r of res) if (r.status === 'rejected') expect([r.reason?.code, r.reason?.statusCode], String(r.reason?.message)).toEqual(['catalog.import_not_committable', 409]);
    expect(new Set(ok.map((r) => r.value.body.id)).size, 'every success returns the same version').toBe(1);
    expect(await drafts(list.id)).toHaveLength(1);
    expect(await itemRows(ok[0]!.value.body.id)).toHaveLength(5);
  });
  it('CONCURRENCY: two different batches of one list committed at once: exactly one draft wins, the other is 409 common.version_conflict and stays dry_run', { timeout: T }, async () => {
    const { list } = await mkList();
    const a = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 1 }])); const b = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 2 }]));
    const res = await Promise.allSettled([commitOf(a.batch.id), commitOf(b.batch.id)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lose = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect([lose.reason?.code, lose.reason?.statusCode]).toEqual(['common.version_conflict', 409]);
    expect(await drafts(list.id)).toHaveLength(1);
    expect((await allBatches(list.id)).map((x: any) => x.status).sort()).toEqual(['committed', 'dry_run']);
  });
  it('ATOMIC: a failure while the last item is written leaves no draft, no item and the batch still dry_run; after the cause is gone the same batch commits', { timeout: T }, async () => {
    const { list } = await mkList();
    const last = tests[4]!;
    const d = await dry(list.id, priceBook([{ code: tests[3]!.code, price: 1 }, { code: last.code, price: 2 }]));
    const before = await listSnapshot(list.id);
    await superTx(async (tx) => {
      await tx.query(`CREATE OR REPLACE FUNCTION catalog.pt_fail_item() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'synthetic failure on the last item' USING ERRCODE = 'P0001'; END $f$`);
      await tx.query(`CREATE OR REPLACE TRIGGER pt_fail_item BEFORE INSERT ON catalog.price_list_items FOR EACH ROW WHEN (NEW.orderable_id = '${last.id}') EXECUTE FUNCTION catalog.pt_fail_item()`);
    });
    try {
      const e = await pfails('commitPriceListImport', req({ params: { batch_id: d.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } }));
      expect(e.statusCode, e.code).toBeGreaterThanOrEqual(400);
      expect(await listSnapshot(list.id), 'nothing, not even the batch status, was left behind').toEqual(before);
    } finally {
      await superTx(async (tx) => { await tx.query(`DROP TRIGGER IF EXISTS pt_fail_item ON catalog.price_list_items`); await tx.query(`DROP FUNCTION IF EXISTS catalog.pt_fail_item()`); });
    }
    const c = await commitOf(d.batch.id);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(await itemRows(c.body.id)).toHaveLength(2);
  });
});

describe('audit and history (done_when 6)', () => {
  it('every write has an audit line: the new version, its items and the batch status change; the actor is recorded', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook(rowsFor(tests.slice(0, 2), () => 3)));
    const c = await commitOf(d.batch.id);
    const va = await auditOf('price_list_versions', c.body.id);
    expect(va.length, 'version audit').toBeGreaterThanOrEqual(1);
    for (const a of va) { expect(a.actor_id, 'the actor of the commit is recorded').toBe(SYS_ACTOR); expect(a.tenant_id).toBe(TENANT_A); }
    const items = await itemRows(c.body.id);
    for (const it of items) expect((await auditOf('price_list_items', it.id)).length, `item ${it.id}`).toBeGreaterThanOrEqual(1);
    const ba = await auditOf('price_list_import_batch', d.batch.id);
    expect(ba.length, 'insert at the dry run + update at the commit').toBeGreaterThanOrEqual(2);
  });
  it('listPriceListImportBatches: newest first, filters by list and status, pages by cursor, matches PriceListImportBatchPage, no errors inside', { timeout: T }, async () => {
    const { list } = await mkList();
    const bytes = (n: number) => priceBook([{ code: tests[0]!.code, price: n }]);
    const a = await dry(list.id, bytes(1)); const b = await dry(list.id, bytes(2)); const c = await dry(list.id, priceBook([{ code: 'NOSUCH2', price: 1 }]));
    await commitOf(a.batch.id);
    const all = await pcall('listPriceListImportBatches', req({ query: { price_list_id: list.id } }), { grants: READ });
    expect(all.status).toBe(200);
    expect(schemaErrors('PriceListImportBatchPage', all.body)).toEqual([]);
    expect(all.body.data.map((x: any) => x.id)).toEqual([c.batch.id, b.batch.id, a.batch.id]);
    expect(JSON.stringify(all.body)).not.toContain('"errors"');
    const only = await pcall('listPriceListImportBatches', req({ query: { price_list_id: list.id, status: 'committed' } }), { grants: READ });
    expect(only.body.data.map((x: any) => x.id)).toEqual([a.batch.id]);
    const p1 = await pcall('listPriceListImportBatches', req({ query: { price_list_id: list.id, limit: 2 } }), { grants: READ });
    expect(p1.body.data).toHaveLength(2); expect(p1.body.page.next_cursor).toBeTruthy();
    const p2 = await pcall('listPriceListImportBatches', req({ query: { price_list_id: list.id, limit: 2, cursor: p1.body.page.next_cursor } }), { grants: READ });
    expect(p2.body.data.map((x: any) => x.id)).toEqual([a.batch.id]);
  });
  it('listPriceListImportBatches shows no batch of another tenant', { timeout: T }, async () => {
    const { list } = await mkList();
    await dry(list.id, priceBook([{ code: tests[0]!.code, price: 1 }]));
    const r = await pcall('listPriceListImportBatches', req({ query: { price_list_id: list.id } }), { tenant: TENANT_B, grants: READ });
    expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
  });
});

describe('permission and tenant isolation of commit', () => {
  it('without catalog.price_list.manage (none, read only): 403 auth.forbidden and nothing changes', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 1 }]));
    const before = await listSnapshot(list.id);
    for (const grants of [NONE, READ]) expectCode(await pfails('commitPriceListImport', req({ params: { batch_id: d.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } }), { grants }), 'auth.forbidden', 403);
    expect(await listSnapshot(list.id)).toEqual(before);
  });
  it('tenant B committing tenant A\'s batch gets the SAME 404 as for an unknown id; A\'s batch is untouched', { timeout: T }, async () => {
    const { list } = await mkList();
    const d = await dry(list.id, priceBook([{ code: tests[0]!.code, price: 1 }]));
    const before = await listSnapshot(list.id);
    const e1 = await pfails('commitPriceListImport', req({ params: { batch_id: d.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } }), { tenant: TENANT_B });
    const e2 = await pfails('commitPriceListImport', req({ params: { batch_id: uid() }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expectCode(e2, 'common.not_found', 404);
    expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    expect(await listSnapshot(list.id)).toEqual(before);
  });
});
