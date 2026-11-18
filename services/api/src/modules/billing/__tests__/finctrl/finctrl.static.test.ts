// T0B-FINCTRL-1 (LD-321, LD-325(b), LD-310) static pins, no database: every one of the 16 operations of T0C-FINCTRL-1 has a REAL handler and is NOT pending (the writer removes the 16 ids from
// billing/index.ts pendingOperations), the permission and idempotency rules of the contract hold, money in the new schemas is integer paisa (never a string, never a float), the probe rows
// of the four new tables exist, and the fiscal year start confirmation is written in the notes (done_when 5). Fails now: the 16 ids are still pending / have no handler.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const OPS = ['listDiscountReasons', 'createDiscountReason', 'updateDiscountReason', 'listPartyDiscountSlabs', 'createPartyDiscountSlab', 'updatePartyDiscountSlab', 'deactivatePartyDiscountSlab',
  'resolveDiscountSlab', 'listUserDiscountLimits', 'setUserDiscountLimit', 'listDiscountAuthorities', 'createDiscountAuthority', 'deactivateDiscountAuthority', 'getMyDiscountPolicy', 'holdLedgerEntry', 'releaseLedgerEntry'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/billing.yaml'));
const opOf = (id: string): any => { for (const [path, item] of Object.entries<any>(spec.paths)) for (const [method, o] of Object.entries<any>(item)) if (o?.operationId === id) return { ...o, path, method }; throw new Error(id); };
const pending: readonly string[] = (manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [];
const handlers = manifest.handlers as Record<string, unknown>;

describe('first priority: every FINCTRL operation has a handler and boot passes (AC-0D-1.2)', () => {
  it.each(OPS)('%s has a handler function and is no longer pending', (id) => {
    expect(typeof handlers[id], `no handler for ${id}`).toBe('function');
    expect(pending, `${id} must leave pendingOperations (LD-325 b)`).not.toContain(id);
  });
  it('the pending list holds nothing of this task and no handler key was invented', () => {
    expect(pending.filter((id) => OPS.includes(id))).toEqual([]);
    const specIds = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
    expect(Object.keys(handlers).filter((id) => !specIds.includes(id))).toEqual([]);
  });
});

describe('permissions and idempotency of the contract (the core pipeline enforces them; a handler never widens them)', () => {
  const reads = ['listDiscountReasons', 'listPartyDiscountSlabs', 'resolveDiscountSlab', 'listUserDiscountLimits', 'listDiscountAuthorities', 'getMyDiscountPolicy'];
  const manages = ['createDiscountReason', 'updateDiscountReason', 'createPartyDiscountSlab', 'updatePartyDiscountSlab', 'deactivatePartyDiscountSlab', 'setUserDiscountLimit', 'createDiscountAuthority', 'deactivateDiscountAuthority'];
  it.each(reads)('%s is a GET under billing.discount_policy.read with no idempotency key', (id) => {
    expect(opOf(id)).toMatchObject({ method: 'get', 'x-permission': 'billing.discount_policy.read', 'x-idempotency': 'none' });
  });
  it.each(manages)('%s is a write under billing.discount_policy.manage', (id) => {
    const o = opOf(id);
    expect(o['x-permission']).toBe('billing.discount_policy.manage');
    expect(['post', 'put', 'patch']).toContain(o.method);
  });
  it.each(['holdLedgerEntry', 'releaseLedgerEntry'])('%s needs billing.account.manage and an Idempotency-Key', (id) => {
    expect(opOf(id)).toMatchObject({ method: 'post', 'x-permission': 'billing.account.manage', 'x-idempotency': 'required' });
  });
  it('billing.discount_policy.manage and billing.account.manage are privileged (MFA), read is not; no front desk role may manage', () => {
    const perms = readFileSync(join(REPO_ROOT, 'contracts/permissions.yaml'), 'utf8');
    const line = (code: string) => perms.split('\n').find((l) => l.includes(`code: ${code},`)) ?? '';
    expect(line('billing.discount_policy.manage')).toMatch(/privileged: true/);
    expect(line('billing.discount_policy.manage')).not.toMatch(/front_desk/);
    expect(line('billing.account.manage')).toMatch(/privileged: true/);
    expect(line('billing.discount_policy.read')).toMatch(/privileged: false/);
  });
});

describe('money is integer paisa on the wire', () => {
  const schemas = ['PartyDiscountSlab', 'CreatePartyDiscountSlabRequest', 'UpdatePartyDiscountSlabRequest', 'UserDiscountLimit', 'SetUserDiscountLimitRequest', 'DiscountAuthority', 'CreateDiscountAuthorityRequest', 'DiscountCeiling', 'CashSessionDto', 'CloseCashSessionRequest'];
  it.each(schemas)('%s: every *_paisa property is an integer with a minimum of 0 and a safe maximum', (name) => {
    const props: Record<string, any> = spec.components.schemas[name].properties;
    const money = Object.entries(props).filter(([k]) => /_paisa$/.test(k));
    expect(money.length, name).toBeGreaterThan(0);
    for (const [k, v] of money) expect(v, `${name}.${k}`).toMatchObject({ type: 'integer', minimum: expect.any(Number) });
  });
  it('discount basis points are integers 0..10000 in every new schema', () => {
    for (const name of ['PartyDiscountSlab', 'CreatePartyDiscountSlabRequest', 'UserDiscountLimit', 'SetUserDiscountLimitRequest', 'DiscountAuthority', 'CreateDiscountAuthorityRequest', 'DiscountCeiling'])
      expect(spec.components.schemas[name].properties.discount_bp ?? spec.components.schemas[name].properties.max_discount_bp, name).toMatchObject({ type: 'integer', minimum: 0, maximum: 10000 });
  });
});

describe('probe rows and notes', () => {
  it('the four new tables have a row in the isolation registry and an isolation test file', () => {
    const reg = readFileSync(join(REPO_ROOT, 'db/tests/isolation/_registry.sql'), 'utf8');
    for (const t of ['discount_authority', 'discount_reason', 'party_discount_slab', 'user_discount_limit']) {
      expect(reg, t).toContain(`'billing.${t}'`);
      expect(existsSync(join(REPO_ROOT, `db/tests/isolation/billing.${t}.test.sql`)), t).toBe(true);
    }
  });
  it('the 16 operations are part of the billing cross tenant probe registry (derived from the spec, none left pending)', () => {
    for (const id of OPS) expect(pending).not.toContain(id);
  });
  it('the fiscal year start is written in the notes: default Shrawan 1 and the lab accountant\'s confirmation step before go-live (done_when 5)', () => {
    const f = join(REPO_ROOT, '.orchestra/notes/T0B-FINCTRL-1-impl.md');
    expect(existsSync(f), 'write .orchestra/notes/T0B-FINCTRL-1-impl.md').toBe(true);
    const text = readFileSync(f, 'utf8');
    expect(text).toMatch(/Shrawan/);
    expect(text).toMatch(/accountant/i);
    expect(text).toMatch(/go-live|go live/i);
  });
});
