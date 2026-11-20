// T0B-CONTENT-1 staff operations (done_when 1, 2, 6, 7; LD-313; LD-325): listPortalContent, createPortalContent, updatePortalContent, deactivatePortalContent, reorderPortalContent.
// Real handlers over a PG17 RLS tx; the contract rules are asserted against the handler itself because the core ajv pipeline is not re-run here.
import { afterAll, describe, expect, it } from 'vitest';
import { PERM, T, TENANT_A, TENANT_B, appTx, asset, auditRows, call, closePatientPool, expectCode, expectInvalid, fails, idem, im, list, mk, ownerRows, req, row, schemaErrors, tag, uid } from './helpers.js';

afterAll(closePatientPool);

describe('T0B-CONTENT-1: createPortalContent', () => {
  it('creates each of the 4 kinds: 201, contract shaped, active, version 1, server set published_at, created_by = the caller', async () => {
    for (const kind of ['news', 'banner', 'offer', 'contact'] as const) {
      const r = await call('createPortalContent', req({ headers: idem(), body: { kind, title: `Synthetic ${kind} ${tag()}` } }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(schemaErrors('PortalContent', r.body), 'matches PortalContent').toEqual([]);
      expect(r.body).toMatchObject({ kind, is_active: true, version: 1 });
      expect(typeof r.body.published_at, 'published_at is set by the server').toBe('string');
      expect(r.assertCalls, 'permission checked first').toEqual([PERM.manage]);
      expect(r.headers?.['etag']).toBe('"1"');
    }
  }, T);
  it('stores and returns every field verbatim (Markdown body is stored as written, the render happens on read)', async () => {
    const img = await asset();
    const body = '## Opening hours\n\nFrom **1 December** we open at 6:30.\n\n- Sunday to Friday\n- Saturday closed\n\n[Details](https://example.org/hours)';
    const c = await mk({ kind: 'banner', title: `Winter ${tag()}`, body, image_attachment_id: img, link_url: 'https://example.org/offers/winter?x=1&y=2', starts_on: '2026-12-01', ends_on: '2026-12-31', sort_order: 7 });
    expect(c).toMatchObject({ kind: 'banner', body, image_attachment_id: img, link_url: 'https://example.org/offers/winter?x=1&y=2', starts_on: '2026-12-01', ends_on: '2026-12-31', sort_order: 7 });
    const db = await row(c.id);
    expect(db).toMatchObject({ tenant_id: TENANT_A, body, image_attachment_id: img, is_active: true, version: 1 });
    expect(db.created_by).toBeTruthy();
  }, T);
  it('mass assignment: a client supplied id, tenant_id, created_by, version or published_at never wins (rejected or ignored)', async () => {
    const evil = { id: uid(), tenant_id: TENANT_B, created_by: uid(), updated_by: uid(), version: 99, published_at: '2001-01-01T00:00:00.000Z', is_active: false };
    let r: any; try { r = await call('createPortalContent', req({ headers: idem(), body: { kind: 'news', title: `Mass ${tag()}`, ...evil } })); } catch (e) { expect((e as any).code).toBe('common.validation_failed'); return; }
    expect(r.status).toBe(201);
    const db = await row(r.body.id);
    expect(db.id).not.toBe(evil.id); expect(db.tenant_id).toBe(TENANT_A); expect(db.created_by).not.toBe(evil.created_by); expect(db.version).toBe(1); expect(db.is_active).toBe(true);
    expect(String(db.published_at)).not.toMatch(/2001/);
  }, T);
  it.each([
    ['kind not allowed', { kind: 'popup' }, '/kind'], ['kind missing', { kind: undefined }, '/kind'], ['title empty', { title: '' }, '/title'], ['title missing', { title: undefined }, '/title'],
    ['title with <', { title: 'a <b>x</b>' }, '/title'], ['title with >', { title: 'a > b' }, '/title'], ['title over 200', { title: 'x'.repeat(201) }, '/title'],
    ['title not a string', { title: 5 }, '/title'],
    ['body script', { body: '<script>alert(1)</script>' }, '/body'], ['body raw html', { body: 'a <b>b</b>' }, '/body'], ['body javascript link', { body: '[x](javascript:alert(1))' }, '/body'],
    ['body http link', { body: '[x](http://example.org)' }, '/body'], ['body image', { body: '![x](https://example.org/a.png)' }, '/body'], ['body reference definition', { body: '[x]: https://example.org' }, '/body'],
    ['body numeric entity', { body: '&#60;script&#62;' }, '/body'], ['body NUL (Postgres would 500)', { body: 'a\u0000b' }, '/body'], ['body oversized', { body: 'a'.repeat(20001) }, '/body'],
    ['body not a string', { body: { html: 'x' } }, '/body'],
    ['link_url http', { link_url: 'http://example.org' }, '/link_url'], ['link_url javascript', { link_url: 'javascript:alert(1)' }, '/link_url'], ['link_url data', { link_url: 'data:text/html,x' }, '/link_url'],
    ['link_url whitespace', { link_url: 'https://example.org/a b' }, '/link_url'], ['link_url angle bracket', { link_url: 'https://example.org/<x>' }, '/link_url'],
    ['link_url quote', { link_url: 'https://example.org/"x' }, '/link_url'], ['link_url over 2048', { link_url: `https://example.org/${'a'.repeat(2040)}` }, '/link_url'],
    ['starts_on not a date', { starts_on: '2026-13-45' }, '/starts_on'], ['starts_on 30 February', { starts_on: '2026-02-30' }, '/starts_on'], ['starts_on with time', { starts_on: '2026-12-01T00:00:00Z' }, '/starts_on'],
    ['ends_on not a date', { ends_on: 'tomorrow' }, '/ends_on'], ['ends_on before starts_on', { starts_on: '2026-12-10', ends_on: '2026-12-09' }, '/ends_on'],
    ['sort_order negative', { sort_order: -1 }, '/sort_order'], ['sort_order too big', { sort_order: 100001 }, '/sort_order'], ['sort_order fractional', { sort_order: 1.5 }, '/sort_order'],
    ['image id not a uuid', { image_attachment_id: 'not-a-uuid' }, '/image_attachment_id'],
  ] as [string, Record<string, unknown>, string][])('refuses: %s (400 common.validation_failed, path %s, nothing written)', async (_n, over, path) => {
    const body: Record<string, unknown> = { kind: 'news', title: `Synthetic ${tag()}`, ...over };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    await expectInvalid('createPortalContent', req({ headers: idem(), body }), path);
  }, T);
  it('accepts the boundary values: title 200, body 20000, link_url 2048, ends_on = starts_on, sort_order 0 and 100000', async () => {
    const c = await mk({ title: 'x'.repeat(200), body: 'a'.repeat(20000), link_url: `https://example.org/${'a'.repeat(2048 - 20)}`, starts_on: '2026-12-01', ends_on: '2026-12-01', sort_order: 100000 });
    expect(c.sort_order).toBe(100000); expect(await mk({ sort_order: 0 })).toMatchObject({ sort_order: 0 });
  }, T);
  it('a body that is a JSON array or null, or a missing body, is a clean 400 (not a 500)', async () => {
    for (const body of [null, undefined, [], 'text', 5]) {
      const e = await fails('createPortalContent', req({ headers: idem(), body }));
      expect(e.code, JSON.stringify(body)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    }
  }, T);
  it('writes an audit event (row audit INSERT with the actor) for every create', async () => {
    const c = await mk();
    const a = await auditRows('portal_content', c.id);
    expect(a.map((x: any) => x.action)).toEqual(['INSERT']);
  }, T);
  it('needs engagement.content.manage: read only, patient app and no grants are 403 auth.forbidden and nothing is written', async () => {
    for (const grants of [[PERM.read], [PERM.self], []]) {
      let writes: string[] = []; let err: any;
      try { writes = (await call('createPortalContent', req({ headers: idem(), body: { kind: 'news', title: 'forbidden' } }), { grants })).writes; } catch (e) { err = e; }
      expectCode(err, 'auth.forbidden', 403); expect(writes).toEqual([]);
    }
  }, T);
});

describe('T0B-CONTENT-1: listPortalContent', () => {
  it('lists everything of the tenant, active or not, in any date window, ordered by kind then sort_order; checks engagement.content.read', async () => {
    const t = tag();
    const a = await mk({ kind: 'offer', title: `L ${t} offer 2`, sort_order: 2 }); const b = await mk({ kind: 'offer', title: `L ${t} offer 1`, sort_order: 1 });
    const gone = await mk({ kind: 'banner', title: `L ${t} expired`, starts_on: '2020-01-01', ends_on: '2020-01-02' });
    const off = await mk({ kind: 'news', title: `L ${t} off` });
    await call('deactivatePortalContent', req({ params: { content_id: off.id }, headers: im(off.version) }));
    const r = await call('listPortalContent', req({ query: { limit: 200 } }));
    expect(r.assertCalls).toEqual([PERM.read]);
    expect(schemaErrors('PortalContentPage', r.body), 'matches PortalContentPage').toEqual([]);
    const ids = r.body.data.map((x: any) => x.id);
    for (const x of [a, b, gone, off]) expect(ids, x.title).toContain(x.id);
    const ours = r.body.data.filter((x: any) => x.title.includes(`L ${t}`));
    const order = ours.map((x: any) => `${x.kind}|${String(x.sort_order).padStart(6, '0')}`);
    expect(order, 'kind then sort_order').toEqual([...order].sort());
  }, T);
  it('whole list is ordered by kind then sort_order (not only our rows)', async () => {
    const rows = await list();
    const keys = rows.map((x: any) => [x.kind, x.sort_order] as const);
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]![0] < keys[i]![0] || (keys[i - 1]![0] === keys[i]![0] && keys[i - 1]![1] <= keys[i]![1]), `${keys[i - 1]} before ${keys[i]}`).toBe(true);
  }, T);
  it('filters: kind, is_active (true / false)', async () => {
    const t = tag(); const n = await mk({ kind: 'contact', title: `F ${t} on` }); const o = await mk({ kind: 'contact', title: `F ${t} off` });
    await call('deactivatePortalContent', req({ params: { content_id: o.id }, headers: im(o.version) }));
    const contacts = await list({ kind: 'contact' });
    expect(contacts.every((x: any) => x.kind === 'contact')).toBe(true); expect(contacts.map((x: any) => x.id)).toEqual(expect.arrayContaining([n.id, o.id]));
    const active = await list({ kind: 'contact', is_active: true }); const inactive = await list({ kind: 'contact', is_active: false });
    expect(active.map((x: any) => x.id)).toContain(n.id); expect(active.map((x: any) => x.id)).not.toContain(o.id);
    expect(inactive.map((x: any) => x.id)).toContain(o.id); expect(inactive.map((x: any) => x.id)).not.toContain(n.id);
    expect(inactive.every((x: any) => x.is_active === false)).toBe(true);
  }, T);
  it('keyset pages: limit and next_cursor walk every row once; a malformed cursor is 400 common.invalid_cursor', async () => {
    const mine = await Promise.all([1, 2, 3, 4, 5].map((i) => mk({ kind: 'offer', title: `P ${tag()} ${i}` })));
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r: any = await call('listPortalContent', req({ query: { kind: 'offer', limit: 2, ...(cursor ? { cursor } : {}) } }));
      expect(r.body.data.length).toBeLessThanOrEqual(2); expect(r.body.page.limit).toBe(2);
      seen.push(...r.body.data.map((x: any) => x.id)); cursor = r.body.page.next_cursor; pages++;
    } while (cursor && pages < 200);
    expect(new Set(seen).size, 'no row twice').toBe(seen.length);
    for (const m of mine) expect(seen).toContain(m.id);
    expectCode(await fails('listPortalContent', req({ query: { cursor: 'not-a-cursor!!', limit: 2 } })), 'common.invalid_cursor', 400);
  }, T);
  it('a foreign cursor (from another tenant) is refused or yields nothing of the other tenant', async () => {
    await mk({ kind: 'offer', title: `Cur ${tag()}` }); await mk({ kind: 'offer', title: `Cur ${tag()}` });
    const a: any = await call('listPortalContent', req({ query: { kind: 'offer', limit: 1 } }), { tenant: TENANT_A });
    const cursor = a.body.page.next_cursor; expect(cursor).toBeTruthy();
    const idsA = new Set((await list({}, { tenant: TENANT_A })).map((x: any) => x.id));
    try { const b: any = await call('listPortalContent', req({ query: { kind: 'offer', limit: 50, cursor } }), { tenant: TENANT_B }); for (const x of b.body.data) expect(idsA.has(x.id), 'tenant A row in a tenant B page').toBe(false); }
    catch (e) { expectCode(e, 'common.invalid_cursor', 400); }
  }, T);
  it('needs engagement.content.read (manage alone and patient grants are 403); the patient operation is separate', async () => {
    for (const grants of [[PERM.manage], [PERM.self], []]) expectCode(await fails('listPortalContent', req({ query: {} }), { grants }), 'auth.forbidden', 403);
  }, T);
  it('a bad filter is 400, not a SQL error', async () => {
    for (const q of [{ kind: 'x' }, { kind: "news' OR 1=1 --" }, { is_active: 'maybe' }, { limit: 0 }, { limit: 201 }]) {
      const e = await fails('listPortalContent', req({ query: q })); expect(e.statusCode, JSON.stringify(q)).toBe(400);
    }
  }, T);
});

describe('T0B-CONTENT-1: updatePortalContent', () => {
  const patch = (c: any, body: object, o: { headers?: object; tenant?: string } = {}) =>
    call('updatePortalContent', req({ params: { content_id: c.id }, headers: o.headers ?? im(c.version), body }), o.tenant ? { tenant: o.tenant } : {});
  it('changes any field; version +1; ETag; If-Match required (428) and stale (409); audit UPDATE', async () => {
    const c = await mk({ kind: 'news', title: `U ${tag()}`, body: 'old' });
    const img = await asset();
    const r = await patch(c, { title: 'New title', body: '**new**', kind: 'offer', link_url: 'https://example.org/n', starts_on: '2026-01-01', ends_on: '2026-02-01', sort_order: 3, image_attachment_id: img });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(schemaErrors('PortalContent', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: c.id, title: 'New title', body: '**new**', kind: 'offer', link_url: 'https://example.org/n', starts_on: '2026-01-01', ends_on: '2026-02-01', sort_order: 3, image_attachment_id: img, version: 2 });
    expect(r.headers?.['etag']).toBe('"2"'); expect(r.assertCalls).toEqual([PERM.manage]);
    expect(r.body.published_at, 'published_at is not rewritten by an edit').toBe(c.published_at);
    expectCode(await fails('updatePortalContent', req({ params: { content_id: c.id }, headers: {}, body: { title: 'x' } })), 'common.precondition_required', 428);
    expectCode(await fails('updatePortalContent', req({ params: { content_id: c.id }, headers: im(1), body: { title: 'stale' } })), 'common.version_conflict', 409);
    expect((await row(c.id)).title, 'a refused update changed nothing').toBe('New title');
    expect((await auditRows('portal_content', c.id)).map((x: any) => x.action)).toEqual(['INSERT', 'UPDATE']);
  }, T);
  it('is_active true reactivates a deactivated item', async () => {
    const c = await mk(); const d = (await call('deactivatePortalContent', req({ params: { content_id: c.id }, headers: im(c.version) }))).body;
    const r = await patch(d, { is_active: true }); expect(r.body).toMatchObject({ is_active: true, version: 3 });
  }, T);
  it('the Markdown, https and date rules hold on update too, and a refused update writes nothing', async () => {
    const c = await mk({ starts_on: '2026-12-10' });
    for (const [over, path] of [[{ body: '<script>x</script>' }, '/body'], [{ body: '[x](javascript:alert(1))' }, '/body'], [{ body: '![x](https://example.org/a.png)' }, '/body'], [{ body: 'a'.repeat(20001) }, '/body'],
      [{ link_url: 'http://example.org' }, '/link_url'], [{ title: '<b>' }, '/title'], [{ kind: 'popup' }, '/kind'], [{ sort_order: -1 }, '/sort_order'], [{ starts_on: '2026-02-30' }, '/starts_on'],
      [{ ends_on: '2026-12-09' }, '/ends_on'] /* before the stored starts_on */] as [object, string][])
      await expectInvalid('updatePortalContent', req({ params: { content_id: c.id }, headers: im(c.version), body: over }), path);
    const empty = await fails('updatePortalContent', req({ params: { content_id: c.id }, headers: im(c.version), body: {} })); // minProperties 1
    expect(empty.code).toBe('common.validation_failed'); expect(empty.statusCode).toBe(400);
    expect((await row(c.id)).version).toBe(1);
  }, T);
  it('unknown id, malformed id and another tenant id are 404 common.not_found / 400, indistinguishable', async () => {
    const c = await mk();
    expectCode(await fails('updatePortalContent', req({ params: { content_id: uid() }, headers: im(1), body: { title: 'x' } })), 'common.not_found', 404);
    expectCode(await fails('updatePortalContent', req({ params: { content_id: c.id }, headers: im(1), body: { title: 'x' } }), { tenant: TENANT_B }), 'common.not_found', 404);
    const e = await fails('updatePortalContent', req({ params: { content_id: 'nope' }, headers: im(1), body: { title: 'x' } })); expect([400, 404]).toContain(e.statusCode);
    expect((await row(c.id)).title, 'tenant B changed nothing').toBe(c.title);
  }, T);
  it('two writers with the same If-Match: exactly one wins, the other gets 409 (no lost update)', async () => {
    const c = await mk();
    const rs = await Promise.allSettled([1, 2, 3, 4].map((i) => patch(c, { title: `racer ${i}` })).map((p) => p));
    const won = rs.filter((r) => r.status === 'fulfilled'); const lost = rs.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1); for (const l of lost) expectCode(l.reason, 'common.version_conflict', 409);
    expect((await row(c.id)).version).toBe(2);
  }, T);
  it('needs engagement.content.manage', async () => {
    const c = await mk(); expectCode(await fails('updatePortalContent', req({ params: { content_id: c.id }, headers: im(1), body: { title: 'x' } }), { grants: [PERM.read] }), 'auth.forbidden', 403);
  }, T);
});

describe('T0B-CONTENT-1: deactivatePortalContent (never deleted)', () => {
  it('sets is_active false, version +1, keeps the row; staff list still shows it; audit UPDATE; permission manage', async () => {
    const c = await mk();
    const r = await call('deactivatePortalContent', req({ params: { content_id: c.id }, headers: im(c.version) }));
    expect(r.status).toBe(200); expect(schemaErrors('PortalContent', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: c.id, is_active: false, version: 2 }); expect(r.assertCalls).toEqual([PERM.manage]);
    expect(await row(c.id)).toMatchObject({ is_active: false, version: 2 });
    expect((await list({ is_active: false })).map((x: any) => x.id)).toContain(c.id);
    expect((await auditRows('portal_content', c.id)).map((x: any) => x.action)).toEqual(['INSERT', 'UPDATE']);
  }, T);
  it('If-Match required (428) and stale (409); unknown id and another tenant are 404; no write on refusal', async () => {
    const c = await mk();
    expectCode(await fails('deactivatePortalContent', req({ params: { content_id: c.id }, headers: {} })), 'common.precondition_required', 428);
    expectCode(await fails('deactivatePortalContent', req({ params: { content_id: c.id }, headers: im(5) })), 'common.version_conflict', 409);
    expectCode(await fails('deactivatePortalContent', req({ params: { content_id: uid() }, headers: im(1) })), 'common.not_found', 404);
    expectCode(await fails('deactivatePortalContent', req({ params: { content_id: c.id }, headers: im(1) }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect((await row(c.id)).is_active).toBe(true);
  }, T);
  it('needs engagement.content.manage', async () => {
    const c = await mk(); expectCode(await fails('deactivatePortalContent', req({ params: { content_id: c.id }, headers: im(1) }), { grants: [PERM.read] }), 'auth.forbidden', 403);
  }, T);
  it('the application role cannot DELETE or TRUNCATE the content tables (history is kept)', async () => {
    for (const table of ['engagement.portal_content', 'engagement.profile_image'])
      for (const sql of [`DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        const e: any = await appTx(TENANT_A, async (tx) => { await tx.query('SAVEPOINT s'); try { await tx.query(sql); return undefined; } catch (x) { await tx.query('ROLLBACK TO s'); return x; } });
        expect(e?.code ?? e?.message, sql).toBeTruthy(); expect(String(e?.message ?? e)).toMatch(/permission denied|row-level security|cannot|policy/i);
      }
    expect((await ownerRows('engagement.portal_content', 'tenant_id = $1', [TENANT_A])).length).toBeGreaterThan(0);
  }, T);
});

describe('T0B-CONTENT-1: reorderPortalContent', () => {
  const ids = async (kind: string, o: { tenant?: string } = {}) => (await list({ kind }, o.tenant ? { tenant: o.tenant } : {})).map((x: any) => x.id as string);
  const reorder = (kind: string, order: string[], o: { tenant?: string } = {}) => call('reorderPortalContent', req({ body: { kind, ids: order } }), o.tenant ? { tenant: o.tenant } : {});
  it('one kind at a time: each id gets sort_order = its position (0 based); answers the kind in the new order; version +1; audit; other kinds untouched', async () => {
    await Promise.all([1, 2, 3].map((i) => mk({ kind: 'banner', title: `R ${tag()} ${i}` })));
    const news = await mk({ kind: 'news', sort_order: 42 });
    const before = await ids('banner'); const order = [...before].reverse();
    const r = await reorder('banner', order);
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(schemaErrors('PortalContentPage', r.body)).toEqual([]);
    expect(r.assertCalls).toEqual([PERM.manage]);
    expect(r.body.data.map((x: any) => x.id)).toEqual(order); expect(r.body.data.map((x: any) => x.sort_order)).toEqual(order.map((_, i) => i));
    expect(r.body.data.every((x: any) => x.kind === 'banner')).toBe(true);
    expect(await ids('banner')).toEqual(order);
    const touched = await row(order[0]!); expect((await auditRows('portal_content', touched.id)).map((x: any) => x.action)).toContain('UPDATE');
    expect((await row(news.id)).sort_order, 'another kind is not renumbered').toBe(42);
  }, T);
  it('a list that omits an item of the kind, repeats one, is empty, or names an id of another kind, another tenant or nobody is 400 /ids and changes nothing', async () => {
    const offerA = await mk({ kind: 'offer' }); await mk({ kind: 'offer' }); const news = await mk({ kind: 'news' });
    const bOnly = await mk({ kind: 'offer' }, { tenant: TENANT_B });
    const all = await ids('offer'); const snapshot = JSON.stringify((await list({ kind: 'offer' })).map((x: any) => [x.id, x.sort_order, x.version]));
    for (const bad of [all.slice(1), [...all, news.id], [...all, bOnly.id], [...all, uid()], [], [all[0], all[0], ...all.slice(1)], all.slice(0, 1)]) {
      const e = await fails('reorderPortalContent', req({ body: { kind: 'offer', ids: bad } }));
      expect(e.code, JSON.stringify(bad)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    }
    expect(JSON.stringify((await list({ kind: 'offer' })).map((x: any) => [x.id, x.sort_order, x.version])), 'a refused reorder changed nothing (atomic)').toBe(snapshot);
    expect(offerA.id).toBeTruthy();
  }, T);
  it('inactive items are part of their kind and must be listed too', async () => {
    const a = await mk({ kind: 'contact' }); const b = await mk({ kind: 'contact' });
    await call('deactivatePortalContent', req({ params: { content_id: b.id }, headers: im(b.version) }));
    const all = await ids('contact'); expect(all).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await reorder('contact', all)).status).toBe(200);
    const e = await fails('reorderPortalContent', req({ body: { kind: 'contact', ids: all.filter((x) => x !== b.id) } })); expect(e.statusCode).toBe(400);
  }, T);
  it('bad kind, bad uuid, too many ids are 400', async () => {
    for (const body of [{ kind: 'popup', ids: [uid()] }, { kind: 'news', ids: ['x'] }, { kind: 'news' }, { ids: [uid()] }, { kind: 'news', ids: Array.from({ length: 501 }, uid) }]) {
      const e = await fails('reorderPortalContent', req({ body })); expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    }
  }, T);
  it('tenant isolation: tenant B cannot reorder tenant A rows (400) and tenant A order is untouched', async () => {
    const a1 = await mk({ kind: 'banner' }); const before = await ids('banner');
    const e = await fails('reorderPortalContent', req({ body: { kind: 'banner', ids: [a1.id] } }), { tenant: TENANT_B }); expect(e.statusCode).toBe(400);
    expect(await ids('banner')).toEqual(before);
  }, T);
  it('two concurrent reorders leave one clean permutation 0..n-1 (no duplicate positions, no 500)', async () => {
    await Promise.all([1, 2, 3, 4].map((i) => mk({ kind: 'offer', title: `C ${tag()} ${i}` })));
    const all = await ids('offer');
    const rs = await Promise.allSettled([reorder('offer', [...all].reverse()), reorder('offer', [...all]), reorder('offer', [...all].reverse())]);
    for (const r of rs) if (r.status === 'rejected') expect([400, 409], String((r.reason as any)?.code ?? r.reason)).toContain((r.reason as any).statusCode);
    expect(rs.some((r) => r.status === 'fulfilled')).toBe(true);
    const rows = await list({ kind: 'offer' }); expect(rows.map((x: any) => x.sort_order)).toEqual(rows.map((_: unknown, i: number) => i));
  }, T);
  it('needs engagement.content.manage', async () => {
    expectCode(await fails('reorderPortalContent', req({ body: { kind: 'news', ids: [uid()] } }), { grants: [PERM.read] }), 'auth.forbidden', 403);
  }, T);
});

describe('T0B-CONTENT-1: tenant isolation of the staff operations', () => {
  it('tenant B sees none of tenant A content and vice versa; a title is not leaked by any filter', async () => {
    const a = await mk({ title: `Iso A ${tag()}` }); const b = await mk({ title: `Iso B ${tag()}` }, { tenant: TENANT_B });
    const la = (await list({}, { tenant: TENANT_A })).map((x: any) => x.id); const lb = (await list({}, { tenant: TENANT_B })).map((x: any) => x.id);
    expect(la).toContain(a.id); expect(la).not.toContain(b.id); expect(lb).toContain(b.id); expect(lb).not.toContain(a.id);
    expect((await row(b.id)).tenant_id).toBe(TENANT_B);
  }, T);
});
