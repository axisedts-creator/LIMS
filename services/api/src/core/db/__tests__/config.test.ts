// T0D-03 — DB-related LIMS_CORE_* keys in loadConfig (02-TRD §11): LIMS_CORE_TX_RETRY_MAX, LIMS_CORE_IDENTITY_AUTH_OPS,
// LIMS_CORE_WITH_TENANT_SCOPE_OPS. Expected CoreConfig fields: txRetryMax: number, identityAuthOps: readonly string[], withTenantScopeOps: readonly string[].
// Lists are comma-separated; unset = the spec default list (core/db/allowlists.ts). Bad values fail fast, naming the key (like T0D-01).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { IDENTITY_AUTH_OPS, WITH_TENANT_SCOPE_OPS } from '../allowlists.js';

const base = { LIMS_CORE_ENV: 'ci' } as const;
const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra }) as any;

describe('DB config keys', () => {
  it('defaults: retry max 3, the spec allowlists', () => {
    const c = load();
    expect(c.txRetryMax).toBe(3);
    expect([...c.identityAuthOps]).toEqual([...IDENTITY_AUTH_OPS]);
    expect([...c.withTenantScopeOps]).toEqual([...WITH_TENANT_SCOPE_OPS]);
  });

  it('LIMS_CORE_TX_RETRY_MAX is read as an integer (0 allowed)', () => {
    expect(load({ LIMS_CORE_TX_RETRY_MAX: '5' }).txRetryMax).toBe(5);
    expect(load({ LIMS_CORE_TX_RETRY_MAX: '0' }).txRetryMax).toBe(0);
  });

  it.each(['-1', '1.5', 'abc', '3; DROP', '1e3'])('LIMS_CORE_TX_RETRY_MAX=%j fails naming the key', (v) => {
    expect(() => load({ LIMS_CORE_TX_RETRY_MAX: v })).toThrow(/LIMS_CORE_TX_RETRY_MAX/);
  });

  it('LIMS_CORE_IDENTITY_AUTH_OPS replaces the default list (trimmed, empty items dropped)', () => {
    expect([...load({ LIMS_CORE_IDENTITY_AUTH_OPS: ' loginStaff , loginPartner ,' }).identityAuthOps]).toEqual(['loginStaff', 'loginPartner']);
  });

  it('LIMS_CORE_WITH_TENANT_SCOPE_OPS replaces the default list', () => {
    expect([...load({ LIMS_CORE_WITH_TENANT_SCOPE_OPS: 'getDeadLetter,suspendTenant' }).withTenantScopeOps]).toEqual(['getDeadLetter', 'suspendTenant']);
  });

  it.each(['LIMS_CORE_IDENTITY_AUTH_OPS', 'LIMS_CORE_WITH_TENANT_SCOPE_OPS'])('%s rejects names that are not operationId-shaped', (key) => {
    expect(() => load({ [key]: 'ok,bad name' })).toThrow(new RegExp(key));
    expect(() => load({ [key]: 'a;b' })).toThrow(new RegExp(key));
  });

  it('the exported config lists are frozen (a module cannot widen the allowlist at run time)', () => {
    const c = load();
    expect(Object.isFrozen(c.identityAuthOps)).toBe(true);
    expect(Object.isFrozen(c.withTenantScopeOps)).toBe(true);
  });
});
