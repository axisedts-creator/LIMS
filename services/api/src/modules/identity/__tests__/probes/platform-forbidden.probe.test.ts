// C2-T29 P-7 (07-SECURITY §6.1), runtime half: every platform-context operation of the REAL identity handler map, called as a tenant user
// (tenant_admin, aal2, a membership, a tenant id, NO platformRole), must refuse with `auth.forbidden` (or `auth.unauthenticated` when the
// handler cannot even see a platform request) and must not touch the DB: ctx.tx / ctx.db throw on any use, so a handler that reads
// before authorising fails this test. Same probe with a platform_support caller for the superadmin-only operations (E-6).
// Synthetic data only. Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/probes
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { manifest } from '../../index.js';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const api: any = parse(readFileSync(join(ROOT, 'contracts/openapi/identity.yaml'), 'utf8'));
const PLATFORM: Array<{ id: string; permission: string; path: string; method: string }> = [];
for (const [path, item] of Object.entries<any>(api.paths)) for (const [method, op] of Object.entries<any>(item)) {
  if (op?.['x-context'] === 'platform') PLATFORM.push({ id: op.operationId, permission: op['x-permission'], path, method });
}

const A = '0190a000-0000-7000-8000-0000000000a1', B = '0190a000-0000-7000-8000-0000000000b1';
const UUID = '0190a000-0000-7000-8000-0000000000c9';
const trap = (what: string) => new Proxy(function () { /* callable */ } as any, {
  get: (_t, p) => { if (p === 'then') return undefined; throw new Error(`DB touched before authorisation: ${what}.${String(p)}`); },
  apply: () => { throw new Error(`DB touched before authorisation: ${what}()`); },
});
const base = () => ({
  tx: trap('tx'), db: trap('db'), now: () => new Date('2026-11-13T04:00:00.000Z'), requestId: '0190a000-0000-7000-8000-0000000000e1',
  log: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } },
  commitOnError: () => undefined,
});
const tenantAdmin = () => ({ ...base(), tenantId: A, aal: 'aal2', actor: { type: 'user', id: '0190a000-0000-7000-8000-000000000011', membershipId: '0190a000-0000-7000-8000-000000000012' }, roles: ['tenant_admin'] });
const support = () => ({ ...base(), aal: 'aal2', actor: { type: 'user', id: '0190a000-0000-7000-8000-0000000000d1' }, platformRole: 'platform_support', platformStaffId: '0190a000-0000-7000-8000-0000000000d2', platformSessionId: '0190a000-0000-7000-8000-0000000000e2' });
const req = () => ({
  params: { tenant_id: B, platform_staff_id: UUID, session_id: UUID, dead_letter_id: UUID, support_session_id: UUID, annex_id: UUID, ird_annex_id: UUID, flag_code: 'x', id: UUID },
  query: {}, headers: {}, body: { tenant_id: B, reason_text: 'synthetic probe', scope: 'admin', ticket_ref: 'SUP-1', duration_minutes: 30, role_code: 'platform_superadmin', display_name: 'Demo', email: 'demo.probe@example.test', allowed_cidrs: ['203.0.113.0/24'] },
});
const outcome = async (op: string, ctx: unknown) => {
  try { await Promise.race([Promise.resolve(manifest.handlers[op]!(req() as never, ctx as never)), new Promise((_ok, no) => setTimeout(() => no(new Error('timeout')), 4000))]); return { ok: true as const }; }
  catch (e: any) { return { ok: false as const, code: e?.code as string | undefined, message: String(e?.message ?? e) }; }
};

describe('P-7 platform operations as a tenant user', () => {
  it('the contract lists platform operations and the handler map implements every one (sweep is not vacuous)', () => {
    expect(PLATFORM.length).toBeGreaterThanOrEqual(30);
    for (const p of PLATFORM) expect(manifest.handlers[p.id], `${p.id} handler`).toBeTypeOf('function');
  });
  it.each(PLATFORM.map((p) => [p.id, p.permission]))('%s (%s): tenant_admin aal2 -> auth.forbidden, DB untouched', async (id) => {
    const r = await outcome(id as string, tenantAdmin());
    expect(r.ok, `${id} must not succeed for a tenant user`).toBe(false);
    if (!r.ok) {
      expect(r.message, `${id} reached the DB before authorising`).not.toMatch(/DB touched before authorisation/);
      expect(r.code, `${id}: ${r.message}`).toMatch(/^auth\.(forbidden|unauthenticated)$/);
    }
  });
  it.each(PLATFORM.map((p) => [p.id, p.permission]))('%s (%s): a context with no actor at all -> auth.unauthenticated or auth.forbidden, never success', async (id) => {
    const r = await outcome(id as string, { ...base(), tenantId: A });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code, `${id}: ${r.message}`).toMatch(/^auth\.(forbidden|unauthenticated)$/);
  });
});

describe('E-6 platform_support cannot reach superadmin-only operations', () => {
  const SUPER_ONLY = PLATFORM.filter((p) => ['platform.tenant.manage', 'platform.dead_letter.manage', 'platform.staff.manage'].includes(p.permission));
  it('there are superadmin-only operations', () => { expect(SUPER_ONLY.length).toBeGreaterThan(10); });
  it.each(SUPER_ONLY.map((p) => [p.id, p.permission]))('%s (%s): platform_support aal2 -> auth.forbidden', async (id) => {
    const r = await outcome(id as string, support());
    expect(r.ok, `${id} must be refused for platform_support`).toBe(false);
    if (!r.ok) {
      expect(r.message, `${id} reached the DB before authorising`).not.toMatch(/DB touched before authorisation/);
      expect(r.code, `${id}: ${r.message}`).toBe('auth.forbidden');
    }
  });
});
