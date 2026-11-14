// C10 T-25 — security probes that need no database (07-SECURITY §5: S-05, S-10, S-16, S-21, S-22, S-23, S-24, S-25; REQ-SEC-080/081/099/100/098).
// Reads contracts/openapi/micro.yaml (the HTTP contract) and drives the permission-first handlers (M23–M28, M39–M49 breakpoint/config, M19 list) with a tx that
// FAILS if touched, so "denied before any SQL" is proven. Synthetic data only.
// SEAMS (as helpers/cultureReads.ts): ctx.ports.IdentityPort.assertRole is a hand fake; privileged ops (micro.breakpoint.manage) are aal2-aware inside assertRole.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { mkCtx, run, specOps, spec, READ, WORK, MANAGE, type Row } from '../../handlers/__tests__/helpers/cultureReads.js';

const BREAKPOINT = 'micro.breakpoint.manage';
const PERMS = new Set([READ, WORK, MANAGE, BREAKPOINT]);
const ops = specOps();
const opEntries = Object.entries(ops);
const UUID = '0190c60c-0000-7000-8000-00000000f001';
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';

// ---- schema helpers: resolve $ref / allOf of request bodies in the spec
const deref = (s: any): any => {
  if (s && typeof s === 'object' && typeof s.$ref === 'string') {
    const name = s.$ref.replace('#/components/schemas/', '');
    const t = spec.components?.schemas?.[name];
    if (!t) throw new Error(`unresolved ${s.$ref}`);
    return deref(t);
  }
  return s;
};
const jsonBody = (op: any) => op.requestBody?.content?.['application/json']?.schema;
/** every object schema reachable from `s` (properties / items / allOf / oneOf / anyOf), with a path for messages */
function* objectSchemas(s: any, path: string, seen = new Set<any>()): Generator<[string, any]> {
  const d = deref(s);
  if (!d || typeof d !== 'object' || seen.has(d)) return;
  seen.add(d);
  if (d.type === 'object' || d.properties) yield [path, d];
  for (const [k, v] of Object.entries<any>(d.properties ?? {})) yield* objectSchemas(v, `${path}.${k}`, seen);
  if (d.items) yield* objectSchemas(d.items, `${path}[]`, seen);
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) for (const [i, x] of (d[k] ?? []).entries()) yield* objectSchemas(x, `${path}.${k}${i}`, seen);
}
function* stringSchemas(s: any, path: string, seen = new Set<any>()): Generator<[string, any]> {
  const d = deref(s);
  if (!d || typeof d !== 'object' || seen.has(d)) return;
  seen.add(d);
  if (d.type === 'string') yield [path, d];
  for (const [k, v] of Object.entries<any>(d.properties ?? {})) yield* stringSchemas(v, `${path}.${k}`, seen);
  if (d.items) yield* stringSchemas(d.items, `${path}[]`, seen);
  if (d.additionalProperties && typeof d.additionalProperties === 'object') yield* stringSchemas(d.additionalProperties, `${path}.*`, seen);
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) for (const [i, x] of (d[k] ?? []).entries()) yield* stringSchemas(x, `${path}.${k}${i}`, seen);
}

describe('S-16 / REQ-SEC-099 operation list (contract)', () => {
  it('has 49 operations M1–M49 and every handler key is a spec operation and vice versa', async () => {
    const { handlers } = await import('../../handlers/index.js');
    const names = opEntries.map(([n]) => n).sort();
    expect(names.length).toBeGreaterThanOrEqual(45);   // M1–M49 minus ops that are consumers/jobs (M18, M50 ... are not HTTP)
    expect(Object.keys(handlers).sort()).toEqual(names);
  });

  it('every operation has an x-permission from the C10 set and none is x-public', () => {
    for (const [name, op] of opEntries) {
      expect(PERMS.has(op['x-permission']), `${name}: x-permission ${String(op['x-permission'])}`).toBe(true);
      expect(op['x-public'], `${name} must not be public`).toBeFalsy();
    }
  });

  it('S-16: no operation creates an instrument record (records arrive only from C7 events)', () => {
    const recordOps = Object.entries<any>(spec.paths).filter(([p]) => p.startsWith('/v1/micro/instrument-records'));
    const allowed = new Set(['listMicroInstrumentRecords', 'assignMicroInstrumentRecord', 'applyMicroInstrumentRecord', 'ignoreMicroInstrumentRecord']);
    const found: string[] = [];
    for (const [path, item] of recordOps) for (const [verb, op] of Object.entries<any>(item)) if (op?.operationId) {
      found.push(op.operationId);
      if (verb === 'post' && path === '/v1/micro/instrument-records') throw new Error(`POST ${path} would create a record over HTTP`);
    }
    expect(found.sort()).toEqual([...allowed].sort());
    for (const [name] of opEntries) expect(name, 'no create/ingest/import of instrument records').not.toMatch(/(create|ingest|import|upload)\w*InstrumentRecord/i);
  });

  it('S-22 / S-23 / S-10: permission per operation family', () => {
    expect(ops['listMicroInstrumentRecords']['x-permission']).toBe(READ);
    for (const n of ['upsertMicroCode', 'createPlatingProtocol', 'versionPlatingProtocol', 'deactivatePlatingProtocol', 'createAstPanel', 'versionAstPanel', 'deactivateAstPanel',
      'createInstrumentVocabMap', 'updateInstrumentVocabMap', 'deactivateInstrumentVocabMap', 'putInstrumentAstDefault', 'updateMicroSettings']) expect(ops[n]['x-permission'], n).toBe(MANAGE);
    for (const n of ['createBreakpointImport', 'listBreakpointImportIssues', 'listBreakpointRows', 'activateBreakpointSet', 'retireBreakpointSet', 'discardBreakpointSet', 'downloadBreakpointTemplate'])
      expect(ops[n]['x-permission'], n).toBe(BREAKPOINT);
  });
});

describe('S-05 strict request schemas (REQ-SEC-080/081)', () => {
  const withBody = opEntries.filter(([, op]) => jsonBody(op));
  it('there are JSON-body operations to check', () => expect(withBody.length).toBeGreaterThan(15));

  it.each(withBody)('%s: every object in the request body is additionalProperties:false', (name, op) => {
    for (const [path, s] of objectSchemas(jsonBody(op), 'body')) if (s.properties) expect(s.additionalProperties, `${name} ${path}`).toBe(false);
  });

  it.each(withBody)('%s: provenance / identity fields are not accepted from the client', (name, op) => {
    const forbidden = ['interpretation_source', 'standard_source', 'entered_by', 'signed_by_membership_id', 'tenant_id', 'created_by', 'updated_by'];
    for (const [path, s] of objectSchemas(jsonBody(op), 'body'))
      for (const f of forbidden) expect(Object.keys(s.properties ?? {}), `${name} ${path} must not declare ${f}`).not.toContain(f);
  });

  it('S-05: createIsolate does not accept isolate_seq; no request body accepts a client `status`', () => {
    const names = Object.keys(deref(jsonBody(ops['createIsolate'])).properties ?? {});
    expect(names).not.toContain('isolate_seq');
    for (const [name, op] of withBody) for (const [path, s] of objectSchemas(jsonBody(op), 'body'))
      if (!['updateInstrumentVocabMap'].includes(name)) expect(Object.keys(s.properties ?? {}), `${name} ${path}`).not.toContain('status');
  });

  it.each(withBody)('%s: every free string has maxLength (or is an enum / uuid / date-time / pattern)', (name, op) => {
    for (const [path, s] of stringSchemas(jsonBody(op), 'body')) {
      const bounded = s.maxLength !== undefined || s.enum || s.const !== undefined || s.pattern || ['uuid', 'date-time', 'date'].includes(s.format);
      expect(bounded, `${name} ${path} is an unbounded string`).toBeTruthy();
    }
  });

  it('bulk caps (REQ-SEC-100): recordAstResults entries <= 60', () => {
    const body = deref(jsonBody(ops['recordAstResults']));
    const entries = deref(Object.values<any>(body.properties).find((p) => deref(p).type === 'array'));
    expect(entries.maxItems).toBeLessThanOrEqual(60);
  });
});

describe('S-25 / S-21 query parameters', () => {
  const params = (op: any): any[] => (op.parameters ?? []).map((p: any) => (p.$ref ? spec.components.parameters[p.$ref.replace('#/components/parameters/', '')] : p));
  it('every `limit` parameter has maximum <= 200', () => {
    for (const [name, op] of opEntries) for (const p of params(op)) if (p?.name === 'limit') expect(p.schema?.maximum, name).toBeLessThanOrEqual(200);
  });
  it('S-21: no query parameter of a micro operation can carry a barcode, a name or a result value (PHI stays in POST bodies / UUID paths)', () => {
    const bad = /barcode|name|phone|raw_value|comment|text/i;   // organism_code / antibiotic_code filters of the CONFIG lists (panels, maps) are catalogue codes, not culture-linked findings
    for (const [name, op] of opEntries) for (const p of params(op)) if (p?.in === 'query') expect(p.name, `${name}?${String(p.name)}`).not.toMatch(bad);
  });
  it('S-21: path parameters are UUIDs (or the closed coded-set names)', () => {
    for (const [name, op] of opEntries) for (const p of params(op)) if (p?.in === 'path' && !['set_name', 'code', 'version_no'].includes(p.name))
      expect(deref(p.schema)?.format ?? deref(p.schema)?.pattern, `${name}/{${String(p.name)}}`).toBeTruthy();
  });
});

describe('S-21 BFF route builders (static)', () => {
  it('no apps/web micro BFF file puts a barcode / name into a URL', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { REPO_ROOT } = await import('../../../../core/module.js');
    const dir = join(REPO_ROOT, 'apps', 'web', 'src', 'features', 'micro', 'server');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/['"`](\/v1\/[^'"`]*)['"`]/g)) expect(m[1], `${f}: ${m[1]}`).not.toMatch(/barcode|[?&](q|name|phone|value)=/i);
      expect(src, `${f} must not log`).not.toMatch(/console\.(log|info|warn|error|debug)\(/);
    }
  });
});

// ---------------------------------------------------------------- permission-first sweep (no SQL on denial)
const noTx = new Proxy({}, { get() { throw new Error('tx touched before the permission check'); } });
const ID = { culture_id: UUID, isolate_id: UUID, plate_id: UUID, record_id: UUID, set_id: UUID, protocol_id: UUID, panel_id: UUID, map_id: UUID, instrument_id: UUID, version_no: '1', set_name: 'organisms', code: 'syn_code' } as Record<string, string>;
const permissionFirst = opEntries.filter(([n, o]) => o['x-permission'] === MANAGE || o['x-permission'] === BREAKPOINT || n === 'listMicroInstrumentRecords' || n === 'listMicroCodedSet'
  || ['listPlatingProtocols', 'listAstPanels', 'listInstrumentVocabMaps', 'listInstrumentAstDefaults', 'getMicroSettings', 'listBreakpointSets', 'getBreakpointSet', 'downloadBreakpointTemplate'].includes(n));

const pathParams = (name: string): Row => {
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId === name)
    return Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1]!, ID[m[1]!] ?? UUID]));
  return {};
};

describe('S-10 / S-22 / S-23 / S-24 permission before SQL', () => {
  it('the sweep covers the config, breakpoint and instrument-record list operations', () => expect(permissionFirst.length).toBeGreaterThanOrEqual(25));

  it.each(permissionFirst)('%s: a user without the permission gets auth.forbidden and no SQL runs', async (name, op) => {
    const grants = [READ, WORK, 'lab.result.read'].filter((g) => g !== op['x-permission']);   // technologist-like: read+work, never manage/breakpoint
    const { ctx, calls } = mkCtx({ tenantId: TENANT, tx: noTx, grants });
    const err = await run(name, { params: pathParams(name), query: {}, body: undefined }, ctx).then(() => undefined, (e: unknown) => e);
    expect(err, `${name} must reject`).toBeInstanceOf(LimsError);
    expect((err as LimsError).code).toBe('auth.forbidden');
    expect(calls.assertRole[0]?.['permission']).toBe(op['x-permission']);
  });

  it.each(opEntries.filter(([, o]) => o['x-permission'] === BREAKPOINT))('%s: aal1 session with the permission gets auth.mfa_required (privileged) and no SQL runs', async (name) => {
    const { ctx } = mkCtx({ tenantId: TENANT, tx: noTx, grants: [BREAKPOINT] });
    ctx.ports.IdentityPort.assertRole = async () => { throw new LimsError('auth.mfa_required'); };   // IdentityPort enforces aal2 for privileged permissions (REQ-SEC-062)
    const err = await run(name, { params: pathParams(name), query: {}, headers: { 'if-match': '"1"' }, body: undefined }, ctx).then(() => undefined, (e: unknown) => e);
    expect((err as LimsError)?.code).toBe('auth.mfa_required');
  });

  it('S-10: a revoked membership (assertRole rejects with auth.forbidden at call time) fails the privileged check even though the token was valid', async () => {
    const { ctx } = mkCtx({ tenantId: TENANT, tx: noTx, grants: [BREAKPOINT] });
    ctx.ports.IdentityPort.assertRole = async () => { throw new LimsError('auth.forbidden'); };
    const err = await run('activateBreakpointSet', { params: { set_id: UUID }, headers: { 'if-match': '"1"' } }, ctx).then(() => undefined, (e: unknown) => e);
    expect((err as LimsError)?.code).toBe('auth.forbidden');
  });

  it('fails closed when the IdentityPort is absent', async () => {
    const { ctx } = mkCtx({ tenantId: TENANT, tx: noTx, grants: [MANAGE] });
    delete ctx.ports.IdentityPort;
    for (const n of ['upsertMicroCode', 'activateBreakpointSet', 'listMicroInstrumentRecords']) {
      const err = await run(n, { params: pathParams(n) }, ctx).then(() => undefined, (e: unknown) => e);
      expect((err as LimsError)?.code, n).toBe('auth.forbidden');
    }
  });

  it('S-24: PUT /coded-sets/ast_interpretations/codes/S by a config manager is refused as a global table (403 auth.forbidden), never written', async () => {
    const queries: string[] = [];
    const tx = { query: async (t: string) => { queries.push(t); return { rows: [], rowCount: 0 }; } };
    const { ctx } = mkCtx({ tenantId: TENANT, tx, grants: [MANAGE, READ] });
    const err = await run('upsertMicroCode', { params: { set_name: 'ast_interpretations', code: 'S' }, headers: { 'if-match': '"1"' }, body: { display: 'Synthetic', is_active: true } }, ctx).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(LimsError);
    expect(['auth.forbidden', 'common.not_found', 'common.validation_failed']).toContain((err as LimsError).code);
    expect((err as LimsError).code, 'ast_interpretations is a global set: 403 auth.forbidden (07-SECURITY S-24)').toBe('auth.forbidden');
    expect(queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q)), 'no write reached SQL').toEqual([]);
  });
});
