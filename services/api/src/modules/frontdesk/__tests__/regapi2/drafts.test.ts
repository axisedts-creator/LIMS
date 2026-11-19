// T0B-REGAPI-2 done_when (3): persisted registration drafts: create or replace, list for the current user and centre, get, delete, automatic expiry after 14 days;
// a draft never creates a patient, lab number or invoice. Operations: createRegistrationDraft, listRegistrationDrafts, getRegistrationDraft, deleteRegistrationDraft.
// PINNED PICKS (the contract has no text for them; LD-310 "create or replace"):
//  - create-or-replace key = (tenant, calling user, centre_id): saving again for the same centre REPLACES that draft (same id, payload, updated_at, expires_at refreshed,
//    version bumped); another centre or another user gets its own row. The request has no draft id, so nothing else can be the key.
//  - expires_at = updated_at + 14 days (migration comment, contract text). An expired draft (expires_at <= now) is invisible to list / get / delete (404 common.not_found)
//    even before any purge job ran; saving purges the caller's OWN expired drafts (the delete policy is owner bound, LD-315 b).
//  - payload on the wire is JSON text; must parse to a JSON object and be <= 1048576 bytes: else 400 common.validation_failed at /payload (never a 500 from the DB CHECK).
//  - another user's draft, an expired draft and an unknown id are the same answer: 404 common.not_found (no existence leak).
//  - the payload (patient data) never reaches ctx.log, an error message or the access log detail.
import { describe, expect, it } from 'vitest';
import { CENTRE, CENTRE_A2, T, TENANT_A, U1, as, codeOf, draftBody, draftRows, fire, forbidden, fresh, idem, notFound, ok, ownerRows, rejected, req, schemaErrors, superTx, uid, without } from './helpers.js';

const create = (who = U1, body: unknown = draftBody(CENTRE.a), o: object = {}) => fire('createRegistrationDraft', req({ headers: idem(), body }), who, o);
const list = (who = U1, query: object = {}) => fire('listRegistrationDrafts', req({ query }), who);
const get = (id: string, who = U1) => fire('getRegistrationDraft', req({ params: { draft_id: id } }), who);
const del = (id: string, who = U1) => fire('deleteRegistrationDraft', req({ params: { draft_id: id } }), who);
const DAY = 86_400_000;
const expire = async (id: string, interval = `now() - interval '1 second'`) => superTx(async (tx) => { await tx.query(`UPDATE frontdesk.registration_drafts SET expires_at = ${interval} WHERE id = $1`, [id]); });

describe('createRegistrationDraft', () => {
  it('201 RegistrationDraftRecord (schema valid), row owned by the caller, payload round-trips, expires_at = updated_at + 14 days', { timeout: T }, async () => {
    const u = fresh(); const body = draftBody(CENTRE.a, { note: 'SYNTHETIC-DRAFT' });
    const b = ok(await create(u, body), 201);
    expect(schemaErrors('RegistrationDraftRecord', b)).toEqual([]);
    expect(b.centre_id).toBe(CENTRE.a);
    expect(JSON.parse(b.payload)).toEqual(JSON.parse(body.payload));
    expect(Math.abs(Date.parse(b.expires_at) - Date.parse(b.updated_at) - 14 * DAY)).toBeLessThan(2000);
    const rows = await draftRows(u.membershipId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: b.id, tenant_id: TENANT_A, user_id: u.membershipId, centre_id: CENTRE.a });
    expect(rows[0].payload).toEqual(JSON.parse(body.payload));
    expect(Math.abs(Date.parse(rows[0].expires_at) - Date.parse(rows[0].updated_at) - 14 * DAY)).toBeLessThan(2000);
  });
  it('a draft never creates a patient, a lab (registration) number, an order, an invoice or a payment', { timeout: T }, async () => {
    const u = fresh();
    const snap = async () => ({ patients: (await ownerRows('frontdesk.patients', 'tenant_id = $1', [TENANT_A])).length, orders: (await ownerRows('frontdesk.orders', 'tenant_id = $1', [TENANT_A])).length,
      counters: JSON.stringify((await ownerRows('frontdesk.number_counters', 'tenant_id = $1 ORDER BY counter_kind, scope_key', [TENANT_A])).map((c) => [c.counter_kind, c.scope_key, c.last_value])) });
    const before = await snap();
    const out = await create(u, draftBody(CENTRE.a, { patient: { new: { full_name: 'Synthetic Draft Person', phone_e164: '+9779800000042' } }, items: [{ orderable_id: uid() }] }));
    ok(out, 201);
    expect(await snap()).toEqual(before);
    for (const m of ['issueOrderInvoice', 'recordPayment', 'recordCreditCharges']) expect(out.probe.w.billingFake.calls(m), m).toHaveLength(0);
  });
  it('create-or-replace: the same user + centre keeps ONE row (same id, new payload, refreshed expiry, version + 1); another centre or user gets its own row', { timeout: T }, async () => {
    const u = fresh();
    const first = ok(await create(u, draftBody(CENTRE.a, { v: 1 })), 201);
    await superTx(async (tx) => { await tx.query(`UPDATE frontdesk.registration_drafts SET expires_at = now() + interval '1 day' WHERE id = $1`, [first.id]); });   // 13 days short
    const second = ok(await create(u, draftBody(CENTRE.a, { v: 2 })), 201);
    expect(second.id).toBe(first.id);
    expect(JSON.parse(second.payload).v).toBe(2);
    expect(Date.parse(second.expires_at) - Date.now()).toBeGreaterThan(13 * DAY);               // refreshed to ~14 days
    const rows = await draftRows(u.membershipId, CENTRE.a);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].version)).toBe(Number(first.version ?? 1) + 1);
    const other = ok(await create(u, draftBody(CENTRE_A2)), 201);
    expect(other.id).not.toBe(first.id);
    const peer = ok(await create(fresh(), draftBody(CENTRE.a)), 201);
    expect(peer.id).not.toBe(first.id);
    expect(await draftRows(u.membershipId)).toHaveLength(2);
  });
  it('saving purges the caller\'s own expired drafts (expiry after 14 days) and leaves the live ones', { timeout: T }, async () => {
    const u = fresh();
    const old = ok(await create(u, draftBody(CENTRE_A2)), 201); await expire(old.id);
    const live = ok(await create(u, draftBody(CENTRE.a)), 201);
    ok(await create(u, draftBody(CENTRE.a, { again: true })), 201);
    const ids = (await draftRows(u.membershipId)).map((r) => r.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(live.id);
  });
  it('payload rules: not JSON, not an object, empty, over 1 MiB => 400 at /payload; just under 1 MiB is accepted; nothing stored on a refusal', { timeout: T }, async () => {
    const u = fresh();
    for (const payload of ['not json', '[]', '"text"', '123', 'null', '', '{']) {
      rejected(await create(u, { centre_id: CENTRE.a, payload }), 'common.validation_failed', '/payload');
    }
    rejected(await create(u, draftBody(CENTRE.a, {}, 1_048_576)), 'common.validation_failed', '/payload');
    expect(await draftRows(u.membershipId)).toHaveLength(0);
    ok(await create(u, draftBody(CENTRE.a, {}, 1_000_000)), 201);
  });
  it('unknown centre => 404; centre outside the caller\'s scope => refused; unknown body key => 400', { timeout: T }, async () => {
    const u = fresh();
    notFound(await create(u, draftBody(uid())));
    const scoped = as(u, { allCentres: false, centreIds: [CENTRE.a] });
    expect(['common.not_found', 'auth.forbidden']).toContain(codeOf(await create(scoped, draftBody(CENTRE_A2))));
    rejected(await create(u, { ...draftBody(CENTRE.a), extra: 1 }));
    expect(await draftRows(u.membershipId)).toHaveLength(0);
  });
  it('requires frontdesk.registration.create (auth.forbidden), nothing stored', { timeout: T }, async () => {
    const u = without(fresh(), 'frontdesk.registration.create');
    forbidden(await create(u));
    expect(await draftRows(u.membershipId)).toHaveLength(0);
  });
  it('the payload (patient data) is never logged, echoed in an error, or written to the access log', { timeout: T }, async () => {
    const secret = `SYN-PAYLOAD-${uid()}`;
    const u = fresh();
    const out = await create(u, draftBody(CENTRE.a, { patient: { full_name: secret } }));
    ok(out, 201);
    expect(out.probe.logs.join('\n')).not.toContain(secret);
    expect(JSON.stringify(out.probe.accessCalls)).not.toContain(secret);
    const bad = await create(u, { centre_id: CENTRE.a, payload: `{"patient":"${secret}"` });
    rejected(bad, 'common.validation_failed', '/payload', secret);
    expect(bad.probe.logs.join('\n')).not.toContain(secret);
  });
});

describe('listRegistrationDrafts', () => {
  it('lists only the caller\'s own unexpired drafts, newest first, as summaries without the payload (schema valid)', { timeout: T }, async () => {
    const u = fresh(); const v = fresh();
    const a = ok(await create(u, draftBody(CENTRE.a)), 201);
    await new Promise((r) => setTimeout(r, 15));
    const b = ok(await create(u, draftBody(CENTRE_A2)), 201);
    const foreign = ok(await create(v, draftBody(CENTRE.a)), 201);
    const gone = ok(await create(fresh(), draftBody(CENTRE.a)), 201);
    const body = ok(await list(u));
    expect(schemaErrors('RegistrationDraftRecordPage', body)).toEqual([]);
    expect(body.data.map((d: any) => d.id)).toEqual([b.id, a.id]);
    expect(JSON.stringify(body)).not.toContain(foreign.id);
    expect(JSON.stringify(body)).not.toContain(gone.id);
    for (const d of body.data) expect(d).not.toHaveProperty('payload');
    await expire(a.id);
    expect(ok(await list(u)).data.map((d: any) => d.id)).toEqual([b.id]);                    // expired => gone before any purge
  });
  it('centre_id filters to that centre; an empty list is 200 with data []', { timeout: T }, async () => {
    const u = fresh();
    const a = ok(await create(u, draftBody(CENTRE.a)), 201); const b = ok(await create(u, draftBody(CENTRE_A2)), 201);
    expect(ok(await list(u, { centre_id: CENTRE_A2 })).data.map((d: any) => d.id)).toEqual([b.id]);
    expect(ok(await list(u, { centre_id: CENTRE.a })).data.map((d: any) => d.id)).toEqual([a.id]);
    const e = ok(await list(fresh()));
    expect(e.data).toEqual([]);
    expect(e.page.limit).toBeGreaterThan(0);
  });
  it('cursor paging: limit 1 returns the newest and a next_cursor that leads to the older one, no repeats', { timeout: T }, async () => {
    const u = fresh();
    const a = ok(await create(u, draftBody(CENTRE.a)), 201); await new Promise((r) => setTimeout(r, 15)); const b = ok(await create(u, draftBody(CENTRE_A2)), 201);
    const p1 = ok(await list(u, { limit: '1' }));
    expect(p1.data.map((d: any) => d.id)).toEqual([b.id]);
    expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = ok(await list(u, { limit: '1', cursor: p1.page.next_cursor }));
    expect(p2.data.map((d: any) => d.id)).toEqual([a.id]);
  });
  it('requires frontdesk.registration.create', { timeout: T }, async () => { forbidden(await list(without(fresh(), 'frontdesk.registration.create'))); });
});

describe('getRegistrationDraft', () => {
  it('owner: 200 with the payload (schema valid)', { timeout: T }, async () => {
    const u = fresh(); const made = ok(await create(u, draftBody(CENTRE.a, { k: 'v' })), 201);
    const b = ok(await get(made.id, u));
    expect(schemaErrors('RegistrationDraftRecord', b)).toEqual([]);
    expect(JSON.parse(b.payload).k).toBe('v');
  });
  it('another user of the same tenant, an expired draft and an unknown id are all 404 common.not_found', { timeout: T }, async () => {
    const u = fresh(); const made = ok(await create(u, draftBody(CENTRE.a)), 201);
    notFound(await get(made.id, fresh()));
    notFound(await get(uid(), u));
    await expire(made.id);
    notFound(await get(made.id, u));
  });
  it('requires frontdesk.registration.create', { timeout: T }, async () => {
    const u = fresh(); const made = ok(await create(u), 201);
    forbidden(await get(made.id, without(u, 'frontdesk.registration.create')));
  });
});

describe('deleteRegistrationDraft', () => {
  it('owner: 204 and the row is gone; a second delete is 404', { timeout: T }, async () => {
    const u = fresh(); const made = ok(await create(u), 201);
    expect((await del(made.id, u)).reply?.status).toBe(204);
    expect(await draftRows(u.membershipId)).toHaveLength(0);
    notFound(await del(made.id, u));
  });
  it('another user\'s draft (same tenant) and an expired draft answer 404; the other user\'s row survives', { timeout: T }, async () => {
    const owner = fresh(); const made = ok(await create(owner), 201);
    notFound(await del(made.id, fresh()));
    expect(await draftRows(owner.membershipId)).toHaveLength(1);
    await expire(made.id);
    notFound(await del(made.id, owner));
  });
  it('requires frontdesk.registration.create; a draft that was deleted never comes back in a list', { timeout: T }, async () => {
    const u = fresh(); const made = ok(await create(u), 201);
    forbidden(await del(made.id, without(u, 'frontdesk.registration.create')));
    expect(await draftRows(u.membershipId)).toHaveLength(1);
    await del(made.id, u);
    expect(ok(await list(u)).data).toEqual([]);
  });
});

describe('concurrency', () => {
  it('8 parallel saves by one user for one centre leave exactly one row and no error', { timeout: T }, async () => {
    const u = fresh();
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => create(u, draftBody(CENTRE.a, { i }))));
    for (const o of outs) expect(o.error, `${(o.error as any)?.code} ${(o.error as any)?.message}`).toBeUndefined();
    expect(await draftRows(u.membershipId, CENTRE.a)).toHaveLength(1);
  });
});
