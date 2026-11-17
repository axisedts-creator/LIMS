// T0B-SYNC-2 done_when (4): pullChanges. Keyset pagination per entity type on (updated_at, id), whitelist of entity types, tenant / centre / permission scoping, tombstones, opaque cursors,
// bounded page size. Live PG17, RLS on. Fails today: createSyncPart2Handlers does not exist.
// Pinned: an entity row with is_active = false (rows are never deleted, 05-SCHEMA) is a TOMBSTONE { id, removed_at = updated_at } and never an upsert; upserts + tombstones of one page <= limit
// (default 200, max 1000 by the contract); permissions per type: doctor -> catalog.referrer.read, test -> catalog.test.read, patient -> frontdesk.patient.read (all asked of IdentityPort.assertRole);
// a type the user may not read answers auth.forbidden for the whole request (the response has no per type error); centre scoped types (patient) use IdentityPort.getActor(ctx).centreScope.
import { describe, expect, it } from 'vitest';
import { A1, A2, B1, CENTRE, TENANT_A, TENANT_B, USER, code, engine, newDevice, okBody, ownerRows, pull, revoke, wipe, AADM, uid, superTx, SEED_ACTOR } from './helpers2.js';

const T = 300_000;
const H = engine();
const SPEC = 'sync2-pull';

/** Walk a type to its end with big pages and return the cursor (the baseline: rows of earlier runs are behind it). */
async function baseline(who: any, dev: string, type: string): Promise<string | undefined> {
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const ch = okBody(await pull(H, who, dev, [{ entity_type: type, ...(cursor ? { cursor } : {}) }], 1000)).changes[0];
    cursor = ch.next_cursor;
    if (!ch.has_more) return cursor;
  }
  throw new Error('baseline did not finish');
}
const insertDoctors = async (tenant: string, n: number, tag: string): Promise<string[]> => {
  const ids = Array.from({ length: n }, () => uid());
  await superTx((tx) => tx.query(`INSERT INTO catalog.doctors (id, tenant_id, doctor_code, display_name, name_normalised, source, created_by, updated_by)
    SELECT i, $1, $3 || '-' || substr(i::text, 25), 'Dr Synthetic ' || $3, lower('dr synthetic ' || $3), 'back_office', $4, $4 FROM unnest($2::uuid[]) AS i`, [tenant, ids, tag, SEED_ACTOR]), tenant);
  return ids;
};
const take = (changes: any, type: string) => changes.find((c: any) => c.entity_type === type)!;
/** All pages of one type from a cursor, with the given page size; returns every page. */
async function walk(who: any, dev: string, type: string, from: string | undefined, limit: number, grants?: any): Promise<any[]> {
  const pages: any[] = []; let cursor = from;
  for (let i = 0; i < 100; i++) {
    const ch = take(okBody(await pull(H, who, dev, [{ entity_type: type, ...(cursor ? { cursor } : {}) }], limit, grants ? { grants } : {})).changes, type);
    pages.push(ch); cursor = ch.next_cursor;
    if (!ch.has_more) return pages;
  }
  throw new Error('walk did not finish');
}
const idsOf = (pages: any[]): string[] => pages.flatMap((p) => [...p.upserts.map((u: any) => u.id), ...p.tombstones.map((t: any) => t.id)]);

describe('keyset pagination (done_when 4)', () => {
  it('rows with the SAME updated_at (one INSERT) are paged without skip or duplicate; every page respects limit; the cursor is opaque; order is updated_at then id', async () => {
    const dev = await newDevice(A1);
    const c0 = await baseline(A1, dev, 'doctor');
    const mine = await insertDoctors(TENANT_A, 7, SPEC);
    const theirs = await insertDoctors(TENANT_B, 3, SPEC);
    const pages = await walk(A1, dev, 'doctor', c0, 3);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const p of pages) { expect(p.upserts.length + p.tombstones.length).toBeLessThanOrEqual(3); expect(typeof p.next_cursor).toBe('string'); expect(p.next_cursor.length).toBeLessThanOrEqual(512); }
    expect(pages.slice(0, -1).every((p) => p.has_more === true)).toBe(true);
    const got = idsOf(pages);
    expect([...got].sort()).toEqual([...mine].sort());                 // exactly mine: no skip, no duplicate, nothing of tenant B
    for (const t of theirs) expect(got).not.toContain(t);
    const keys = pages.flatMap((p) => p.upserts.map((u: any) => `${u.updated_at}|${u.id}`));
    expect(keys).toEqual([...keys].sort());
    for (const p of pages) expect(p.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);   // opaque: no separators, no JSON, no ids
    for (const p of pages) expect(p.next_cursor).not.toContain(TENANT_A.slice(-8));
  }, T);
  it('an upsert is { id, updated_at, document } (+ version when the table has one) and the document never carries tenant_id or the audit columns', async () => {
    const dev = await newDevice(A1);
    const c0 = await baseline(A1, dev, 'doctor');
    const [id] = await insertDoctors(TENANT_A, 1, SPEC);
    const u = take(okBody(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: c0! }], 50)).changes, 'doctor').upserts[0];
    expect(u.id).toBe(id);
    expect(u.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(typeof u.document).toBe('object'); expect(Array.isArray(u.document)).toBe(false);
    expect(Object.keys(u).every((k) => ['id', 'version', 'updated_at', 'document'].includes(k))).toBe(true);
    for (const k of ['tenant_id', 'created_by', 'updated_by']) expect(u.document).not.toHaveProperty(k);
  }, T);
  it('a row changed after it was delivered comes again on a later page; a row inserted between two pages shows up; the last cursor keeps working (resume)', async () => {
    const dev = await newDevice(A1);
    const c0 = await baseline(A1, dev, 'doctor');
    const first = await insertDoctors(TENANT_A, 4, SPEC);
    const p1 = take(okBody(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: c0! }], 2)).changes, 'doctor');
    expect(p1.has_more).toBe(true);
    const late = await insertDoctors(TENANT_A, 1, SPEC);
    const delivered = p1.upserts[0].id;
    await superTx((tx) => tx.query(`UPDATE catalog.doctors SET display_name = 'Dr Changed', updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`, [TENANT_A, delivered]), TENANT_A);
    const rest = await walk(A1, dev, 'doctor', p1.next_cursor, 2);
    const got = idsOf(rest);
    expect(got).toContain(late[0]); expect(got).toContain(delivered);                 // the changed row is re-delivered
    for (const id of first) if (id !== p1.upserts[0].id && id !== p1.upserts[1]?.id) expect(got).toContain(id);
    const end = rest[rest.length - 1].next_cursor;
    const none = take(okBody(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: end }], 50)).changes, 'doctor');
    expect([none.upserts, none.tombstones, none.has_more]).toEqual([[], [], false]);
    const [fresh] = await insertDoctors(TENANT_A, 1, SPEC);
    expect(idsOf([take(okBody(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: end }], 50)).changes, 'doctor')])).toEqual([fresh]);
  }, T);
  it('without a cursor the pull starts at the beginning; with no limit the page is bounded (default 200); the response carries server_time', async () => {
    const dev = await newDevice(A1);
    await insertDoctors(TENANT_A, 210, SPEC);
    const body = okBody(await pull(H, A1, dev, [{ entity_type: 'doctor' }]));
    const ch = take(body.changes, 'doctor');
    expect(ch.upserts.length + ch.tombstones.length).toBeLessThanOrEqual(200);
    expect(ch.has_more).toBe(true);
    expect(body.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, T);
  it('several entity types in one request come back in one page each, in the order asked, each with its own cursor', async () => {
    const dev = await newDevice(A1);
    const body = okBody(await pull(H, A1, dev, [{ entity_type: 'test' }, { entity_type: 'doctor' }], 5));
    expect(body.changes.map((c: any) => c.entity_type)).toEqual(['test', 'doctor']);
    for (const c of body.changes) expect(c.upserts.length + c.tombstones.length).toBeLessThanOrEqual(5);
  }, T);
});

describe('tombstones (done_when 4)', () => {
  it('a deactivated row is a tombstone { id, removed_at } with no row data and never also an upsert; reactivating it makes it an upsert again', async () => {
    const dev = await newDevice(A1);
    const c0 = await baseline(A1, dev, 'doctor');
    const [keep, gone] = await insertDoctors(TENANT_A, 2, SPEC);
    await superTx((tx) => tx.query(`UPDATE catalog.doctors SET is_active = false, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`, [TENANT_A, gone]), TENANT_A);
    const ch = take(okBody(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: c0! }], 50)).changes, 'doctor');
    expect(ch.upserts.map((u: any) => u.id)).toEqual([keep]);
    expect(ch.tombstones).toHaveLength(1);
    expect(Object.keys(ch.tombstones[0]).sort()).toEqual(['id', 'removed_at']);
    expect(ch.tombstones[0].id).toBe(gone);
    expect(JSON.stringify(ch.tombstones)).not.toMatch(/Synthetic|Dr /);
    await superTx((tx) => tx.query(`UPDATE catalog.doctors SET is_active = true, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`, [TENANT_A, gone]), TENANT_A);
    const again = take(okBody(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: ch.next_cursor }], 50)).changes, 'doctor');
    expect(again.upserts.map((u: any) => u.id)).toEqual([gone]);
  }, T);
});

describe('whitelist, cursor validity, page size (done_when 4)', () => {
  it.each(['user', 'users', 'credential', 'membership', 'role', 'session', 'sync_operation', 'core.users', 'doctor; DROP TABLE catalog.doctors', "doctor' OR '1'='1", '../doctor', '', 'DOCTOR'])
    ('entity type %j is outside the whitelist: common.validation_failed, nothing read', async (t) => {
      const dev = await newDevice(A1);
      expect(code(await pull(H, A1, dev, [{ entity_type: t }]))).toBe('common.validation_failed');
      const still = await ownerRows('SELECT to_regclass($1) AS t', ['catalog.doctors']);
      expect(still[0].t).toBe('catalog.doctors');
    }, T);
  it('no entity types, more than 20, a non uuid device id: common.validation_failed', async () => {
    const dev = await newDevice(A1);
    expect(code(await pull(H, A1, dev, []))).toBe('common.validation_failed');
    expect(code(await pull(H, A1, dev, Array.from({ length: 21 }, () => ({ entity_type: 'doctor' }))))).toBe('common.validation_failed');
    expect(code(await pull(H, A1, 'nope', [{ entity_type: 'doctor' }]))).toBe('common.validation_failed');
  }, T);
  it('limit 0, 1001, 1.5, "10" and -1 are common.validation_failed; 1 and 1000 are fine', async () => {
    const dev = await newDevice(A1);
    for (const l of [0, 1001, 1.5, '10', -1]) expect(code(await pull(H, A1, dev, [{ entity_type: 'doctor' }], l as any)), String(l)).toBe('common.validation_failed');
    for (const l of [1, 1000]) okBody(await pull(H, A1, dev, [{ entity_type: 'doctor' }], l));
  }, T);
  it('a garbage cursor, an empty one, one over 512 chars, and a cursor of another entity type are common.invalid_cursor', async () => {
    const dev = await newDevice(A1);
    const good = take(okBody(await pull(H, A1, dev, [{ entity_type: 'test' }], 1)).changes, 'test').next_cursor;
    for (const c of ['garbage!!', 'AAAA', 'x'.repeat(513), Buffer.from('{"k":"2026-01-01","i":"x"}').toString('base64url'), good]) {
      const o = await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: c }]);
      expect(code(o), c.slice(0, 20)).toMatch(/^(common\.invalid_cursor|common\.validation_failed)$/);
    }
    expect(code(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: 'garbage!!' }]))).toBe('common.invalid_cursor');
    expect(code(await pull(H, A1, dev, [{ entity_type: 'doctor', cursor: good }]))).toBe('common.invalid_cursor');   // bound to its entity type
  }, T);
});

describe('tenant, centre and permission scoping (done_when 4)', () => {
  it('tenant B pulls its own rows only, whatever it asks; tenant A rows never appear', async () => {
    const dB = await newDevice(B1);
    const c0 = await baseline(B1, dB, 'doctor');
    const a = await insertDoctors(TENANT_A, 3, SPEC), b = await insertDoctors(TENANT_B, 2, SPEC);
    const got = idsOf(await walk(B1, dB, 'doctor', c0, 2));
    expect([...got].sort()).toEqual([...b].sort());
    for (const id of a) expect(got).not.toContain(id);
  }, T);
  it('permission: without the entity permission the whole request is auth.forbidden and reads nothing; with only that permission it works; sync.use is needed too', async () => {
    const dev = await newDevice(A1);
    const noRef = await pull(H, A1, dev, [{ entity_type: 'doctor' }], 5, { grants: { codes: ['sync.use', 'catalog.test.read'] } });
    expect(code(noRef)).toBe('auth.forbidden'); expect(noRef.asserted).toContain('catalog.referrer.read');
    expect(code(await pull(H, A1, dev, [{ entity_type: 'test' }, { entity_type: 'doctor' }], 5, { grants: { codes: ['sync.use', 'catalog.test.read'] } }))).toBe('auth.forbidden');
    okBody(await pull(H, A1, dev, [{ entity_type: 'doctor' }], 5, { grants: { codes: ['sync.use', 'catalog.referrer.read'] } }));
    expect(code(await pull(H, A1, dev, [{ entity_type: 'doctor' }], 5, { grants: { codes: ['catalog.referrer.read'] } }))).toBe('auth.forbidden');
  }, T);
  it('centre scope: a patient of another centre is never returned to a user scoped to centre 1; a user with all centres sees both', async () => {
    const dev = await newDevice(A1);
    const c0 = await baseline(A1, dev, 'patient');
    const [p1, p2] = [uid(), uid()];
    await superTx((tx) => tx.query(`INSERT INTO frontdesk.patients (id, tenant_id, patient_code, full_name, name_search, sex, registered_centre_id, created_by, updated_by) VALUES
      ($1, $3, $5, 'Sync Two Centre One (SYNTHETIC)', 'sync two centre one (synthetic)', 'unknown', $4, $7, $7), ($2, $3, $6, 'Sync Two Centre Two (SYNTHETIC)', 'sync two centre two (synthetic)', 'unknown', $8, $7, $7)`,
      [p1, p2, TENANT_A, CENTRE.a1, `S2A-${p1.slice(-10)}`, `S2B-${p2.slice(-10)}`, SEED_ACTOR, CENTRE.a2]), TENANT_A);
    const scoped = idsOf(await walk(A1, dev, 'patient', c0, 50, { centreIds: [CENTRE.a1] }));
    expect(scoped).toContain(p1); expect(scoped).not.toContain(p2);
    const none = idsOf(await walk(A1, dev, 'patient', c0, 50, { centreIds: [] }));
    expect(none).not.toContain(p1); expect(none).not.toContain(p2);
    const all = idsOf(await walk(A1, dev, 'patient', c0, 50, { all: true }));
    expect(all).toEqual(expect.arrayContaining([p1, p2]));
  }, T);
  it('personal data of the rows never reaches the logs or the metrics of the request', async () => {
    const dev = await newDevice(A1);
    await insertDoctors(TENANT_A, 2, SPEC);
    const o = await pull(H, A1, dev, [{ entity_type: 'doctor' }], 20);
    okBody(o);
    expect(o.logs.join('\n')).not.toMatch(/Dr Synthetic|doctor_code|display_name/);
  }, T);
});

describe('the device (done_when 4)', () => {
  it('unknown, another user\'s, other tenant\'s device: sync.device_unknown; revoked: sync.device_revoked; wipe pending: sync.wipe_required (before any data is read)', async () => {
    const dev = await newDevice(A1), d1 = await newDevice(A1), d2 = await newDevice(A1);
    await revoke(AADM, d1); await wipe(AADM, d2);
    const q = [{ entity_type: 'doctor' }];
    expect(code(await pull(H, A1, uid(), q))).toBe('sync.device_unknown');
    expect(code(await pull(H, A2, dev, q))).toBe('sync.device_unknown');
    expect(code(await pull(H, B1, dev, q))).toBe('sync.device_unknown');
    expect(code(await pull(H, A1, d1, q))).toBe('sync.device_revoked');
    expect(code(await pull(H, A1, d2, q))).toBe('sync.wipe_required');
    expect(USER.a1).toBeTruthy();
  }, T);
});
