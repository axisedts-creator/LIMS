// T0B-SWEEP-2 (LD-270) done_when (3) HARNESS: the 18 partners operations answered 403 partners.partner_inactive because the seeded partner is inactive.
// createSessions() (services/api/test-sweep/sessions.ts) must seed the partner ACTIVE on the throwaway database (plain SQL; no db/seeds edit):
// a partners.partners row in tenant_a with status 'active' and a partners.partner_users row for the partner session's user/membership.
import { describe, expect, it } from 'vitest';
import { createRunKey, createSessions, TENANT_A } from '../sessions.js';

const PARTNER_USER = '01a1a98a-ac40-7000-8000-00000000a30e';
const PARTNER_MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a50e';

describe('createSessions seeds an active partner', () => {
  it('writes partners.partners (active) and partners.partner_users for the partner membership, in tenant_a', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const q = async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [{ id: '01a1a98a-ac40-7000-8000-00000000f001' }] }; };
    const tokens = await createSessions(q, createRunKey(), 'https://gotrue.lims.test/auth/v1', 'authenticated');
    expect(Object.keys(tokens)).toHaveLength(7);

    const partners = calls.filter((c) => /\bpartners\.partners\b/i.test(c.sql) && /\b(insert|update)\b/i.test(c.sql));
    const users = calls.filter((c) => /\bpartners\.partner_users\b/i.test(c.sql) && /\b(insert|update)\b/i.test(c.sql));
    expect(partners.length, 'no INSERT/UPDATE on partners.partners').toBeGreaterThan(0);
    expect(users.length, 'no INSERT/UPDATE on partners.partner_users').toBeGreaterThan(0);

    const text = (cs: typeof calls) => cs.map((c) => `${c.sql} ${JSON.stringify(c.params)}`).join('\n');
    expect(text(partners)).toMatch(/\bactive\b/i);
    expect(text(partners)).not.toMatch(/\b(inactive|suspended|deactivated)\b/i);
    expect(text(partners)).toContain(TENANT_A);
    expect(text(users)).toContain(TENANT_A);
    expect(text(users)).toMatch(new RegExp(`${PARTNER_USER}|${PARTNER_MEMBERSHIP}`));
  });
  it('runs the partner seed inside the same transaction as the sessions (rolled back together on failure)', async () => {
    const seq: string[] = [];
    const q = async (sql: string) => {
      seq.push(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql) ? sql.trim().toUpperCase() : /partners\.partner/i.test(sql) ? 'PARTNER' : 'other');
      return { rows: [{ id: '01a1a98a-ac40-7000-8000-00000000f001' }] };
    };
    await createSessions(q, createRunKey(), 'https://gotrue.lims.test/auth/v1', 'authenticated');
    const b = seq.indexOf('BEGIN'), c = seq.lastIndexOf('COMMIT'), p = seq.indexOf('PARTNER');
    expect(p).toBeGreaterThan(b);
    expect(p).toBeLessThan(c);
  });
});
