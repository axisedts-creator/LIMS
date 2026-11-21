// T0B-CONTENT-1 done_when (3), (7): listMyPortalContent, the public read of the patient app. Only active items inside their date window, ordered by kind then sort_order,
// short public cache headers, no staff fields, no personal data, tenant of the patient session. "today" is the database's current_date (the RLS policy portal_content__select__patient
// uses it), read from the database so the window edges cannot flake around midnight. The staff list is the control group.
import { afterAll, describe, expect, it } from 'vitest';
import { PERM, T, TENANT_A, TENANT_B, MEM, SYS_ACTOR, call, closePatientPool, expectCode, fails, im, mine, mk, req, schemaErrors, superTx, tag } from './helpers.js';

afterAll(closePatientPool);
const dbToday = async (): Promise<string> => superTx(async (tx) => String((await tx.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`)).rows[0].d));
const shift = (d: string, n: number): string => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const PUBLIC_KEYS = ['id', 'kind', 'title', 'body', 'image_attachment_id', 'link_url', 'starts_on', 'ends_on', 'published_at'];

describe('T0B-CONTENT-1: listMyPortalContent (patient app)', () => {
  it('returns exactly the active items inside their window: edges inclusive, open ends allowed; excludes inactive, future, expired', async () => {
    const t = tag(); const today = await dbToday();
    const want: Record<string, any> = {}; const skip: Record<string, any> = {};
    want.noDates = await mk({ kind: 'offer', title: `W ${t} no dates` });
    want.inside = await mk({ kind: 'offer', title: `W ${t} inside`, starts_on: shift(today, -3), ends_on: shift(today, 3) });
    want.startsToday = await mk({ kind: 'offer', title: `W ${t} starts today`, starts_on: today });
    want.endsToday = await mk({ kind: 'offer', title: `W ${t} ends today`, ends_on: today });
    want.oneDay = await mk({ kind: 'offer', title: `W ${t} one day`, starts_on: today, ends_on: today });
    want.openEnd = await mk({ kind: 'offer', title: `W ${t} open end`, starts_on: shift(today, -30) });
    want.openStart = await mk({ kind: 'offer', title: `W ${t} open start`, ends_on: shift(today, 30) });
    skip.future = await mk({ kind: 'offer', title: `W ${t} future`, starts_on: shift(today, 1), ends_on: shift(today, 9) });
    skip.expired = await mk({ kind: 'offer', title: `W ${t} expired`, starts_on: shift(today, -9), ends_on: shift(today, -1) });
    skip.farFuture = await mk({ kind: 'offer', title: `W ${t} far future`, starts_on: '2099-01-01' });
    skip.off = await mk({ kind: 'offer', title: `W ${t} deactivated` });
    await call('deactivatePortalContent', req({ params: { content_id: skip.off.id }, headers: im(skip.off.version) }));
    const r = await mine({ kind: 'offer' });
    expect(r.status).toBe(200); expect(r.assertCalls).toEqual([PERM.self]);
    expect(schemaErrors('PortalContentPublicPage', r.body), 'matches PortalContentPublicPage').toEqual([]);
    const ids = r.body.data.map((x: any) => x.id);
    for (const [k, v] of Object.entries(want)) expect(ids, `${k} must be shown`).toContain(v.id);
    for (const [k, v] of Object.entries(skip)) expect(ids, `${k} must NOT be shown`).not.toContain(v.id);
    // control group: the staff list still has all of them
    const staff = (await call('listPortalContent', req({ query: { kind: 'offer', limit: 200 } }))).body.data.map((x: any) => x.id);
    for (const v of [...Object.values(want), ...Object.values(skip)]) expect(staff).toContain(v.id);
    // every row the patient app got is really active and inside the window
    for (const x of r.body.data) { expect(x.kind).toBe('offer'); if (x.starts_on) expect(x.starts_on <= today).toBe(true); if (x.ends_on) expect(x.ends_on >= today).toBe(true); }
  }, T);

  it('ordered by kind then sort_order (the order set by reorderPortalContent), and the kind filter narrows', async () => {
    const t = tag();
    const a = await mk({ kind: 'banner', title: `O ${t} a` }); const b = await mk({ kind: 'banner', title: `O ${t} b` }); const c = await mk({ kind: 'banner', title: `O ${t} c` });
    const all = (await call('listPortalContent', req({ query: { kind: 'banner', limit: 200 } }))).body.data.map((x: any) => x.id as string);
    const order = [c.id, ...all.filter((i: string) => ![a.id, b.id, c.id].includes(i)), a.id, b.id];
    expect((await call('reorderPortalContent', req({ body: { kind: 'banner', ids: order } }))).status).toBe(200);
    const r = await mine({ kind: 'banner' });
    const mineIds = r.body.data.map((x: any) => x.id).filter((i: string) => [a.id, b.id, c.id].includes(i));
    expect(mineIds).toEqual([c.id, a.id, b.id]);
    const everything = (await mine()).body.data.map((x: any) => `${x.kind}`);
    expect(everything, 'grouped by kind, kinds ascending').toEqual([...everything].sort());
    expect((await mine({ kind: 'news' })).body.data.every((x: any) => x.kind === 'news')).toBe(true);
  }, T);

  it('public shape only: no staff, audit or concurrency fields, no is_active / sort_order, no author id, no personal data', async () => {
    const t = tag();
    await mk({ kind: 'news', title: `S ${t}`, body: '## Hello\n\n**bold** [site](https://example.org)', link_url: 'https://example.org/n', starts_on: '2020-01-01' });
    const r = await mine({ kind: 'news' });
    expect(r.body.data.length).toBeGreaterThan(0);
    for (const x of r.body.data) {
      expect(Object.keys(x).filter((k) => !PUBLIC_KEYS.includes(k)), 'keys outside PortalContentPublic').toEqual([]);
      for (const k of ['created_by', 'updated_by', 'created_at', 'updated_at', 'version', 'is_active', 'sort_order', 'tenant_id']) expect(x, k).not.toHaveProperty(k);
    }
    const wire = JSON.stringify(r.body);
    for (const secret of [SYS_ACTOR, MEM.a, MEM.b, TENANT_A, TENANT_B]) expect(wire, `leaks ${secret}`).not.toContain(secret);
    expect(wire, 'no raw HTML on the wire (the body is Markdown, the patient app renders with HTML off)').not.toContain('<');
    expect(r.body.data.find((x: any) => x.title === `S ${t}`)?.body).toBe('## Hello\n\n**bold** [site](https://example.org)');
  }, T);

  it('cache headers: short and public (done_when 3), varying on the credential so one tenant is never served another tenants copy; no Set-Cookie', async () => {
    const r = await mine();
    const cc = String(r.headers?.['cache-control'] ?? '').toLowerCase();
    expect(cc, 'cache-control').toContain('public');
    const age = /(?:^|[\s,])max-age=(\d+)/.exec(cc); expect(age, `max-age in "${cc}"`).toBeTruthy();
    expect(Number(age![1]), 'short: 1 to 300 seconds').toBeGreaterThanOrEqual(1); expect(Number(age![1])).toBeLessThanOrEqual(300);
    expect(cc).not.toContain('no-store'); expect(cc).not.toContain('private');
    expect(String(r.headers?.['vary'] ?? '').toLowerCase(), 'Vary: Authorization keeps tenants apart in a shared cache').toContain('authorization');
    expect(Object.keys(r.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('set-cookie');
  }, T);

  it('tenant of the session: a patient of tenant B sees only tenant B content, never tenant A (and the reverse)', async () => {
    const a = await mk({ kind: 'contact', title: `A only ${tag()}` }); const b = await mk({ kind: 'contact', title: `B only ${tag()}` }, { tenant: TENANT_B });
    const ra = (await mine({ kind: 'contact' }, { tenant: TENANT_A })).body.data.map((x: any) => x.id); const rb = (await mine({ kind: 'contact' }, { tenant: TENANT_B })).body.data.map((x: any) => x.id);
    expect(ra).toContain(a.id); expect(ra).not.toContain(b.id); expect(rb).toContain(b.id); expect(rb).not.toContain(a.id);
  }, T);

  it('nothing widens the set: is_active=false, include_inactive, tenant_id and date overrides in the query change nothing', async () => {
    const t = tag(); const off = await mk({ kind: 'news', title: `X ${t} off` }); await call('deactivatePortalContent', req({ params: { content_id: off.id }, headers: im(off.version) }));
    const future = await mk({ kind: 'news', title: `X ${t} future`, starts_on: '2099-01-01' }); const other = await mk({ kind: 'news', title: `X ${t} B` }, { tenant: TENANT_B });
    for (const extra of [{ is_active: false }, { is_active: 'false' }, { include_inactive: true }, { all: 1 }, { tenant_id: TENANT_B }, { as_of: '2099-06-01' }, { today: '2099-06-01' }, { starts_on: '2099-01-01' }]) {
      let ids: string[] = [];
      try { ids = (await mine({ kind: 'news', ...extra })).body.data.map((x: any) => x.id); } catch (e) { expect((e as any).statusCode, JSON.stringify(extra)).toBe(400); continue; }
      for (const bad of [off.id, future.id, other.id]) expect(ids, `${JSON.stringify(extra)} leaked ${bad}`).not.toContain(bad);
    }
  }, T);

  it('a STAFF actor calling the patient operation never gets inactive or out-of-window rows (refused, or filtered the same way)', async () => {
    const t = tag(); const off = await mk({ kind: 'offer', title: `Y ${t} off` }); await call('deactivatePortalContent', req({ params: { content_id: off.id }, headers: im(off.version) }));
    const future = await mk({ kind: 'offer', title: `Y ${t} future`, starts_on: '2099-01-01' });
    let ids: string[] = [];
    try { ids = (await call('listMyPortalContent', req({ query: { limit: 200 }, headers: { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' } }), { grants: [PERM.self, PERM.read, PERM.manage], as: 'staff' })).body.data.map((x: any) => x.id); }
    catch (e) { expectCode(e, 'auth.forbidden', 403); return; }
    expect(ids).not.toContain(off.id); expect(ids).not.toContain(future.id);
  }, T);

  it('needs engagement.self.read: staff-only grants are 403 for the patient operation', async () => {
    expectCode(await fails('listMyPortalContent', req({ query: {}, headers: { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' } }), { as: 'patient', grants: [PERM.read, PERM.manage] }), 'auth.forbidden', 403);
  }, T);

  it('pages: limit and next_cursor walk the whole public set once, a bad cursor or kind or limit is 400', async () => {
    await Promise.all([1, 2, 3].map((i) => mk({ kind: 'contact', title: `Pg ${tag()} ${i}` })));
    const seen: string[] = []; let cursor: string | undefined; let n = 0;
    do { const r: any = await mine({ kind: 'contact', limit: 2, ...(cursor ? { cursor } : {}) }); expect(r.body.data.length).toBeLessThanOrEqual(2); seen.push(...r.body.data.map((x: any) => x.id)); cursor = r.body.page.next_cursor; n++; } while (cursor && n < 200);
    expect(new Set(seen).size).toBe(seen.length); expect(n).toBeGreaterThan(1);
    expectCode(await fails('listMyPortalContent', req({ query: { cursor: 'garbage!!' }, headers: { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' } }), { as: 'patient' }), 'common.invalid_cursor', 400);
    for (const q of [{ kind: 'x' }, { kind: "news' OR 1=1 --" }, { limit: 0 }, { limit: 201 }]) expect((await fails('listMyPortalContent', req({ query: q, headers: { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' } }), { as: 'patient' })).statusCode, JSON.stringify(q)).toBe(400);
  }, T);

  it('a deactivated item disappears from the patient app at once (no stale read inside the request)', async () => {
    const c = await mk({ kind: 'banner', title: `D ${tag()}` });
    expect((await mine({ kind: 'banner' })).body.data.map((x: any) => x.id)).toContain(c.id);
    await call('deactivatePortalContent', req({ params: { content_id: c.id }, headers: im(c.version) }));
    expect((await mine({ kind: 'banner' })).body.data.map((x: any) => x.id)).not.toContain(c.id);
  }, T);
});
