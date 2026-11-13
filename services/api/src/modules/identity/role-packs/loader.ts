// Role-pack loader (spec/program/11-ROLE-MATRIX.md §4 item 1, R3, R6; LD-141). Reads role-packs.data.yaml (verbatim copy of
// spec/program/11-ROLE-MATRIX.data.yaml) and validates it against contracts/permissions.yaml (the registry).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { DEFAULT_REGISTRY, type Registry } from '../domain/permission-set.js';
import { validateRolePacks, type RolePackFile } from '../domain/role-pack.js';

// Default role codes (tenant, partner, platform) from contracts/permissions.yaml, read once.
const reg = parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8')) as Record<string, Array<{ code: string }> | undefined>;
const DEFAULT_ROLE_CODES = ['roles', 'partner_roles', 'platform_roles'].flatMap((k) => (reg[k] ?? []).map((r) => r.code));

export function parseRolePacks(yamlText: string, registry: Registry = DEFAULT_REGISTRY): RolePackFile {
  return validateRolePacks(parse(yamlText), registry, DEFAULT_ROLE_CODES);
}

export function loadRolePacks(): RolePackFile {
  return parseRolePacks(readFileSync(join(import.meta.dirname, 'role-packs.data.yaml'), 'utf8'));
}
