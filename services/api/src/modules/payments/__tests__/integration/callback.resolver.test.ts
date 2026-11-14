// PG-T09 / CR-C15-004: the `paymentCallback` AuthResolver (TRD §6.3 step 1, 05-SCHEMA §3 P-41, 08 CR-REGISTER §4.11) over the DEFINER emulation in helpers/merchantDb.ts.
// ACs: AC-PG-14.2 (token resolves only to its own tenant), REQ-SEC-019/020 (one DEFINER lookup, hashed input), REQ-SEC-052 (identical result for every invalid token), 30-day window (review m#23).
// Not provable here: the real DEFINER against FORCE RLS, the owner policy and the GUC reset (ST-21 / 05-SCHEMA checks 11-13) - they need the C0 payments DDL.
// Fails now: service/callback.service.ts does not export createCallbackResolver.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { SYSTEM_ACTOR, ZERO_TENANT, makeCallbackHarness, sha256, type CallbackHarness } from '../helpers/callbackHarness';

const A = TENANTS.A, B = TENANTS.B;
const DAY = 86_400_000;
let t: CallbackHarness;
beforeEach(async () => { t = await makeCallbackHarness(); });

/** the core calls resolver.resolve(credential, tx) on an anonymous, pre-tenant transaction */
const resolve = (token: unknown, now = FIXED_NOW) => t.h.db.run(async (ctx: any) => t.resolver.resolve(token, ctx.tx), { tenantId: ZERO_TENANT, now: () => new Date(now) });
const at = (days: number): string => new Date(Date.parse(FIXED_NOW) + days * DAY).toISOString();

describe('paymentCallback resolver (CR-C15-004)', () => {
  it('exposes resolve() (core/auth/resolvers.ts requires it)', () => {
    expect(typeof t.resolver.resolve).toBe('function');
  });

  it('a live eSewa token -> the payments system actor, the intent\'s tenant and extraClaims { payment_intent_id } only', async () => {
    const m = await t.make();
    await expect(resolve(m.token)).resolves.toEqual({ actor: { type: 'system', id: SYSTEM_ACTOR }, tenantId: A, extraClaims: { payment_intent_id: m.intentId } });
  });

  it('a live Khalti token resolves the same way', async () => {
    const k = await t.make({ gateway: 'khalti' });
    await expect(resolve(k.token)).resolves.toEqual({ actor: { type: 'system', id: SYSTEM_ACTOR }, tenantId: A, extraClaims: { payment_intent_id: k.intentId } });
  });

  it('AC-PG-14.2: a tenant-B token resolves to tenant B only (and a tenant-A token to A), never across', async () => {
    const a = await t.make({ tenant: 'A' }), b = await t.make({ tenant: 'B' });
    await expect(resolve(b.token)).resolves.toMatchObject({ tenantId: B, extraClaims: { payment_intent_id: b.intentId } });
    await expect(resolve(a.token)).resolves.toMatchObject({ tenantId: A, extraClaims: { payment_intent_id: a.intentId } });
  });

  it('REQ-SEC-052: unknown, malformed, oversize, empty, non-string and near-miss tokens all resolve to undefined (never a throw, never a distinguishable error)', async () => {
    const m = await t.make();
    const near = m.token.slice(0, -1) + (m.token.endsWith('A') ? 'B' : 'A');
    for (const bad of ['', 'x', 'A'.repeat(43), 'A'.repeat(4096), near, m.token.toUpperCase(), ` ${m.token}`, `${m.token}\n`, "' OR 1=1 --", '../../x', '\u0000', '０１２', null, undefined, 42, {}, []])
      await expect(resolve(bad as any), `token ${JSON.stringify(bad)}`).resolves.toBeUndefined();
  });

  it('review m#23: a token is accepted for 30 days after intent creation and refused afterwards (the window is the DEFINER\'s, not configuration)', async () => {
    const m = await t.make();
    await expect(resolve(m.token, at(29))).resolves.toMatchObject({ tenantId: A });
    await expect(resolve(m.token, at(31))).resolves.toBeUndefined();
    await expect(resolve(m.token, at(400))).resolves.toBeUndefined();
  });

  it('REQ-SEC-019/020: exactly one statement - the DEFINER function - with the 32-byte SHA-256 of the token as a bytea parameter; the raw token is never sent; no direct table read', async () => {
    const m = await t.make();
    const before = t.h.db.stmts.length;
    await resolve(m.token);
    const sent = t.h.db.stmts.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/app\.payments_resolve_callback_token\s*\(/i);
    expect(sent[0]!.text).not.toMatch(/payments\.intents/i);
    expect(sent[0]!.values).toHaveLength(1);
    expect(Buffer.isBuffer(sent[0]!.values[0])).toBe(true);
    expect((sent[0]!.values[0] as Buffer).equals(sha256(m.token))).toBe(true);
    expect(JSON.stringify(sent.map((s) => s.values.map((v) => (Buffer.isBuffer(v) ? v.toString('latin1') : v))))).not.toContain(m.token);
  });

  it('is read-only and idempotent: resolving twice changes no row and gives the same claims', async () => {
    const m = await t.make();
    const snapshot = JSON.stringify([t.h.db.intents(A), t.h.db.callbacks(A), t.h.db.transitions(A)]);
    const first = await resolve(m.token), second = await resolve(m.token);
    expect(second).toEqual(first);
    expect(JSON.stringify([t.h.db.intents(A), t.h.db.callbacks(A), t.h.db.transitions(A)])).toBe(snapshot);
  });

  it('the resolver result carries no token, hash, URL or amount (claims are copied into request.jwt.claims)', async () => {
    const m = await t.make();
    const r = await resolve(m.token);
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${m.token}|https?:|amount`, 'i'));
    expect(Object.keys((r as any).extraClaims)).toEqual(['payment_intent_id']);
  });
});
