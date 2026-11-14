// C9 T-25 — S-03 / AB-05 (07-SECURITY §5; REQ-SEC-013/067/080): bodies carrying tenant_id, created_by, status, outcome, version (or any unknown field) never reach the database.
// (a) contract: every request body schema of quality.yaml is closed (`additionalProperties: false`, recursively) and declares none of the server-owned fields;
// (b) behaviour: the REAL handler of every write operation with a body, given the minimal valid body PLUS a server-owned field, never lets the planted value into a SQL parameter or the answer
//     (core's schema check answers 400 common.validation_failed first in production; the handler/service layer is the second line and must not read the field either).
// No database. Fails now if a schema is open, declares a server-owned field, or a service copies an unknown body field into SQL.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OPS, SPEC, fire, loadManifest, makeHarness, minimalBody, requestFor, seen, TENANT_B, type OpInfo } from './kit.js';

const SERVER_OWNED = ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'status', 'outcome', 'version', 'id', 'rules_violated', 'activated_by', 'excluded_by'];
const ALL = ['quality.autoverify.manage', 'quality.autoverify.read', 'quality.config.manage', 'quality.qc.manage', 'quality.qc_run.read', 'quality.qc_run.review', 'quality.tat_alert.ack', 'quality.tat_alert.read'];
const deref = (s: any): any => { let c = s; for (let i = 0; i < 20 && c?.$ref; i++) c = String(c.$ref).replace(/^#\//, '').split('/').reduce((n: any, k: string) => n?.[k], SPEC); return c; };
const bodySchema = (o: OpInfo) => o.operation.requestBody?.content?.['application/json']?.schema;

/** every object schema reachable from `root` with the JSON pointer it was found at (cycles cut by depth). */
function objects(root: any, at = '#', depth = 0, out: Array<{ at: string; s: any }> = []): Array<{ at: string; s: any }> {
  const s = deref(root);
  if (!s || depth > 12 || typeof s !== 'object') return out;
  if (s.type === 'object' || s.properties) out.push({ at, s });
  for (const [k, v] of Object.entries<any>(s.properties ?? {})) objects(v, `${at}/${k}`, depth + 1, out);
  if (s.items) objects(s.items, `${at}/[]`, depth + 1, out);
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) (s[k] ?? []).forEach((x: any, i: number) => objects(x, `${at}/${k}${i}`, depth + 1, out));
  return out;
}
const WITH_BODY = OPS.filter((o) => o.hasBody);

describe('S-03 (a) request body schemas are closed and declare no server-owned field', () => {
  it('there are request bodies to check', () => expect(WITH_BODY.length).toBeGreaterThanOrEqual(25));
  it.each(WITH_BODY.map((o) => [o.id, o] as const))('%s', (_id, op) => {
    const open: string[] = [], owned: string[] = [];
    for (const { at, s } of objects(bodySchema(op))) {
      const free = s.properties === undefined && s.additionalProperties !== false;   // a free-form map is a hole unless the spec says otherwise
      if (s.additionalProperties !== false && !free) open.push(at);
      if (free) open.push(`${at} (free-form)`);
      for (const k of Object.keys(s.properties ?? {})) if (SERVER_OWNED.includes(k) && at === '#') owned.push(k);
    }
    expect(open, `${op.id}: object schemas without additionalProperties: false`).toEqual([]);
    expect(owned, `${op.id}: server-owned fields declared in the body`).toEqual([]);
  });
});

describe('S-03 (b) the handler layer never uses a server-owned body field', () => {
  let handlers: Record<string, (...a: any[]) => Promise<any>>;
  beforeAll(async () => { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); handlers = (await loadManifest()).handlers; });
  const FIELDS = { tenant_id: TENANT_B, created_by: TENANT_B, status: 'active', outcome: 'accepted', version: 987654321 };
  it.each(WITH_BODY.map((o) => [o.id, o] as const))('%s', async (_id, op) => {
    const h = makeHarness({ permissions: ALL, aal: 'aal2' }, op.id);
    const body = { ...(minimalBody(op) as object), ...FIELDS };
    const out = await fire(handlers[op.id]!, requestFor(op, { body }), h.ctx);
    const sql = JSON.stringify(h.queries.map((q) => q.values));
    expect(sql, 'tenant_id from the body reached a SQL parameter').not.toContain(TENANT_B);
    expect(sql, 'a body value reached a SQL parameter').not.toContain('"accepted"');
    expect(sql).not.toContain('987654321');
    expect(out.error ? seen(out.error) : JSON.stringify(out.reply?.body)).not.toContain(TENANT_B);
    if (out.reply) expect(out.reply.status, 'an unknown/server-owned field must not produce a success').toBeGreaterThanOrEqual(400);
  });
});
