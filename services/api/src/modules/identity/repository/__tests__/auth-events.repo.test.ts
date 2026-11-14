// T6 repositories (05-SCHEMA s5.4/s6: app.identity_record_auth_event DEFINER for tenant-less rows, auth_events__insert__tenant for tenant rows, app.identity_is_breached).
// ASSUMED API: `createAuthEventsRepo()` -> { recordTenantless(tx, e), recordTenant(tx, e) } (e = event shape in service/__tests__/auth.helpers.ts header);
//              `createBreachedRepo()` -> { isBreached(tx, sha1: Buffer(20)) => Promise<boolean> }. Both take the request tx first; SQL only, parameterised.
// Expected now: fail on missing ../auth-events.repo.js / ../breached.repo.js. Live-DB behaviour of the DEFINER is pgTAP (db/tests/identity/T0B-10.C2_policies, test 32).
import { describe, expect, it, vi } from 'vitest';
import { createAuthEventsRepo } from '../auth-events.repo.js';
import { createBreachedRepo } from '../breached.repo.js';
import { idN, rejection } from '../../service/__tests__/auth.helpers.js';

const tx = (rows: unknown[] = []) => { const query = vi.fn(async (_t: string, _v?: unknown[]) => ({ rows })); return { query } as any; };
const HEX = 'ab'.repeat(32);
const ev = (o: Record<string, unknown> = {}) => ({ id: idN(1), eventType: 'login_failed', reasonCode: undefined, userId: undefined, emailHmacHex: HEX, clientIp: '203.0.113.9', userAgent: 'Firefox', requestId: idN(2), actorId: idN(3), ...o });
const payload = (c: unknown[]) => (typeof c[0] === 'string' ? JSON.parse(c[0] as string) : c[0]) as Record<string, unknown>;

describe('recordTenantless (through the DEFINER only)', () => {
  it('one parameterised call to app.identity_record_auth_event($1::jsonb); payload carries the snake_case fields, email_hmac_hex, created_by = actorId; NO tenant_id key', async () => {
    const t = tx(); await createAuthEventsRepo().recordTenantless(t, ev({ userId: idN(9), platformStaffId: idN(8), sessionId: idN(7), reasonCode: 'x' }) as any);
    expect(t.query).toHaveBeenCalledTimes(1);
    const [sql, vals] = t.query.mock.calls[0]!; expect(sql).toMatch(/app\.identity_record_auth_event\s*\(\s*\$1(::jsonb)?\s*\)/i); expect(sql).not.toMatch(/insert\s+into\s+identity\.auth_events/i);
    const p = payload(vals as unknown[]);
    expect(p).toMatchObject({ id: idN(1), event_type: 'login_failed', reason_code: 'x', user_id: idN(9), platform_staff_id: idN(8), session_id: idN(7), email_hmac_hex: HEX, client_ip: '203.0.113.9', user_agent: 'Firefox', request_id: idN(2), created_by: idN(3) });
    expect(p).not.toHaveProperty('tenant_id');
  });
  it('a tenant id on a tenant-less event is a programmer error (the DEFINER would raise tenant_events_use_rls_path): rejected before any query', async () => {
    const t = tx(); const e = await rejection(() => createAuthEventsRepo().recordTenantless(t, ev({ tenantId: idN(5) }) as any)); expect(e).toBeInstanceOf(Error); expect(t.query).not.toHaveBeenCalled();
  });
  it('hostile user agent / ip text only ever travels as data', async () => {
    const t = tx(); await createAuthEventsRepo().recordTenantless(t, ev({ userAgent: "'; DROP TABLE identity.auth_events;--" }) as any);
    expect(String(t.query.mock.calls[0]![0])).not.toContain('DROP TABLE');
  });
});

describe('recordTenant (auth_events__insert__tenant path, after bindTenant)', () => {
  it('one parameterised INSERT INTO identity.auth_events with tenant_id as a parameter; no DEFINER call', async () => {
    const t = tx(); await createAuthEventsRepo().recordTenant(t, ev({ eventType: 'login_blocked_locked', tenantId: idN(5), userId: idN(9), membershipId: idN(6) }) as any);
    expect(t.query).toHaveBeenCalledTimes(1); const [sql, vals] = t.query.mock.calls[0]!;
    expect(sql).toMatch(/insert\s+into\s+identity\.auth_events/i); expect(sql).not.toMatch(/identity_record_auth_event/);
    for (const col of ['tenant_id', 'user_id', 'membership_id', 'event_type', 'email_hmac', 'client_ip', 'user_agent', 'request_id', 'created_by']) expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
    const v = vals as unknown[]; expect(v).toContain(idN(5)); expect(v).toContain('login_blocked_locked'); expect(v).toContain(idN(6)); expect(v).toContain(idN(3));
    expect(JSON.stringify(sql)).not.toContain(idN(5));
  });
  it('requires a tenant id (a tenant-less insert would be refused by RLS and lose the event): rejected before any query', async () => {
    const t = tx(); const e = await rejection(() => createAuthEventsRepo().recordTenant(t, ev() as any)); expect(e).toBeInstanceOf(Error); expect(t.query).not.toHaveBeenCalled();
  });
  it('user_agent is cut to 512 chars (auth_events__ua__ck) so a long UA cannot make the failure write itself fail', async () => {
    const t = tx(); await createAuthEventsRepo().recordTenant(t, ev({ tenantId: idN(5), userAgent: 'U'.repeat(900) }) as any);
    const v = t.query.mock.calls[0]![1] as unknown[]; const ua = v.find((x) => typeof x === 'string' && /^U+$/.test(x)) as string; expect(ua.length).toBeLessThanOrEqual(512);
  });
  it('the 32-byte e-mail HMAC is passed as the hex value / Buffer (never an e-mail)', async () => {
    const t = tx(); await createAuthEventsRepo().recordTenant(t, ev({ tenantId: idN(5) }) as any);
    const v = t.query.mock.calls[0]![1] as unknown[]; expect(v.some((x) => x === HEX || (Buffer.isBuffer(x) && x.equals(Buffer.from(HEX, 'hex'))))).toBe(true);
  });
});

describe('breached.repo (AU-T4 lookup; app.identity_is_breached INVOKER, class-G table)', () => {
  it('isBreached: SELECT app.identity_is_breached($1::bytea) with the 20-byte SHA-1 as the only parameter; boolean result', async () => {
    const sha1 = Buffer.alloc(20, 7);
    for (const b of [true, false]) { const t = tx([{ identity_is_breached: b, is_breached: b, breached: b }]); expect(await createBreachedRepo().isBreached(t, sha1)).toBe(b); const [sql, vals] = t.query.mock.calls[0]!; expect(sql).toMatch(/app\.identity_is_breached\s*\(\s*\$1(::bytea)?\s*\)/i); expect(vals).toEqual([sha1]); }
  });
  it('anything but a 20-byte Buffer is refused before any query (never a silent "not breached")', async () => {
    for (const bad of [Buffer.alloc(19), Buffer.alloc(21), 'a'.repeat(40), undefined]) { const t = tx([{ breached: false }]); const e = await rejection(() => createBreachedRepo().isBreached(t, bad as any)); expect(e).toBeInstanceOf(Error); expect(t.query).not.toHaveBeenCalled(); }
  });
  it('an empty result is not "false" (fails closed)', async () => { const t = tx([]); expect(await rejection(() => createBreachedRepo().isBreached(t, Buffer.alloc(20)))).toBeInstanceOf(Error); });
});
