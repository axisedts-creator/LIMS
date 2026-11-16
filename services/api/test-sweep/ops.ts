// T0B-SWEEP-1: the generated route table = every operation of contracts/openapi/<m>.yaml (core.yaml included).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const HTTP = ['get', 'put', 'post', 'delete', 'patch'] as const;
type Obj = Record<string, any>;

export interface Param { name: string; in: string; required: boolean; schema: Obj }
export interface Operation {
  operationId: string; method: string; path: string; module: string;
  security: string[];           // scheme names; [] = public
  permission?: string; context?: string; idempotency?: string;
  params: Param[]; hasBody: boolean; bodyType?: string;
}

const docs = new Map<string, Obj>();
function doc(dir: string, file: string): Obj {
  const k = join(dir, file);
  if (!docs.has(k)) docs.set(k, parse(readFileSync(k, 'utf8')) as Obj);
  return docs.get(k)!;
}
/** Resolves `#/a/b` and `_common.yaml#/a/b` refs (the only forms in contracts/openapi). */
function deref(dir: string, file: string, v: Obj | undefined): Obj | undefined {
  for (let i = 0; v && typeof v.$ref === 'string' && i < 8; i++) {
    const [f, ptr = ''] = (v.$ref as string).split('#');
    const target = f ? f : file;
    v = ptr.split('/').filter(Boolean).reduce<any>((o, p) => o?.[p], doc(dir, target));
    file = target;
  }
  return v;
}

export function loadOperations(repoRoot: string): Operation[] {
  const dir = join(repoRoot, 'contracts', 'openapi');
  const out: Operation[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml') && !x.startsWith('_')).sort()) {
    const d = doc(dir, f);
    const module = f.replace(/\.yaml$/, '');
    for (const [path, item] of Object.entries<Obj>(d.paths ?? {})) {
      for (const m of HTTP) {
        const op = item?.[m];
        if (!op?.operationId) continue;
        const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
          .map((p: Obj) => deref(dir, f, p)!)
          .filter(Boolean)
          .map((p: Obj) => ({ name: p.name, in: p.in, required: !!p.required || p.in === 'path', schema: deref(dir, f, p.schema) ?? {} }));
        const body = deref(dir, f, op.requestBody);
        out.push({
          operationId: op.operationId, method: m, path, module,
          security: (op.security ?? d.security ?? []).flatMap((s: Obj) => Object.keys(s)),
          permission: op['x-permission'], context: op['x-context'], idempotency: op['x-idempotency'],
          params, hasBody: !!body, bodyType: body ? Object.keys(body.content ?? {})[0] : undefined,
        });
      }
    }
  }
  return out.sort((a, b) => a.module.localeCompare(b.module) || a.operationId.localeCompare(b.operationId));
}
