// C2-T29 security pack, contract side (07-SECURITY §6; reads contracts/openapi/identity.yaml, no DB). Synthetic data only.
//   E-8   every JSON request body is closed (additionalProperties:false) and carries none of the server-owned fields (tenant_id, permissions, status, aal, is_locked, ...).
//   P-7   platform-context operations are guarded by a `platform.*` permission; tenant-context operations by a non-platform one (so a tenant grant can never reach /platform/*).
//   P-1   every tenant operation that takes an object id in its path documents `common.not_found` (the cross-tenant 404).
//   AU-T21 every identity_auth operation is x-public; the pre-auth family is exactly the BFF-only §5.1 set (spec-lint half).
//   D-T7  phone pattern accepts +9779841000000, rejects 9779841000000 / +0123456789 / +1234567 (inviteUser, updateUser).
//   D-T11 DeadLetter bodies carry `version` and never `job_payload`.   D-T15 listDeadLetters rejects limit > 200 at the schema.
// Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/security
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const api: any = parse(readFileSync(join(ROOT, 'contracts/openapi/identity.yaml'), 'utf8'));
const common: any = parse(readFileSync(join(ROOT, 'contracts/openapi/_common.yaml'), 'utf8'));

interface Op { id: string; method: string; path: string; op: any }
const OPS: Op[] = [];
for (const [path, item] of Object.entries<any>(api.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) OPS.push({ id: op.operationId, method, path, op });

/** resolves local (#/components/...) and _common.yaml refs; one level at a time. */
function deref(s: any): any {
  if (!s || typeof s !== 'object' || typeof s.$ref !== 'string') return s;
  const [file, ptr] = s.$ref.split('#');
  const root = file ? common : api;
  return deref(ptr!.split('/').slice(1).reduce((n: any, k: string) => n?.[k], root));
}
/** all property names reachable in a schema (allOf/oneOf/anyOf/items/properties), with the owning object schema. */
function objects(s: any, seen = new Set<any>()): any[] {
  s = deref(s); if (!s || typeof s !== 'object' || seen.has(s)) return [];
  seen.add(s);
  const out: any[] = s.properties || s.type === 'object' ? [s] : [];
  for (const k of ['allOf', 'oneOf', 'anyOf']) for (const x of s[k] ?? []) out.push(...objects(x, seen));
  if (s.items) out.push(...objects(s.items, seen));
  for (const p of Object.values<any>(s.properties ?? {})) out.push(...objects(p, seen));
  return out;
}
const bodyOf = (op: any) => op.requestBody && deref(op.requestBody)?.content?.['application/json']?.schema;

const SERVER_OWNED = ['tenant_id', 'permissions', 'is_locked', 'aal', 'membership_id', 'actor_type', 'locked_at', 'created_by', 'version'];
// Deliberate, spec-named exceptions: a platform operation that targets a tenant carries `tenant_id`; the dead-letter list filter is a query param, not a body.
const TENANT_ID_BODY_OK = new Set(['openSupportSession', 'provisionTenant', 'setTenantFeatureFlag', 'updateTenantSettingsAsPlatform', 'createPlatformIrdAnnex', 'listDeadLetters']);

describe('E-8 request bodies are closed and carry no server-owned field', () => {
  const withBody = OPS.filter((o) => bodyOf(o.op));
  it('the contract has request bodies to check (sweep is not vacuous)', () => { expect(OPS.length).toBeGreaterThan(100); expect(withBody.length).toBeGreaterThan(30); });
  it.each(withBody.map((o) => [o.id, o]))('%s: every object in the body is additionalProperties:false', (_id, o: any) => {
    for (const obj of objects(bodyOf(o.op))) {
      if (!obj.properties) continue;   // free-form maps are not request objects
      expect(obj.additionalProperties, `${o.id}: an object schema in the request body is open`).toBe(false);
    }
  });
  it.each(withBody.map((o) => [o.id, o]))('%s: body never accepts tenant_id / permissions / aal / is_locked / membership_id (E-8)', (_id, o: any) => {
    const names = objects(bodyOf(o.op)).flatMap((x) => Object.keys(x.properties ?? {}));
    for (const f of SERVER_OWNED.filter((f) => f !== 'version')) {
      if (f === 'tenant_id' && TENANT_ID_BODY_OK.has(o.id)) continue;
      if (f === 'membership_id' && o.id === 'createAuditExport') continue;   // an actor FILTER of the export (audit rows by membership), not an identity input
      expect(names, `${o.id}: body property ${f}`).not.toContain(f);
    }
  });
  it('no tenant-context body accepts `status` except the documented state filters', () => {
    const offenders = withBody.filter((o) => o.op['x-context'] === 'tenant'
      && objects(bodyOf(o.op)).some((x) => Object.keys(x.properties ?? {}).includes('status'))).map((o) => o.id);
    expect(offenders).toEqual([]);
  });
});

describe('P-7 platform vs tenant permission namespaces', () => {
  const platform = OPS.filter((o) => o.op['x-context'] === 'platform');
  const tenant = OPS.filter((o) => o.op['x-context'] === 'tenant');
  it('34 platform and 64 tenant operations exist (every operation is classified)', () => {
    expect(platform.length).toBeGreaterThanOrEqual(30); expect(tenant.length).toBeGreaterThanOrEqual(60);
    expect(OPS.every((o) => ['platform', 'tenant', 'identity_auth'].includes(o.op['x-context']))).toBe(true);
  });
  it.each(platform.map((o) => [o.id, o]))('%s lives under /platform/ and needs a platform.* permission', (_id, o: any) => {
    expect(o.path, o.id).toMatch(/^\/v1\/identity\/platform\//);
    expect(o.op['x-permission'], `${o.id} x-permission`).toMatch(/^platform\./);
  });
  it.each(tenant.map((o) => [o.id, o]))('%s is not under /platform/ and never needs a platform.* permission', (_id, o: any) => {
    expect(o.path, o.id).not.toMatch(/^\/v1\/identity\/platform\//);
    expect(String(o.op['x-permission'] ?? ''), o.id).not.toMatch(/^platform\./);
  });
  it('every non-public tenant operation names a permission or is an own-record (/me, /own) operation', () => {
    const naked = tenant.filter((o) => !o.op['x-permission'] && !/\/(me|own)\b|\/me\//.test(o.path) && !/\/auth\//.test(o.path) && !o.op['x-public']).map((o) => `${o.method} ${o.path}`);
    expect(naked).toEqual([]);
  });
});

describe('P-1 object-id operations document the cross-tenant 404', () => {
  const byId = OPS.filter((o) => o.op['x-context'] === 'tenant' && /\{[a-z_]*_id\}/.test(o.path)
    && !/\/(me|own)\b/.test(o.path));
  it('there are id-bearing tenant operations', () => { expect(byId.length).toBeGreaterThan(15); });
  it.each(byId.map((o) => [o.id, o]))('%s lists common.not_found and a 404 response', (_id, o: any) => {
    expect(Object.keys(o.op.responses), `${o.id} responses`).toContain('404');
  });
});

describe('AU-T21 pre-auth operations (spec-lint half)', () => {
  const auth = OPS.filter((o) => o.op['x-context'] === 'identity_auth');
  it('all 15 identity_auth operations are x-public and hang under /auth/ or /mobile/', () => {
    expect(auth.length).toBe(15);
    for (const o of auth) { expect(o.op['x-public'], o.id).toBeTruthy(); expect(o.path, o.id).toMatch(/^\/v1\/identity\/(auth|mobile)\//); }
  });
  it('x-public operations are exactly the identity_auth ones (no tenant/platform operation is public)', () => {
    expect(OPS.filter((o) => o.op['x-public']).map((o) => o.id).sort()).toEqual(auth.map((o) => o.id).sort());
  });
});

describe('D-T7 phone pattern (08 A6.2)', () => {
  const pat = (name: string) => new RegExp(deref(api.components.schemas[name]).properties.phone_e164.pattern);
  for (const schema of ['UserInviteRequest', 'UserUpdateRequest']) {
    it(`${schema}: +9779841000000 accepted; 9779841000000, +0123456789, +1234567 rejected`, () => {
      const re = pat(schema);
      expect(re.test('+9779841000000')).toBe(true);
      for (const bad of ['9779841000000', '+0123456789', '+1234567', '+97798410000000000', '+977 9841000000', '+9779841000000\n']) expect(re.test(bad), bad).toBe(false);
    });
  }
});

describe('D-T11 / D-T15 dead-letter shape', () => {
  const dl = (n: string) => deref(api.components.schemas[n]);
  it('DeadLetter (row + detail) has version and no job_payload anywhere in the response schemas', () => {
    const names = Object.keys(api.components.schemas).filter((n) => /^DeadLetter/.test(n) && !/Request$/.test(n));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) for (const o of objects(dl(n))) expect(Object.keys(o.properties ?? {}), `${n}.job_payload`).not.toContain('job_payload');
    const row = names.find((n) => dl(n).properties?.version);
    expect(row, 'a DeadLetter schema with a version property').toBeTruthy();
  });
  it('listDeadLetters: limit capped at 200 and the filter params are closed to the documented eight', () => {
    const op = OPS.find((o) => o.id === 'listDeadLetters')!.op;
    const params = (op.parameters ?? []).map(deref);
    const names = params.map((p: any) => p.name);
    for (const n of ['state', 'platform_rows', 'tenant_id', 'task_identifier', 'dead_at_from', 'dead_at_to', 'cursor', 'limit']) expect(names).toContain(n);
    expect(names.length).toBe(8);
    expect(deref(params.find((p: any) => p.name === 'limit').schema).maximum).toBe(200);
  });
});
