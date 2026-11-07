// T-07 (C3) — analytes + analyte versions: createAnalyte / getAnalyte / updateAnalyte / createAnalyteVersionDraft / updateAnalyteVersionDraft /
// publishAnalyteVersion / discardAnalyteVersionDraft (operations #29–#35, without formula validation — that is T-11).
// Spec: 06-PLAN row T-07 (done_when: publish supersedes predecessor; ordinal needs an ordered value set; immutability API 409 + DB P0001; no back-dating;
//       one draft; bumps stamp orderables.revision), 02-TRD §3 (stamping), §5.2 #29–#35, §9.1 (entity 'analyte': created / updated / deactivated / versioned;
//       draft writes bump nothing), 05-SCHEMA (analytes, analyte_versions, constraints + triggers §10.2), 03-APP-FLOW §2.1 (V1–V5);
//       PRD AC-02.2 (analyte code), AC-02.3 (single narrative analyte), AC-02.6, AC-03.1–03.5; 07-SECURITY S-1, S-5, S-6, AB-9, AB-20, REQ-SEC-082.
// Real core createEvents({producer:'catalog'}) and T-03's real revision service over the SQL fake in helpers/testsDb.ts (RLS, row locks, UNIQUE/CHECK/FK,
// the analyte_versions triggers, READ COMMITTED). The permission checks for publish (AC-03.6) are handler-level: see analyteVersions.handlers.test.ts.
// Interface: see helpers/t7.ts (SEAM header). Authoring notes (assumptions, gaps): .orchestra/notes/T-07-tests.md.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { ISO_UTC, errPaths, events, lims, rejection, validation400 } from '../helpers/t6.js';
import { pgError } from '../helpers/mastersDb.js';
import {
  CBC, DAY, HB, HB_B, HB_V1, HB_V2, ID, M1, M2, M_B, MICRO, NOW_MS, PANEL, RBC, SEC, T, T0, T1, TEST_B, aBody, aStmts, ana, at, draftOf, ms, orderableRev, pBody, pubOf,
  setup7, versionsOf, type Env7,
} from '../helpers/t7.js';

/** Everything a failed call must leave untouched. */
const snap = (db: Env7['db']) => JSON.stringify({ a: db.rows('analytes'), v: db.rows('analyte_versions'), o: db.rows('orderables'), t: db.rows('tests'), n: db.events.length, r: db.revisionOf(TENANT_A) });
const only = (db: Env7['db']) => events(db).map((e) => e.envelope.payload);
/** A world without the seeded HB/RBC (empty of analytes) plus the given rows. */
const world = (analytes: any[], versions: any[]) => setup7({ base: false, t6: { analytes, analyte_versions: versions } });
const create = (e: Env7, b: unknown, test_id: string = CBC.test.id, o: any = {}) => e.db.run((ctx) => e.svc['createAnalyte']!(ctx, { test_id, body: b }), o);
const get = (e: Env7, id: string, as_of?: string) => e.db.run((ctx) => e.svc['getAnalyte']!(ctx, { id, as_of }));
const patchA = (e: Env7, id: string, patch: unknown, expectedVersion: unknown = 1) => e.db.run((ctx) => e.svc['updateAnalyte']!(ctx, { id, expectedVersion, patch }));
const draft = (e: Env7, analyte_id: string, body?: unknown, o: any = {}) => e.db.run((ctx) => e.svc['createAnalyteVersionDraft']!(ctx, { analyte_id, body }), o);
const patchV = (e: Env7, id: string, patch: unknown, expectedVersion: unknown = 1) => e.db.run((ctx) => e.svc['updateAnalyteVersionDraft']!(ctx, { id, expectedVersion, patch }));
const publish = (e: Env7, id: string, body: unknown = pBody(), expectedVersion: unknown = 1, o: any = {}) => e.db.run((ctx) => e.svc['publishAnalyteVersion']!(ctx, { id, expectedVersion, body }), o);
const discard = (e: Env7, id: string, expectedVersion: unknown = 1) => e.db.run((ctx) => e.svc['discardAnalyteVersionDraft']!(ctx, { id, expectedVersion }));
const notFound = (x: any) => lims(x, 'common.not_found', 404);

// ============================================================================================================ createAnalyte (#29)
describe('createAnalyte (#29) — AC-02.2 (code), initial draft version, F-02', () => {
  it('201 Analyte DTO: code upper-cased, defaults, draft_version_id, no current_version, no internal columns', { timeout: T }, async () => {
    const e = setup7();
    const out = await create(e, aBody({ code: ' wbc ' }));
    expect(out).toMatchObject({ test_id: CBC.test.id, code: 'WBC', name: 'White cell count', sort_order: 30, is_reportable: true, is_active: true, version: 1 });
    expect(out.id).toMatch(UUIDV7);
    expect(out.draft_version_id).toMatch(UUIDV7);
    expect(out).not.toHaveProperty('current_version');
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at']) expect(out).not.toHaveProperty(k);
  });

  it('omitted optionals take the schema defaults (sort_order 100, is_reportable true)', { timeout: T }, async () => {
    const e = setup7();
    const out = await create(e, aBody({ sort_order: undefined }));
    expect(out).toMatchObject({ sort_order: 100, is_reportable: true });
  });

  it('writes one analytes row and its version 1 DRAFT (no published_*, no effective_from, no change_reason) with the initial fields', { timeout: T }, async () => {
    const e = setup7();
    const out = await create(e, aBody({ print_name: 'WBC count', report_subheading: 'WBC parameters' }, { unit_code: '10e9_l', decimals: 2, method_id: M1.id }));
    expect(e.db.row('analytes', out.id)).toMatchObject({ tenant_id: TENANT_A, test_id: CBC.test.id, code: 'WBC', name: 'White cell count', print_name: 'WBC count', report_subheading: 'WBC parameters', sort_order: 30, is_reportable: true, version: 1, is_active: true, created_by: USER, updated_by: USER });
    const v = e.db.row('analyte_versions', out.draft_version_id)!;
    expect(v).toMatchObject({ tenant_id: TENANT_A, analyte_id: out.id, version_no: 1, status: 'draft', result_type: 'numeric', unit_code: '10e9_l', decimals: 2, method_id: M1.id, version: 1, created_by: USER });
    for (const k of ['effective_from', 'effective_to', 'published_at', 'published_by', 'change_reason']) expect(v[k], k).toBeNull();
  });

  it('publishes catalog.changed.v1 {entity_type analyte, entity_id = the NEW analyte id, change_kind created} in the SAME tx and stamps the owning test\'s orderable', { timeout: T }, async () => {
    const e = setup7();
    const out = await create(e, aBody());
    const ev = events(e.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'analyte', entity_id: out.id, change_kind: 'created' });
    expect(ev[0]!.envelope.payload.effective_from).toMatch(ISO_UTC);
    expect(ev[0]!.key).toBe(`${TENANT_A}:catalog:418`);
    expect(e.db.revisionOf(TENANT_A)).toBe(418);
    expect(orderableRev(e.db, CBC.test.id)).toBe(418);          // the owner test's orderable row
    expect(orderableRev(e.db, MICRO.test.id)).toBe(0);          // other tests untouched
    const mine = e.db.stmts.filter((s) => s.tenantId === TENANT_A);
    const idx = (re: RegExp) => mine.findIndex((s) => re.test(s.text));
    const a = idx(/^\s*INSERT\s+INTO\s+catalog\.analytes\b/i), v = idx(/^\s*INSERT\s+INTO\s+catalog\.analyte_versions\b/i), ev0 = idx(/INSERT INTO core\.event_log/i);
    expect(a).toBeGreaterThanOrEqual(0); expect(v).toBeGreaterThan(a); expect(ev0).toBeGreaterThan(v);
    expect(new Set(mine.map((x) => x.txId)).size).toBe(1);
  });

  it('rollback / a failing event insert / a failing version insert leaves nothing: no analyte, no version, revision 417, no event, orderable unstamped', { timeout: T }, async () => {
    const a = setup7(); await rejection(create(a, aBody(), CBC.test.id, { rollback: true }));
    const b = setup7(); b.db.fail(/INSERT INTO core\.event_log/i); await rejection(create(b, aBody()));
    const c = setup7(); c.db.fail(/INSERT INTO catalog\.analyte_versions/i); await rejection(create(c, aBody()));
    for (const { db } of [a, b, c]) {
      expect(db.rows('analytes').map((r) => r['code']).sort()).toEqual(['HB', 'HBB', 'ONLYB', 'RBC']);
      expect(db.rows('analyte_versions')).toHaveLength(3);
      expect(events(db)).toHaveLength(0); expect(db.revisionOf(TENANT_A)).toBe(417); expect(orderableRev(db, CBC.test.id)).toBe(0);
    }
  });

  it.each([['padded', ' wbc ', 'WBC'], ['mixed', 'Wbc_2', 'WBC_2']])('code %s is trimmed and upper-cased on write', { timeout: T }, async (_n, raw, want) => {
    const e = setup7();
    const out = await create(e, aBody({ code: raw }));
    expect(out.code).toBe(want);
    expect(e.db.row('analytes', out.id)!['code']).toBe(want);
  });

  it.each([
    ['empty', ''], ['blank', '   '], ['leading digit', '1HB'], ['hyphen', 'A-B'], ['dot', 'A.B'], ['space inside', 'A B'], ['33 chars', 'x'.repeat(33)], ['leading underscore', '_X'],
    ['dotless i (case-fold forgery)', 'ıdx'], ['long s (case-fold forgery)', 'ſugar'], ['fullwidth letters', 'ＡＢＣ'], ['newline', 'A\nB'], ['number', 123], ['null', null], ['object', { a: 1 }],
  ])('invalid code (%s) -> 400 path /code, nothing written (AC-02.2)', { timeout: T }, async (_n, code) => {
    const e = setup7(); const before = snap(e.db);
    const x = await rejection(create(e, { ...aBody(), code }));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain('/code');
    expect(snap(e.db)).toBe(before);
  });

  it('a duplicate code is 409 catalog.code_duplicate across ALL tests of the tenant and case-insensitively; another tenant\'s code is not a clash', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    for (const [code, testId] of [['hb', CBC.test.id], ['HB', MICRO.test.id], ['rbc', MICRO.test.id]] as const) {
      lims(await rejection(create(e, aBody({ code }), testId)), 'catalog.code_duplicate', 409);
    }
    expect(snap(e.db)).toBe(before);
    const ok = await create(e, aBody({ code: 'onlyb' }));                       // tenant B owns ONLYB; tenant A may use it
    expect(ok.code).toBe('ONLYB');
    expect(e.db.rows('analytes', TENANT_B).map((r) => r['code']).sort()).toEqual(['HBB', 'ONLYB']);
  });

  it('two concurrent creates of the same code: exactly one 201, the other 409 catalog.code_duplicate', { timeout: T }, async () => {
    const e = setup7();
    const r = await Promise.allSettled([create(e, aBody({ code: 'plt' })), create(e, aBody({ code: 'PLT' }))]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const bad = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    lims(bad.reason, 'catalog.code_duplicate', 409);
    expect(e.db.rows('analytes', TENANT_A).filter((x) => x['code'] === 'PLT')).toHaveLength(1);
    expect(events(e.db)).toHaveLength(1); expect(e.db.revisionOf(TENANT_A)).toBe(418);
  });

  it.each([['code'], ['name'], ['initial_version']])('missing required %s -> 400 path /%s', { timeout: T }, async (field) => {
    const e = setup7();
    const x = await rejection(create(e, aBody({ [field]: undefined })));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain(`/${field}`);
  });

  it('missing initial_version.result_type -> 400 path /initial_version/result_type', { timeout: T }, async () => {
    const e = setup7();
    const x = await rejection(create(e, aBody({}, { result_type: undefined })));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain('/initial_version/result_type');
  });

  it.each([
    ['empty name', { name: '' }, '/name'], ['121-char name', { name: 'n'.repeat(121) }, '/name'], ['non-string name', { name: 5 }, '/name'],
    ['121-char print_name', { print_name: 'p'.repeat(121) }, '/print_name'], ['81-char report_subheading', { report_subheading: 's'.repeat(81) }, '/report_subheading'],
    ['negative sort_order', { sort_order: -1 }, '/sort_order'], ['sort_order 10000', { sort_order: 10000 }, '/sort_order'], ['fractional sort_order', { sort_order: 1.5 }, '/sort_order'],
    ['string is_reportable', { is_reportable: 'yes' }, '/is_reportable'],
  ])('%s -> 400 at %s, nothing written', { timeout: T }, async (_n, over, path) => {
    const e = setup7(); const before = snap(e.db);
    const x = await rejection(create(e, aBody(over)));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('non-object bodies are 400, never 500', { timeout: T }, async () => {
    const e = setup7();
    for (const b of [null, undefined, 'x', 7, [], [aBody()]]) validation400(await rejection(create(e, b)));
  });

  // ---- AC-02.6 on the initial version
  it.each([
    ['numeric without decimals', { result_type: 'numeric', decimals: undefined }, '/initial_version/decimals'],
    ['numeric decimals 7', { result_type: 'numeric', decimals: 7 }, '/initial_version/decimals'],
    ['numeric decimals -1', { result_type: 'numeric', decimals: -1 }, '/initial_version/decimals'],
    ['numeric decimals 1.5', { result_type: 'numeric', decimals: 1.5 }, '/initial_version/decimals'],
    ['ordinal without value_set_code', { result_type: 'ordinal', decimals: undefined, unit_code: undefined }, '/initial_version/value_set_code'],
    ['coded without value_set_code', { result_type: 'coded', decimals: undefined, unit_code: undefined }, '/initial_version/value_set_code'],
    ['ordinal with an UNORDERED value set', { result_type: 'ordinal', value_set_code: 'POS_NEG', decimals: undefined, unit_code: undefined }, '/initial_version/value_set_code'],
    ['ordinal with an unknown value set', { result_type: 'ordinal', value_set_code: 'NO_SUCH_SET', decimals: undefined, unit_code: undefined }, '/initial_version/value_set_code'],
    ['coded with an unknown value set', { result_type: 'coded', value_set_code: 'NO_SUCH_SET', decimals: undefined, unit_code: undefined }, '/initial_version/value_set_code'],
    ['ordinal with another tenant\'s value set', { result_type: 'ordinal', value_set_code: 'B_ORD', decimals: undefined, unit_code: undefined }, '/initial_version/value_set_code'],
    ['unit_code with a slash', { unit_code: 'g/dl' }, '/initial_version/unit_code'],
    ['unknown result_type', { result_type: 'binary' }, '/initial_version/result_type'],
  ])('AC-02.6: %s -> 400 at %s, nothing written', { timeout: T }, async (_n, v, path) => {
    const e = setup7(); const before = snap(e.db);
    const x = await rejection(create(e, aBody({}, v)));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it.each([
    ['ordinal + ordered GLOBAL set', { result_type: 'ordinal', value_set_code: 'URINE_SEMIQ' }],
    ['ordinal + ordered TENANT set', { result_type: 'ordinal', value_set_code: 'MY_ORD' }],
    ['coded + unordered set (ordering is only required for ordinal)', { result_type: 'coded', value_set_code: 'POS_NEG' }],
    ['text', { result_type: 'text', decimals: undefined, unit_code: undefined }],
    ['narrative', { result_type: 'narrative', decimals: undefined, unit_code: undefined }],
    ['attachment', { result_type: 'attachment', decimals: undefined, unit_code: undefined }],
    ['numeric decimals 0', { result_type: 'numeric', decimals: 0 }],
    ['numeric decimals 6', { result_type: 'numeric', decimals: 6 }],
  ])('AC-02.6: %s is accepted', { timeout: T }, async (_n, v) => {
    const e = setup7();
    const out = await create(e, aBody({}, v));
    expect(e.db.row('analyte_versions', out.draft_version_id)).toMatchObject({ status: 'draft', result_type: (v as any).result_type });
  });

  it('S-1: a method_id of tenant B -> 404 common.not_found; nothing written', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    notFound(await rejection(create(e, aBody({}, { method_id: M_B.id }))));
    expect(snap(e.db)).toBe(before);
  });

  it('S-1: a test_id of tenant B, of a PANEL, or unknown -> 404 common.not_found; nothing written', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    for (const id of [TEST_B.test.id, PANEL.panel.id, ID(0xdead)]) notFound(await rejection(create(e, aBody({ code: 'newone' }), id)));
    expect(snap(e.db)).toBe(before);
  });

  it('a malformed test_id is 400', { timeout: T }, async () => {
    const e = setup7();
    for (const id of ['', 'abc', null, 7, '0190c300-0000-7000-8000-00000000zzzz']) validation400(await rejection(create(e, aBody({ code: 'newone' }), id as never)));
  });

  it('S-5: mass assignment (server-owned or unknown fields, top level or inside initial_version) -> 400, nothing written', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    for (const extra of [{ tenant_id: TENANT_B }, { id: ID(0xbad) }, { test_id: MICRO.test.id }, { version: 7 }, { is_active: false }, { current_version: {} }, { draft_version_id: ID(1) }, { created_by: ID(1) }]) {
      validation400(await rejection(create(e, { ...aBody({ code: 'newone' }), ...extra })));
    }
    for (const extra of [{ status: 'published' }, { version_no: 5 }, { effective_from: at(0) }, { tenant_id: TENANT_B }, { published_at: at(0) }, { change_reason: 'x' }, { analyte_id: HB.id }]) {
      validation400(await rejection(create(e, aBody({ code: 'newone' }, extra))));
    }
    expect(snap(e.db)).toBe(before);
  });
});

// ============================================================================================================ getAnalyte (#30)
describe('getAnalyte (#30) — AnalyteDetail, versions newest first, current_version at as_of (AC-03.1)', () => {
  it('returns the analyte with versions newest first, current_version = the published one, draft_version_id = the open draft; no internal columns', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const out = await get(e, HB.id);
    expect(out).toMatchObject({ id: HB.id, test_id: CBC.test.id, code: 'HB', name: 'Hemoglobin', report_subheading: 'RBC parameters', sort_order: 10, is_reportable: true, is_active: true, version: 1 });
    expect(out.versions.map((v: any) => [v.version_no, v.status])).toEqual([[2, 'draft'], [1, 'published']]);
    expect(out.current_version).toMatchObject({ id: HB_V1.id, analyte_id: HB.id, version_no: 1, status: 'published', result_type: 'numeric', unit_code: 'g_dl', decimals: 1, method_id: M1.id, effective_from: T0, change_reason: 'initial', version: 1 });
    expect(out.draft_version_id).toBe(HB_V2.id);
    for (const v of [out, out.current_version, ...out.versions]) for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'published_by', 'published_at', 'source_import_id']) expect(v, k).not.toHaveProperty(k);
  });

  it('AC-03.1: current_version follows the effective window — v1 until T1 (exclusive), v2 from T1; nothing before v1 starts; default as_of = ctx.now()', { timeout: T }, async () => {
    const v1 = pubOf(1, HB.id, { status: 'superseded', effective_to: new Date(T1), version: 2 });
    const v2 = pubOf(2, HB.id, { version_no: 2, decimals: 2, effective_from: new Date(T1), published_at: new Date(T1) });
    const e = world([HB], [v1, v2]);
    const dec = async (as_of?: string) => (await get(e, HB.id, as_of)).current_version?.decimals;
    expect(await dec('2025-12-31T23:59:59.999Z')).toBeUndefined();
    expect(await dec(T0)).toBe(1);
    expect(await dec('2026-11-30T23:59:59.999Z')).toBe(1);
    expect(await dec(T1)).toBe(2);
    expect(await dec('2027-06-01T00:00:00.000Z')).toBe(2);
    expect(await dec()).toBe(1);                                              // ctx.now() = 2026-11-07 < T1
    const cv = (await get(e, HB.id, '2026-06-01T00:00:00.000Z')).current_version;
    expect(cv).toMatchObject({ status: 'superseded', effective_from: T0, effective_to: T1 });
  });

  it('a draft or a discarded version is never current, even though it is listed', { timeout: T }, async () => {
    const e = world([HB], [draftOf(1, HB.id, { version_no: 1 }), draftOf(2, HB.id, { version_no: 2, status: 'discarded' })]);
    const out = await get(e, HB.id, '2027-01-01T00:00:00.000Z');
    expect(out).not.toHaveProperty('current_version');
    expect(out.draft_version_id).toBe(ID(0x4001));
    expect(out.versions).toHaveLength(2);
  });

  it('lists at most 50 versions, newest first', { timeout: T }, async () => {
    const many = Array.from({ length: 52 }, (_, i) => pubOf(100 + i, HB.id, { version_no: i + 1, status: 'superseded', effective_to: new Date(Date.UTC(2026, 0, 2 + i)), effective_from: new Date(Date.UTC(2026, 0, 1 + i)) }));
    const out = await get(world([HB], many), HB.id);
    expect(out.versions).toHaveLength(50);
    expect(out.versions[0].version_no).toBe(52);
    expect(out.versions[49].version_no).toBe(3);
  });

  it('S-1: tenant B\'s analyte, an unknown id -> 404; a malformed id or as_of -> 400', { timeout: T }, async () => {
    const e = setup7();
    for (const id of [HB_B.id, ID(0xdead)]) notFound(await rejection(get(e, id)));
    validation400(await rejection(get(e, 'not-a-uuid')));
    for (const as_of of ['2026-11-07', 'yesterday', '2026-11-07T12:00:00Z', '2026-11-07T12:00:00.000+05:45', '']) {
      const x = await rejection(get(e, HB.id, as_of));
      validation400(x);
      if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain('/as_of');
    }
  });

  it('a read writes nothing: no UPDATE/INSERT statement, no event', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    await get(e, HB.id);
    expect(aStmts(e.db).filter((s) => !/^\s*SELECT/i.test(s.text))).toEqual([]);
    expect(e.db.events).toHaveLength(0);
  });
});

// ============================================================================================================ updateAnalyte (#31)
describe('updateAnalyte (#31) — display attributes, If-Match, event + stamp', () => {
  it('200 Analyte version 2 with the patched attributes; code and test_id unchanged', { timeout: T }, async () => {
    const e = setup7();
    const out = await patchA(e, HB.id, { name: 'Haemoglobin', print_name: 'Hb', report_subheading: 'Red cells', sort_order: 15, is_reportable: false });
    expect(out).toMatchObject({ id: HB.id, code: 'HB', test_id: CBC.test.id, name: 'Haemoglobin', print_name: 'Hb', report_subheading: 'Red cells', sort_order: 15, is_reportable: false, is_active: true, version: 2 });
    expect(e.db.row('analytes', HB.id)).toMatchObject({ name: 'Haemoglobin', version: 2, updated_by: USER });
  });

  it('publishes catalog.changed.v1 {analyte, entity_id = analyte id, updated} and stamps the owner test\'s orderable', { timeout: T }, async () => {
    const e = setup7();
    await patchA(e, HB.id, { name: 'Haemoglobin' });
    expect(only(e.db)).toHaveLength(1);
    expect(only(e.db)[0]).toMatchObject({ catalog_revision: 418, entity_type: 'analyte', entity_id: HB.id, change_kind: 'updated' });
    expect(orderableRev(e.db, CBC.test.id)).toBe(418);
    expect(orderableRev(e.db, MICRO.test.id)).toBe(0);
  });

  it('is_active -> false is a `deactivated` event; the analyte keeps its versions', { timeout: T }, async () => {
    const e = setup7();
    const out = await patchA(e, HB.id, { is_active: false });
    expect(out.is_active).toBe(false);
    expect(only(e.db)[0]).toMatchObject({ entity_type: 'analyte', entity_id: HB.id, change_kind: 'deactivated' });
    expect(versionsOf(e.db, HB.id)).toHaveLength(1);
  });

  it('If-Match: absent -> 428, stale -> 409 common.version_conflict, malformed -> 400; the row is unchanged', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    const a = await rejection(e.db.run((ctx) => e.svc['updateAnalyte']!(ctx, { id: HB.id, patch: { name: 'x' } })));
    lims(a, 'common.precondition_required', 428);
    lims(await rejection(patchA(e, HB.id, { name: 'x' }, 2)), 'common.version_conflict', 409);
    for (const bad of [0, -1, 1.5, '1', null, 2147483648]) validation400(await rejection(patchA(e, HB.id, { name: 'x' }, bad)));
    expect(snap(e.db)).toBe(before);
  });

  it('two concurrent updates with the same If-Match: one 200, one 409 common.version_conflict; one event', { timeout: T }, async () => {
    const e = setup7();
    const r = await Promise.allSettled([patchA(e, HB.id, { name: 'First' }), patchA(e, HB.id, { name: 'Second' })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(e.db.row('analytes', HB.id)!['version']).toBe(2);
    expect(only(e.db)).toHaveLength(1);
  });

  it.each([
    ['empty name', { name: '' }, '/name'], ['121-char name', { name: 'n'.repeat(121) }, '/name'], ['121-char print_name', { print_name: 'p'.repeat(121) }, '/print_name'],
    ['81-char report_subheading', { report_subheading: 's'.repeat(81) }, '/report_subheading'], ['sort_order 10000', { sort_order: 10000 }, '/sort_order'],
    ['string is_active', { is_active: 'no' }, '/is_active'],
  ])('%s -> 400 at %s, unchanged', { timeout: T }, async (_n, patch, path) => {
    const e = setup7(); const before = snap(e.db);
    const x = await rejection(patchA(e, HB.id, patch));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('S-5: code, test_id, tenant_id, id, version, current_version, created_by in the patch -> 400; the code can never change', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    for (const extra of [{ code: 'HGB' }, { test_id: MICRO.test.id }, { tenant_id: TENANT_B }, { id: ID(0xbad) }, { version: 9 }, { current_version: {} }, { created_by: ID(1) }]) {
      validation400(await rejection(patchA(e, HB.id, { name: 'x', ...extra })));
    }
    expect(snap(e.db)).toBe(before);
  });

  it('S-1: tenant B\'s analyte / unknown id -> 404 and tenant B\'s row is untouched; a malformed id is 400', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    for (const id of [HB_B.id, ID(0xdead)]) notFound(await rejection(patchA(e, id, { name: 'hijack' })));
    validation400(await rejection(patchA(e, 'nope', { name: 'x' })));
    expect(snap(e.db)).toBe(before);
    expect(e.db.row('analytes', HB_B.id)).toMatchObject({ name: 'Tenant B hemoglobin', version: 1 });
  });
});

// ============================================================================================================ createAnalyteVersionDraft (#32)
describe('createAnalyteVersionDraft (#32) — copy, numbering, one open draft (AC-03.4)', () => {
  it('201: copies the latest PUBLISHED version\'s clinical fields into version_no 2 (draft, version 1, no dates, no reason); stamps nothing', { timeout: T }, async () => {
    const e = setup7();
    const out = await draft(e, HB.id);
    expect(out).toMatchObject({ analyte_id: HB.id, version_no: 2, status: 'draft', result_type: 'numeric', unit_code: 'g_dl', decimals: 1, method_id: M1.id, version: 1 });
    expect(out.id).toMatch(UUIDV7);
    for (const k of ['effective_from', 'effective_to', 'change_reason', 'tenant_id', 'published_at', 'published_by']) expect(out, k).not.toHaveProperty(k);
    expect(e.db.row('analyte_versions', out.id)).toMatchObject({ tenant_id: TENANT_A, status: 'draft', created_by: USER, effective_from: null, published_at: null, change_reason: null });
    expect(e.db.events).toHaveLength(0);                                       // draft rows are exempt from the revision bump (02-TRD §3, §9.1)
    expect(e.db.revisionOf(TENANT_A)).toBe(417);
    expect(orderableRev(e.db, CBC.test.id)).toBe(0);
  });

  it('copy_from_version_no copies THAT version (an older one) and numbers max+1', { timeout: T }, async () => {
    const v1 = pubOf(1, HB.id, { status: 'superseded', decimals: 1, effective_to: new Date(T1) });
    const v2 = pubOf(2, HB.id, { version_no: 2, decimals: 3, unit_code: 'mg_dl', effective_from: new Date(T1), published_at: new Date(T1) });
    const e = world([HB], [v1, v2]);
    const out = await draft(e, HB.id, { copy_from_version_no: 1 });
    expect(out).toMatchObject({ version_no: 3, status: 'draft', decimals: 1, unit_code: 'g_dl' });
  });

  it('numbering is max+1 over ALL statuses (a discarded v2 is not reused)', { timeout: T }, async () => {
    const e = world([HB], [HB_V1, draftOf(2, HB.id, { version_no: 2, status: 'discarded' })]);
    expect((await draft(e, HB.id)).version_no).toBe(3);
  });

  it('AC-03.4: while a draft exists, another is 409 common.version_conflict; nothing is written', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    lims(await rejection(draft(e, HB.id)), 'common.version_conflict', 409);
    lims(await rejection(draft(e, HB.id, { copy_from_version_no: 1 })), 'common.version_conflict', 409);
    expect(snap(e.db)).toBe(before);
  });

  it('after the open draft is discarded a new draft can be created (number = max+1)', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    await discard(e, HB_V2.id);
    expect((await draft(e, HB.id)).version_no).toBe(3);
  });

  it('two concurrent creates: exactly one 201, the other 409 common.version_conflict; exactly one draft row', { timeout: T }, async () => {
    const e = setup7();
    const r = await Promise.allSettled([draft(e, HB.id), draft(e, HB.id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(versionsOf(e.db, HB.id).filter((v) => v['status'] === 'draft')).toHaveLength(1);
  });

  it('copy_from_version_no that does not exist -> 400 or 404 and nothing is written; malformed -> 400 path /copy_from_version_no', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    const miss = await rejection(draft(e, HB.id, { copy_from_version_no: 9 }));
    expect([400, 404]).toContain(miss.statusCode);
    for (const bad of [0, -1, 1.5, '1', null]) {
      const x = await rejection(draft(e, HB.id, { copy_from_version_no: bad }));
      validation400(x);
      if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain('/copy_from_version_no');
    }
    expect(snap(e.db)).toBe(before);
  });

  it('an absent or empty body is fine (copy_from_version_no is optional)', { timeout: T }, async () => {
    for (const b of [undefined, {}]) expect((await draft(setup7(), HB.id, b)).version_no).toBe(2);
  });

  it('S-1: tenant B\'s analyte / unknown -> 404; S-5: unknown fields -> 400', { timeout: T }, async () => {
    const e = setup7(); const before = snap(e.db);
    for (const id of [HB_B.id, ID(0xdead)]) notFound(await rejection(draft(e, id)));
    for (const extra of [{ status: 'published' }, { version_no: 9 }, { tenant_id: TENANT_B }, { unit_code: 'x' }, { analyte_id: HB_B.id }]) validation400(await rejection(draft(e, HB.id, extra)));
    expect(snap(e.db)).toBe(before);
  });

  it('a failing insert leaves no draft (rollback)', { timeout: T }, async () => {
    const e = setup7(); e.db.fail(/INSERT INTO catalog\.analyte_versions/i);
    await rejection(draft(e, HB.id));
    expect(versionsOf(e.db, HB.id)).toHaveLength(1);
  });
});

// ============================================================================================================ updateAnalyteVersionDraft (#33)
describe('updateAnalyteVersionDraft (#33) — draft edits only (AC-03.2), AC-02.6, unset', () => {
  it('200: patches clinical fields; version 2; round-trips formula_expression verbatim; no event, no revision bump (draft)', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    // T-11: `HB * 3` on HB's own draft is a self-cycle (AC-04.3) -> the verbatim round-trip uses another existing numeric analyte (RBC).
    const out = await patchV(e, HB_V2.id, { unit_code: 'mg_dl', decimals: 3, method_id: M2.id, formula_expression: 'RBC * 3' });
    expect(out).toMatchObject({ id: HB_V2.id, status: 'draft', unit_code: 'mg_dl', decimals: 3, method_id: M2.id, formula_expression: 'RBC * 3', version: 2 });
    expect(e.db.row('analyte_versions', HB_V2.id)).toMatchObject({ unit_code: 'mg_dl', decimals: 3, method_id: M2.id, formula_expression: 'RBC * 3', version: 2, updated_by: USER, status: 'draft' });
    expect(e.db.events).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(417); expect(orderableRev(e.db, CBC.test.id)).toBe(0);
  });

  it('`unset` clears the listed optional fields (stored NULL, omitted from the DTO)', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const out = await patchV(e, HB_V2.id, { unset: ['unit_code', 'method_id'] });
    expect(out).not.toHaveProperty('unit_code'); expect(out).not.toHaveProperty('method_id');
    expect(e.db.row('analyte_versions', HB_V2.id)).toMatchObject({ unit_code: null, method_id: null, decimals: 2 });
  });

  it('the same field both set and unset, an unknown/duplicate unset entry, or unsetting decimals of a numeric version -> 400; unchanged', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const patch of [{ unit_code: 'x', unset: ['unit_code'] }, { unset: ['result_type'] }, { unset: ['bogus'] }, { unset: 'unit_code' }, { unset: ['decimals'] }]) validation400(await rejection(patchV(e, HB_V2.id, patch)));
    expect(snap(e.db)).toBe(before);
  });

  it.each([
    ['ordinal without a value set', { result_type: 'ordinal' }, '/value_set_code'],
    ['ordinal + unordered set', { result_type: 'ordinal', value_set_code: 'POS_NEG' }, '/value_set_code'],
    ['ordinal + unknown set', { result_type: 'ordinal', value_set_code: 'NOPE' }, '/value_set_code'],
    ['ordinal + tenant B\'s set', { result_type: 'ordinal', value_set_code: 'B_ORD' }, '/value_set_code'],
    ['coded without a value set', { result_type: 'coded' }, '/value_set_code'],
    ['decimals 7', { decimals: 7 }, '/decimals'], ['decimals -1', { decimals: -1 }, '/decimals'], ['decimals 1.5', { decimals: 1.5 }, '/decimals'],
    ['unit_code with a space', { unit_code: 'g dl' }, '/unit_code'], ['unknown result_type', { result_type: 'binary' }, '/result_type'],
    ['non-uuid method_id', { method_id: 'x' }, '/method_id'], ['501-char formula_expression', { formula_expression: 'a'.repeat(501) }, '/formula_expression'],
  ])('AC-02.6: %s -> 400 at %s; unchanged', { timeout: T }, async (_n, patch, path) => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    const x = await rejection(patchV(e, HB_V2.id, patch));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('AC-02.6: ordinal + an ordered set (global or tenant) is accepted', { timeout: T }, async () => {
    for (const vs of ['URINE_SEMIQ', 'MY_ORD']) {
      const e = setup7({ t6: { analyte_versions: [HB_V2] } });
      expect(await patchV(e, HB_V2.id, { result_type: 'ordinal', value_set_code: vs })).toMatchObject({ result_type: 'ordinal', value_set_code: vs });
    }
  });

  it('S-1: a method_id of tenant B -> 404 (FK), unchanged', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    notFound(await rejection(patchV(e, HB_V2.id, { method_id: M_B.id })));
    expect(snap(e.db)).toBe(before);
  });

  // ---- AC-03.2 / AB-9: published rows are immutable through the API
  const FIELDS: Array<[string, unknown]> = [['unit_code', 'mg_dl'], ['decimals', 3], ['method_id', M2.id], ['value_set_code', 'MY_ORD'], ['formula_expression', 'RBC * 2'], ['result_type', 'text']];
  const v1 = pubOf(1, HB.id, { status: 'superseded', effective_to: new Date('2026-06-01T00:00:00.000Z'), version: 2 });
  const v2 = pubOf(2, HB.id, { version_no: 2, effective_from: new Date('2026-06-01T00:00:00.000Z'), published_at: new Date('2026-06-01T00:00:00.000Z') });
  const v3 = draftOf(3, HB.id, { version_no: 3, status: 'discarded' });
  it.each([['superseded', v1], ['published', v2], ['discarded', v3]] as const)('AC-03.2: PATCH of any clinical field of a %s version -> 409 catalog.version_in_use; the row is unchanged', { timeout: T }, async (_s, row) => {
    const e = world([HB], [v1, v2, v3]); const before = snap(e.db);
    for (const [f, v] of FIELDS) lims(await rejection(patchV(e, row.id, { [f]: v }, Number(row.version ?? 1))), 'catalog.version_in_use', 409);
    lims(await rejection(patchV(e, row.id, { unset: ['unit_code'] }, Number(row.version ?? 1))), 'catalog.version_in_use', 409);
    expect(snap(e.db)).toBe(before);
  });

  it('a version that was just published can no longer be patched (end-to-end AC-03.2)', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const pub = await publish(e, HB_V2.id);
    lims(await rejection(patchV(e, HB_V2.id, { decimals: 5 }, pub.version)), 'catalog.version_in_use', 409);
    expect(e.db.row('analyte_versions', HB_V2.id)!['decimals']).toBe(2);
  });

  it('DB backstop: if the trigger fires (P0001 immutable_row, e.g. a lost race) the API still answers 409, never 500', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    e.db.fail(/UPDATE catalog\.analyte_versions/i, () => pgError('P0001', 'immutable_row'));
    const x = await rejection(patchV(e, HB_V2.id, { decimals: 4 }));
    expect(x.statusCode).toBe(409);
    expect(['catalog.version_in_use', 'common.immutable_record']).toContain(x.code);
  });

  it('If-Match: absent -> 428, stale -> 409 common.version_conflict, malformed -> 400', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    lims(await rejection(e.db.run((ctx) => e.svc['updateAnalyteVersionDraft']!(ctx, { id: HB_V2.id, patch: { decimals: 3 } }))), 'common.precondition_required', 428);
    lims(await rejection(patchV(e, HB_V2.id, { decimals: 3 }, 2)), 'common.version_conflict', 409);
    for (const bad of [0, -3, 1.5, '1', null]) validation400(await rejection(patchV(e, HB_V2.id, { decimals: 3 }, bad)));
    expect(snap(e.db)).toBe(before);
  });

  it('S-5: status, version_no, analyte_id, tenant_id, effective_from/to, change_reason, published_*, id, version, formula_inputs in the patch -> 400; unchanged', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const extra of [{ status: 'published' }, { version_no: 9 }, { analyte_id: HB_B.id }, { tenant_id: TENANT_B }, { effective_from: at(0) }, { effective_to: at(DAY) }, { change_reason: 'x' },
      { published_at: at(0) }, { published_by: USER }, { id: ID(0xbad) }, { version: 9 }, { formula_inputs: ['A'] }, { source_import_id: ID(1) }]) {
      validation400(await rejection(patchV(e, HB_V2.id, { decimals: 3, ...extra })));
    }
    expect(snap(e.db)).toBe(before);
  });

  it('S-1: tenant B\'s version / unknown -> 404; malformed id -> 400', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const id of [ID(0x4004), ID(0xdead)]) notFound(await rejection(patchV(e, id, { decimals: 3 })));
    validation400(await rejection(patchV(e, 'nope', { decimals: 3 })));
    expect(snap(e.db)).toBe(before);
  });

  it('a patch racing a publish of the same draft: at most one wins (both claim version 1); the loser gets 409 and never half-applies', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const r = await Promise.allSettled([patchV(e, HB_V2.id, { decimals: 5 }), publish(e, HB_V2.id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const bad = (r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
    expect(bad.statusCode).toBe(409);
    expect(['catalog.version_in_use', 'common.version_conflict']).toContain(bad.code);
    const row = e.db.row('analyte_versions', HB_V2.id)!;
    if (row['status'] === 'published') expect(row['decimals']).toBe(2); else expect(row).toMatchObject({ status: 'draft', decimals: 5 });
  });
});

// ============================================================================================================ discardAnalyteVersionDraft (#35)
describe('discardAnalyteVersionDraft (#35) — V3', () => {
  it('200: the draft becomes `discarded` (version +1); no event, no bump; the analyte and its published version are untouched', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const out = await discard(e, HB_V2.id);
    expect(out).toMatchObject({ id: HB_V2.id, status: 'discarded', version_no: 2, version: 2 });
    expect(e.db.row('analyte_versions', HB_V2.id)).toMatchObject({ status: 'discarded', version: 2, updated_by: USER });
    expect(e.db.row('analyte_versions', HB_V1.id)).toMatchObject({ status: 'published', version: 1 });
    expect(e.db.row('analytes', HB.id)).toMatchObject({ is_active: true, version: 1 });
    expect(e.db.events).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(417);
  });

  it('a freshly created analyte whose only version is discarded stays; it has no current_version and no draft', { timeout: T }, async () => {
    const e = setup7();
    const a = await create(e, aBody());
    await discard(e, a.draft_version_id);
    const out = await get(e, a.id);
    expect(out).not.toHaveProperty('current_version'); expect(out).not.toHaveProperty('draft_version_id');
    expect(out.versions.map((v: any) => v.status)).toEqual(['discarded']);
  });

  it.each([['published', HB_V1], ['superseded', pubOf(5, HB.id, { version_no: 5, status: 'superseded', effective_to: new Date(T1) })], ['discarded', draftOf(6, HB.id, { version_no: 6, status: 'discarded' })]] as const)(
    '409 catalog.version_in_use for a %s version; the row is unchanged', { timeout: T }, async (_s, row) => {
      const e = world([HB], [row]); const before = snap(e.db);
      lims(await rejection(discard(e, row.id)), 'catalog.version_in_use', 409);
      expect(snap(e.db)).toBe(before);
    });

  it('If-Match: absent -> 428, stale -> 409 common.version_conflict, malformed -> 400', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    lims(await rejection(e.db.run((ctx) => e.svc['discardAnalyteVersionDraft']!(ctx, { id: HB_V2.id }))), 'common.precondition_required', 428);
    lims(await rejection(discard(e, HB_V2.id, 2)), 'common.version_conflict', 409);
    for (const bad of [0, 1.5, '1', null]) validation400(await rejection(discard(e, HB_V2.id, bad)));
    expect(snap(e.db)).toBe(before);
  });

  it('S-1: tenant B\'s version / unknown -> 404', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const id of [ID(0x4004), ID(0xdead)]) notFound(await rejection(discard(e, id)));
    expect(snap(e.db)).toBe(before);
  });
});

// ============================================================================================================ publishAnalyteVersion (#34)
describe('publishAnalyteVersion (#34) — V4 + V5: supersede the predecessor, window rules, stamp (AC-03.1, AC-03.3, done_when)', () => {
  it('AC-03.1: publishing v2 at T1 gives v2 `published` from T1 and v1 `superseded` with effective_to = T1 (version +1)', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const out = await publish(e, HB_V2.id, pBody({ effective_from: T1, change_reason: 'two decimals per the new SOP' }));
    expect(out).toMatchObject({ id: HB_V2.id, analyte_id: HB.id, version_no: 2, status: 'published', result_type: 'numeric', unit_code: 'g_dl', decimals: 2, method_id: M1.id, effective_from: T1, change_reason: 'two decimals per the new SOP', version: 2 });
    expect(out).not.toHaveProperty('effective_to');
    const rows = versionsOf(e.db, HB.id);
    expect(rows[0]).toMatchObject({ id: HB_V1.id, status: 'superseded', version: 2 });
    expect(ms(rows[0]!['effective_to'])).toBe(Date.parse(T1));
    expect(ms(rows[0]!['effective_from'])).toBe(Date.parse(T0));              // the predecessor's start is never edited
    expect(rows[1]).toMatchObject({ id: HB_V2.id, status: 'published', published_by: USER, change_reason: 'two decimals per the new SOP', effective_to: null });
    expect(Math.abs(ms(rows[1]!['published_at'])! - NOW_MS)).toBeLessThan(2000);
    expect(ms(rows[1]!['effective_from'])).toBe(Date.parse(T1));
    // getAnalyte(asOf): decimals 1 before T1, 2 from T1
    expect((await get(e, HB.id, '2026-11-30T23:59:59.999Z')).current_version).toMatchObject({ version_no: 1, decimals: 1 });
    expect((await get(e, HB.id, T1)).current_version).toMatchObject({ version_no: 2, decimals: 2 });
  });

  it('effective_from omitted -> now (ctx.now()); the predecessor ends exactly there', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const out = await publish(e, HB_V2.id);
    expect(out.effective_from).toMatch(ISO_UTC);
    expect(Math.abs(Date.parse(out.effective_from) - NOW_MS)).toBeLessThan(1000);
    const rows = versionsOf(e.db, HB.id);
    expect(ms(rows[0]!['effective_to'])).toBe(Date.parse(out.effective_from));
  });

  it('publishes ONE catalog.changed.v1 {analyte, entity_id = analyte id, versioned, effective_from = the version\'s} and stamps the owner test\'s orderable — same tx', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    await publish(e, HB_V2.id, pBody({ effective_from: T1 }));
    expect(only(e.db)).toHaveLength(1);
    expect(only(e.db)[0]).toMatchObject({ catalog_revision: 418, entity_type: 'analyte', entity_id: HB.id, change_kind: 'versioned', effective_from: T1 });
    expect(e.db.revisionOf(TENANT_A)).toBe(418);
    expect(orderableRev(e.db, CBC.test.id)).toBe(418);
    expect(orderableRev(e.db, MICRO.test.id)).toBe(0);
    const mine = e.db.stmts.filter((s) => s.tenantId === TENANT_A);
    expect(new Set(mine.map((x) => x.txId)).size).toBe(1);
    const ev = mine.findIndex((s) => /INSERT INTO core\.event_log/i.test(s.text));
    const upd = mine.map((s, i) => (/^\s*UPDATE\s+catalog\.analyte_versions\b/i.test(s.text) ? i : -1)).filter((i) => i >= 0);
    expect(upd.length).toBeGreaterThanOrEqual(2);                              // predecessor + the published version
    expect(Math.max(...upd)).toBeLessThan(ev);
  });

  it('the first version of a new analyte publishes with no predecessor to supersede', { timeout: T }, async () => {
    const e = setup7();
    const a = await create(e, aBody());
    const out = await publish(e, a.draft_version_id, pBody({ change_reason: 'initial release' }), 1);
    expect(out).toMatchObject({ version_no: 1, status: 'published', change_reason: 'initial release' });
    expect((await get(e, a.id)).current_version).toMatchObject({ id: a.draft_version_id, status: 'published' });
    expect(events(e.db)).toHaveLength(2);                                      // created + versioned
    expect(only(e.db)[1]).toMatchObject({ entity_type: 'analyte', entity_id: a.id, change_kind: 'versioned', catalog_revision: 419 });
  });

  it('scheduled chain: v2 at T+1d then v3 at T+2d supersedes v2 (effective_to = v3.from) and leaves v1 closed at v2.from; v3 before v2.from is refused', { timeout: T }, async () => {
    const d1 = at(DAY), d2 = at(2 * DAY);
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    await publish(e, HB_V2.id, pBody({ effective_from: d1 }));
    const d3 = (await draft(e, HB.id)).id;                                     // copies v2
    lims(await rejection(publish(e, d3, pBody({ effective_from: at(DAY / 2) }))), 'common.validation_failed', 400);
    await publish(e, d3, pBody({ effective_from: d2 }));
    const rows = versionsOf(e.db, HB.id);
    expect(rows.map((r) => r['status'])).toEqual(['superseded', 'superseded', 'published']);
    expect(ms(rows[0]!['effective_to'])).toBe(Date.parse(d1));
    expect(ms(rows[1]!['effective_to'])).toBe(Date.parse(d2));
    expect(rows[2]!['effective_to']).toBeNull();
  });

  // ---- AC-03.3 no back-dating
  it('AC-03.3: an effective_from more than 300 s in the past -> 400 path /effective_from; nothing changes', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const bad of [at(-301 * SEC), at(-DAY), '2020-01-01T00:00:00.000Z', T0]) {
      const x = await rejection(publish(e, HB_V2.id, pBody({ effective_from: bad })));
      lims(x, 'common.validation_failed', 400);
      expect(errPaths(x)).toContain('/effective_from');
    }
    expect(snap(e.db)).toBe(before);
  });

  it('AC-03.3: within the 300 s tolerance (299 s back) and in the future are accepted', { timeout: T }, async () => {
    for (const ok of [at(-299 * SEC), at(0), at(DAY)]) {
      const e = setup7({ t6: { analyte_versions: [HB_V2] } });
      expect((await publish(e, HB_V2.id, pBody({ effective_from: ok }))).effective_from).toBe(ok);
    }
  });

  it('a malformed effective_from (not UTC-ms ISO, wrong type) -> 400 path /effective_from', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const bad of ['tomorrow', '2026-12-01', '2026-12-01T00:00:00Z', '2026-12-01T00:00:00.000+05:45', '2026-13-01T00:00:00.000Z', '', 0, null, {}]) {
      const x = await rejection(publish(e, HB_V2.id, pBody({ effective_from: bad })));
      validation400(x);
      if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain('/effective_from');
    }
    expect(snap(e.db)).toBe(before);
  });

  it('effective_from must be strictly AFTER the predecessor\'s (a scheduled predecessor): equal or earlier -> 400 /effective_from; one millisecond later -> ok', { timeout: T }, async () => {
    const sched = pubOf(1, HB.id, { effective_from: new Date(T1), published_at: new Date(T0) });
    const mk = () => world([HB], [sched, HB_V2]);
    for (const bad of [T1, '2026-11-30T00:00:00.000Z', at(0)]) {
      const e = mk();
      const x = await rejection(publish(e, HB_V2.id, pBody({ effective_from: bad })));
      lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/effective_from');
      expect(e.db.row('analyte_versions', HB_V2.id)!['status']).toBe('draft');
    }
    const e = mk();
    await publish(e, HB_V2.id, pBody({ effective_from: '2026-12-01T00:00:00.001Z' }));
    expect(ms(e.db.row('analyte_versions', sched.id)!['effective_to'])).toBe(Date.parse('2026-12-01T00:00:00.001Z'));
  });

  // ---- AC-03.5
  it.each([
    ['the unit changes', { unit_code: 'mg_dl' }],
    ['the method changes', { method_id: M2.id }],
    ['the unit is removed', { unit_code: null }],
    ['the method is removed', { method_id: null }],
  ])('AC-03.5: %s and no reference_range_set_id / allow_without_ranges -> 400 path /reference_range_set_id; nothing changes', { timeout: T }, async (_n, over) => {
    const e = world([HB], [HB_V1, draftOf(2, HB.id, over)]); const before = snap(e.db);
    for (const b of [pBody(), pBody({ allow_without_ranges: false })]) {
      const x = await rejection(publish(e, ID(0x4002), b));
      lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/reference_range_set_id');
    }
    expect(snap(e.db)).toBe(before);
  });

  it('AC-03.5: allow_without_ranges: true lets a unit/method change publish; so does a decimals-only change, and a first version', { timeout: T }, async () => {
    const a = world([HB], [HB_V1, draftOf(2, HB.id, { unit_code: 'mg_dl', method_id: M2.id })]);
    expect((await publish(a, ID(0x4002), pBody({ allow_without_ranges: true }))).status).toBe('published');
    const b = setup7({ t6: { analyte_versions: [HB_V2] } });                    // only decimals differ
    expect((await publish(b, HB_V2.id)).status).toBe('published');
    const c = setup7();
    const fresh = await create(c, aBody());
    expect((await publish(c, fresh.draft_version_id)).status).toBe('published');
  });

  // ---- AC-02.6 / AC-02.3 at publish (defence in depth: the CHECKs allow some of these states)
  const NEW = ana(10, TENANT_A, CBC.test.id, { code: 'URINE_NIT' });
  const first = (o: any) => draftOf(10, NEW.id, { version_no: 1, unit_code: null, method_id: null, ...o });
  it.each([
    ['ordinal + an UNORDERED set', first({ result_type: 'ordinal', value_set_code: 'POS_NEG', decimals: null }), '/value_set_code'],
    ['ordinal + a set that does not exist', first({ result_type: 'ordinal', value_set_code: 'NOPE', decimals: null }), '/value_set_code'],
    ['ordinal + tenant B\'s set', first({ result_type: 'ordinal', value_set_code: 'B_ORD', decimals: null }), '/value_set_code'],
    ['ordinal without a value set (row bypassing the CHECK)', first({ result_type: 'ordinal', value_set_code: null, decimals: null }), '/value_set_code'],
    ['coded without a value set (row bypassing the CHECK)', first({ result_type: 'coded', value_set_code: null, decimals: null }), '/value_set_code'],
    ['numeric without decimals (row bypassing the CHECK)', first({ result_type: 'numeric', decimals: null }), '/decimals'],
  ])('AC-02.6 at publish: %s -> 400 at %s; the draft stays a draft', { timeout: T }, async (_n, row, path) => {
    const e = world([NEW], [row]); const before = snap(e.db);
    const x = await rejection(publish(e, ID(0x400a)));
    lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('AC-02.6 at publish: ordinal + an ordered set publishes', { timeout: T }, async () => {
    for (const vs of ['URINE_SEMIQ', 'MY_ORD']) {
      const e = world([NEW], [first({ result_type: 'ordinal', value_set_code: vs, decimals: null })]);
      expect((await publish(e, ID(0x400a))).status).toBe('published');
    }
  });

  describe('AC-02.3 — at most one active reportable narrative analyte for narrative/microbiology/anatomic/molecular tests', () => {
    const narr = { result_type: 'narrative', decimals: null, unit_code: null, method_id: null };
    const N1 = (o: any = {}) => ana(11, TENANT_A, MICRO.test.id, { code: 'NARR1', ...o });
    const N2 = ana(12, TENANT_A, MICRO.test.id, { code: 'NARR2' });
    const N1V = pubOf(11, ID(0x300b), { ...narr });
    const N2V = draftOf(12, N2.id, { version_no: 1, ...narr });
    it('a second narrative analyte on a microbiology test -> 400 path /result_type; nothing changes', { timeout: T }, async () => {
      const e = world([N1(), N2], [N1V, N2V]); const before = snap(e.db);
      const x = await rejection(publish(e, N2V.id));
      lims(x, 'common.validation_failed', 400); expect(errPaths(x)).toContain('/result_type');
      expect(snap(e.db)).toBe(before);
    });
    it('is allowed when the other narrative analyte is not reportable, or inactive, or on a standard-workflow test', { timeout: T }, async () => {
      for (const other of [{ is_reportable: false }, { is_active: false }]) {
        const e = world([N1(other), N2], [N1V, N2V]);
        expect((await publish(e, N2V.id)).status).toBe('published');
      }
      const std = ana(13, TENANT_A, CBC.test.id, { code: 'NARR3' }), std2 = ana(14, TENANT_A, CBC.test.id, { code: 'NARR4' });
      const e = world([std, std2], [pubOf(13, std.id, narr), draftOf(14, std2.id, { version_no: 1, ...narr })]);
      expect((await publish(e, ID(0x400e))).status).toBe('published');
    });
    it('a NEW version of the one narrative analyte itself is not a second narrative analyte', { timeout: T }, async () => {
      const e = world([N1()], [N1V, draftOf(15, ID(0x300b), { version_no: 2, ...narr })]);
      expect((await publish(e, ID(0x400f), pBody({ allow_without_ranges: true }))).status).toBe('published');
    });
  });

  // ---- V-state errors, body validation
  it.each([['published', HB_V1], ['superseded', pubOf(5, HB.id, { version_no: 5, status: 'superseded', effective_to: new Date(T1) })], ['discarded', draftOf(6, HB.id, { version_no: 6, status: 'discarded' })]] as const)(
    'publishing a %s version -> 409 catalog.version_in_use; nothing changes', { timeout: T }, async (_s, row) => {
      const e = world([HB], [row]); const before = snap(e.db);
      lims(await rejection(publish(e, row.id)), 'catalog.version_in_use', 409);
      expect(snap(e.db)).toBe(before);
    });

  it('If-Match: absent -> 428, stale -> 409 common.version_conflict, malformed -> 400', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    lims(await rejection(e.db.run((ctx) => e.svc['publishAnalyteVersion']!(ctx, { id: HB_V2.id, body: pBody() }))), 'common.precondition_required', 428);
    lims(await rejection(publish(e, HB_V2.id, pBody(), 3)), 'common.version_conflict', 409);
    for (const bad of [0, 1.5, '1', null]) validation400(await rejection(publish(e, HB_V2.id, pBody(), bad)));
    expect(snap(e.db)).toBe(before);
  });

  it.each([
    ['missing change_reason', { change_reason: undefined }, '/change_reason'], ['empty change_reason', { change_reason: '' }, '/change_reason'],
    ['501-char change_reason', { change_reason: 'r'.repeat(501) }, '/change_reason'], ['non-string change_reason', { change_reason: 7 }, '/change_reason'],
    ['non-boolean allow_without_ranges', { allow_without_ranges: 'yes' }, '/allow_without_ranges'], ['non-uuid reference_range_set_id', { reference_range_set_id: 'x' }, '/reference_range_set_id'],
    ['non-uuid critical_limit_set_id', { critical_limit_set_id: 'x' }, '/critical_limit_set_id'],
  ])('%s -> 400 at %s; nothing changes', { timeout: T }, async (_n, over, path) => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    const x = await rejection(publish(e, HB_V2.id, pBody(over)));
    validation400(x);
    if (x.code === 'common.validation_failed') expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('a 500-char change_reason is accepted and stored verbatim', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const reason = 'r'.repeat(500);
    expect((await publish(e, HB_V2.id, pBody({ change_reason: reason }))).change_reason).toBe(reason);
  });

  it('S-5: status, version_no, analyte_id, tenant_id, published_*, unit_code, id, version in the body -> 400; nothing changes', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const extra of [{ status: 'superseded' }, { version_no: 9 }, { analyte_id: HB_B.id }, { tenant_id: TENANT_B }, { published_by: ID(1) }, { published_at: at(0) }, { unit_code: 'x' }, { id: ID(1) }, { version: 9 }]) {
      validation400(await rejection(publish(e, HB_V2.id, pBody(extra))));
    }
    expect(snap(e.db)).toBe(before);
  });

  it('S-1: tenant B\'s version / unknown -> 404; malformed -> 400; B\'s published version is untouched', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } }); const before = snap(e.db);
    for (const id of [ID(0x4004), ID(0xdead)]) notFound(await rejection(publish(e, id)));
    validation400(await rejection(publish(e, 'nope')));
    expect(snap(e.db)).toBe(before);
  });

  // ---- atomicity, concurrency
  it('atomic: rollback, a failing event insert, or a failing UPDATE leaves the draft a draft, the predecessor published and open-ended, revision 417, orderable unstamped', { timeout: T }, async () => {
    const mk = () => setup7({ t6: { analyte_versions: [HB_V2] } });
    const a = mk(); await rejection(publish(a, HB_V2.id, pBody(), 1, { rollback: true }));
    const b = mk(); b.db.fail(/INSERT INTO core\.event_log/i); await rejection(publish(b, HB_V2.id));
    const c = mk(); c.db.fail(/UPDATE catalog\.analyte_versions/i); await rejection(publish(c, HB_V2.id));
    for (const { db } of [a, b, c]) {
      expect(db.row('analyte_versions', HB_V2.id)).toMatchObject({ status: 'draft', version: 1, published_at: null });
      expect(db.row('analyte_versions', HB_V1.id)).toMatchObject({ status: 'published', version: 1, effective_to: null });
      expect(events(db)).toHaveLength(0); expect(db.revisionOf(TENANT_A)).toBe(417); expect(orderableRev(db, CBC.test.id)).toBe(0);
    }
  });

  it('two concurrent publishes of the same draft: exactly one succeeds, the other is 409; the predecessor is superseded once; one event; revision 418', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const r = await Promise.allSettled([publish(e, HB_V2.id), publish(e, HB_V2.id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const bad = (r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
    expect(bad.statusCode).toBe(409);
    expect(['catalog.version_in_use', 'common.version_conflict']).toContain(bad.code);
    const rows = versionsOf(e.db, HB.id);
    expect(rows.map((x) => x['status'])).toEqual(['superseded', 'published']);
    expect(rows[0]!['version']).toBe(2);
    expect(only(e.db)).toHaveLength(1); expect(e.db.revisionOf(TENANT_A)).toBe(418);
  });

  it('publishes of two different analytes at once: both succeed, gapless revisions 418 and 419, one event each', { timeout: T }, async () => {
    const rbc2 = draftOf(7, RBC.id, { unit_code: '10e12_l', decimals: 3 });
    const e = setup7({ t6: { analyte_versions: [HB_V2, rbc2] } });
    await Promise.all([publish(e, HB_V2.id), publish(e, rbc2.id)]);
    expect(only(e.db).map((p) => p.catalog_revision).sort()).toEqual([418, 419]);
    expect(only(e.db).map((p) => p.entity_id).sort()).toEqual([HB.id, RBC.id].sort());
    expect(e.db.revisionOf(TENANT_A)).toBe(419);
  });

  // ---- SQL hygiene
  it('REQ-SEC-082 / defence in depth: every SELECT/UPDATE on analytes / analyte_versions carries an explicit tenant_id = $n; values are bound, never inlined', { timeout: T }, async () => {
    const planted = "O'Brien'; DROP TABLE catalog.analytes; --";
    const e = setup7();
    const a = await create(e, aBody({ name: planted }));
    await patchA(e, a.id, { print_name: planted });
    await get(e, a.id);
    const d = await draft(e, HB.id);
    await patchV(e, d.id, { decimals: 3 });
    await publish(e, d.id, pBody({ change_reason: planted }), 2);
    await discard(e, a.draft_version_id);
    const stmts = aStmts(e.db);
    expect(stmts.length).toBeGreaterThan(8);
    for (const s of stmts) {
      const t = s.text.replace(/\s+/g, ' ');
      if (/^\s*(SELECT|UPDATE)/i.test(t)) expect(t, t).toMatch(/\btenant_id\s*=\s*\$\d+/i);
      expect(t).not.toContain('DROP TABLE'); expect(t).not.toContain("O'Brien");
      expect(t).not.toMatch(/'[0-9a-f]{8}-[0-9a-f]{4}-/i);                    // no uuid literal inlined
    }
    expect(e.db.row('analytes', a.id)!['name']).toBe(planted);
    expect(versionsOf(e.db, HB.id).at(-1)!['change_reason']).toBe(planted);
  });

  it('a tenant-B session cannot touch tenant A\'s analytes at all (RLS + predicate): 404 on every operation', { timeout: T }, async () => {
    const e = setup7({ t6: { analyte_versions: [HB_V2] } });
    const b = (fn: (ctx: any) => Promise<unknown>) => rejection(e.db.run(fn, { tenantId: TENANT_B }));
    notFound(await b((c) => e.svc['getAnalyte']!(c, { id: HB.id })));
    notFound(await b((c) => e.svc['updateAnalyte']!(c, { id: HB.id, expectedVersion: 1, patch: { name: 'x' } })));
    notFound(await b((c) => e.svc['createAnalyteVersionDraft']!(c, { analyte_id: HB.id })));
    notFound(await b((c) => e.svc['updateAnalyteVersionDraft']!(c, { id: HB_V2.id, expectedVersion: 1, patch: { decimals: 4 } })));
    notFound(await b((c) => e.svc['publishAnalyteVersion']!(c, { id: HB_V2.id, expectedVersion: 1, body: pBody() })));
    notFound(await b((c) => e.svc['discardAnalyteVersionDraft']!(c, { id: HB_V2.id, expectedVersion: 1 })));
    notFound(await b((c) => e.svc['createAnalyte']!(c, { test_id: CBC.test.id, body: aBody({ code: 'newone' }) })));
    expect(e.db.row('analyte_versions', HB_V2.id)).toMatchObject({ status: 'draft', version: 1 });
  });
});
