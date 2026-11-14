// FD-T12 review item 1: F22 listOrderFlags + F23 resolveOrderFlag (02-TRD §5.1 F22/F23, OrderFlag §6; flag_resolutions coded set 05-SCHEMA:1862; PRD US-FD-13.1 "flag appears on the front-desk worklist").
// F22: frontdesk.order.read, filters status (default open) / kind / centre_id, keyset page. F23: frontdesk.order.edit, Idempotency-Key + If-Match, {resolution_code, note?<=500}, common.immutable_record once resolved.
// Real PG17 under RLS (centre scope = IdentityPort actor centreScope, tenant = RLS). Harness: ./desk.ts. LD-70: pending.json is the writer's.
// Spec gaps, deliberately NOT asserted: coded-set membership of resolution_code (owner of that check not named, as FD-T09 cancel reason), the audit access-log action for flag reads (none listed in TRD §5.2).
import { describe, expect, it, vi } from 'vitest';
import { schemaErrors } from '../patients/helpers.js';
import { scenario } from '../orders/helpers.js';
import { CENTRE, CENTRE_A2, NOW_ISO, T, TENANT_B, orderRow, seedOrder, seedPatient } from './helpers.js';
import { EDIT, READ, flagRow, listFlags, listFlagsFail, resolveFlag, resolveFlagFails, rows, seed, uid } from './desk.js';

vi.setConfig({ testTimeout: T });
type Side = 'a' | 'b';
/** An order + one flag (default: open recollection_required). `flag` overrides flag columns. */
async function flagged(o: { side?: Side; centre?: string; flag?: Record<string, unknown> } = {}) {
  const side = o.side ?? 'a';
  const patient = await seedPatient(side);
  const order = o.centre === CENTRE_A2 ? (await scenario({ side, centre: CENTRE_A2, items: [] })).order : await seedOrder(side, patient.id);
  const flag = rows.flag(side, order.id, { centre_id: o.centre ?? CENTRE[side], ...(o.flag ?? {}) });
  await seed('frontdesk.order_flags', flag);
  return { patient, order, flag };
}
const resolved = { status: 'resolved', resolution_code: 'recollected', resolved_at: '2026-11-06T00:00:00Z', resolved_by: uid() };
const bookingKind = { kind: 'booking_cancelled_after_registration', specimen_id: null };
const idsOf = (r: { body: any }) => r.body.data.map((f: any) => f.id);
async function allIds(query: object, o: Parameters<typeof listFlags>[1] = {}) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await listFlags({ limit: 2, ...query, ...(cursor ? { cursor } : {}) }, o);
    ids.push(...idsOf(r));
    cursor = r.body.page.next_cursor;
    if (!cursor) return ids;
  }
  throw new Error('cursor never ended');
}

describe('F22 listOrderFlags', () => {
  it('default = open flags only; OrderFlagPage schema; open flag has no resolution fields; read-only (no write tx)', async () => {
    const open = await flagged();
    const done = await flagged({ flag: resolved });
    const r = await listFlags({});
    expect(r.status).toBe(200);
    expect(r.wrote).toBe(false);
    expect(schemaErrors('OrderFlagPage', r.body)).toEqual([]);
    const ids = await allIds({});
    expect(ids).toContain(open.flag.id);
    expect(ids).not.toContain(done.flag.id);
    const mine = (await listFlags({ limit: 200 })).body.data.find((f: any) => f.id === open.flag.id);
    expect(mine).toMatchObject({ id: open.flag.id, order_id: open.order.id, kind: 'recollection_required', status: 'open', specimen_id: open.flag.specimen_id, version: 1 });
    expect(mine.resolution_code ?? null).toBeNull();
    expect(mine.resolved_at ?? null).toBeNull();
  });

  it('status=resolved returns resolved flags only', async () => {
    const open = await flagged();
    const done = await flagged({ flag: resolved });
    const ids = await allIds({ status: 'resolved' });
    expect(ids).toContain(done.flag.id);
    expect(ids).not.toContain(open.flag.id);
    const row = (await listFlags({ status: 'resolved', limit: 200 })).body.data.find((f: any) => f.id === done.flag.id);
    expect(row).toMatchObject({ status: 'resolved', resolution_code: 'recollected' });
  });

  it('kind filter: booking_cancelled_after_registration vs recollection_required', async () => {
    const rec = await flagged();
    const bk = await flagged({ flag: bookingKind });
    const onlyBooking = await allIds({ kind: 'booking_cancelled_after_registration' });
    expect(onlyBooking).toContain(bk.flag.id); expect(onlyBooking).not.toContain(rec.flag.id);
    const onlyRec = await allIds({ kind: 'recollection_required' });
    expect(onlyRec).toContain(rec.flag.id); expect(onlyRec).not.toContain(bk.flag.id);
  });

  it('centre_id filter + centre scoping: an actor scoped to centre A never sees centre A2 flags, even when asking for them', async () => {
    const a1 = await flagged();
    const a2 = await flagged({ centre: CENTRE_A2 });
    const scoped = await allIds({});
    expect(scoped).toContain(a1.flag.id); expect(scoped).not.toContain(a2.flag.id);
    const both = await allIds({}, { centreIds: [CENTRE.a, CENTRE_A2] });
    expect(both).toEqual(expect.arrayContaining([a1.flag.id, a2.flag.id]));
    const only2 = await allIds({ centre_id: CENTRE_A2 }, { centreIds: [CENTRE.a, CENTRE_A2] });
    expect(only2).toContain(a2.flag.id); expect(only2).not.toContain(a1.flag.id);
    const asked = await allIds({ centre_id: CENTRE_A2 }).catch((e: any) => { expect(e.code).toBe('common.not_found'); return [] as string[]; });   // outside the scope: empty page or not_found, never the rows
    expect(asked).not.toContain(a2.flag.id);
  });

  it('keyset paging: limit 2 over >= 5 flags pages without duplicates or gaps', async () => {
    const made = await Promise.all([1, 2, 3, 4, 5].map(() => flagged({ flag: bookingKind })));
    const ids = await allIds({ kind: 'booking_cancelled_after_registration' });
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of made) expect(ids).toContain(m.flag.id);
  });

  it('tenant isolation (RLS): tenant A never lists tenant B flags and vice versa', async () => {
    const a = await flagged();
    const b = await flagged({ side: 'b' });
    const seenByA = await allIds({});
    expect(seenByA).toContain(a.flag.id); expect(seenByA).not.toContain(b.flag.id);
    const seenByB = await allIds({}, { tenant: TENANT_B });
    expect(seenByB).toContain(b.flag.id); expect(seenByB).not.toContain(a.flag.id);
  });

  it('permission: frontdesk.order.read is required (order.edit alone / patient.read -> 403 auth.forbidden)', async () => {
    expect((await listFlagsFail({}, { grants: [EDIT] })).code).toBe('auth.forbidden');
    expect((await listFlagsFail({}, { grants: ['frontdesk.patient.read'] })).code).toBe('auth.forbidden');
  });

  it('bad filters -> common.validation_failed (unknown status / kind, non-uuid centre_id)', async () => {
    for (const q of [{ status: 'bogus' }, { kind: 'bogus' }, { centre_id: 'not-a-uuid' }]) expect((await listFlagsFail(q)).code, JSON.stringify(q)).toBe('common.validation_failed');
  });
});

describe('F23 resolveOrderFlag', () => {
  const body = { resolution_code: 'recollected', note: 'Synthetic note: patient came back' };

  it('resolves an open flag: OrderFlag schema; status resolved, resolution_code, resolved_at = now, resolved_by = the actor, version bumped; the ORDER is untouched', async () => {
    const f = await flagged();
    const before = await orderRow(f.order.id);
    const r = await resolveFlag(f.flag.id, body);
    expect(r.status).toBe(200);
    expect(schemaErrors('OrderFlag', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: f.flag.id, order_id: f.order.id, status: 'resolved', resolution_code: 'recollected', kind: 'recollection_required' });
    expect(new Date(r.body.resolved_at).toISOString()).toBe(NOW_ISO);
    const row = await flagRow(f.flag.id);
    expect(row).toMatchObject({ status: 'resolved', resolution_code: 'recollected', note: body.note });
    expect(new Date(row.resolved_at).toISOString()).toBe(NOW_ISO);
    expect(row.resolved_by).toBe(r.probe.ctx.actor.membershipId);
    expect(r.body.resolved_by.membership_id).toBe(row.resolved_by);
    expect(Number(row.version)).toBeGreaterThan(1);
    expect(r.body.version).toBe(Number(row.version));
    const after = await orderRow(f.order.id);
    expect({ status: after.status, version: after.version }).toEqual({ status: before.status, version: before.version });
    expect(r.probe.logs.join('\n')).not.toContain(body.note);                          // free text is never logged
  });

  it('note is optional; resolved flag leaves the open worklist (F22 default) and shows under status=resolved', async () => {
    const f = await flagged({ flag: bookingKind });
    expect((await resolveFlag(f.flag.id, { resolution_code: 'order_kept' })).status).toBe(200);
    expect((await flagRow(f.flag.id)).note ?? null).toBeNull();
    expect(await allIds({ kind: 'booking_cancelled_after_registration' })).not.toContain(f.flag.id);
    expect(await allIds({ status: 'resolved', kind: 'booking_cancelled_after_registration' })).toContain(f.flag.id);
  });

  it('resolving once only: a second resolve (any key) -> common.immutable_record and the first resolution is unchanged', async () => {
    const f = await flagged();
    await resolveFlag(f.flag.id, body);
    const first = await flagRow(f.flag.id);
    const e = await resolveFlagFails(f.flag.id, { resolution_code: 'other', note: 'second attempt' }, { ifMatch: `"${Number(first.version)}"` });
    expect(e.code).toBe('common.immutable_record');
    expect(await flagRow(f.flag.id)).toMatchObject({ status: 'resolved', resolution_code: 'recollected', note: body.note, version: first.version });
  });

  it('a flag that arrives already resolved -> common.immutable_record', async () => {
    const f = await flagged({ flag: resolved });
    expect((await resolveFlagFails(f.flag.id, body)).code).toBe('common.immutable_record');
  });

  it('If-Match: absent -> common.precondition_required; stale -> common.version_conflict; the flag stays open', async () => {
    const f = await flagged();
    expect((await resolveFlagFails(f.flag.id, body, { ifMatch: null })).code).toBe('common.precondition_required');
    expect((await resolveFlagFails(f.flag.id, body, { ifMatch: '"999"' })).code).toBe('common.version_conflict');
    expect((await flagRow(f.flag.id)).status).toBe('open');
  });

  it('bad body -> common.validation_failed: missing resolution_code, note over 500 chars, unknown field; nothing written', async () => {
    const f = await flagged();
    for (const b of [{ note: 'x' }, { resolution_code: 'recollected', note: 'x'.repeat(501) }, { resolution_code: 'recollected', status: 'open', resolved_by: uid() }, {}]) {
      expect((await resolveFlagFails(f.flag.id, b)).code, JSON.stringify(b).slice(0, 40)).toBe('common.validation_failed');
    }
    expect((await flagRow(f.flag.id)).status).toBe('open');
  });

  it('a note of exactly 500 characters is accepted (boundary)', async () => {
    const f = await flagged();
    expect((await resolveFlag(f.flag.id, { resolution_code: 'other', note: 'x'.repeat(500) })).status).toBe(200);
  });

  it('permission: frontdesk.order.edit is required (order.read alone -> 403 auth.forbidden), flag unchanged', async () => {
    const f = await flagged();
    expect((await resolveFlagFails(f.flag.id, body, { grants: [READ] })).code).toBe('auth.forbidden');
    expect((await flagRow(f.flag.id)).status).toBe('open');
  });

  it('centre scope + tenant isolation: outside the flag centre, another tenant, or an unknown id -> 404 common.not_found; flag unchanged', async () => {
    const f = await flagged({ centre: CENTRE_A2 });
    expect((await resolveFlagFails(f.flag.id, body, { centreIds: [CENTRE.a] })).code).toBe('common.not_found');
    expect((await resolveFlagFails(f.flag.id, body, { tenant: TENANT_B })).code).toBe('common.not_found');
    expect((await resolveFlagFails(uid(), body, { ifMatch: '"1"' })).code).toBe('common.not_found');
    expect((await flagRow(f.flag.id)).status).toBe('open');
  });

  it('resolving a flag does not affect another flag of the same order', async () => {
    const f = await flagged();
    const sibling = rows.flag('a', f.order.id, { specimen_id: uid() });
    await seed('frontdesk.order_flags', sibling);
    await resolveFlag(f.flag.id, body);
    expect((await flagRow(sibling.id)).status).toBe('open');
  });
});
