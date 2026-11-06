// 02-CONVENTIONS §1.3: no import from another module's folder (01 §4, REQ-ARCH-076).
import { posix } from 'node:path';
import { imports, normPath, type Violation } from './_scan.ts';

export const name = 'no-cross-module-import';
const ROOTS = ['services/api/src/modules', 'apps/web/src/features'];

export function check(path: string, source: string): Violation[] {
  const p = normPath(path);
  const root = ROOTS.find((r) => p.startsWith(r + '/'));
  if (!root) return [];
  const own = p.slice(root.length + 1).split('/')[0];
  return imports(source).flatMap(({ spec, line }) => {
    if (!spec.startsWith('.')) return [];
    const target = posix.normalize(posix.join(posix.dirname(p), spec));
    if (!target.startsWith(root + '/')) return [];
    const mod = target.slice(root.length + 1).split('/')[0];
    return mod === own ? [] : [{ rule: name, line, message: `'${own}' must not import from module '${mod}' (${spec}); go through its public port` }];
  });
}
