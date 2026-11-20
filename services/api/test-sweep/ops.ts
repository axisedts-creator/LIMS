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
  bodySchema?: Obj;             // T0B-SWEEP-2: request-body schema of bodyType, every $ref resolved
}

const docs = new Map<string, Obj>();
function doc(dir: string, file: string): Obj {
  const k = join(dir, file);
  if (!docs.has(k)) docs.set(k, parse(readFileSync(k, 'utf8')) as Obj);
  return docs.get(k)!;
}
/** Deep copy with every `#/a/b` / `_common.yaml#/a/b` $ref inlined (T0B-SWEEP-2). A cycle is cut to `{}` (free-form) so the result is finite. */
function resolveAll(dir: string, file: string, v: unknown, seen: string[] = []): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveAll(dir, file, x, seen));
  if (!v || typeof v !== 'object') return v;
  const o = v as Obj;
  if (typeof o.$ref === 'string') {
    const [f, ptr = ''] = (o.$ref as string).split('#');
    const target = f || file, key = `${target}#${ptr}`;
    if (seen.includes(key)) return {};
    const { $ref: _r, ...rest } = o;
    const hit = ptr.split('/').filter(Boolean).reduce<any>((x, p) => x?.[p], doc(dir, target)) ?? {};
    const resolved = resolveAll(dir, target, hit, [...seen, key]) as Obj;
    return Object.keys(rest).length ? { ...resolved, ...(resolveAll(dir, file, rest, seen) as Obj) } : resolved;
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveAll(dir, file, x, seen)]));
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
          .map((p: Obj) => resolveAll(dir, f, p) as Obj)
          .filter((p: Obj) => p && p.name)
          .map((p: Obj) => ({ name: p.name, in: p.in, required: !!p.required || p.in === 'path', schema: p.schema ?? {} }));
        const body = resolveAll(dir, f, op.requestBody) as Obj | undefined;
        const bodyType = body ? Object.keys(body.content ?? {})[0] : undefined;
        const raw = bodyType ? body!.content[bodyType]?.schema : undefined;
        out.push({
          operationId: op.operationId, method: m, path, module,
          security: (op.security ?? d.security ?? []).flatMap((s: Obj) => Object.keys(s)),
          permission: op['x-permission'], context: op['x-context'], idempotency: op['x-idempotency'],
          params, hasBody: !!body, bodyType,
          ...(raw ? { bodySchema: raw as Obj } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => a.module.localeCompare(b.module) || a.operationId.localeCompare(b.operationId));
}
