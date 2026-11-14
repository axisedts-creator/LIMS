// C16.T-P5 — in-app notifications: E45 listMyNotifications, E46 markMyNotificationsRead
// (06-PLAN row T-P5; 02-TRD §4.9, §5 E45/E46, §7; 05-SCHEMA notifications + §8 policy row "PAT_ACC; read_at only"; PRD US-EN-11.1 / 11.3; 07-SECURITY §6.5 bulk-mark row, §7.4).
// done_when "no text stored": the DTO is exactly the Notification schema (kind/entity/route ids only) and nothing in the handlers writes anything but read_at.
// tests: mixed-ids bulk -> per-id not_found. (US-EN-11.2 = no push SDK + refresh on launch/resume/pull: Flutter side, apps/patient_app/test/features/notifications.)
// Fails now: handlers/index.ts maps both operationIds to the T-01 placeholder (common.service_unavailable); no notification service exists.
//
// SEAMS (same convention as membership.handlers.test.ts): handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; errors are thrown LimsError(code).
//   ctx = {tenantId, actor:{type:'patient',id}, tx, now(), audit, ports:{IdentityPort}}. Permission = ctx.ports.IdentityPort.assertRole(ctx,{permission}) BEFORE any tx.query:
//   E45 engagement.self.read, E46 engagement.self.manage. Missing tenantId/actor/tx -> auth.unauthenticated.
//   DB = __tests__/notifications.world.ts: tenant RLS + PAT_ACC (a patient sees/updates only its account's notifications and links); the UPDATE trigger allows read_at only.
//   Account scoping must hold with the SQL as written: the world applies RLS, but a handler that returns another account's row would also fail the DTO/ids assertions below.
// Assumptions where the spec is silent (stated, asserted only as far as written): outcome `updated` is returned for an own row that is already read, and its read_at is NOT moved
//   (first read wins); read_at = ctx.now(); list order created_at DESC (index 05-SCHEMA); `unread_only` arrives as the query string 'true'|'false' (or a boolean); the cursor is opaque;
//   profile_id = account_patient_links.id for the row's patient_id (patients never see patient_id, 07-SECURITY §7.1); a row without a patient (enquiry_reply) has no profile_id key.
//   Pipeline-level checks (schema min/max, Idempotency-Key replay, x-permission floor) are not re-tested; handlers are driven directly so they must refuse bad input themselves.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ACC2, ACC_B, ENT, LINK1, LINK3, NID, P, PAT1, PAT2, PAT3, TB, makeWorld, note, type World } from '../../__tests__/notifications.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const call = (op: string, w: World, req: Record<string, any> = {}, over: Record<string, unknown> = {}, tenant?: string, account?: string) =>
  (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, w.session('patient', over, tenant, account));
const list = (w: World, query: Record<string, unknown> = {}, tenant?: string, account?: string) => call('listMyNotifications', w, { query }, {}, tenant, account);
const mark = (w: World, ids: unknown, tenant?: string, account?: string) => call('markMyNotificationsRead', w, { body: { ids } }, {}, tenant, account);
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const hdr = (out: any, name: string) => out.headers?.[name] ?? out.headers?.[name.toLowerCase()];
const idsOf = (out: any): string[] => out.body.data.map((n: any) => n.id);
const sorted = (a: string[]) => [...a].sort();
const OWN = [NID(1), NID(2), NID(3), NID(4), NID(5)];
const NOW = '2026-11-05T04:15:00.000Z';
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

describe('contract: operations exist and floors match 02-TRD §5 / §7', () => {
  it('x-permission floors: E45 engagement.self.read, E46 engagement.self.manage', () => {
    expect(opOf('listMyNotifications')['x-permission']).toBe(P.SELF_READ);
    expect(opOf('markMyNotificationsRead')['x-permission']).toBe(P.SELF_MANAGE);
  });
  it('both operations have a real handler (not the T-01 placeholder): a bare ctx fails closed with auth.unauthenticated', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    for (const op of ['listMyNotifications', 'markMyNotificationsRead']) {
      const e = await (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: { ids: [NID(1)] } }, bare).catch((x: unknown) => x);
      expect(e?.code, op).toBe('auth.unauthenticated');
    }
  });
  it('no text stored (US-EN-11.1): the Notification DTO schema is closed and carries ids only', () => {
    const s = spec.components.schemas['Notification'];
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(['created_at', 'entity_id', 'entity_type', 'id', 'kind', 'profile_id', 'read_at', 'route_id']);
  });
  it('the request body of E46 is closed: only ids[1..200]', () => {
    const b = opOf('markMyNotificationsRead').requestBody.content['application/json'].schema;
    expect(b.additionalProperties).toBe(false);
    expect(b.properties.ids.minItems).toBe(1);
    expect(b.properties.ids.maxItems).toBe(200);
  });
});

describe('E45 listMyNotifications (US-EN-11.1)', () => {
  it('asserts engagement.self.read before any statement; a denied role gets auth.forbidden and no statement runs', async () => {
    const w = makeWorld();
    await list(w);
    expect(w.identity.asserted[0]).toEqual({ permission: P.SELF_READ, at: 0 });
    const w2 = makeWorld();
    w2.identity.deny.add(P.SELF_READ);
    expect(await code(list(w2))).toBe('auth.forbidden');
    expect(w2.stmts).toEqual([]);
  });

  it('returns 200 with {data, page:{limit}} and Cache-Control: no-store; reads only', async () => {
    const w = makeWorld();
    const out: any = await list(w);
    expect(out.status).toBe(200);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(out.body.page.limit).toBe(50);
    expect(w.writes()).toEqual([]);
  });

  it('only the account\'s own notifications: another account of the same tenant and another tenant are invisible', async () => {
    const w = makeWorld();
    expect(sorted(idsOf(await list(w)))).toEqual(sorted(OWN));
    expect(idsOf(await list(w, {}, undefined, ACC2))).toEqual([NID(6)]);
    expect(idsOf(await list(w, {}, TB, ACC_B))).toEqual([NID(7)]);
  });

  it('every item is exactly the Notification schema; no patient_id / account_id / tenant_id / entity_seq / expires_at / any text field', async () => {
    const w = makeWorld();
    const out: any = await list(w);
    expect(out.body.data).toHaveLength(OWN.length);
    for (const n of out.body.data) {
      expect(schemaErrors('Notification', n), JSON.stringify(n)).toEqual([]);
      for (const k of ['patient_id', 'account_id', 'tenant_id', 'entity_seq', 'expires_at', 'created_by', 'title', 'body', 'message', 'text', 'name', 'display_name']) expect(n, k).not.toHaveProperty(k);
    }
    expect(JSON.stringify(out.body)).not.toMatch(new RegExp(`${PAT1}|${PAT2}|${PAT3}|Synthetic Patient`));
  });

  it('profile_id is the link id of the row\'s patient (never the patient id); a row without a patient has no profile_id', async () => {
    const w = makeWorld();
    const by = (out: any, id: string) => out.body.data.find((n: any) => n.id === id);
    const out: any = await list(w);
    expect(by(out, NID(1)).profile_id).toBe(LINK1);
    expect(by(out, NID(5))).not.toHaveProperty('profile_id');
    expect([undefined, LINK3]).toContain(by(out, NID(4)).profile_id); // suspended link: shown as its link id or not at all, never as the patient id
  });

  it('kinds, entity ids and route ids come back as stored; unset optionals are omitted (not null); read_at only when read', async () => {
    const w = makeWorld();
    const out: any = await list(w);
    const by = (id: string) => out.body.data.find((n: any) => n.id === id);
    expect(by(NID(1))).toMatchObject({ kind: 'report_ready', entity_type: 'order', entity_id: ENT(1), route_id: 'patient_app.report' });
    expect(by(NID(1))).not.toHaveProperty('read_at');
    expect(by(NID(2))).toMatchObject({ kind: 'booking_confirmed', route_id: 'patient_app.booking' });
    expect(iso(by(NID(2)).read_at)).toBe('2026-11-04T09:30:00.000Z');
    expect(by(NID(3))).toMatchObject({ kind: 'follow_up_reminder', entity_type: 'reminder', entity_id: ENT(3) });
    expect(by(NID(3))).not.toHaveProperty('route_id');
  });

  it('newest first (created_at DESC)', async () => {
    const w = makeWorld();
    expect(idsOf(await list(w))).toEqual(OWN); // seeded 10:00, 09:00, 03rd, 02nd, 01st
  });

  it('unread_only filters to read_at IS NULL (string or boolean); false / absent returns all', async () => {
    const w = makeWorld();
    expect(idsOf(await list(w, { unread_only: 'true' }))).toEqual([NID(1), NID(3), NID(4), NID(5)]);
    expect(idsOf(await list(w, { unread_only: true }))).toEqual([NID(1), NID(3), NID(4), NID(5)]);
    expect(sorted(idsOf(await list(w, { unread_only: 'false' })))).toEqual(sorted(OWN));
  });

  it('paging: limit + opaque cursor walk every row exactly once, including rows with the same created_at', async () => {
    const w = makeWorld({ seed: ({ tables }) => { tables['notifications']!.push(note({ id: NID(11), entity_id: ENT(11), created_at: '2026-11-04T10:00:00.000Z' }), note({ id: NID(12), entity_id: ENT(12), created_at: '2026-11-04T10:00:00.000Z' })); } });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const out: any = await list(w, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(out.body.page.limit).toBe(2);
      expect(out.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...idsOf(out));
      cursor = out.body.page.next_cursor;
      if (cursor === undefined) break;
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    }
    expect(cursor).toBeUndefined();
    expect(sorted(seen)).toEqual(sorted([...OWN, NID(11), NID(12)]));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a page that is the last has no next_cursor; default limit is 50 and 200 is allowed', async () => {
    const w = makeWorld({ seed: ({ tables }) => { for (let i = 0; i < 60; i++) tables['notifications']!.push(note({ id: NID(100 + i), entity_id: ENT(100 + i), created_at: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T0${i % 10}:00:00.000Z` })); } });
    const first: any = await list(w);
    expect(first.body.data).toHaveLength(50);
    expect(typeof first.body.page.next_cursor).toBe('string');
    const all: any = await list(w, { limit: 200 });
    expect(all.body.data).toHaveLength(65);
    expect(all.body.page.next_cursor).toBeUndefined();
  });

  it('bad input is common.validation_failed: limit 0 / 201 / abc / 1.5, malformed cursor, unread_only not a boolean', async () => {
    const w = makeWorld();
    for (const q of [{ limit: 0 }, { limit: 201 }, { limit: 'abc' }, { limit: 1.5 }, { cursor: 'not base64!!' }, { cursor: 'x'.repeat(513) }, { unread_only: 'maybe' }]) {
      expect(await code(list(w, q)), JSON.stringify(q)).toBe('common.validation_failed');
    }
  });

  it('no text column is ever selected and the error path leaks no row data', async () => {
    const w = makeWorld();
    await list(w);
    for (const c of w.stmts) expect(c.text, c.text).not.toMatch(/\b(title|body|message|text|summary)\b/i);
    const e: any = await list(w, { limit: 0 }).catch((x: unknown) => x);
    expect(JSON.stringify([e.message, e.details ?? null])).not.toMatch(new RegExp(`${NID(1)}|${PAT1}`));
  });
});

describe('E46 markMyNotificationsRead (US-EN-11.3, 07-SECURITY §6.5)', () => {
  const FOREIGN_ACCOUNT = NID(6), FOREIGN_TENANT = NID(7), UNKNOWN = NID(999);

  it('asserts engagement.self.manage before any statement; a denied role gets auth.forbidden and nothing is written', async () => {
    const w = makeWorld();
    await mark(w, [NID(1)]);
    expect(w.identity.asserted[0]).toEqual({ permission: P.SELF_MANAGE, at: 0 });
    const w2 = makeWorld();
    w2.identity.deny.add(P.SELF_MANAGE);
    expect(await code(mark(w2, [NID(1)]))).toBe('auth.forbidden');
    expect(w2.stmts).toEqual([]);
  });

  it('mixed ids: own -> updated; another account\'s, another tenant\'s and unknown ids -> per-id not_found; answer is 200, one result per id, in request order', async () => {
    const w = makeWorld();
    const ids = [NID(1), FOREIGN_ACCOUNT, FOREIGN_TENANT, UNKNOWN, NID(2)];
    const out: any = await mark(w, ids);
    expect(out.status).toBe(200);
    expect(hdr(out, 'Cache-Control')).toMatch(/no-store/);
    expect(out.body).toEqual({ results: [
      { id: NID(1), outcome: 'updated' }, { id: FOREIGN_ACCOUNT, outcome: 'not_found' }, { id: FOREIGN_TENANT, outcome: 'not_found' }, { id: UNKNOWN, outcome: 'not_found' }, { id: NID(2), outcome: 'updated' },
    ] });
    expect(Object.keys(out.body)).toEqual(['results']);
  });

  it('only own ids change: read_at = ctx.now() on the own unread row; foreign rows are untouched; an already-read row keeps its read_at', async () => {
    const w = makeWorld();
    const before = JSON.parse(JSON.stringify(w.tables['notifications']));
    await mark(w, [NID(1), NID(6), NID(7), NID(2)]);
    expect(iso(w.row(NID(1))!['read_at'])).toBe(NOW);
    expect(iso(w.row(NID(2))!['read_at'])).toBe('2026-11-04T09:30:00.000Z');
    expect(w.row(NID(6))!['read_at']).toBeNull();
    expect(w.row(NID(7))!['read_at']).toBeNull();
    const after = JSON.parse(JSON.stringify(w.tables['notifications']));
    for (const [i, row] of after.entries()) { if (row.id === NID(1)) { expect({ ...row, read_at: null }).toEqual({ ...before[i], read_at: null }); } else expect(row).toEqual(before[i]); } // nothing else changed anywhere
  });

  it('every write is an UPDATE of notifications SET read_at only (no insert/delete, no other column)', async () => {
    const w = makeWorld();
    await mark(w, [NID(1), NID(6), NID(3)]);
    const writes = w.writes();
    expect(writes.length).toBeGreaterThan(0);
    for (const c of writes) {
      expect(c.text, c.text).toMatch(/^\s*update\s+(?:engagement\.)?notifications\b/i);
      const set = /\bset\s+(.+?)(?:\s+where\b|\s+returning\b|$)/is.exec(c.text)?.[1] ?? '';
      expect([...set.matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map((m) => m[1]), c.text).toEqual(['read_at']);
    }
  });

  it('all ids foreign -> 200 with all not_found and no row changed (never 404 for the whole call)', async () => {
    const w = makeWorld();
    const out: any = await mark(w, [NID(6), NID(7)]);
    expect(out.status).toBe(200);
    expect(out.body.results.map((r: any) => r.outcome)).toEqual(['not_found', 'not_found']);
    expect(w.row(NID(6))!['read_at']).toBeNull();
    expect(w.row(NID(7))!['read_at']).toBeNull();
  });

  it('another account of the same tenant and another tenant cannot mark this account\'s rows', async () => {
    const w = makeWorld();
    expect((await mark(w, [NID(1), NID(3)], undefined, ACC2) as any).body.results.map((r: any) => r.outcome)).toEqual(['not_found', 'not_found']);
    expect((await mark(w, [NID(1), NID(3)], TB, ACC_B) as any).body.results.map((r: any) => r.outcome)).toEqual(['not_found', 'not_found']);
    expect(w.row(NID(1))!['read_at']).toBeNull();
    expect(w.row(NID(3))!['read_at']).toBeNull();
  });

  it('marking twice is safe: the second call reports updated again and does not move read_at', async () => {
    const w = makeWorld();
    await mark(w, [NID(1)]);
    w.clock.iso = '2026-11-05T05:00:00.000Z';
    const out: any = await mark(w, [NID(1)]);
    expect(out.body.results).toEqual([{ id: NID(1), outcome: 'updated' }]);
    expect(iso(w.row(NID(1))!['read_at'])).toBe(NOW);
  });

  it('a repeated id in one call never fails the call and every answered id was requested', async () => {
    const w = makeWorld();
    const out: any = await mark(w, [NID(1), NID(1)]);
    expect(out.status).toBe(200);
    for (const r of out.body.results) { expect(r.id).toBe(NID(1)); expect(r.outcome).toBe('updated'); }
    expect(iso(w.row(NID(1))!['read_at'])).toBe(NOW);
  });

  it('200 ids (one own, 199 unknown) -> 200 results; the own row is updated', async () => {
    const w = makeWorld();
    const ids = [NID(1), ...Array.from({ length: 199 }, (_, i) => NID(2000 + i))];
    const out: any = await mark(w, ids);
    expect(out.body.results).toHaveLength(200);
    expect(out.body.results.filter((r: any) => r.outcome === 'updated').map((r: any) => r.id)).toEqual([NID(1)]);
  });

  it('two concurrent calls on the same rows both succeed', async () => {
    const w = makeWorld();
    const [a, b]: any[] = await Promise.all([mark(w, [NID(1), NID(3)]), mark(w, [NID(3), NID(1)])]);
    expect(a.body.results.every((r: any) => r.outcome === 'updated')).toBe(true);
    expect(b.body.results.every((r: any) => r.outcome === 'updated')).toBe(true);
    expect(w.row(NID(1))!['read_at']).not.toBeNull();
    expect(w.row(NID(3))!['read_at']).not.toBeNull();
  });

  it('bad input is common.validation_failed and writes nothing: no/empty/over-200/non-uuid/non-array ids, missing body, extra keys', async () => {
    const w = makeWorld();
    const bodies: unknown[] = [undefined, null, {}, { ids: [] }, { ids: 'x' }, { ids: [NID(1), 'not-a-uuid'] }, { ids: [123] }, { ids: Array.from({ length: 201 }, (_, i) => NID(3000 + i)) }, { ids: [NID(1)], read: true }, { ids: [NID(1)], account_id: ACC2 }, []];
    for (const body of bodies) expect(await code(call('markMyNotificationsRead', w, { body })), JSON.stringify(body)?.slice(0, 60)).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]);
    expect(w.row(NID(1))!['read_at']).toBeNull();
  });

  it('the unknown-id answer is identical to the foreign-id answer (no existence oracle)', async () => {
    const w = makeWorld();
    const out: any = await mark(w, [NID(6), NID(999)]);
    expect(out.body.results.map((r: any) => r.outcome)).toEqual(['not_found', 'not_found']);
    expect(JSON.stringify(out.body)).not.toMatch(/forbidden|other|account|tenant/i);
  });

  it('account id never taken from the body: marking with account_id in the body is refused, and the row stays unread', async () => {
    const w = makeWorld();
    expect(await code(call('markMyNotificationsRead', w, { body: { ids: [NID(6)], account_id: ACC2 } }))).toBe('common.validation_failed');
    expect(w.row(NID(6))!['read_at']).toBeNull();
  });
});
