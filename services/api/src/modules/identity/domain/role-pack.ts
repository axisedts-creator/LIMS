// Role-pack templates (spec/program/11-ROLE-MATRIX.md R3, R6; LD-141). Pure validation of the parsed data file.
// LD-141: pack contents are copied verbatim from 11-ROLE-MATRIX.data.yaml; this only rejects, it never widens or edits a role.
import type { Registry } from './permission-set.js';

export type RolePackRole = {
  readonly code: string;
  readonly name: string;
  readonly mfa_required: boolean;
  readonly base_default_role: string | null;
  readonly permissions: readonly string[];
};
export type RolePack = { readonly code: string; readonly label: string; readonly roles: readonly RolePackRole[] };
export type RolePackFile = { readonly version: 1; readonly packs: readonly RolePack[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Throws Error naming the offending code on the first violation (fail closed).
export function validateRolePacks(doc: unknown, registry: Registry, defaultRoleCodes: readonly string[]): RolePackFile {
  if (!isObj(doc)) throw new Error('role packs: document is not a mapping');
  if (doc.version !== 1) throw new Error(`role packs: unsupported version ${String(doc.version)}`);
  if (!Array.isArray(doc.packs) || doc.packs.length === 0) throw new Error('role packs: packs missing');
  const perms = new Map(registry.map((e) => [e.code, e.privileged]));
  const defaults = new Set(defaultRoleCodes);
  const seen = new Set<string>();
  for (const p of doc.packs as unknown[]) {
    if (!isObj(p) || !isStr(p.code) || !Array.isArray(p.roles)) throw new Error('role packs: malformed pack');
    for (const r of p.roles as unknown[]) {
      if (!isObj(r) || !isStr(r.code) || !isStr(r.name) || typeof r.mfa_required !== 'boolean'
        || !(r.base_default_role === null || isStr(r.base_default_role))
        || !Array.isArray(r.permissions) || !r.permissions.every(isStr)) {
        throw new Error(`role packs: malformed role ${isObj(r) ? String(r.code) : ''} in ${p.code}`);
      }
      // R6: templates are custom roles and must never collide with a default role code.
      if (defaults.has(r.code)) throw new Error(`role packs: template code ${r.code} equals a default role code (R6)`);
      if (seen.has(r.code)) throw new Error(`role packs: duplicate template code ${r.code}`);
      seen.add(r.code);
      if (r.base_default_role !== null && !defaults.has(r.base_default_role)) {
        throw new Error(`role packs: ${r.code} base_default_role ${r.base_default_role} is not a default role`);
      }
      for (const c of r.permissions as string[]) {
        if (!perms.has(c)) throw new Error(`role packs: ${r.code} permission ${c} is not in contracts/permissions.yaml`);
        // R3: any privileged permission forces MFA for the template.
        if (perms.get(c) === true && !r.mfa_required) {
          throw new Error(`role packs: ${r.code} holds privileged ${c} but mfa_required is false (R3)`);
        }
      }
    }
  }
  return doc as unknown as RolePackFile;
}
