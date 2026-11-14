// T-SEC1 shared helpers for the probe suite (NOT a test file): contract-derived operation inventory + actor classes, source file walker.
// Spec: 07-SECURITY §5, §6.1, §6.5; 02-TRD §5; contracts/openapi/engagement.yaml (x-permission + security); contracts/permissions.yaml (fixed_actor_permissions).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

export const SPEC: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
export const PERMS: any = loadSpec(join(REPO_ROOT, 'contracts/permissions.yaml'));
export const ENGAGEMENT_DIR = join(REPO_ROOT, 'services/api/src/modules/engagement');
export const PATIENT_APP_DIR = join(REPO_ROOT, 'apps/patient_app');

export type ActorClass = 'preauth' | 'display' | 'patient' | 'staff';
export interface Op { id: string; method: string; path: string; permission: string; security: string[]; actor: ActorClass; pathParams: string[]; errors: string[]; privileged: boolean; op: any }

const FIXED = PERMS.fixed_actor_permissions as Record<string, any>;
export const PATIENT_PERMISSIONS: string[] = FIXED['patient'];
export const PREAUTH_PERMISSIONS: string[] = FIXED['patient_pre_auth'];
export const DISPLAY_PERMISSIONS: string[] = FIXED['device']['queue_display'];
const PERM_ROWS = new Map<string, any>((PERMS.permissions as any[]).map((p) => [p.code, p]));
export const permissionRow = (code: string): any => PERM_ROWS.get(code);

export function operations(): Op[] {
  const out: Op[] = [];
  for (const [path, item] of Object.entries<any>(SPEC.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!op?.operationId) continue;
      const security = (op.security ?? []).flatMap((s: object) => Object.keys(s));
      const permission: string = op['x-permission'];
      const actor: ActorClass = security.includes('patientPreAuth') ? 'preauth' : security.includes('queueDisplayToken') ? 'display' : /^\/v1\/engagement\/me(\/|$)/.test(path) ? 'patient' : 'staff'; // permission alone is ambiguous: engagement.booking.cancel is a patient AND a front_desk permission
      out.push({ id: op.operationId, method, path, permission, security, actor, pathParams: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!), errors: op['x-error-codes'] ?? [], privileged: permissionRow(permission)?.privileged === true, op });
    }
  }
  return out;
}

/** Non-test .ts files under the engagement module (source under probe). */
export function sourceFiles(dir = ENGAGEMENT_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') out.push(...sourceFiles(p)); } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}
export const read = (p: string): string => readFileSync(p, 'utf8');

/** Files under a directory (any extension), skipping build output and tool caches. */
export function walk(dir: string, skip = new Set(['build', '.dart_tool', '.gradle', 'node_modules', '.git', '.idea'])): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, skip)); else out.push(p);
  }
  return out;
}
