// T0D-OFFLINE-2 done_when 5: REFERENCE DATA PREFETCH. When online and idle, pull and keep fresh the cacheable reads of the offline design section 3 for the
// signed in role (pullChanges, POST /v1/core/sync/pull, core.yaml SyncEntityType) with incremental cursors, a size cap (default 150 MB, least recently used
// patients leave first), a Ready for offline indicator; nothing is prefetched for roles without the permission.
// CONTRACT (writer: apps/web/src/core/offline/prefetch.ts, re-exported from index.ts):
//   PREFETCH_ENTITIES   [{ entity_type, permission }], copied from services/api/src/core/sync/pull.service.ts SOURCES (the server's own permission per type):
//                       test catalog.test.read, parameter catalog.test.read, doctor catalog.referrer.read, centre identity.centre.read,
//                       price_list_version catalog.price_list.read, verification_policy lab.verification_policy.read, print_profile reporting.settings.manage,
//                       patient frontdesk.patient.read. worklist_item and permission are NOT requested (the server fails them closed until the lead maps them).
//   DEFAULT_CACHE_CAP_BYTES  150 MB.
//   createPrefetcher({ store, fetch, deviceId, permissions, now, capBytes?, limit?, isOnline?, isIdle?, baseUrl? }) -> {
//     run(): Promise<{ ok: boolean; skipped?: 'offline' | 'busy' | 'no_permission' | 'locked' | 'error'; requested: string[]; evicted: number }>
//     get(entityType, id): Promise<document | undefined>      the row as the read API returns it; a read of a patient counts as a use (LRU)
//     list(entityType): Promise<document[]>
//     usage(): Promise<{ bytes: number; capBytes: number }>   bytes = size of what is kept (plain size of the documents, or a little more: envelope)
//     status(): Promise<{ ready: boolean; fetchedAt: number | null }>   ready = every permitted type has been pulled to its end at least once
//   }
//   Request: one POST per round with { device_id, entities: [{ entity_type, cursor? }], limit } (limit 1..1000); further rounds ONLY for the types that said has_more,
//   with their next_cursor. Cursors are saved after each round together with its documents, so a later run (even after a reopen) continues where it stopped.
//   A failing round (non 2xx, network error) ends the run with ok:false and skipped:'error': no retry inside run(), cursors and documents of earlier rounds stay.
//   Tombstones delete the document. Documents are stored only encrypted (store 'refdata'); nothing personal is readable in the raw IndexedDB.
import { describe, expect, it } from 'vitest';
import { DEVICE, PIN, fakeServer, rawDump, unlockedStore } from '@/core/offline/__tests__/offline1.helpers';

const ID = (n: number) => `0193c4a0-0000-7000-8000-0000005e${String(n).padStart(4, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();
const doc = (n: number, extra: Record<string, unknown> = {}) => ({ id: ID(n), version: 1, updated_at: iso(Date.parse('2026-11-17T09:00:00Z')), document: { id: ID(n), code: `C${n}`, ...extra } });
const pad = (n: number) => 'z'.repeat(n);

const PULL = 'POST /v1/core/sync/pull';
type Page = { upserts?: unknown[]; tombstones?: unknown[] };

/** A pull handler that serves scripted pages per entity type. Cursor "cN" = N pages consumed; has_more while pages remain. */
function pullScript() {
  const pages: Record<string, Page[]> = {};
  const bodies: Array<{ device_id: string; entities: Array<{ entity_type: string; cursor?: string }>; limit?: number }> = [];
  let failNext: { status: number; body?: unknown } | null = null;
  const handler = ({ body }: { body: (typeof bodies)[number] }) => {
    bodies.push(body);
    if (failNext) { const f = failNext; failNext = null; return { status: f.status, body: f.body ?? { code: 'common.internal' } }; }
    return {
      status: 200,
      body: {
        server_time: iso(Date.parse('2026-11-18T06:00:00Z')),
        changes: body.entities.map((e) => {
          const n = e.cursor ? Number(e.cursor.slice(1)) : 0;
          const list = pages[e.entity_type] ?? [];
          const p = list[n];
          return p
            ? { entity_type: e.entity_type, upserts: p.upserts ?? [], tombstones: p.tombstones ?? [], next_cursor: `c${n + 1}`, has_more: n + 1 < list.length }
            : { entity_type: e.entity_type, upserts: [], tombstones: [], next_cursor: e.cursor ?? 'c0', has_more: false };
        }),
      },
    };
  };
  return { pages, bodies, handler, fail: (status: number, body?: unknown) => { failNext = { status, body }; } };
}

const ALL_READS = ['sync.use', 'catalog.test.read', 'catalog.referrer.read', 'identity.centre.read', 'catalog.price_list.read', 'lab.verification_policy.read', 'reporting.settings.manage', 'frontdesk.patient.read'];

async function setup(permissions: string[], over: Record<string, unknown> = {}) {
  const env = await unlockedStore();
  const script = pullScript();
  const server = fakeServer({ [PULL]: script.handler as never });
  const { createPrefetcher } = await import('@/core/offline/prefetch');
  const make = (store = env.store, extra: Record<string, unknown> = {}) => createPrefetcher({ store, fetch: server.fetch, deviceId: DEVICE, permissions, now: env.c.now, ...over, ...extra } as never);
  return { env, script, server, make, prefetcher: make() };
}
const pulls = (server: ReturnType<typeof fakeServer>) => server.calls.filter((c) => c.method === 'POST' && c.path === '/v1/core/sync/pull');

describe('which entity types are requested (roles without the permission get nothing)', () => {
  it('the table copies the server permission of each cacheable type and leaves out worklist_item and permission', async () => {
    const { PREFETCH_ENTITIES, DEFAULT_CACHE_CAP_BYTES } = await import('@/core/offline/prefetch');
    const m = Object.fromEntries(PREFETCH_ENTITIES.map((e: { entity_type: string; permission: string }) => [e.entity_type, e.permission]));
    expect(m).toEqual({
      test: 'catalog.test.read', parameter: 'catalog.test.read', doctor: 'catalog.referrer.read', centre: 'identity.centre.read',
      price_list_version: 'catalog.price_list.read', verification_policy: 'lab.verification_policy.read', print_profile: 'reporting.settings.manage', patient: 'frontdesk.patient.read',
    });
    expect(DEFAULT_CACHE_CAP_BYTES).toBeGreaterThanOrEqual(150_000_000);
    expect(DEFAULT_CACHE_CAP_BYTES).toBeLessThanOrEqual(150 * 1024 * 1024);
  });
  it('a full role requests all eight types in one POST with its device id and a legal limit', async () => {
    const { prefetcher, server } = await setup(ALL_READS);
    const r = await prefetcher.run();
    expect(r.ok).toBe(true);
    const [first] = pulls(server);
    expect(first!.body.device_id).toBe(DEVICE);
    expect(first!.body.entities.map((e: { entity_type: string }) => e.entity_type).sort()).toEqual(
      ['centre', 'doctor', 'parameter', 'patient', 'price_list_version', 'print_profile', 'test', 'verification_policy']);
    expect(first!.body.entities.every((e: { cursor?: string }) => e.cursor === undefined)).toBe(true);
    expect(Number.isInteger(first!.body.limit)).toBe(true);
    expect(first!.body.limit).toBeGreaterThanOrEqual(1);
    expect(first!.body.limit).toBeLessThanOrEqual(1000);
    expect(first!.headers['content-type']).toMatch(/json/);
  });
  it('only the permitted types are requested: a front desk role without catalog.referrer.read never asks for doctors', async () => {
    const { prefetcher, server } = await setup(['sync.use', 'catalog.test.read', 'frontdesk.patient.read']);
    await prefetcher.run();
    const types = pulls(server).flatMap((c) => c.body.entities.map((e: { entity_type: string }) => e.entity_type)).sort();
    expect(types).toEqual(['parameter', 'patient', 'test']);
  });
  it('worklist_item and permission are never requested, whatever the role holds', async () => {
    const { prefetcher, server } = await setup([...ALL_READS, 'lab.worklist.read', 'identity.self.manage']);
    await prefetcher.run();
    const types = pulls(server).flatMap((c) => c.body.entities.map((e: { entity_type: string }) => e.entity_type));
    expect(types).not.toContain('worklist_item');
    expect(types).not.toContain('permission');
  });
  it('a role with sync.use only, or without sync.use, sends nothing at all', async () => {
    for (const perms of [['sync.use'], [], ALL_READS.filter((p) => p !== 'sync.use')]) {
      const { prefetcher, server } = await setup(perms);
      const r = await prefetcher.run();
      expect(r.ok).toBe(false);
      expect(r.skipped).toBe('no_permission');
      expect(r.requested).toEqual([]);
      expect(pulls(server)).toHaveLength(0);
    }
  });
});

describe('when it may run: online, idle, unlocked', () => {
  it('offline: no request', async () => {
    const { prefetcher, server } = await setup(ALL_READS, { isOnline: () => false });
    expect(await prefetcher.run()).toMatchObject({ ok: false, skipped: 'offline' });
    expect(pulls(server)).toHaveLength(0);
  });
  it('busy (the user is working): no request', async () => {
    const { prefetcher, server } = await setup(ALL_READS, { isIdle: () => false });
    expect(await prefetcher.run()).toMatchObject({ ok: false, skipped: 'busy' });
    expect(pulls(server)).toHaveLength(0);
  });
  it('locked store: no request, nothing thrown', async () => {
    const { prefetcher, server, env } = await setup(ALL_READS);
    env.store.lock();
    expect(await prefetcher.run()).toMatchObject({ ok: false, skipped: 'locked' });
    expect(pulls(server)).toHaveLength(0);
  });
});

describe('incremental cursors', () => {
  it('first run has no cursor; the next run (even after reopening the store) sends the saved cursor and only fetches what is new', async () => {
    const { script, server, make, env, prefetcher } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1)] }];
    script.pages.parameter = [{ upserts: [doc(2)] }];
    await prefetcher.run();
    const firstTypes = pulls(server)[0]!.body.entities;
    expect(firstTypes.map((e: { entity_type: string }) => e.entity_type).sort()).toEqual(['parameter', 'test']);
    expect(firstTypes.every((e: { cursor?: string }) => e.cursor === undefined)).toBe(true);
    env.store.close();
    const reopened = await env.reopen();
    await reopened.unlock(PIN);
    script.pages.test!.push({ upserts: [doc(3)] }); // the server has one new test
    const before = pulls(server).length;
    await make(reopened).run();
    const second = pulls(server)[before]!;
    expect(second.body.entities.find((e: { entity_type: string }) => e.entity_type === 'test').cursor).toBe('c1');
    expect(second.body.entities.find((e: { entity_type: string }) => e.entity_type === 'parameter').cursor).toBe('c1');
    const again = make(reopened);
    expect((await again.list('test')).map((d: { id: string }) => d.id).sort()).toEqual([ID(1), ID(3)]);
  });
  it('has_more: further rounds ask only for the types that have more, with their next cursor', async () => {
    const { script, server, prefetcher } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1)] }, { upserts: [doc(2)] }, { upserts: [doc(3)] }];
    script.pages.parameter = [{ upserts: [doc(9)] }];
    const r = await prefetcher.run();
    expect(r.ok).toBe(true);
    const bodies = pulls(server).map((c) => c.body.entities);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual([{ entity_type: 'test', cursor: 'c1' }]);
    expect(bodies[2]).toEqual([{ entity_type: 'test', cursor: 'c2' }]);
    expect((await prefetcher.list('test')).map((d: { id: string }) => d.id).sort()).toEqual([ID(1), ID(2), ID(3)]);
  });
  it('a failed round keeps what the earlier rounds stored and the next run resumes from the saved cursor, not from the start', async () => {
    const { script, server, prefetcher } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1)] }, { upserts: [doc(2)] }];
    // first round passes, second round fails with a server error
    const handler = server.routes[PULL] as (a: { body: never; url: string; init: RequestInit }) => unknown;
    let n = 0;
    server.routes[PULL] = ((a: never) => (++n === 2 ? { status: 500, body: { code: 'common.internal' } } : handler(a))) as never;
    const r = await prefetcher.run();
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('error');
    expect((await prefetcher.status()).ready).toBe(false);
    expect((await prefetcher.list('test')).map((d: { id: string }) => d.id)).toEqual([ID(1)]);
    server.routes[PULL] = handler as never;
    const before = pulls(server).length;
    await prefetcher.run();
    expect(pulls(server)[before]!.body.entities.find((e: { entity_type: string }) => e.entity_type === 'test').cursor).toBe('c1');
    expect((await prefetcher.list('test')).map((d: { id: string }) => d.id).sort()).toEqual([ID(1), ID(2)]);
  });
  it('403 sync.device_revoked and 429 are failures too: nothing stored, cursors unchanged, no throw', async () => {
    const { script, server, prefetcher } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1)] }];
    script.fail(403, { code: 'sync.device_revoked' });
    expect((await prefetcher.run()).ok).toBe(false);
    script.fail(429, { code: 'common.rate_limited' });
    expect((await prefetcher.run()).ok).toBe(false);
    expect(await prefetcher.list('test')).toEqual([]);
    await prefetcher.run();
    expect(pulls(server)[2]!.body.entities.every((e: { cursor?: string }) => e.cursor === undefined)).toBe(true);
    expect((await prefetcher.list('test')).length).toBe(1);
  });
  it('a network failure resolves to a failed result, never a throw', async () => {
    const { server, prefetcher } = await setup(['sync.use', 'catalog.test.read']);
    server.routes[PULL] = (() => 'throw') as never;
    const r = await prefetcher.run();
    expect(r.ok).toBe(false);
  });
});

describe('what is kept', () => {
  it('upserts are readable through get / list; tombstones remove the document', async () => {
    const { script, prefetcher } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1, { name: 'Complete blood count' }), doc(2)] }, { tombstones: [{ id: ID(2), removed_at: iso(Date.parse('2026-11-18T05:00:00Z')) }], upserts: [doc(1, { name: 'CBC renamed' })] }];
    await prefetcher.run();
    expect(await prefetcher.get('test', ID(2))).toBeUndefined();
    expect(await prefetcher.get('test', ID(1))).toMatchObject({ name: 'CBC renamed' });
    expect(await prefetcher.get('test', ID(404))).toBeUndefined();
  });
  it('personal data is stored only encrypted: the raw IndexedDB has no readable name or phone', async () => {
    const { script, prefetcher, env } = await setup(['sync.use', 'frontdesk.patient.read']);
    script.pages.patient = [{ upserts: [doc(1, { full_name: 'Zoya Synthetic', phone: '9822222222' })] }];
    await prefetcher.run();
    expect(await prefetcher.get('patient', ID(1))).toMatchObject({ full_name: 'Zoya Synthetic' });
    const dump = await rawDump(env.dbName);
    expect(dump).not.toContain('Zoya');
    expect(dump).not.toContain('9822222222');
  });
  it('the kept data is gone after the store is wiped', async () => {
    const { script, prefetcher, env } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1)] }];
    await prefetcher.run();
    await env.store.wipe();
    const dump = await rawDump(env.dbName);
    expect(dump).not.toContain(ID(1));
  });
});

describe('size cap: least recently used patients leave first', () => {
  const patient = (n: number) => doc(n, { full_name: `Synthetic Patient ${n}`, notes: pad(850) });
  it('uses 150 MB by default and reports usage', async () => {
    const { script, prefetcher } = await setup(['sync.use', 'frontdesk.patient.read']);
    script.pages.patient = [{ upserts: [patient(1)] }];
    await prefetcher.run();
    const u = await prefetcher.usage();
    expect(u.capBytes).toBeGreaterThanOrEqual(150_000_000);
    expect(u.bytes).toBeGreaterThan(800);
    expect(u.bytes).toBeLessThan(5000);
  });
  it('over the cap the least recently used patient goes; a patient that was read stays; usage ends at or under the cap', async () => {
    const { script, prefetcher, env } = await setup(['sync.use', 'frontdesk.patient.read', 'catalog.test.read'], { capBytes: 2500 });
    script.pages.test = [{ upserts: [doc(900)] }];
    script.pages.patient = [{ upserts: [patient(1), patient(2)] }];
    const r1 = await prefetcher.run();
    expect(r1.evicted).toBe(0);
    env.c.advance(60_000);
    expect(await prefetcher.get('patient', ID(1))).toBeTruthy(); // patient 1 is used now: patient 2 is the least recently used
    env.c.advance(60_000);
    script.pages.patient.push({ upserts: [patient(3)] });
    const r2 = await prefetcher.run();
    expect(r2.evicted).toBe(1);
    expect(await prefetcher.get('patient', ID(2))).toBeUndefined();
    expect(await prefetcher.get('patient', ID(1))).toBeTruthy();
    expect(await prefetcher.get('patient', ID(3))).toBeTruthy();
    expect((await prefetcher.usage()).bytes).toBeLessThanOrEqual(2500);
  });
  it('catalogue types are never evicted by the cap, only patients', async () => {
    const { script, prefetcher } = await setup(['sync.use', 'frontdesk.patient.read', 'catalog.test.read'], { capBytes: 1500 });
    script.pages.test = [{ upserts: [doc(900, { name: 'Kept test' })] }];
    script.pages.patient = [{ upserts: [patient(1), patient(2), patient(3)] }];
    await prefetcher.run();
    expect(await prefetcher.get('test', ID(900))).toMatchObject({ name: 'Kept test' });
    const left = (await prefetcher.list('patient')).length;
    expect(left).toBeLessThanOrEqual(1);
  });
});

describe('Ready for offline', () => {
  it('not ready before the first full pull; ready with the time once every permitted type reached its end', async () => {
    const { script, prefetcher, env } = await setup(['sync.use', 'catalog.test.read']);
    expect(await prefetcher.status()).toMatchObject({ ready: false, fetchedAt: null });
    script.pages.test = [{ upserts: [doc(1)] }, { upserts: [doc(2)] }];
    script.pages.parameter = [{ upserts: [doc(3)] }];
    const t = env.c.now();
    await prefetcher.run();
    expect(await prefetcher.status()).toMatchObject({ ready: true, fetchedAt: t });
  });
  it('stays not ready while a type still has more pages (failed run), and the state survives a reopen once ready', async () => {
    const { script, server, make, env, prefetcher } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1)] }, { upserts: [doc(2)] }];
    const handler = server.routes[PULL] as (a: never) => unknown;
    let n = 0;
    server.routes[PULL] = ((a: never) => (++n === 2 ? { status: 500, body: {} } : handler(a))) as never;
    await prefetcher.run();
    expect((await prefetcher.status()).ready).toBe(false);
    server.routes[PULL] = handler as never;
    await prefetcher.run();
    expect((await prefetcher.status()).ready).toBe(true);
    env.store.close();
    const reopened = await env.reopen();
    await reopened.unlock(PIN);
    expect((await make(reopened).status()).ready).toBe(true);
  });
  it('a refresh keeps it ready and moves the time forward', async () => {
    const { script, prefetcher, env } = await setup(['sync.use', 'catalog.test.read']);
    script.pages.test = [{ upserts: [doc(1)] }];
    await prefetcher.run();
    env.c.advance(3_600_000);
    await prefetcher.run();
    expect(await prefetcher.status()).toMatchObject({ ready: true, fetchedAt: env.c.now() });
  });
});

