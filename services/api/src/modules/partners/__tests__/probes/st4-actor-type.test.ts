// C13 T22 — ST4 actor-type probes (07-SECURITY §6 ST4; abuse cases AB5, AB6; US-15.1, US-15.2). Generated from partners.yaml: EVERY operationId.
// Partner-facing operation + staff / device / portal / patient actor -> 403 auth.forbidden; staff (/admin) operation + partner / device / portal / patient actor -> 403.
// "Forbidden" means: LimsError auth.forbidden (403), zero SQL, zero port call other than IdentityPort.assertRole (which a real C2 denies for the wrong actor), no write, no log line.
// Handlers run through manifest.handlers[operationId] with a request whose ids exist nowhere, so the only thing that can stop them is the actor gate (defence in depth behind the core x-permission check).
// The partner-token-on-another-module sample (ST4 "1 operation per other module") needs the identity resolver and the real pipeline: T24 (staging E2E), not here.
import { describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';
import { ALL, OPS, PARTNER_OPS, recCtx, reqFor, settle, STAFF_OPS, UNOWNED_STUBS, WRONG_FOR_PARTNER_OPS, WRONG_FOR_STAFF_OPS } from './kit.js';

const H = manifest.handlers as Record<string, (req: any, ctx: any) => Promise<any>>;
const STUBS = new Set(UNOWNED_STUBS);

describe('ST4 classification (generator guard)', () => {
  it('every operationId is either partner-facing or staff (/admin), exactly once, and the 68 ops are all covered', () => {
    expect(OPS.length).toBe(68);
    expect(new Set([...PARTNER_OPS, ...STAFF_OPS].map((o) => o.operationId))).toEqual(new Set(OPS));
    expect(PARTNER_OPS.length + STAFF_OPS.length).toBe(68);
  });

  it('AB5/AB6 contract: partner-facing paths carry partner-actor permissions only, /admin paths staff permissions only (no code shared across the two sides)', () => {
    const partnerSide = new Set(PARTNER_OPS.map((o) => o.permission));
    const staffSide = new Set(STAFF_OPS.map((o) => o.permission));
    expect([...partnerSide].filter((p) => staffSide.has(p))).toEqual([]);
    expect([...staffSide].sort()).toEqual(['partners.manifest.receive', 'partners.partner.manage', 'partners.partner.read', 'partners.pickup.manage', 'partners.referrer.map']);
    expect(ALL.every((o) => o.permission?.startsWith('partners.'))).toBe(true); // no platform.* / frontdesk.* / catalog.* code on a partners route
  });
});

const implemented = (ops: typeof ALL) => ops.filter((o) => !STUBS.has(o.operationId));

describe('ST4 / AB5: partner-facing operations refuse every non-partner actor', () => {
  const cases = implemented(PARTNER_OPS).flatMap((o) => WRONG_FOR_PARTNER_OPS.map((actor) => [o.operationId, actor] as const));
  it.each(cases)('%s as actor %s -> 403 auth.forbidden before any SQL or write', async (operationId, actor) => {
    const o = ALL.find((x) => x.operationId === operationId)!;
    const k = recCtx(actor, { activePartner: true }); // even if a partner row would be found for this membership
    const r = await settle(H[operationId]!(reqFor(o), k.ctx));
    expect(r.ok, `${operationId} resolved for ${actor}: ${JSON.stringify((r as any).value)}`).toBe(false);
    if (!r.ok) { expect(r.error.code).toBe('auth.forbidden'); expect(r.error.statusCode).toBe(403); }
    expect(k.sql, 'no SQL for a wrong actor').toEqual([]);
    expect(k.portCalls.filter((c) => c !== 'IdentityPort.assertRole'), 'no port call for a wrong actor').toEqual([]);
    expect(k.audit).toEqual([]);
  });
});

describe('ST4 / AB6: staff (/admin) operations refuse partner, device, portal and patient actors', () => {
  const cases = implemented(STAFF_OPS).flatMap((o) => WRONG_FOR_STAFF_OPS.map((actor) => [o.operationId, actor] as const));
  it.each(cases)('%s as actor %s -> 403 auth.forbidden before any SQL or write', async (operationId, actor) => {
    const o = ALL.find((x) => x.operationId === operationId)!;
    const k = recCtx(actor, { activePartner: true });
    const r = await settle(H[operationId]!(reqFor(o), k.ctx));
    expect(r.ok, `${operationId} resolved for ${actor}: ${JSON.stringify((r as any).value)}`).toBe(false);
    if (!r.ok) { expect(r.error.code).toBe('auth.forbidden'); expect(r.error.statusCode).toBe(403); }
    expect(k.sql, 'no SQL for a wrong actor').toEqual([]);
    expect(k.portCalls.filter((c) => c !== 'IdentityPort.assertRole')).toEqual([]);
  });
});

describe('ST4 spec gap: operations with no owning task', () => {
  it.each(UNOWNED_STUBS)('%s is still a stub and fails closed (never 2xx) until a task owns it; then remove it from UNOWNED_STUBS and it joins the matrices above', async (operationId) => {
    const o = ALL.find((x) => x.operationId === operationId)!;
    const k = recCtx('user');
    const r = await settle(H[operationId]!(reqFor(o), k.ctx));
    if (r.ok) expect(r.value?.status).toBe(501); // dev only
    else expect(r.error.code).toMatch(/^(common\.internal|auth\.forbidden)$/);
    expect(k.writes()).toEqual([]);
  });
});
