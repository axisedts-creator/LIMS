// Permission-set resolution (01-PRD AC-B2.1, AC-B2.2; 02-TRD §2, §7.4; 03-APP-FLOW §4.3; contracts/permissions.yaml). Pure.
// `registry` = the `permissions:` array of contracts/permissions.yaml; defaults to the C0 generated constants.
import {
  FIXED_ACTOR_PERMISSIONS, PERMISSION_CODES, PRIVILEGED, ROLE_GRANTS,
} from '../../../../../../contracts/ports/generated/permissions.js';

export type RegistryEntry = { readonly code: string; readonly privileged: boolean; readonly roles: readonly string[] };
export type Registry = readonly RegistryEntry[];

const grantsByCode = new Map<string, string[]>();
for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
  for (const c of codes) grantsByCode.set(c, [...(grantsByCode.get(c) ?? []), role]);
}
export const DEFAULT_REGISTRY: Registry = Object.freeze(
  PERMISSION_CODES.map((code) => Object.freeze({ code, privileged: PRIVILEGED.has(code), roles: grantsByCode.get(code) ?? [] })),
);

const find = (code: unknown, registry: Registry): RegistryEntry | undefined =>
  typeof code === 'string' ? registry.find((e) => e.code === code) : undefined;

// Assignable to a tenant role: exists, not platform.*, not actor-only (roles: []).
export function isAssignable(code: string, registry: Registry = DEFAULT_REGISTRY): boolean {
  const e = find(code, registry);
  return e !== undefined && !e.code.startsWith('platform.') && e.roles.length > 0;
}

export type RolePermissionsResult =
  | { ok: true; mfaRequired: boolean }
  | { ok: false; errors: Array<{ pointer: string; code: 'common.field_invalid' }> };

// AC-B2.2: every non-assignable entry reported at /permissions/<i>. AC-B2.1: mfa = submitted OR any privileged code.
export function validateRolePermissions(
  codes: readonly string[], submittedMfaRequired: boolean, registry: Registry = DEFAULT_REGISTRY,
): RolePermissionsResult {
  const errors: Array<{ pointer: string; code: 'common.field_invalid' }> = [];
  let privileged = false;
  codes.forEach((c, i) => {
    if (!isAssignable(c, registry)) errors.push({ pointer: `/permissions/${i}`, code: 'common.field_invalid' });
    else if (find(c, registry)!.privileged) privileged = true;
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, mfaRequired: submittedMfaRequired === true || privileged };
}

// Union of codes whose registry `roles` include any given role; sorted, de-duplicated.
export function permissionsOfRoles(roleCodes: readonly string[], registry: Registry = DEFAULT_REGISTRY): string[] {
  const roles = new Set(roleCodes);
  return [...new Set(registry.filter((e) => e.roles.some((r) => roles.has(r))).map((e) => e.code))].sort();
}

// 02-TRD §7.4 [DECISION]. Unknown scope -> [] (fail closed).
const SUPPORT_READ_ONLY = ['identity.user.read', 'identity.centre.read', 'audit.log.read'] as const;
const SUPPORT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read_only: SUPPORT_READ_ONLY,
  admin: [...SUPPORT_READ_ONLY, 'identity.user.manage', 'identity.role.manage', 'identity.centre.manage',
    'identity.settings.manage', 'identity.session.revoke'],
});

export function supportPermissions(scope: 'read_only' | 'admin'): string[] {
  return Object.hasOwn(SUPPORT, scope) ? [...SUPPORT[scope]!].sort() : [];
}

export type FixedActor = 'device' | 'portal' | 'patient' | 'patient_pre_auth' | 'partner';
const DEFAULT_VARIANT: Readonly<Record<string, string>> = { device: 'bridge_agent' }; // absent device_kind = bridge_agent

// Fixed actor sets (contracts/permissions.yaml fixed_actor_permissions). Unknown actor/variant -> [] (fail closed).
export function fixedActorPermissions(actor: FixedActor, variant?: string): string[] {
  const sets = FIXED_ACTOR_PERMISSIONS as Readonly<Record<string, readonly string[] | Readonly<Record<string, readonly string[]>>>>;
  const v = Object.hasOwn(sets, actor) ? sets[actor] : undefined;
  if (v === undefined) return [];
  if (Array.isArray(v)) return variant === undefined ? [...v].sort() : [];
  const group = v as Readonly<Record<string, readonly string[]>>;
  const key = variant ?? DEFAULT_VARIANT[actor];
  return key !== undefined && Object.hasOwn(group, key) ? [...group[key]!].sort() : [];
}
