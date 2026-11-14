// RM-T05 shared contract lookups (tester-owned; not a test file). Names are NOT invented: the apply operation is found by its operationId
// `applyRolePack` (task brief); the pack-list read and the screen route are found by scanning the contracts for "role-pack(s)".
// All three are absent until CR-C2-RM-001 is accepted by C0, so the tests below fail for that reason today.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..');
const yml = (...p: string[]) => parse(readFileSync(join(ROOT, ...p), 'utf8')) as any;

export const identity = () => yml('contracts', 'openapi', 'identity.yaml');

/** path / method / operation object of the operation with this operationId, or undefined. */
export function operation(id: string): { path: string; method: string; op: any } | undefined {
  for (const [path, item] of Object.entries<any>(identity().paths ?? {}))
    for (const [method, op] of Object.entries<any>(item)) if (op?.operationId === id) return { path, method: method.toUpperCase(), op };
  return undefined;
}
/** GET operation that lists the packs with their roles (the diff source): a GET path ending in /role-packs. */
export function listPacksOp(): { path: string } | undefined {
  const p = Object.entries<any>(identity().paths ?? {}).find(([k, v]) => /\/role-packs$/.test(k) && v?.get);
  return p ? { path: p[0] } : undefined;
}
/** staff_web route of the apply screen: owner C2, path under /admin/roles/ containing "pack". */
export function packRoute(): { id: string; path: string; permission: string; rel: string } | undefined {
  const r = (yml('contracts', 'routes.yaml').routes as any[]).find((x) => x.origin === 'staff_web' && x.owner === 'C2' && /^\/admin\/roles\/[^{]*pack/i.test(String(x.path)));
  return r ? { id: r.id, path: r.path, permission: r.permission, rel: String(r.path).replace(/^\/admin\//, '') } : undefined;
}
