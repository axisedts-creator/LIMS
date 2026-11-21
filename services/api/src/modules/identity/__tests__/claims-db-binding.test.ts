// WIRE-DB / LD-189 (C1, AUTH-SENSITIVE): identity claims late db binding. Synthetic ids, fake pg, no network.
// AC-0D-2.6 (identityAuthTx opens with identity system-actor claims, no tenant), 02-TRD s6.4, 08 A25 D-212 / R10, CR-C2-020.
//
// INTERFACE THE TESTS EXPECT (the spec fixes behaviour, not names; the writer may dispute a name in .orchestra/notes/WIRE-DB-dispute-*.md):
//   modules/identity/claims/dbBinding.ts
//     export function createIdentityDbBinding(): {
//       readonly db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };   // frozen, EXACTLY this one method; handed to createClaimsResolver({ db })
//       bind(src: {
//         readActorId(): Promise<unknown>;      // reads core.g_system_actors (module 'identity', is_active) through the pool; called lazily
//         open(actorId: string): { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };   // = createDb({ ..., identitySystemActorId })
//       }): void;
//     }
//   Behaviour: unbound -> identityAuthTx rejects LimsError common.internal. Bound -> the first call awaits readActorId(), accepts only a UUID
//   string, memoises it after the first success, then delegates to open(id).identityAuthTx(input, fn). A rejected / empty / non-UUID read
//   rejects common.internal (message = the code only, no id, no driver text), is NOT cached, and the next call reads again.
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { createDb } from '../../../core/db/tx.js';
import { createFakePgBouncer, pgError, IDENTITY_SYSTEM_ACTOR } from '../../../core/db/__tests__/helpers.js';
import { createClaimsResolver } from '../claims/resolver.js';
import { createIdentityDbBinding } from '../claims/dbBinding.js';
import { ID, jwt, req, tenantRow } from '../claims/__tests__/helpers.js';

const ACTOR = IDENTITY_SYSTEM_ACTOR; // synthetic UUID
const INPUT = { requestId: ID.req, clientIp: '203.0.113.7', operation: { module: 'identity', operationId: 'resolveSession', context: 'identity_auth' } };

async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection, but it resolved');
}
const expectInternal = (e: any, ...secrets: string[]) => {
  expect(e).toBeInstanceOf(LimsError);
  expect(e.code).toBe('common.internal');
  const blob = `${e.message} ${e.detail ?? ''} ${JSON.stringify(e)}`;
  for (const s of secrets) expect(blob, 'error must not leak the value').not.toContain(s);
};

/** src whose open() returns a recording delegate; readActorId answers from a script (value or Error per call, last repeats). */
function rig(script: Array<unknown | Error> = [ACTOR]) {
  const calls = { read: 0, open: [] as string[], tx: [] as unknown[] };
  const src = {
    async readActorId() {
      const v = script[Math.min(calls.read++, script.length - 1)];
      if (v instanceof Error) throw v;
      return v;
    },
    open(actorId: string) {
      calls.open.push(actorId);
      return { async identityAuthTx<T>(input: any, fn: (tx: any, ctl: any) => Promise<T>): Promise<T> { calls.tx.push(input); return fn({ k: 'tx' }, { noRetry() {} }); } };
    },
  };
  const binding = createIdentityDbBinding();
  return { binding, src, calls };
}

describe('least privilege: what the claims resolver receives', () => {
  it('db is a frozen facade with exactly one method, identityAuthTx', () => {
    const { binding } = rig();
    expect(Object.isFrozen(binding.db)).toBe(true);
    expect(Object.keys(binding.db)).toEqual(['identityAuthTx']);
    for (const k of ['requestTx', 'withTenantScope', 'anonymousTx', 'pool', 'connect', 'query', 'end']) expect(binding.db).not.toHaveProperty(k);
  });
  it('bind() exposes nothing back: the facade does not carry the source (no pool, no read function)', () => {
    const { binding, src } = rig();
    const ret: unknown = binding.bind(src);
    expect(ret).toBeUndefined();
    expect(Object.keys(binding.db)).toEqual(['identityAuthTx']);
    expect(JSON.stringify(Object.getOwnPropertyNames(binding.db))).not.toMatch(/readActorId|open|pool/);
  });
});

describe('before binding (08 A25 D-212: the bearerJwt path never sees an unbound db)', () => {
  it('identityAuthTx rejects common.internal and never runs the callback', async () => {
    const { binding } = rig();
    const fn = vi.fn();
    expectInternal(await rejection(binding.db.identityAuthTx(INPUT, fn)));
    expect(fn).not.toHaveBeenCalled();
  });
  it('the real claims resolver over an unbound facade rejects common.internal for a valid jwt (fails closed, no claims)', async () => {
    const { binding } = rig();
    const resolver = createClaimsResolver({ db: binding.db });
    expectInternal(await rejection(resolver.resolve(jwt(), req())));
  });
});

describe('lazy, memoised identity system actor (AC-0D-2.6)', () => {
  it('bind() reads nothing; the first identityAuthTx reads once and opens with that id; the callback result is returned', async () => {
    const { binding, src, calls } = rig();
    binding.bind(src);
    expect(calls.read, 'a bind at boot must not touch the database').toBe(0);
    expect(calls.open).toEqual([]);
    const out = await binding.db.identityAuthTx(INPUT, async (tx) => ({ tx, ok: 1 }));
    expect(out).toEqual({ tx: { k: 'tx' }, ok: 1 });
    expect(calls.read).toBe(1);
    expect(calls.open).toEqual([ACTOR]);
    expect(calls.tx).toEqual([INPUT]);
  });
  it('a second and third call do not read again (memoised) and still use the same id', async () => {
    const { binding, src, calls } = rig();
    binding.bind(src);
    await binding.db.identityAuthTx(INPUT, async () => 1);
    await binding.db.identityAuthTx(INPUT, async () => 2);
    await binding.db.identityAuthTx(INPUT, async () => 3);
    expect(calls.read).toBe(1);
    expect(new Set(calls.open)).toEqual(new Set([ACTOR]));
    expect(calls.tx).toHaveLength(3);
  });
  it('a transaction failure after the id is memoised does not re-read the id and does not cache the failure', async () => {
    const { binding, src, calls } = rig();
    binding.bind(src);
    await binding.db.identityAuthTx(INPUT, async () => 1);
    expect(await rejection(binding.db.identityAuthTx(INPUT, async () => { throw pgError('40001'); }))).toMatchObject({ code: '40001' });
    expect(await binding.db.identityAuthTx(INPUT, async () => 'again')).toBe('again');
    expect(calls.read).toBe(1);
  });
  it('accepts an upper-case UUID too (same shape rule as core/db/tx.ts) and passes it through unchanged', async () => {
    const up = ACTOR.toUpperCase();
    const { binding, src, calls } = rig([up]);
    binding.bind(src);
    await binding.db.identityAuthTx(INPUT, async () => 1);
    expect(calls.open).toEqual([up]);
  });
});

describe('fail closed: a failed, empty or malformed lookup (no id in the message, never cached, next call retries)', () => {
  it('a lookup that throws -> common.internal with no driver text; the next call reads again and succeeds', async () => {
    const boom = Object.assign(new Error(`connect ECONNREFUSED 10.0.0.9:5432 ${ACTOR}`), { code: 'ECONNREFUSED' });
    const { binding, src, calls } = rig([boom, ACTOR]);
    binding.bind(src);
    const fn = vi.fn(async () => 'ran');
    const e = await rejection(binding.db.identityAuthTx(INPUT, fn));
    expectInternal(e, ACTOR, 'ECONNREFUSED', '10.0.0.9', 'connect');
    expect(fn).not.toHaveBeenCalled();
    expect(calls.open, 'no transaction may open without an actor').toEqual([]);
    expect(await binding.db.identityAuthTx(INPUT, fn)).toBe('ran');
    expect(calls.read).toBe(2);
    expect(calls.open).toEqual([ACTOR]);
  });
  it.each([
    ['undefined (no row)', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('an empty lookup (%s) -> common.internal; not cached; retried', async (_n, empty) => {
    const { binding, src, calls } = rig([empty, ACTOR]);
    binding.bind(src);
    expectInternal(await rejection(binding.db.identityAuthTx(INPUT, async () => 1)));
    expect(calls.open).toEqual([]);
    expect(await binding.db.identityAuthTx(INPUT, async () => 2)).toBe(2);
    expect(calls.read).toBe(2);
  });
  it.each([
    ['plain text', 'identity-system-actor'],
    ['a number', 12345],
    ['an object', { id: ACTOR }],
    ['an array with the id', [ACTOR]],
    ['a uuid with a suffix', `${ACTOR}-x`],
    ['a uuid with a prefix', `x${ACTOR}`],
    ['a uuid with a trailing newline', `${ACTOR}\n`],
    ['a SQL-ish string', `${ACTOR}'; DROP TABLE core.g_system_actors; --`],
    ['a braced uuid', `{${ACTOR}}`],
    ['a uuid without dashes', ACTOR.replace(/-/g, '')],
  ])('a non-UUID value (%s) is rejected common.internal with the value absent from the message; never reaches open()', async (_n, bad) => {
    const { binding, src, calls } = rig([bad, ACTOR]);
    binding.bind(src);
    const e = await rejection(binding.db.identityAuthTx(INPUT, async () => 1));
    expectInternal(e, typeof bad === 'string' ? bad.trim() || 'zzz-never' : 'zzz-never', 'DROP TABLE');
    expect(calls.open).toEqual([]);
    expect(await binding.db.identityAuthTx(INPUT, async () => 2)).toBe(2); // a bad read is not cached either
    expect(calls.read).toBe(2);
  });
  it('a failing lookup keeps failing closed on every call until it succeeds (no stale or default id)', async () => {
    const { binding, src, calls } = rig([new Error('down'), new Error('down'), new Error('down')]);
    binding.bind(src);
    for (let i = 0; i < 3; i++) expectInternal(await rejection(binding.db.identityAuthTx(INPUT, async () => 1)));
    expect(calls.read).toBe(3);
    expect(calls.open).toEqual([]);
  });
});

describe('composed with the real core createDb (fake pg, no network)', () => {
  const compose = () => {
    const fake = createFakePgBouncer(1);
    const log = { info() {}, warn() {}, error() {} };
    const metrics = { inc() {} };
    const binding = createIdentityDbBinding();
    let reads = 0;
    binding.bind({
      async readActorId() { reads += 1; return ACTOR; },
      open: (id) => createDb({ pool: fake.pool, log, metrics, sleep: async () => undefined, random: () => 0, identitySystemActorId: id } as any),
    });
    return { fake, binding, reads: () => reads };
  };

  it('the transaction opens with claims EXACTLY { sub: <actor>, actor_type: "system" } and no tenant_id', async () => {
    const { fake, binding } = compose();
    await binding.db.identityAuthTx(INPUT, async (tx) => (await tx.query('SELECT 1')).rows);
    const claims = fake.openingClaims();
    expect(claims).toEqual({ sub: ACTOR, actor_type: 'system' });
    expect(Object.keys(claims).sort()).toEqual(['actor_type', 'sub']);
    expect(claims).not.toHaveProperty('tenant_id');
  });

  it('claims content cannot be steered by the caller: extra input claims/sub/tenant are ignored', async () => {
    const { fake, binding } = compose();
    await binding.db.identityAuthTx({ ...INPUT, claims: { sub: ID.sub, tenant_id: ID.tenant, actor_type: 'user' }, tenantId: ID.tenant } as any, async () => 1);
    expect(fake.openingClaims()).toEqual({ sub: ACTOR, actor_type: 'system' });
  });

  it.each([
    ['another module', { module: 'catalog', operationId: 'resolveSession', context: 'identity_auth' }],
    ['not identity_auth context', { module: 'identity', operationId: 'resolveSession', context: 'tenant' }],
    ['an operation outside the allowlist', { module: 'identity', operationId: 'listUsers', context: 'identity_auth' }],
    ['no operation', undefined],
  ])('an operation outside the identity auth allowlist (%s) is refused common.internal before any transaction SQL', async (_n, operation) => {
    const { fake, binding } = compose();
    const fn = vi.fn();
    expectInternal(await rejection(binding.db.identityAuthTx({ ...INPUT, operation } as any, fn)));
    expect(fn).not.toHaveBeenCalled();
    expect(fake.log, 'no BEGIN / set_config / query of any kind').toEqual([]);
    expect(fake.state.connects).toBe(0);
  });

  it('the real resolver end to end: one identityAuthTx, the DEFINER row evaluated, system-actor claims on the transaction only', async () => {
    const fake = createFakePgBouncer(1);
    const future = (m: number) => new Date(Date.now() + m * 60_000);
    const row = tenantRow({ idle_expires_at: future(15), absolute_expires_at: future(600) });
    const binding = createIdentityDbBinding();
    binding.bind({
      async readActorId() { return ACTOR; },
      open: (id) => {
        const db = createDb({ pool: fake.pool, log: { info() {}, warn() {}, error() {} }, metrics: { inc() {} }, sleep: async () => undefined, random: () => 0, identitySystemActorId: id } as any);
        return { identityAuthTx: (i: any, fn: any) => db.identityAuthTx(i, (tx: any, c: any) => fn({ ...tx, query: async (t: string, v?: unknown[]) => (/identity_resolve_session/.test(t) ? { rows: [row] } : tx.query(t, v)) }, c)) } as any;
      },
    });
    const out = await createClaimsResolver({ db: binding.db }).resolve(jwt(), req());
    expect(out.kind).toBe('tenant');
    const claims = fake.openingClaims();
    expect(claims).toEqual({ sub: ACTOR, actor_type: 'system' });
    expect(claims.sub).not.toBe(ID.sub); // never the caller's sub
  });
});
