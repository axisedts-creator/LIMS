// SESSION-ACTOR-1 (LD-208): the 200 bodies of loginStaff, loginPartner, openMobileSession and resolveSession, produced by the REAL services over fake repos, validate against the
// response schemas of contracts/openapi/identity.yaml (SessionState.actor is required, additionalProperties false) with the SAME ajv options as core/openapi.ts RESPONSE_AJV_OPTIONS
// = { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false } (RESPONSE_AJV_OPTIONS itself is module-private; AJV_OPTIONS is the exported base). Strict mode stays ON; the only extra
// keyword is the root `components` holder that the same-file $refs point at.
// Expected now: every body test fails with `required: actor` - the exact response_contract_violation seen live on staging (loginStaff 200, '/session required' ).
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { AJV_OPTIONS } from '../../../core/openapi.js';
import { createAuthService } from '../service/auth.service.js';
import { createLoginPartner } from '../handlers/loginPartner.js';
import { createOpenMobileSession } from '../handlers/openMobileSession.js';
import { createResolveSession } from '../handlers/resolveSession.js';
import { EMAIL, PASSWORD, SUB, platformRow, tenantRow } from '../service/__tests__/auth.helpers.js';
import { loginRunner, makeWorld, partnerRow, staffRow } from '../handlers/__tests__/kinds.helpers.js';
import { makeSessionWorld } from '../handlers/__tests__/session.helpers.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => ((v: unknown) => boolean) & { errors?: any[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false, keywords: [...AJV_OPTIONS.keywords, 'components'] } });
function responseSchema(operationId: string, status = '200'): object {
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'put', 'post', 'delete', 'patch']) {
    if (item?.[m]?.operationId === operationId) {
      const s = item[m].responses?.[status]?.content?.['application/json']?.schema; if (!s) throw new Error(`${operationId} has no ${status} json schema`);
      return { components: spec.components, ...s };
    }
  }
  throw new Error(`no operation ${operationId}`);
}
/** [] when valid, else the ajv errors (dataPath + keyword + params) */
function violations(operationId: string, body: unknown): any[] {
  const v = compile({ schema: responseSchema(operationId) }); return v(body) ? [] : [...(v.errors ?? [])];
}
const GOOD = { email: EMAIL, password: PASSWORD };
const loginStaff = (w: ReturnType<typeof makeWorld>) => createAuthService(w.deps as any).loginStaff(w.makeCtx().ctx, GOOD as any) as Promise<any>;

describe('the validator is the real one (guards against a vacuous pass)', () => {
  const session = { session_id: '0190a000-0000-7000-8000-000000000001', kind: 'platform', state: 'mfa_enrolment_required', aal: 'aal1', idle_expires_at: '2026-11-15T07:00:00.000Z', absolute_expires_at: '2026-11-15T15:00:00.000Z' };
  const body = (s: object) => ({ session_token: 'A'.repeat(43), session: s });
  it('the pre-fix body (no actor) is the staging violation: required actor', () => {
    const v = violations('loginStaff', body(session));
    expect(v.some((e) => e.keyword === 'required' && e.params?.missingProperty === 'actor')).toBe(true);
  });
  it('a complete actor is valid; display_name "" , a 21-role list, a bad tenant_code and an extra key (email) are each invalid', () => {
    const ok = { display_name: 'Sam Staff', roles: ['platform_support'] };
    expect(violations('loginStaff', body({ ...session, actor: ok }))).toEqual([]);
    expect(violations('loginStaff', body({ ...session, actor: { ...ok, tenant_code: 'lab_a' } }))).toEqual([]);
    expect(violations('loginStaff', body({ ...session, actor: { ...ok, display_name: '' } })).length).toBeGreaterThan(0);
    expect(violations('loginStaff', body({ ...session, actor: { ...ok, roles: Array.from({ length: 21 }, (_, i) => `r${i}`) } })).length).toBeGreaterThan(0);
    expect(violations('loginStaff', body({ ...session, actor: { ...ok, tenant_code: 'Lab-A' } })).length).toBeGreaterThan(0);
    expect(violations('loginStaff', body({ ...session, actor: { ...ok, email: 'a@example.test' } })).length).toBeGreaterThan(0);
  });
});

describe('200 bodies of the real services validate against the contract', () => {
  it('loginStaff, platform session (the staging login): valid', async () => {
    const w = makeWorld({ rows: { [SUB]: platformRow() } }); const r = await loginStaff(w);
    expect(r.status).toBe(200); expect(violations('loginStaff', r.body)).toEqual([]);
    expect(r.body.session.actor.roles.length).toBeGreaterThan(0);
  });
  it('loginStaff, tenant session (active and mfa_pending): valid, with tenant_code', async () => {
    for (const row of [tenantRow(), tenantRow({ mfa_required: true, has_verified_factor: true })]) {
      const w = makeWorld({ rows: { [SUB]: row } }); const r = await loginStaff(w);
      expect(violations('loginStaff', r.body)).toEqual([]); expect(r.body.session.actor.tenant_code).toBe('lab_a');
    }
  });
  it('loginPartner: valid', async () => {
    const w = makeWorld({ rows: { [SUB]: partnerRow() } }); const r = loginRunner(w, 'partner');
    const out: any = await createLoginPartner(w.deps as any)(r.req(GOOD) as any, r.hctx);
    expect(out.status).toBe(200); expect(violations('loginPartner', out.body)).toEqual([]);
  });
  it('openMobileSession (staff form): valid', async () => {
    const w = makeWorld({ rows: { [SUB]: staffRow() } }); const r = loginRunner(w, undefined);
    const deps = { ...w.deps, now: () => new Date(w.clock.ms), repo: { ...w.deps.repo, async membershipHasPermission() { return true; } } };
    const out: any = await createOpenMobileSession(deps as any)(r.req({ ...GOOD, app_instance_id: '0190a000-0000-7000-8000-000000007001', app_platform: 'android' }) as any, r.hctx);
    expect(out.status).toBe(200); expect(violations('openMobileSession', out.body)).toEqual([]);
  });
  it('resolveSession: tenant_staff and platform sessions: valid', async () => {
    const w = await makeSessionWorld();
    for (const kind of ['tenant_staff', 'platform'] as const) {
      const { token } = w.addSession({ kind }); const { hctx } = w.makeHctx();
      const out: any = await createResolveSession(w.deps as any)(w.req({ token, body: { touch: false } }) as any, hctx);
      expect(out.status).toBe(200); expect(violations('resolveSession', out.body)).toEqual([]);
      expect(out.body.session.actor.display_name.length).toBeGreaterThan(0);
    }
  });
});
