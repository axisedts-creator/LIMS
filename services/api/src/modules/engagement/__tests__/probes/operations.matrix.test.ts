// C16.T-SEC1 — operation probe matrix (07-SECURITY §6.1 coverage, §6.5 actor confusion / privilege escalation, §5 AB-6 / AB-7 / AB-8 / AB-14; 06-PLAN row T-SEC1 "every operation ... covered").
// Contract-derived, so a NEW operation or permission cannot ship without landing in a row here: every operationId of contracts/openapi/engagement.yaml is classified (pre-auth / display / patient / staff) and checked.
// What this proves: the authorization surface DECLARED for each of the 98 operations (security scheme + x-permission + declared errors + closed request/response shapes) cannot let a patient token reach a staff operation,
// a staff / display / pre-auth credential reach a /me operation, or a body/response carry tenant / account / patient identifiers. Enforcement at run time is core's permission engine (fixed_actor_permissions) + RLS;
// handler-level 404 probes live with each task's tests (orders P-L1, reports, mybookings, ...) and the SQL binding scan in sql.tenant-binding.test.ts.
// NOT covered here (needs a live stack): real tokens through the HTTP dispatcher; see .orchestra/notes/T-SEC1-tests.md.
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { DISPLAY_PERMISSIONS, PATIENT_PERMISSIONS, PERMS, PREAUTH_PERMISSIONS, SPEC, operations, permissionRow, type Op } from './support.js';

const OPS = operations();
const by = (a: Op['actor']) => OPS.filter((o) => o.actor === a);
const PATIENT_PRIVATE_IDS = ['tenant_id', 'account_id', 'patient_id', 'membership_id', 'user_id'];

/** Resolve local $refs (loadSpec bundles cross-file refs into #/components/...). */
function deref(x: any, seen = new Set<string>()): any {
  if (!x || typeof x !== 'object' || typeof x.$ref !== 'string') return x;
  if (seen.has(x.$ref)) return {};
  seen.add(x.$ref);
  const node = x.$ref.replace(/^#\//, '').split('/').reduce((n: any, k: string) => n?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], SPEC);
  return deref(node, seen);
}
/** Every property name reachable from a schema (allOf/oneOf/anyOf/items/properties/additionalProperties), cycle-safe. */
function propertyNames(schema: any, seen = new Set<any>()): string[] {
  const s = deref(schema);
  if (!s || typeof s !== 'object' || seen.has(s)) return [];
  seen.add(s);
  const out: string[] = [];
  for (const [k, v] of Object.entries<any>(s.properties ?? {})) out.push(k, ...propertyNames(v, seen));
  for (const k of ['allOf', 'oneOf', 'anyOf']) for (const v of s[k] ?? []) out.push(...propertyNames(v, seen));
  if (s.items) out.push(...propertyNames(s.items, seen));
  if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push(...propertyNames(s.additionalProperties, seen));
  return out;
}
const bodySchema = (o: Op) => deref(o.op.requestBody?.content?.['application/json']?.schema);
const okSchemas = (o: Op) => Object.entries<any>(o.op.responses ?? {}).filter(([c]) => /^2/.test(c)).flatMap(([, r]) => Object.values<any>(deref(r).content ?? {}).map((c) => c.schema)).filter(Boolean);
const paramNames = (o: Op) => (o.op.parameters ?? []).map((p: any) => deref(p).name as string);

describe('inventory (07-SECURITY §6.1: every operationId in TRD §5)', () => {
  it('98 operations, unique ids, every one carries a security scheme and an x-permission that exists in permissions.yaml', () => {
    expect(OPS).toHaveLength(98);
    expect(new Set(OPS.map((o) => o.id)).size).toBe(98);
    for (const o of OPS) {
      expect(o.security.length, `${o.id} security`).toBeGreaterThan(0);
      expect(permissionRow(o.permission), `${o.id} -> ${o.permission} must be a row of contracts/permissions.yaml`).toBeDefined();
    }
  });

  it('the manifest handles exactly these operations and none is still the T-01 placeholder (a 503 stub is "covered" by nothing)', async () => {
    expect(Object.keys(manifest.handlers).sort()).toEqual(OPS.map((o) => o.id).sort());
    const stillStubbed: string[] = [];
    for (const o of OPS) {
      try { await (handlers as any)[o.id]({ params: {}, query: {}, headers: {}, body: {} }, {}); } catch (e: any) { if (e?.code === 'common.service_unavailable') stillStubbed.push(o.id); }
    }
    expect(stillStubbed).toEqual([]);
  });

  it('actor classes: 3 pre-auth, 1 display, the rest split by the /me prefix (patient) vs staff', () => {
    expect(by('preauth').map((o) => o.id).sort()).toEqual(['getPatientAppConfig', 'requestPatientOtp', 'verifyPatientOtp']);
    expect(by('display').map((o) => o.id)).toEqual(['getQueueBoard']);
    expect(by('patient').length + by('staff').length).toBe(94);
    expect(by('patient').length).toBeGreaterThanOrEqual(35);
    expect(by('staff').length).toBeGreaterThanOrEqual(45);
  });
});

describe('actor confusion / privilege escalation (07-SECURITY §6.5, AB-8, AB-14)', () => {
  it('pre-auth credential: only engagement.auth.challenge, and only the three pre-auth operations use it (AB-14: t.<code> against /me/* -> 403)', () => {
    expect(PREAUTH_PERMISSIONS).toEqual(['engagement.auth.challenge']);
    expect(OPS.filter((o) => o.permission === 'engagement.auth.challenge').map((o) => o.id).sort()).toEqual(by('preauth').map((o) => o.id).sort());
    for (const o of OPS.filter((x) => x.actor !== 'preauth')) expect(PREAUTH_PERMISSIONS, `${o.id} must not be reachable with the pre-auth permission set`).not.toContain(o.permission);
  });

  it('display token: only engagement.queue.board_read and only getQueueBoard (AB-8: replay against listQueueTokens / patient endpoints -> 403)', () => {
    expect(DISPLAY_PERMISSIONS).toEqual(['engagement.queue.board_read']);
    for (const o of OPS.filter((x) => x.actor !== 'display')) expect(DISPLAY_PERMISSIONS, `${o.id} must not accept the display permission set`).not.toContain(o.permission);
    expect(by('display')[0]!.security).toEqual(['queueDisplayToken']);
  });

  it('staff token on every patient operation -> 403: no patient operation is satisfiable by a tenant-role permission, except the declared dual engagement.booking.cancel', () => {
    const grantedToRoles = (code: string) => ((permissionRow(code)?.roles as string[]) ?? []).length > 0;
    for (const o of by('patient')) {
      expect(PATIENT_PERMISSIONS, `${o.id}: patient operations must use a permission of the fixed patient set`).toContain(o.permission);
      if (grantedToRoles(o.permission)) expect(o.permission, `${o.id}: patient permission is also granted to a tenant role`).toBe('engagement.booking.cancel');
    }
    // the dual permission is safe only because the staff op lives on a different path with its own actor class; pin both sides
    expect(OPS.filter((o) => o.permission === 'engagement.booking.cancel').map((o) => `${o.actor}:${o.id}`).sort()).toEqual(['patient:cancelMyBooking', 'staff:cancelBooking']);
  });

  it('patient token on every staff operation -> 403: no staff operation uses a permission that is only in the patient / pre-auth / display sets', () => {
    const patientOnly = PATIENT_PERMISSIONS.filter((c) => !((permissionRow(c)?.roles as string[]) ?? []).length);
    for (const o of by('staff')) expect(patientOnly, `${o.id} (${o.permission}) is staff-facing but needs a permission no tenant role can hold`).not.toContain(o.permission);
    for (const o of by('staff')) expect(o.permission.startsWith('reporting.portal.'), `${o.id}`).toBe(false);
  });

  it('CI rule: a patient-only permission can never be granted to a tenant role (permissions.yaml)', () => {
    const fixed = new Set([...PATIENT_PERMISSIONS, ...PREAUTH_PERMISSIONS, ...DISPLAY_PERMISSIONS]);
    const dual = (PERMS.permissions as any[]).filter((p) => fixed.has(p.code) && (p.roles ?? []).length > 0).map((p) => p.code);
    expect(dual).toEqual(['engagement.booking.cancel']); // the only deliberate overlap (front_desk cancels for a patient); anything new needs a CR
    for (const code of [...PREAUTH_PERMISSIONS, ...DISPLAY_PERMISSIONS]) expect(permissionRow(code).roles, code).toEqual([]);
  });

  it('partner / portal claims on any engagement operation -> 403: no engagement operation uses a partners.* / portal-only permission', () => {
    const portalOnly = ['reporting.portal.challenge'];
    for (const o of OPS) {
      expect(o.permission.startsWith('partners.'), o.id).toBe(false);
      expect(portalOnly, o.id).not.toContain(o.permission);
    }
    // reporting.portal.view/download are shared by portal AND patient actors; they may only back the three /me report operations
    expect(OPS.filter((o) => o.permission.startsWith('reporting.portal.')).map((o) => o.id).sort()).toEqual(['downloadMyReport', 'getMySmartSummary', 'listMyReports']);
  });

  it('privileged operations demand MFA: updateEngagementSettings and the membership plan writes declare auth.mfa_required; nothing else does', () => {
    const must = ['updateEngagementSettings', 'createMembershipPlan', 'updateMembershipPlan'];
    for (const id of must) { const o = OPS.find((x) => x.id === id)!; expect(o.privileged, `${id} permission must be privileged`).toBe(true); expect(o.errors, id).toContain('auth.mfa_required'); }
    for (const o of OPS) expect(o.errors.includes('auth.mfa_required'), `${o.id}: mfa_required iff the permission is privileged`).toBe(o.privileged);
  });

  it('front_desk loses engagement.link.issue -> 403: issueLinkCode is gated by exactly that permission (role removal flips it)', () => {
    expect(OPS.find((o) => o.id === 'issueLinkCode')!.permission).toBe('engagement.link.issue');
    expect(permissionRow('engagement.link.issue').roles).toEqual(expect.arrayContaining(['front_desk']));
    expect(OPS.filter((o) => o.permission === 'engagement.link.issue')).toHaveLength(1);
  });

  it('every operation declares auth.forbidden + auth.unauthenticated; patient + pre-auth operations declare the 426 app-version guard, staff and display operations do not', () => {
    for (const o of OPS) { expect(o.errors, o.id).toEqual(expect.arrayContaining(['auth.forbidden', 'auth.unauthenticated', 'common.validation_failed'])); }
    for (const o of [...by('patient'), ...by('preauth')]) expect(o.errors, o.id).toContain('engagement.app_version_unsupported');
    for (const o of [...by('staff'), ...by('display')]) expect(o.errors, o.id).not.toContain('engagement.app_version_unsupported');
  });
});

describe('cross-tenant / cross-account shape probes (07-SECURITY §6.1, AB-6, AB-7)', () => {
  it('every operation with a path parameter declares common.not_found (the cross-tenant / foreign-id answer is 404, never 403 or 200)', () => {
    const withIds = OPS.filter((o) => o.pathParams.length > 0);
    expect(withIds.length).toBeGreaterThanOrEqual(40);
    for (const o of withIds) expect(o.errors, `${o.id} {${o.pathParams.join(',')}}`).toContain('common.not_found');
  });

  it('no operation accepts a tenant selector from the caller: no tenant_id / tenant parameter or body property anywhere (tenant comes from the credential only)', () => {
    for (const o of OPS) {
      expect(paramNames(o).filter((n: string) => /^(tenant|tenant_id)$/i.test(n)), `${o.id} params`).toEqual([]);
      const b = bodySchema(o);
      if (b) expect(propertyNames(b).filter((n) => /^tenant(_id)?$/.test(n)), `${o.id} body`).toEqual([]);
    }
  });

  it('pre-auth operations select the tenant by tenant_code only (08 A19 D-121), never by id', () => {
    for (const o of by('preauth')) expect(paramNames(o).some((n: string) => /tenant_code/i.test(n)) || o.security.includes('patientPreAuth'), o.id).toBe(true);
  });

  it('patient request bodies are closed objects and cannot name an account / patient / membership (AB-7: patient_id in a booking body -> 400 unknown field)', () => {
    for (const o of by('patient')) {
      const b = bodySchema(o);
      if (!b) continue;
      expect(b.additionalProperties, `${o.id} body must set additionalProperties: false`).toBe(false);
      expect(propertyNames(b).filter((n) => PATIENT_PRIVATE_IDS.includes(n)), `${o.id} body names an internal id`).toEqual([]);
    }
    for (const o of by('patient')) expect(paramNames(o).filter((n: string) => PATIENT_PRIVATE_IDS.includes(n)), `${o.id} query/path names an internal id`).toEqual([]);
  });

  it('patient responses never expose tenant_id / account_id / patient_id / user_id (profile_id = link id is the only handle; membership_id there is the patient_memberships row id, not core.memberships)', () => {
    for (const o of by('patient')) for (const s of okSchemas(o)) expect(propertyNames(s).filter((n) => PATIENT_PRIVATE_IDS.includes(n) && n !== 'membership_id'), `${o.id} response`).toEqual([]);
  });

  it('staff request bodies are closed objects too (mass-assignment: unknown fields -> 400)', () => {
    for (const o of by('staff')) { const b = bodySchema(o); if (b && b.type === 'object') expect(b.additionalProperties, `${o.id} body`).toBe(false); }
  });
});
