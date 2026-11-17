// C10 T-10 — AST panels + AST entry: M11 assignAstPanel, M12 recordAstResults, M29 listAstPanels, M30 createAstPanel, M31 versionAstPanel, M32 deactivateAstPanel WITHOUT a database
// (06-IMPLEMENTATION-PLAN row T-10; 02-TRD §4.2 panel precedence, §4.3 raw value, §4.4 interpretation rules 0–4, §5 M11/M12/M29–M32, §5.6 IsolateDto / AstResultDto / AstPanelDto, §10 p95, §12 SQLSTATE mapping,
// §13 rules; 05-SCHEMA §8 ast_panels / ast_panel_antibiotics / ast_results; PRD AC-06.1–06.6, AC-06.3a, AC-16.1; 07-SECURITY T-A1, T-A3, T-A4, T-A8, T-E1, S-01, S-03, S-05, S-09, S-23).
// DB behaviour (real constraints, RLS centre scope, audit trail, 10x seed p95) is in ast.writes.integration.test.ts (live DB, gated with LIMS_T10_REQUIRE_DB=1).
// SEAMS: handlers assignAstPanel / recordAstResults / listAstPanels / createAstPanel / versionAstPanel / deactivateAstPanel in handlers/index.ts REAL map (any file layout; service/ast.service.ts,
//   repository/ast.repo.ts per plan). The tx is the fake of helpers/astWrites.ts: single-table SELECTs (equalities, IS NULL, = TRUE; no JOIN / OR), INSERT / UPDATE, SAVEPOINT emulation incl. 25P02 after an error.
//   Permission: M11 / M12 load the isolate (and its culture) FIRST, THEN IdentityPort.assertRole(ctx, { permission: 'micro.culture.work', centreId: <isolate centre_id> }) (02-CV §10.1); M29 asks
//   micro.culture.read, M30–M32 micro.config.manage (D-64). M11 takes If-Match "<isolate version>" (428 / 409); M12 has none (per-entry `version`); M31 / M32 take If-Match "<panel version>".
//   Lock order (T-09 review): culture row FOR UPDATE, then isolate row FOR UPDATE. Panel precedence reads v_organisms.organism_group_code and cultures.specimen_site_code; the pure rule is domain/selection.ts.
//   Per-entry outcomes: HTTP 200 + results[i] = { antibiotic_code, method, outcome: 'ok'|'error', code?, path?, ast_result? } in request order; every entry that writes does so inside its own SAVEPOINT.
//   Value / interpretation rules are the pure domain/ast-value.ts and domain/interpretation.ts (catalog: g_cs_ast_interpretations, g_ast_category_restrictions).
// ASSUMED (spec silent; flagged so a ruling can overrule): M11 on a pending_id / withdrawn isolate = 409 micro.isolate_invalid_transition, on a cancelled culture 409 micro.culture_invalid_transition
//   (as T-09); M12 on a withdrawn isolate = 409 micro.isolate_invalid_transition; a panel id of another tenant or a missing one = 404, a same-tenant panel that is superseded / deactivated and not the isolate's
//   own = 400 common.id_mismatch (TRD §13); row method = the antibiotic's own method, else body.method, else panel.default_method; re-assigning a panel never deletes or overwrites an AST row;
//   an antibiotic code outside v_antibiotics = per-entry common.validation_failed /entries/<n>/antibiotic_code (even with add_to_isolate); a concurrent duplicate insert of an entry = per-entry
//   common.version_conflict; a duplicate antibiotic+method inside a panel body = 400 /antibiotics/<n>/antibiotic_code; M29 filters organism_code / organism_group_code match the panel's own scope columns exactly.
//   M12 token `accept_suggestion` / `breakpoint_band_id` (TRD §4.5) belongs to the breakpoint work (T-13) and is not covered here.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { failure, MANAGE, mkCtx, READ, responseErrors, run, schemaErrors, specOps, spec, WORK, type Row } from './helpers/cultureReads.js';
import { astTx, iso, NOW, writesOf, type World } from './helpers/astWrites.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CENTRE_A1 = u(0xa1), CENTRE_B1 = u(0xb1);
const ACTOR_USER = '01a1b34e-1000-7eee-9d29-d7ca59a10001', ACTOR_M = '01a1a98a-ac40-7000-8000-00000000a500';
const ORDER = u(0x801), ITEM = u(0x802), TEST1 = u(0x701);
const SITE_A = 'syn_site_a', SITE_B = 'syn_site_b';
const ECOLI = 'syn_ecoli', STAPH = 'syn_staph', KLEB = 'syn_kleb', GNR = 'syn_gnr', GPC = 'syn_gpc';
const S = { rec: u(0x901), eco: u(0x902), siteB: u(0x903), nosite: u(0x904), final: u(0x905), canc: u(0x906), b: u(0x907), conc: u(0x908) };
const C = { rec: u(0x1001), eco: u(0x1002), siteB: u(0x1003), nosite: u(0x1004), final: u(0x1005), canc: u(0x1006), b: u(0x1007), conc: u(0x1008) };
const I = { rec: u(0x3001), eco: u(0x3002), kleb: u(0x3003), siteB: u(0x3004), nosite: u(0x3005), pend: u(0x3006), wd: u(0x3007), final: u(0x3008), canc: u(0x3009), b: u(0x300a), own: u(0x300b), conc: u(0x300c) };
const P = { oSite: u(0x5001), o: u(0x5002), gSite: u(0x5003), g: u(0x5004), site: u(0x5005), any: u(0x5006), rec: u(0x5007), oldV1: u(0x5008), dead: u(0x5009), bPanel: u(0x500a), tieB: u(0x500b), tieA: u(0x500c), tieIdHi: u(0x500e), tieIdLo: u(0x500d), cfg: u(0x500f), cfgOld: u(0x5010) };
const AST = { amp: u(0x4001), cip: u(0x4002), col: u(0x4003), zone: u(0x4004), sup: u(0x4005), tob: u(0x4006) };
const PLANTED = '2026-11-04T05:00:00.000Z';
const NOW_ISO = NOW.toISOString();

// ------------------------------------------------------------------ world
const culture = (id: string, status: string, specimen: string, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, order_id: ORDER, order_item_id: ITEM, specimen_id: specimen, patient_id: u(0xa00), test_id: TEST1, specimen_type_code: 'urine',
  specimen_site_code: SITE_A, barcode_snapshot: null, plating_protocol_id: null, status, outcome_code: null, received_at: new Date('2026-11-04T04:00:00.000Z'), planted_at: new Date(PLANTED),
  next_read_due_at: null, final_due_at: null, last_specimen_seq: 1, current_report_version_no: 0, last_report_phase: null, chain_cancelled: false, amendment_reason_code: null, amendment_reason_text: null,
  cancel_reason_code: null, cancel_comment: null, cancelled_at: null, version: 5, is_active: true, created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
const isolate = (id: string, cultureId: string, specimen: string, seq: number, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, culture_id: cultureId, specimen_id: specimen, isolate_seq: seq, plate_id: null, status: 'identified', organism_code: ECOLI, organism_source: 'manual',
  identified_at: new Date('2026-11-04T09:00:00.000Z'), identified_by_membership_id: ACTOR_M, colony_description: 'Synthetic colony', quantity_text: 'Synthetic few', is_reportable: true, withdraw_reason_code: null,
  withdraw_comment: null, ast_panel_id: null, ast_method: null, version: 3, is_active: true, created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
const panel = (id: string, code: string, over: Row = {}): Row => ({
  id, tenant_id: A, code, version_no: 1, display: `Synthetic ${code}`, organism_code: null, organism_group_code: null, specimen_site_code: null, default_method: 'mic', superseded_at: null, version: 1, is_active: true,
  created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
const pabx = (panelId: string, n: number, abx: string, over: Row = {}): Row => ({
  id: u(0x6000 + parseInt(panelId.slice(-4), 16) * 0x10 + n), tenant_id: A, panel_id: panelId, antibiotic_code: abx, sort_order: n, method: null, is_reported_default: true, version: 1, is_active: true,
  created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
const astRow = (id: string, isolateId: string, cultureId: string, abx: string, method: string, order: number, over: Row = {}): Row => ({
  id, tenant_id: A, centre_id: CENTRE_A1, culture_id: cultureId, isolate_id: isolateId, antibiotic_code: abx, method, raw_value: null, raw_qualifier: null, raw_numeric: null, unit_code: null, category_code: null,
  standard: null, standard_version: null, standard_source: null, interpretation_raw: null, interpretation_source: null, breakpoint_set_id: null, breakpoint_band_id: null, suggestion_overridden: false, source: 'manual',
  instrument_record_id: null, instrument_id: null, instrument_result_time: null, is_reportable: true, report_visibility: 'shown', off_panel: false, panel_sort_order: order, entered_by_membership_id: null,
  entered_at: null, version: 1, is_active: true, created_at: new Date(PLANTED), created_by: ACTOR_USER, updated_at: new Date(PLANTED), updated_by: ACTOR_USER, ...over,
});
/** the six precedence panels (each with two antibiotics) — mkWorld(keys) includes only the named ones */
const PRECEDENCE: Record<string, Row> = {
  oSite: panel(P.oSite, 'syn_p_o_site', { organism_code: ECOLI, specimen_site_code: SITE_A }), o: panel(P.o, 'syn_p_o', { organism_code: ECOLI }),
  gSite: panel(P.gSite, 'syn_p_g_site', { organism_group_code: GNR, specimen_site_code: SITE_A }), g: panel(P.g, 'syn_p_g', { organism_group_code: GNR }),
  site: panel(P.site, 'syn_p_site', { specimen_site_code: SITE_A }), any: panel(P.any, 'syn_p_any'),
};
const ID_OF: Record<string, string> = { oSite: P.oSite, o: P.o, gSite: P.gSite, g: P.g, site: P.site, any: P.any };

function mkWorld(keys: readonly string[] = []): World {
  const panels = [...keys.map((k) => PRECEDENCE[k]!), panel(P.rec, 'syn_p_rec', { organism_code: STAPH, specimen_site_code: SITE_B, default_method: 'mic' })];
  const abx = panels.flatMap((p) => (p['id'] === P.rec
    ? [pabx(P.rec, 0, 'syn_amp'), pabx(P.rec, 1, 'syn_cip'), pabx(P.rec, 2, 'colistin'), pabx(P.rec, 3, 'syn_zone', { method: 'zone_diameter' }), pabx(P.rec, 4, 'syn_sup'), pabx(P.rec, 5, 'syn_tob', { is_reported_default: false })]
    : [pabx(p['id'], 0, 'syn_amp'), pabx(p['id'], 1, 'syn_cip', { method: 'zone_diameter' }), pabx(p['id'], 2, 'syn_tob', { is_reported_default: false })]));
  return {
    cultures: [culture(C.rec, 'growth_detected', S.rec, { specimen_site_code: SITE_B }), culture(C.eco, 'growth_detected', S.eco), culture(C.siteB, 'growth_detected', S.siteB, { specimen_site_code: SITE_B }),
      culture(C.nosite, 'growth_detected', S.nosite, { specimen_site_code: null }), culture(C.final, 'final_submitted', S.final, { outcome_code: 'syn_positive', current_report_version_no: 1 }),
      culture(C.canc, 'cancelled', S.canc, { cancel_reason_code: 'syn_reason', cancelled_at: new Date(PLANTED) }), culture(C.b, 'growth_detected', S.b, { tenant_id: B, centre_id: CENTRE_B1 }),
      culture(C.conc, 'growth_detected', S.conc)],
    culture_plates: [], culture_transitions: [], culture_observations: [], instrument_records: [], report_versions: [], settings: [], specimen_isolate_counters: [],
    isolates: [
      isolate(I.rec, C.rec, S.rec, 1, { organism_code: STAPH, ast_panel_id: P.rec, ast_method: 'mic', version: 4 }), isolate(I.eco, C.eco, S.eco, 1), isolate(I.kleb, C.eco, S.eco, 2, { organism_code: KLEB }),
      isolate(I.siteB, C.siteB, S.siteB, 1), isolate(I.nosite, C.nosite, S.nosite, 1), isolate(I.pend, C.eco, S.eco, 3, { status: 'pending_id', organism_code: null, organism_source: null, identified_at: null, identified_by_membership_id: null, version: 1 }),
      isolate(I.wd, C.eco, S.eco, 4, { status: 'withdrawn', withdraw_reason_code: 'duplicate', version: 4 }), isolate(I.final, C.final, S.final, 1, { version: 4 }), isolate(I.canc, C.canc, S.canc, 1),
      isolate(I.b, C.b, S.b, 1, { tenant_id: B, centre_id: CENTRE_B1 }), isolate(I.own, C.eco, S.eco, 5, { ast_panel_id: P.oldV1, ast_method: 'mic' }), isolate(I.conc, C.conc, S.conc, 1),
    ],
    ast_panels: [...panels, panel(P.oldV1, 'syn_p_old', { organism_code: ECOLI, superseded_at: new Date('2026-11-03T05:00:00.000Z'), is_active: true }),
      panel(P.dead, 'syn_p_dead', { organism_code: ECOLI, specimen_site_code: SITE_A, is_active: false }), panel(P.bPanel, 'syn_p_b', { tenant_id: B, organism_code: ECOLI, specimen_site_code: SITE_A })],
    ast_panel_antibiotics: [...abx, pabx(P.oldV1, 0, 'syn_amp'), pabx(P.dead, 0, 'syn_amp')],
    ast_results: [
      astRow(AST.amp, I.rec, C.rec, 'syn_amp', 'mic', 0), astRow(AST.cip, I.rec, C.rec, 'syn_cip', 'mic', 1, { raw_value: '1', raw_qualifier: '=', raw_numeric: '1', unit_code: 'ug_ml', version: 3 }),
      astRow(AST.col, I.rec, C.rec, 'colistin', 'mic', 2), astRow(AST.zone, I.rec, C.rec, 'syn_zone', 'zone_diameter', 3),
      astRow(AST.sup, I.rec, C.rec, 'syn_sup', 'mic', 4, { raw_value: '4', raw_qualifier: '=', raw_numeric: '4', unit_code: 'ug_ml', report_visibility: 'suppressed_by_rule', version: 2 }),
      astRow(AST.tob, I.rec, C.rec, 'syn_tob', 'mic', 5, { is_reportable: false }),
    ],
    v_organisms: [{ code: ECOLI, display: 'Synthetic E. coli', organism_group_code: GNR, is_active: true }, { code: STAPH, display: 'Synthetic S. aureus', organism_group_code: GPC, is_active: true },
      { code: KLEB, display: 'Synthetic Klebsiella', organism_group_code: null, is_active: true }],
    v_organism_groups: [{ code: GNR, display: 'Synthetic GNR', is_active: true }, { code: GPC, display: 'Synthetic GPC', is_active: true }],
    v_specimen_sites: [{ code: SITE_A, display: 'Synthetic site A', is_active: true }, { code: SITE_B, display: 'Synthetic site B', is_active: true }],
    v_antibiotics: ['syn_amp', 'syn_cip', 'colistin', 'polymyxin_b', 'syn_zone', 'syn_sup', 'syn_tob', 'syn_extra', 'syn_extra2', 'syn_extra3'].map((code) => ({ code, display: `Synthetic ${code}`, is_active: true })),
    v_media: [], v_growth_codes: [], v_isolate_withdraw_reasons: [],
    g_cs_ast_interpretations: [...['S', 'SDD', 'I', 'I^', 'R', 'NS'].map((code) => ({ standard: 'CLSI', code, is_active: true })), ...['S', 'I', 'R'].map((code) => ({ standard: 'EUCAST', code, is_active: true })),
      ...['WT', 'NWT'].map((code) => ({ standard: 'ECOFF', code, is_active: true })), { standard: 'CLSI', code: 'OLD', is_active: false }],
    g_ast_category_restrictions: [{ standard: 'CLSI', antibiotic_code: 'colistin', allowed_codes: ['I', 'R'], is_active: true }, { standard: 'CLSI', antibiotic_code: 'polymyxin_b', allowed_codes: ['I', 'R'], is_active: true }],
  };
}
const row = (w: World, table: string, id: string): Row => w[table]!.find((r) => r['id'] === id)!;
const astOf = (w: World, isolateId: string) => w['ast_results']!.filter((r) => r['isolate_id'] === isolateId);
const astBy = (w: World, isolateId: string, abx: string, method = 'mic') => astOf(w, isolateId).find((r) => r['antibiotic_code'] === abx && r['method'] === method)!;

function setup(w: World, grants: readonly string[] = [WORK]) {
  const { tx, log, open, aborted } = astTx(w);
  const { ctx, calls } = mkCtx({ tenantId: A, tx, grants, members: { [ACTOR_M]: 'Synthetic Actor Tech' }, users: { [ACTOR_USER]: 'Synthetic Actor User' }, tests: { [TEST1]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
  const published: unknown[] = []; const logs: unknown[] = [];
  ctx.events = { publish: async (...a: unknown[]) => { published.push(a); return { eventId: 'e', duplicate: false }; } };
  const sink = (...a: unknown[]) => { logs.push(a); };
  ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } };
  return { ctx, calls, log, published, logs, w, open, aborted };
}
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const KEY = { 'idempotency-key': 'syn-key-1' };
const M11 = (isolateId: string, body: Row, headers: Row) => ({ params: { isolate_id: isolateId }, headers: { ...KEY, ...headers }, body });
const assign = (id: string, v: number, body: Row = {}) => M11(id, body, ifm(v));
const M12 = (isolateId: string, entries: Row[], body: Row = {}) => ({ params: { isolate_id: isolateId }, headers: { ...KEY }, body: { entries, ...body } });
const entry = (abx: string, method = 'mic', over: Row = {}): Row => ({ antibiotic_code: abx, method, ...over });
const results = (res: any): Row[] => res.body.results;

const expectCode = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(status); };
const expectInvalid = (e: any, path?: string) => { expectCode(e, 'common.validation_failed', 400); if (path !== undefined) expect(e.errors?.map((x: any) => x.path), JSON.stringify(e.errors)).toContain(path); };
const errEntry = (r: Row, code: string, path?: string | RegExp) => {
  expect(r['outcome'], JSON.stringify(r)).toBe('error'); expect(r['code'], JSON.stringify(r)).toBe(code); expect(r['ast_result']).toBeUndefined();
  if (typeof path === 'string') expect(r['path']).toBe(path); else if (path) expect(r['path']).toMatch(path); else expect(typeof r['path']).toBe('string');
};
const okEntry = (r: Row) => { expect(r['outcome'], JSON.stringify(r)).toBe('ok'); expect(r['code']).toBeUndefined(); expect(r['path']).toBeUndefined(); expect(r['ast_result']).toBeDefined(); return r['ast_result'] as Row; };
const lockOrder = (log: { table: string; sql: string }[]) => {
  const at = (t: string) => log.findIndex((l) => l.table === t && /FOR\s+UPDATE/i.test(l.sql));
  return { culture: at('cultures'), isolate: at('isolates') };
};

// ------------------------------------------------------------------ contract pins (micro.yaml)
describe('C10-T10 contract pins (micro.yaml): permissions, idempotency, If-Match, errors, strict bodies, AC-16.1', () => {
  const OPS = {
    assignAstPanel: { perm: WORK, idem: 'required', ifMatch: true, errors: ['micro.isolate_invalid_transition', 'micro.report_final_locked', 'common.version_conflict', 'common.precondition_required'], dto: /IsolateDto$/ },
    recordAstResults: { perm: WORK, idem: 'required', ifMatch: false, errors: ['micro.report_final_locked'], dto: null },
    listAstPanels: { perm: READ, idem: 'none', ifMatch: false, errors: [], dto: null },
    createAstPanel: { perm: MANAGE, idem: 'required', ifMatch: false, errors: ['micro.code_duplicate'], dto: null },
    versionAstPanel: { perm: MANAGE, idem: 'required', ifMatch: true, errors: ['common.version_conflict', 'common.precondition_required'], dto: null },   // micro.code_duplicate is declared on M30 only
    deactivateAstPanel: { perm: MANAGE, idem: 'optional', ifMatch: true, errors: ['common.version_conflict', 'common.precondition_required'], dto: null },
  } as const;
  it.each(Object.entries(OPS))('%s: x-permission %s only, idempotency, If-Match as TRD §5 says, declared errors', (id, o) => {
    const op = specOps()[id];
    expect(op['x-permission']).toBe(o.perm);
    expect(op['x-idempotency']).toBe(o.idem);
    expect((op.parameters ?? []).some((p: any) => String(p.$ref ?? '').endsWith('/IfMatch'))).toBe(o.ifMatch);
    for (const c of ['common.not_found', 'common.validation_failed', ...o.errors]) expect(op['x-error-codes'], c).toContain(c);
    if (o.dto) expect(op.responses['200'].content['application/json'].schema.$ref).toMatch(o.dto);
  });

  it('M11 body = { ast_panel_id?, method? } strict; M12 body = { entries 1..60 } strict, entry carries no provenance / visibility field (S-05, T-A4, AC-16.1)', () => {
    const ops = specOps(); const body = (id: string) => ops[id].requestBody.content['application/json'].schema;
    expect(body('assignAstPanel').additionalProperties).toBe(false);
    expect(Object.keys(body('assignAstPanel').properties).sort()).toEqual(['ast_panel_id', 'method']);
    const b12 = body('recordAstResults'); const e = b12.properties.entries;
    expect(b12.additionalProperties).toBe(false); expect(b12.required).toEqual(['entries']);
    expect([e.minItems, e.maxItems]).toEqual([1, 60]);
    expect(e.items.additionalProperties).toBe(false);
    expect(e.items.required).toEqual(['antibiotic_code', 'method']);
    for (const forbidden of ['report_visibility', 'interpretation_source', 'standard_source', 'source', 'off_panel', 'entered_by', 'entered_by_membership_id', 'tenant_id', 'centre_id', 'culture_id', 'isolate_id', 'raw_qualifier', 'raw_numeric', 'unit_code'])
      expect(Object.keys(e.items.properties), forbidden).not.toContain(forbidden);
    expect(Object.keys(e.items.properties).sort()).toEqual(['accept_suggestion', 'add_to_isolate', 'antibiotic_code', 'breakpoint_band_id', 'category_code', 'is_reportable', 'method', 'qualifier_code', 'raw_value', 'standard', 'standard_version', 'version']);
  });

  it('AC-16.1: NO operation of micro.yaml accepts report_visibility — not in any request body (resolved $refs included), query or path parameter; v1 offers no API to set it', () => {
    const found: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: any, where: string): void => {
      if (node === null || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      if (typeof node['$ref'] === 'string' && node['$ref'].startsWith('#/')) walk(node['$ref'].slice(2).split('/').reduce((n: any, k: string) => n?.[k], spec), where);
      if (node['properties'] && 'report_visibility' in node['properties']) found.push(where);
      for (const [k, v] of Object.entries(node)) if (k !== 'examples') walk(v, where);
    };
    for (const [path, item] of Object.entries<any>(spec.paths)) for (const op of Object.values<any>(item)) {
      if (!op?.operationId) continue;
      for (const p of op.parameters ?? []) expect(p.name, `${op.operationId} parameter`).not.toBe('report_visibility');
      for (const c of Object.values<any>(op.requestBody?.content ?? {})) walk(c.schema, `${op.operationId} ${path}`);
    }
    expect(found).toEqual([]);
    const dto = spec.components.schemas.AstResultDto;                          // responses still carry it, read-only, with the two documented values
    expect(dto.required).toContain('report_visibility');
    expect(dto.properties.report_visibility.enum).toEqual(['shown', 'suppressed_by_rule']);
  });

  it('M30 / M31 body: antibiotics 1..60 { antibiotic_code, method?, is_reported_default }, no version_no / superseded_at / is_active / tenant_id; M31 has no `code`; M32 body is empty', () => {
    const ops = specOps(); const body = (id: string) => ops[id].requestBody?.content['application/json'].schema;
    const b30 = body('createAstPanel'); const b31 = body('versionAstPanel');
    for (const b of [b30, b31]) {
      expect(b.additionalProperties).toBe(false);
      expect([b.properties.antibiotics.minItems, b.properties.antibiotics.maxItems]).toEqual([1, 60]);
      for (const f of ['version_no', 'superseded_at', 'is_active', 'tenant_id', 'id', 'version']) expect(Object.keys(b.properties), f).not.toContain(f);
    }
    expect(Object.keys(b30.properties)).toContain('code');
    expect(Object.keys(b31.properties)).not.toContain('code');
    const b32 = body('deactivateAstPanel');
    expect(b32 === undefined || (b32.additionalProperties === false && Object.keys(b32.properties ?? {}).length === 0)).toBe(true);
    expect(ops['createAstPanel'].responses['201']).toBeDefined();
  });
});

// ------------------------------------------------------------------ M11 permission / BOLA / strictness
const M11_WRITES: [string, () => Row][] = [['assignAstPanel', () => assign(I.eco, 3)], ['recordAstResults', () => M12(I.rec, [entry('syn_amp', 'mic', { raw_value: '2' })])]];
describe('C10-T10 permissions (D-64) + BOLA (S-01): M11 / M12 need micro.culture.work with the isolate\'s centre, object first; another tenant = 404 like a missing one', () => {
  it.each(M11_WRITES)('%s without micro.culture.work (read-only / config-only) -> 403 auth.forbidden, asked for micro.culture.work with the isolate\'s centre_id AFTER the isolate was read; nothing written', async (op, req) => {
    for (const grants of [[READ], [MANAGE], []]) {
      const w = mkWorld(['o']); const before = structuredClone(w); const s = setup(w, grants);
      expectCode(await failure(run(op, req(), s.ctx)), 'auth.forbidden', 403);
      expect(s.calls.assertRole.at(-1), JSON.stringify(grants)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
      expect(s.log.length).toBeGreaterThan(0);
      expect(writesOf(s.log)).toEqual([]);
      expect(w).toEqual(before);
    }
  });

  it.each(M11_WRITES)('%s on an isolate of tenant B and on a random id: the same 404 common.not_found, no assertRole (no existence oracle), nothing written', async (op, req) => {
    const w1 = mkWorld(['o']); const w2 = mkWorld(['o']); const before = structuredClone(w1);
    const foreign = setup(w1); const missing = setup(w2);
    const sw = (r: Row, id: string): Row => ({ ...r, params: { isolate_id: id } });
    const e1 = await failure(run(op, sw(req(), I.b), foreign.ctx));
    const e2 = await failure(run(op, sw(req(), u(0x30ff)), missing.ctx));
    for (const e of [e1, e2]) expectCode(e, 'common.not_found', 404);
    expect({ code: e1.code, message: e1.message }).toEqual({ code: e2.code, message: e2.message });
    expect(writesOf(foreign.log)).toEqual([]);
    expect(w1).toEqual(before);
    expect(foreign.calls.assertRole).toEqual([]);
  });
});

// ------------------------------------------------------------------ M11 assignAstPanel
describe('C10-T10 M11 assignAstPanel — AC-06.1 panel precedence (organism + site) > (organism) > (group + site) > (group) > (site) > none, tie-break lowest code then id', () => {
  const ALL = ['oSite', 'o', 'gSite', 'g', 'site', 'any'];
  const LADDER: [string, string[], string][] = [
    ['(organism, site)', ALL, 'oSite'], ['(organism)', ALL.slice(1), 'o'], ['(group, site)', ALL.slice(2), 'gSite'], ['(group)', ALL.slice(3), 'g'], ['(site)', ALL.slice(4), 'site'], ['(any, any)', ALL.slice(5), 'any'],
  ];
  it.each(LADDER)('isolate E. coli (group syn_gnr) of a culture with site A: best level %s wins -> panel %s', async (_l, keys, winner) => {
    const w = mkWorld(keys); const s = setup(w);
    const res = await run('assignAstPanel', assign(I.eco, 3), s.ctx);
    expect(res.status).toBe(200);
    expect(row(w, 'isolates', I.eco)).toMatchObject({ ast_panel_id: ID_OF[winner], version: 4, updated_by: ACTOR_USER });
    expect(res.body.ast_panel).toMatchObject({ id: ID_OF[winner], code: PRECEDENCE[winner]!['code'], version_no: 1, display: PRECEDENCE[winner]!['display'] });
    expect(responseErrors('assignAstPanel', res.body)).toEqual([]);
    expect(s.calls.assertRole.at(-1)).toEqual({ permission: WORK, centreId: CENTRE_A1 });
  });

  it('no match at all -> 400 common.validation_failed /ast_panel_id (TRD §4.2, 08 A13 P-1); nothing written, isolate unchanged', async () => {
    const w = mkWorld([]); const before = structuredClone(w); const s = setup(w);
    expectInvalid(await failure(run('assignAstPanel', assign(I.eco, 3), s.ctx)), '/ast_panel_id');
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
  });

  it('a different site is excluded, no site on the culture excludes every site panel, an organism without a group skips group panels', async () => {
    const w1 = mkWorld(ALL); await run('assignAstPanel', assign(I.siteB, 3), setup(w1).ctx);                         // culture site B: (o,A) and (g,A) and (A) do not apply
    expect(row(w1, 'isolates', I.siteB)['ast_panel_id']).toBe(P.o);
    const w2 = mkWorld(['oSite', 'gSite', 'site', 'any']); await run('assignAstPanel', assign(I.nosite, 3), setup(w2).ctx);       // no site: only the site-less (any) panel is left
    expect(row(w2, 'isolates', I.nosite)['ast_panel_id']).toBe(P.any);
    const w3 = mkWorld(['g', 'gSite', 'site']); await run('assignAstPanel', assign(I.kleb, 3), setup(w3).ctx);                    // KLEB has no group: group panels skipped, (site) is next
    expect(row(w3, 'isolates', I.kleb)['ast_panel_id']).toBe(P.site);
  });

  it('tie at the winning level: lowest code, then lowest id (TRD §4.2 [CONV])', async () => {
    const w = mkWorld(['g']);
    w['ast_panels']!.push(panel(P.tieB, 'syn_tie_b', { organism_code: ECOLI }), panel(P.tieA, 'syn_tie_a', { organism_code: ECOLI }));
    await run('assignAstPanel', assign(I.eco, 3), setup(w).ctx);
    expect(row(w, 'isolates', I.eco)['ast_panel_id']).toBe(P.tieA);                                                  // code order, not insertion order, not id order (tieB < tieA by id)
    const w2 = mkWorld([]);                                                                                          // same code twice cannot exist in the database (partial unique); seeded directly
    w2['ast_panels']!.push(panel(P.tieIdHi, 'syn_tie', { organism_code: ECOLI }), panel(P.tieIdLo, 'syn_tie', { organism_code: ECOLI }));
    await run('assignAstPanel', assign(I.eco, 3), setup(w2).ctx);
    expect(row(w2, 'isolates', I.eco)['ast_panel_id']).toBe(P.tieIdLo);
  });

  it('superseded, deactivated and other-tenant panels are never chosen, however specific (the better ones sit in the world: oldV1 / dead are organism-level, bPanel is (organism, site) of tenant B)', async () => {
    const w = mkWorld(['g']); const s = setup(w);
    await run('assignAstPanel', assign(I.eco, 3), s.ctx);
    expect(row(w, 'isolates', I.eco)['ast_panel_id']).toBe(P.g);
    expect(s.log.filter((l) => l.table === 'ast_panels').every((l) => l.op === 'SELECT')).toBe(true);
  });

  it('effect (AC-06.1): isolate.ast_panel_id + ast_method = panel default_method, version + 1; one pending AST row per panel antibiotic in panel order — method = the antibiotic\'s own else the panel\'s, is_reportable = is_reported_default, panel_sort_order, off_panel false, no value, source manual; IsolateDto + ETag', async () => {
    const w = mkWorld(['o']); const s = setup(w);
    const res = await run('assignAstPanel', assign(I.eco, 3), s.ctx);
    expect(row(w, 'isolates', I.eco)).toMatchObject({ ast_panel_id: P.o, ast_method: 'mic', version: 4 });
    const rows = astOf(w, I.eco).sort((a, b) => a['panel_sort_order'] - b['panel_sort_order']);
    expect(rows.map((r) => [r['antibiotic_code'], r['method'], r['is_reportable'], r['panel_sort_order']])).toEqual([['syn_amp', 'mic', true, 0], ['syn_cip', 'zone_diameter', true, 1], ['syn_tob', 'mic', false, 2]]);
    for (const r of rows) expect(r).toMatchObject({ tenant_id: A, centre_id: CENTRE_A1, culture_id: C.eco, isolate_id: I.eco, off_panel: false, source: 'manual', version: 1, created_by: ACTOR_USER, updated_by: ACTOR_USER });
    for (const r of rows) { expect(r['raw_value'] ?? null).toBeNull(); expect(r['category_code'] ?? null).toBeNull(); }
    expect(res.body.ast.map((a: Row) => [a['antibiotic_code'], a['method'], a['panel_sort_order'], a['off_panel']])).toEqual([['syn_amp', 'mic', 0, false], ['syn_cip', 'zone_diameter', 1, false], ['syn_tob', 'mic', 2, false]]);
    expect(res.body).toMatchObject({ id: I.eco, version: 4, ast_method: 'mic', ast_panel: { id: P.o } });
    expect(res.headers?.['etag']).toBe('"4"');
    expect(schemaErrors('IsolateDto', res.body)).toEqual([]);
    expect(responseErrors('assignAstPanel', res.body)).toEqual([]);
    expect(s.calls.access).toEqual([]); expect(s.published).toEqual([]);
  });

  it('body.method overrides the panel default for antibiotics without their own method and becomes isolate.ast_method; an antibiotic with its own method keeps it', async () => {
    const w = mkWorld(['o']); await run('assignAstPanel', assign(I.eco, 3, { method: 'zone_diameter' }), setup(w).ctx);
    expect(row(w, 'isolates', I.eco)['ast_method']).toBe('zone_diameter');
    expect(astOf(w, I.eco).map((r) => [r['antibiotic_code'], r['method']]).sort()).toEqual([['syn_amp', 'zone_diameter'], ['syn_cip', 'zone_diameter'], ['syn_tob', 'zone_diameter']]);
    const w2 = mkWorld(['o']); await run('assignAstPanel', assign(I.eco, 3, { method: 'other' }), setup(w2).ctx);
    expect(astBy(w2, I.eco, 'syn_cip', 'zone_diameter')).toBeDefined();                                           // own method wins
    expect(astBy(w2, I.eco, 'syn_amp', 'other')).toBeDefined();
  });

  it('explicit ast_panel_id of a current panel is used whatever precedence says; it is audited as the isolate\'s panel (DTO ast_panel)', async () => {
    const w = mkWorld(['oSite', 'any']); const s = setup(w);
    const res = await run('assignAstPanel', assign(I.eco, 3, { ast_panel_id: P.any }), s.ctx);
    expect(row(w, 'isolates', I.eco)['ast_panel_id']).toBe(P.any);
    expect(res.body.ast_panel.id).toBe(P.any);
  });

  it('explicit ast_panel_id: a same-tenant panel that is superseded or deactivated (and not the isolate\'s own) -> 400 common.id_mismatch; another tenant\'s or a missing panel -> 404 common.not_found; nothing written (S-01, S-03, TRD §13)', async () => {
    for (const id of [P.oldV1, P.dead]) {
      const w = mkWorld(['o']); const before = structuredClone(w); const s = setup(w);
      expectCode(await failure(run('assignAstPanel', assign(I.eco, 3, { ast_panel_id: id }), s.ctx)), 'common.id_mismatch', 400);
      expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
    }
    const w1 = mkWorld(['o']); const w2 = mkWorld(['o']); const b1 = structuredClone(w1);
    const e1 = await failure(run('assignAstPanel', assign(I.eco, 3, { ast_panel_id: P.bPanel }), setup(w1).ctx));
    const e2 = await failure(run('assignAstPanel', assign(I.eco, 3, { ast_panel_id: u(0x50ff) }), setup(w2).ctx));
    for (const e of [e1, e2]) expectCode(e, 'common.not_found', 404);
    expect(w1).toEqual(b1);
  });

  it('explicit ast_panel_id equal to the isolate\'s OWN panel is allowed even when that version was superseded meanwhile', async () => {
    const w = mkWorld(['o']); const s = setup(w);
    const res = await run('assignAstPanel', assign(I.own, 3, { ast_panel_id: P.oldV1 }), s.ctx);
    expect(res.body.ast_panel.id).toBe(P.oldV1);
    expect(row(w, 'isolates', I.own)['ast_panel_id']).toBe(P.oldV1);
  });

  it('AC-16.1 / S-05: no statement of M11 writes report_visibility (the database default "shown" applies); created rows are shown', async () => {
    const w = mkWorld(['o']); const s = setup(w);
    await run('assignAstPanel', assign(I.eco, 3), s.ctx);
    expect(writesOf(s.log).filter((l) => /report_visibility/i.test(l.sql))).toEqual([]);
    for (const r of astOf(w, I.eco)) expect(r['report_visibility']).toBe('shown');
  });

  it('re-assigning the same panel (new version) never deletes or overwrites an AST row: counts, values and row versions of I.rec stay', async () => {
    const w = mkWorld([]); const before = structuredClone(w['ast_results']!.filter((r) => r['isolate_id'] === I.rec)); const s = setup(w);
    const res = await run('assignAstPanel', assign(I.rec, 4, { ast_panel_id: P.rec }), s.ctx);
    expect(astOf(w, I.rec)).toEqual(before);
    expect(res.body.ast).toHaveLength(6);
    expect(writesOf(s.log).filter((l) => l.table === 'ast_results' && l.op === 'UPDATE')).toEqual([]);
  });

  it.each([
    ['pending_id isolate (not identified)', I.pend, 1, 'micro.isolate_invalid_transition'],
    ['withdrawn isolate', I.wd, 4, 'micro.isolate_invalid_transition'],
    ['isolate of a final_submitted culture', I.final, 4, 'micro.report_final_locked'],
    ['isolate of a cancelled culture', I.canc, 3, 'micro.culture_invalid_transition'],
  ])('%s -> 409 (own error code), nothing written', async (_n, id, v, code) => {
    const w = mkWorld(['o', 'any']); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('assignAstPanel', assign(id, v), s.ctx)), code, 409);
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
  });

  it('If-Match: missing -> 428 common.precondition_required, stale -> 409 common.version_conflict; strict body: unknown fields (report_visibility, tenant_id, status, version), bad method, bad uuid -> 400; nothing written', async () => {
    const w = mkWorld(['o']); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('assignAstPanel', M11(I.eco, {}, {}), s.ctx)), 'common.precondition_required', 428);
    expectCode(await failure(run('assignAstPanel', assign(I.eco, 2), s.ctx)), 'common.version_conflict', 409);
    for (const body of [{ report_visibility: 'shown' }, { tenant_id: B }, { status: 'identified' }, { version: 3 }, { method: 'disc' }, { ast_panel_id: 'not-a-uuid' }, { antibiotics: [] }])
      expectInvalid(await failure(run('assignAstPanel', assign(I.eco, 3, body), s.ctx)));
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
  });

  it('lock order: culture row FOR UPDATE precedes isolate row FOR UPDATE (no deadlock with M4 / M8–M10)', async () => {
    const w = mkWorld(['o']); const s = setup(w);
    await run('assignAstPanel', assign(I.eco, 3), s.ctx);
    const l = lockOrder(s.log);
    expect(l.culture).toBeGreaterThanOrEqual(0); expect(l.isolate).toBeGreaterThanOrEqual(0); expect(l.culture).toBeLessThan(l.isolate);
  });

  it('a P0001 immutable_row from the database (the culture was submitted between read and write) -> 409 micro.report_final_locked (TRD §12)', async () => {
    const w = mkWorld(['o']); const s = setup(w);
    const q = s.ctx.tx.query.bind(s.ctx.tx);
    s.ctx.tx.query = async (sql: string, p: unknown[]) => { if (/^\s*(INSERT\s+INTO|UPDATE)\s+(micro\.)?(ast_results|isolates)\b/i.test(sql)) throw Object.assign(new Error('immutable_row'), { code: 'P0001' }); return q(sql, p); };
    expectCode(await failure(run('assignAstPanel', assign(I.eco, 3), s.ctx)), 'micro.report_final_locked', 409);
  });
});

// ------------------------------------------------------------------ M12 recordAstResults
describe('C10-T10 M12 recordAstResults — AC-06.2 raw value parsing, stored exactly as entered', () => {
  it('mic "<=0.25": raw_value "<=0.25", raw_qualifier "<=", raw_numeric 0.25, unit ug_ml; zone_diameter "18": qualifier "=", numeric 18, unit mm; method other: no numeric / no unit; row version + 1; AstResultDto', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordAstResults', M12(I.rec, [entry('syn_amp', 'mic', { raw_value: '<=0.25' }), entry('syn_zone', 'zone_diameter', { raw_value: '18' }), entry('syn_tob', 'mic', { raw_value: '≥ 8/4' })]), s.ctx);
    expect(res.status).toBe(200);
    expect(results(res).map((r) => [r['antibiotic_code'], r['method'], r['outcome']])).toEqual([['syn_amp', 'mic', 'ok'], ['syn_zone', 'zone_diameter', 'ok'], ['syn_tob', 'mic', 'ok']]);
    const amp = astBy(w, I.rec, 'syn_amp'); const zone = astBy(w, I.rec, 'syn_zone', 'zone_diameter'); const tob = astBy(w, I.rec, 'syn_tob');
    expect(amp).toMatchObject({ raw_value: '<=0.25', raw_qualifier: '<=', unit_code: 'ug_ml', version: 2, updated_by: ACTOR_USER, tenant_id: A, culture_id: C.rec });
    expect(Number(amp['raw_numeric'])).toBe(0.25);
    expect(zone).toMatchObject({ raw_value: '18', raw_qualifier: '=', unit_code: 'mm', version: 2 }); expect(Number(zone['raw_numeric'])).toBe(18);
    expect(tob).toMatchObject({ raw_value: '≥ 8/4', raw_qualifier: '>=', unit_code: 'ug_ml' }); expect(Number(tob['raw_numeric'])).toBe(8);   // second number of a combination kept in raw_value only
    const dto = okEntry(results(res)[0]!);
    expect(dto).toMatchObject({ id: AST.amp, antibiotic_code: 'syn_amp', method: 'mic', raw_value: '<=0.25', raw_qualifier: '<=', raw_numeric: '0.25', unit_code: 'ug_ml', version: 2, report_visibility: 'shown', off_panel: false, source: 'manual' });
    expect(schemaErrors('AstResultDto', dto)).toEqual([]);
    expect(responseErrors('recordAstResults', res.body)).toEqual([]);
    expect(entered(amp)).toEqual({ by: ACTOR_M, at: NOW_ISO });
    const w2 = mkWorld(); const r2 = await run('recordAstResults', M12(I.rec, [entry('syn_extra2', 'other', { raw_value: 'POS', add_to_isolate: true }), entry('syn_extra', 'other', { raw_value: 'Detected', add_to_isolate: true })]), setup(w2).ctx);
    expect(results(r2).every((r) => r['outcome'] === 'ok')).toBe(true);
    for (const r of [astBy(w2, I.rec, 'syn_extra2', 'other'), astBy(w2, I.rec, 'syn_extra', 'other')]) { expect(r['raw_numeric'] ?? null).toBeNull(); expect(r['unit_code'] ?? null).toBeNull(); expect(r['raw_qualifier'] ?? null).toBeNull(); }
  });
  const entered = (r: Row) => ({ by: r['entered_by_membership_id'], at: r['entered_at'] ? iso(r['entered_at']) : null });

  it.each([['mic', '>>2'], ['mic', '2 ug'], ['mic', '1234567'], ['mic', 'abc'], ['zone_diameter', '101'], ['zone_diameter', '18.123'], ['zone_diameter', '<>5'], ['zone_diameter', '1,5']])
  ('%s "%s" -> per-entry micro.ast_value_invalid with path /entries/0/raw_value; the row is untouched', async (method, raw) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    const abx = method === 'mic' ? 'syn_amp' : 'syn_zone';
    const res = await run('recordAstResults', M12(I.rec, [entry(abx, method, { raw_value: raw })]), s.ctx);
    expect(res.status).toBe(200);
    errEntry(results(res)[0]!, 'micro.ast_value_invalid', '/entries/0/raw_value');
    expect(w['ast_results']).toEqual(before['ast_results']);
  });

  it('a sentinel raw value never reaches a log call, success or failure (REQ-SEC-024, T-D1)', async () => {
    const SENTINEL = 'SYN-SENTINEL-DO-NOT-LOG';
    const w = mkWorld(); const s = setup(w);
    await run('recordAstResults', M12(I.rec, [entry('syn_amp', 'other', { raw_value: SENTINEL }), entry('syn_cip', 'mic', { raw_value: SENTINEL })]), s.ctx);
    await failure(run('recordAstResults', M12(I.rec, [entry('syn_amp', 'other', { raw_value: SENTINEL, unknown_field: SENTINEL })]), s.ctx));
    expect(JSON.stringify(s.logs)).not.toContain(SENTINEL);
  });
});

describe('C10-T10 M12 — AC-06.3 / 06.3a / 06.4 / 06.5 interpretation rules (TRD §4.4); per-entry codes travel in results[].code with HTTP 200', () => {
  const rec = (entries: Row[]) => M12(I.rec, entries);
  it('AC-06.3: a category without standard, or with standard but no standard_version -> per-entry micro.ast_standard_required; nothing stored for the entry', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    const res = await run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '2', category_code: 'S' }), entry('syn_cip', 'mic', { raw_value: '2', category_code: 'S', standard: 'CLSI' }),
      entry('syn_tob', 'mic', { raw_value: '2', category_code: 'S', standard_version: '2026' })]), s.ctx);
    errEntry(results(res)[0]!, 'micro.ast_standard_required', /^\/entries\/0\/(standard|standard_version|category_code)$/);
    errEntry(results(res)[1]!, 'micro.ast_standard_required', /^\/entries\/1\/(standard_version|category_code)$/);
    errEntry(results(res)[2]!, 'micro.ast_standard_required', /^\/entries\/2\/(standard|category_code)$/);
    expect(w['ast_results']).toEqual(before['ast_results']);
  });

  it('AC-06.3a: a category with no raw value in the entry and none stored -> per-entry micro.ast_value_invalid, NOTHING stored (not even the category); with a stored raw value the same entry succeeds and keeps it', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordAstResults', rec([entry('syn_amp', 'mic', { category_code: 'S', standard: 'CLSI', standard_version: '2026' }), entry('syn_cip', 'mic', { category_code: 'S', standard: 'CLSI', standard_version: '2026' })]), s.ctx);
    errEntry(results(res)[0]!, 'micro.ast_value_invalid', /^\/entries\/0\/(raw_value|category_code)$/);
    const ok = okEntry(results(res)[1]!);
    expect(ok).toMatchObject({ antibiotic_code: 'syn_cip', raw_value: '1', category_code: 'S', standard: 'CLSI', standard_version: '2026' });
    expect(astBy(w, I.rec, 'syn_amp')).toMatchObject({ raw_value: null, category_code: null, standard: null, standard_version: null, version: 1 });
    expect(astBy(w, I.rec, 'syn_cip')).toMatchObject({ raw_value: '1', category_code: 'S', version: 4 });
  });

  it('a valid category stores category + standard + standard_version with provenance manual / manual (T-A4: the client cannot choose them), keeps the pending row\'s method and panel_sort_order', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '2', category_code: 'R', standard: 'EUCAST', standard_version: '2026', is_reportable: false })]), s.ctx);
    const dto = okEntry(results(res)[0]!);
    expect(astBy(w, I.rec, 'syn_amp')).toMatchObject({ category_code: 'R', standard: 'EUCAST', standard_version: '2026', standard_source: 'manual', interpretation_source: 'manual', source: 'manual', is_reportable: false, panel_sort_order: 0, off_panel: false });
    expect(dto).toMatchObject({ category_code: 'R', standard: 'EUCAST', standard_version: '2026', standard_source: 'manual', interpretation_source: 'manual', is_reportable: false });
    expect(schemaErrors('AstResultDto', dto)).toEqual([]);
  });

  it('AC-06.4: CLSI colistin / polymyxin_b with S -> per-entry micro.ast_category_not_allowed (/entries/n/category_code); I and R are fine; the restriction is per standard (EUCAST colistin S is fine)', async () => {
    const w = mkWorld(); const s = setup(w);
    const std = { standard: 'CLSI', standard_version: '2026' };
    const res = await run('recordAstResults', rec([entry('colistin', 'mic', { raw_value: '4', category_code: 'S', ...std }), entry('polymyxin_b', 'mic', { raw_value: '4', category_code: 'S', ...std, add_to_isolate: true }),
      entry('colistin', 'mic', { raw_value: '4', category_code: 'I', ...std }), entry('syn_amp', 'mic', { raw_value: '4', category_code: 'S', ...std }),
      entry('syn_tob', 'mic', { raw_value: '4', category_code: 'S', standard: 'EUCAST', standard_version: '2026' })]), s.ctx);
    errEntry(results(res)[0]!, 'micro.ast_category_not_allowed', '/entries/0/category_code');
    errEntry(results(res)[1]!, 'micro.ast_category_not_allowed', '/entries/1/category_code');
    okEntry(results(res)[2]!); okEntry(results(res)[3]!); okEntry(results(res)[4]!);
    expect(astOf(w, I.rec).some((r) => r['antibiotic_code'] === 'polymyxin_b')).toBe(false);                      // the refused off-panel add left no row
    expect(astBy(w, I.rec, 'colistin')).toMatchObject({ category_code: 'I' });
    const w2 = mkWorld(); const r2 = await run('recordAstResults', rec([entry('colistin', 'mic', { raw_value: '4', category_code: 'S', standard: 'EUCAST', standard_version: '2026' })]), setup(w2).ctx);
    okEntry(results(r2)[0]!);
  });

  it('AC-06.5 / S-09: a category code that does not exist for the standard (SDD with EUCAST, WT with CLSI, unknown, inactive) -> per-entry micro.ast_category_not_allowed; SDD with CLSI and WT with ECOFF are fine', async () => {
    const w = mkWorld(); const s = setup(w);
    const mk = (abx: string, category_code: string, standard: string) => entry(abx, 'mic', { raw_value: '2', category_code, standard, standard_version: '2026' });
    const res = await run('recordAstResults', rec([mk('syn_amp', 'SDD', 'EUCAST'), mk('syn_cip', 'WT', 'CLSI'), mk('syn_tob', 'ZZ', 'CLSI'), mk('syn_sup', 'OLD', 'CLSI'), mk('colistin', 'SDD', 'CLSI'), mk('syn_amp', 'SDD', 'CLSI'), mk('syn_cip', 'WT', 'ECOFF')]), s.ctx);
    const r = results(res);
    for (const n of [0, 1, 2, 3]) errEntry(r[n]!, 'micro.ast_category_not_allowed', `/entries/${n}/category_code`);
    errEntry(r[4]!, 'micro.ast_category_not_allowed', '/entries/4/category_code');                                        // SDD is not allowed for CLSI colistin (restriction I/R)
    okEntry(r[5]!); okEntry(r[6]!);
    expect(astBy(w, I.rec, 'syn_amp')).toMatchObject({ category_code: 'SDD', standard: 'CLSI' });
  });

  it('standard "unknown" / an invalid standard in the body is refused by the strict schema (400) — the category / unknown rule stays in the database (ast_results__unknown__ck)', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    for (const standard of ['unknown', 'clsi', 'FDA']) expectInvalid(await failure(run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '2', category_code: 'S', standard, standard_version: '2026' })]), s.ctx)));
    expect(w).toEqual(before);
  });

  it('an entry without a category is stored with its raw value only (blocks submission later, not now): category stays null', async () => {
    const w = mkWorld(); const s = setup(w);
    okEntry(results(await run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '2' })]), s.ctx))[0]!);
    expect(astBy(w, I.rec, 'syn_amp')).toMatchObject({ raw_value: '2', category_code: null, standard: null });
  });
});

describe('C10-T10 M12 — AC-06.6 off_panel, versions, partial success with SAVEPOINTs', () => {
  const rec = (entries: Row[]) => M12(I.rec, entries);
  it('AC-06.6: an antibiotic that is not in the isolate\'s panel -> per-entry micro.antibiotic_not_in_panel (/entries/n/antibiotic_code), nothing stored; with add_to_isolate: true -> stored with off_panel = true (version 1, no panel_sort_order)', async () => {
    const w = mkWorld(); const s = setup(w);
    const n0 = astOf(w, I.rec).length;
    const res = await run('recordAstResults', rec([entry('syn_extra', 'mic', { raw_value: '2' }), entry('syn_extra2', 'mic', { raw_value: '2', add_to_isolate: false }), entry('syn_extra3', 'mic', { raw_value: '0.5', add_to_isolate: true })]), s.ctx);
    errEntry(results(res)[0]!, 'micro.antibiotic_not_in_panel', '/entries/0/antibiotic_code');
    errEntry(results(res)[1]!, 'micro.antibiotic_not_in_panel', '/entries/1/antibiotic_code');
    const dto = okEntry(results(res)[2]!);
    expect(dto).toMatchObject({ antibiotic_code: 'syn_extra3', off_panel: true, raw_value: '0.5', version: 1, report_visibility: 'shown' });
    expect(dto['panel_sort_order']).toBeUndefined();
    expect(astOf(w, I.rec)).toHaveLength(n0 + 1);
    expect(astBy(w, I.rec, 'syn_extra3')).toMatchObject({ off_panel: true, tenant_id: A, centre_id: CENTRE_A1, culture_id: C.rec, isolate_id: I.rec, source: 'manual', created_by: ACTOR_USER, version: 1 });
    expect(astBy(w, I.rec, 'syn_extra3')['report_visibility']).toBe('shown');
    expect(schemaErrors('AstResultDto', dto)).toEqual([]);
  });

  it('an isolate without any panel: every antibiotic is "not in panel" unless add_to_isolate', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordAstResults', M12(I.eco, [entry('syn_amp', 'mic', { raw_value: '2' }), entry('syn_cip', 'mic', { raw_value: '2', add_to_isolate: true })]), s.ctx);
    errEntry(results(res)[0]!, 'micro.antibiotic_not_in_panel', '/entries/0/antibiotic_code');
    expect(okEntry(results(res)[1]!)).toMatchObject({ off_panel: true });
  });

  it('an antibiotic code outside the coded set is a per-entry common.validation_failed /entries/n/antibiotic_code (never stored, add_to_isolate does not bypass it)', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordAstResults', rec([entry('syn_nope', 'mic', { raw_value: '2', add_to_isolate: true })]), s.ctx);
    errEntry(results(res)[0]!, 'common.validation_failed', '/entries/0/antibiotic_code');
    expect(astOf(w, I.rec).some((r) => r['antibiotic_code'] === 'syn_nope')).toBe(false);
  });

  it('per-entry version: stale -> per-entry common.version_conflict /entries/n/version, row unchanged; matching -> ok and version + 1; a suppressed_by_rule row keeps its visibility (AC-16.1: only a future rule changes it)', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordAstResults', rec([entry('syn_cip', 'mic', { raw_value: '2', version: 2 }), entry('syn_cip', 'mic', { raw_value: '4', version: 3 }), entry('syn_sup', 'mic', { raw_value: '8', version: 2 })]), s.ctx);
    errEntry(results(res)[0]!, 'common.version_conflict', '/entries/0/version');
    expect(okEntry(results(res)[1]!)).toMatchObject({ raw_value: '4', version: 4 });
    const sup = okEntry(results(res)[2]!);
    expect(sup).toMatchObject({ raw_value: '8', version: 3, report_visibility: 'suppressed_by_rule' });
    expect(astBy(w, I.rec, 'syn_sup')['report_visibility']).toBe('suppressed_by_rule');
    expect(schemaErrors('AstResultDto', sup)).toEqual([]);
  });

  it('partial success is committed: [ok, bad value, ok, not in panel, ok] -> five results in request order, the three ok rows stored, the two failed rows untouched', async () => {
    const w = mkWorld(); const s = setup(w);
    const res = await run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '1' }), entry('syn_cip', 'mic', { raw_value: 'abc' }), entry('syn_zone', 'zone_diameter', { raw_value: '20' }),
      entry('syn_extra', 'mic', { raw_value: '2' }), entry('syn_tob', 'mic', { raw_value: '4' })]), s.ctx);
    expect(res.status).toBe(200);
    const r = results(res);
    expect(r.map((x) => x['outcome'])).toEqual(['ok', 'error', 'ok', 'error', 'ok']);
    expect(r.map((x) => x['antibiotic_code'])).toEqual(['syn_amp', 'syn_cip', 'syn_zone', 'syn_extra', 'syn_tob']);
    expect(r.map((x) => x['method'])).toEqual(['mic', 'mic', 'zone_diameter', 'mic', 'mic']);
    errEntry(r[1]!, 'micro.ast_value_invalid', '/entries/1/raw_value'); errEntry(r[3]!, 'micro.antibiotic_not_in_panel', '/entries/3/antibiotic_code');
    expect([astBy(w, I.rec, 'syn_amp')['raw_value'], astBy(w, I.rec, 'syn_zone', 'zone_diameter')['raw_value'], astBy(w, I.rec, 'syn_tob')['raw_value']]).toEqual(['1', '20', '4']);
    expect(astBy(w, I.rec, 'syn_cip')).toMatchObject({ raw_value: '1', version: 3 });                               // the failed entry kept the stored value 1 and version 3
    expect(responseErrors('recordAstResults', res.body)).toEqual([]);
  });

  it('every entry that writes does so inside its own SAVEPOINT (plain identifier names); a database failure of one entry rolls back to it and the next entries still commit (PostgreSQL aborts the transaction otherwise: 25P02)', async () => {
    const w = mkWorld(); const s = setup(w);
    const q = s.ctx.tx.query.bind(s.ctx.tx);
    s.ctx.tx.query = async (sql: string, p: unknown[]) => {                                                            // a concurrent writer wins the race for the off-panel row of syn_extra
      if (/^\s*INSERT\s+INTO\s+(micro\.)?ast_results\b/i.test(sql) && p.includes('syn_extra')) {
        await q(`UPDATE micro.ast_results SET method = 'bogus' WHERE tenant_id = $1 AND id = $2`, [A, AST.amp]).catch(() => undefined);   // really fails inside the fake: the tx is now aborted
        throw Object.assign(new Error('duplicate key value violates unique constraint "ast_results__isolate_abx_method__uq"'), { code: '23505', constraint: 'ast_results__isolate_abx_method__uq' });
      }
      return q(sql, p);
    };
    const res = await run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '1' }), entry('syn_extra', 'mic', { raw_value: '2', add_to_isolate: true }), entry('syn_tob', 'mic', { raw_value: '4' })]), s.ctx);
    const r = results(res);
    expect(r.map((x) => x['outcome'])).toEqual(['ok', 'error', 'ok']);
    errEntry(r[1]!, 'common.version_conflict', /^\/entries\/1(\/.*)?$/);
    expect(astBy(w, I.rec, 'syn_amp')['raw_value']).toBe('1'); expect(astBy(w, I.rec, 'syn_tob')['raw_value']).toBe('4');
    expect(s.aborted()).toBe(false);
    let depth = 0; const writes = s.log.filter((l) => /^\s*(SAVEPOINT|RELEASE|ROLLBACK\s+TO)\b/i.test(l.sql) || ((l.op === 'INSERT' || l.op === 'UPDATE') && l.table === 'ast_results'));
    for (const l of writes) { if (/^\s*SAVEPOINT\b/i.test(l.sql)) depth++; else if (/^\s*RELEASE\b/i.test(l.sql)) depth--; else if (l.op === 'INSERT' || l.op === 'UPDATE') expect(depth, `write outside a savepoint: ${l.sql.slice(0, 60)}`).toBeGreaterThan(0); }
    expect(s.log.some((l) => /^\s*ROLLBACK\s+TO\b/i.test(l.sql))).toBe(true);
  });

  it('a P0001 immutable_row raised by the database on an entry (culture submitted meanwhile) fails the WHOLE request with 409 micro.report_final_locked (TRD §5 M12 / §12), not a per-entry result', async () => {
    const w = mkWorld(); const s = setup(w);
    const q = s.ctx.tx.query.bind(s.ctx.tx);
    s.ctx.tx.query = async (sql: string, p: unknown[]) => { if (/^\s*(INSERT\s+INTO|UPDATE)\s+(micro\.)?ast_results\b/i.test(sql) && p.includes('syn_final_race')) throw Object.assign(new Error('immutable_row'), { code: 'P0001' }); return q(sql, p); };
    expectCode(await failure(run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '1' }), entry('syn_extra', 'other', { raw_value: 'syn_final_race', add_to_isolate: true })]), s.ctx)), 'micro.report_final_locked', 409);
  });

  it.each([
    ['isolate of a final_submitted culture', I.final, 'micro.report_final_locked'],
    ['withdrawn isolate', I.wd, 'micro.isolate_invalid_transition'],
    ['isolate of a cancelled culture', I.canc, 'micro.culture_invalid_transition'],
  ])('%s -> whole request 409 (own error code), nothing written', async (_n, id, code) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
    expectCode(await failure(run('recordAstResults', M12(id, [entry('syn_amp', 'mic', { raw_value: '1', add_to_isolate: true })]), s.ctx)), code, 409);
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
  });

  it('strict body (S-05, T-A4, AC-16.1): report_visibility / interpretation_source / standard_source / source / off_panel / entered_by / tenant_id / isolate_id inside an entry, unknown top-level fields, 0 and 61 entries, bad antibiotic_code / method / category pattern -> 400 common.validation_failed for the whole request; nothing written', async () => {
    const base = entry('syn_amp', 'mic', { raw_value: '1' });
    const bads: Row[] = [
      ...['report_visibility', 'interpretation_source', 'standard_source', 'source', 'off_panel', 'entered_by', 'entered_by_membership_id', 'tenant_id', 'centre_id', 'isolate_id', 'culture_id', 'raw_qualifier', 'raw_numeric', 'unit_code']
        .map((f) => M12(I.rec, [{ ...base, [f]: f === 'off_panel' ? true : 'shown' }])),
      M12(I.rec, [base], { report_visibility: 'shown' }), M12(I.rec, []), M12(I.rec, Array.from({ length: 61 }, () => base)),
      M12(I.rec, [{ ...base, antibiotic_code: 'Bad Code' }]), M12(I.rec, [{ ...base, method: 'disc' }]), M12(I.rec, [{ ...base, category_code: 'S;DROP' }]), M12(I.rec, [{ ...base, raw_value: 'x'.repeat(33) }]),
      M12(I.rec, [{ antibiotic_code: 'syn_amp' }]), { params: { isolate_id: I.rec }, headers: { ...KEY }, body: {} },
    ];
    for (const req of bads) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w);
      expectInvalid(await failure(run('recordAstResults', req, s.ctx)));
      expect(writesOf(s.log), JSON.stringify(req.body).slice(0, 80)).toEqual([]); expect(w).toEqual(before);
    }
  });

  it('AC-16.1: no INSERT / UPDATE statement of M11 / M12 / M30–M32 mentions report_visibility; every stored or created row is "shown"', async () => {
    const w = mkWorld(['o']); const s = setup(w, [WORK, MANAGE]);
    await run('assignAstPanel', assign(I.eco, 3), s.ctx);
    await run('recordAstResults', M12(I.rec, [entry('syn_amp', 'mic', { raw_value: '1' }), entry('syn_extra', 'mic', { raw_value: '2', add_to_isolate: true })]), s.ctx);
    await run('createAstPanel', { params: {}, headers: { ...KEY }, body: { code: 'syn_new_panel', display: 'Synthetic new', default_method: 'mic', antibiotics: [{ antibiotic_code: 'syn_amp', is_reported_default: true }] } }, s.ctx);
    expect(s.log.filter((l) => (l.op === 'INSERT' || l.op === 'UPDATE') && /report_visibility/i.test(l.sql))).toEqual([]);
    for (const r of w['ast_results']!.filter((x) => x['isolate_id'] !== I.rec || x['antibiotic_code'] !== 'syn_sup')) expect(r['report_visibility']).toBe('shown');
  });

  it('lock order: culture FOR UPDATE precedes isolate FOR UPDATE', async () => {
    const w = mkWorld(); const s = setup(w);
    await run('recordAstResults', rec([entry('syn_amp', 'mic', { raw_value: '1' })]), s.ctx);
    const l = lockOrder(s.log);
    expect(l.culture).toBeGreaterThanOrEqual(0); expect(l.isolate).toBeGreaterThanOrEqual(0); expect(l.culture).toBeLessThan(l.isolate);
  });

  it('60 entries on one isolate: reads are batched (the number of SELECTs does not grow with the entry count: <= 30 for 60 entries, TRD §10 "batched inserts / single transaction"), every entry answered once', async () => {
    const w = mkWorld(); const s = setup(w);
    const codes = Array.from({ length: 60 }, (_, i) => `syn_bulk_${i}`);
    w['v_antibiotics']!.push(...codes.map((code) => ({ code, display: code, is_active: true })));
    const res = await run('recordAstResults', rec(codes.map((c) => entry(c, 'mic', { raw_value: '2', add_to_isolate: true }))), s.ctx);
    expect(results(res)).toHaveLength(60); expect(results(res).every((r) => r['outcome'] === 'ok')).toBe(true);
    expect(s.log.filter((l) => l.op === 'SELECT').length).toBeLessThanOrEqual(30);
    expect(astOf(w, I.rec).filter((r) => r['off_panel'] === true)).toHaveLength(60);
  });
});

// ------------------------------------------------------------------ M29–M32 panel configuration
const panelBody = (code: string, over: Row = {}): Row => ({ code, display: `Synthetic ${code}`, default_method: 'mic', organism_code: ECOLI, specimen_site_code: SITE_A,
  antibiotics: [{ antibiotic_code: 'syn_cip', is_reported_default: true }, { antibiotic_code: 'syn_amp', method: 'zone_diameter', is_reported_default: false }, { antibiotic_code: 'syn_tob', is_reported_default: true }], ...over });
const create = (body: Row, headers: Row = {}) => ({ params: {}, headers: { ...KEY, ...headers }, body });
const versionReq = (id: string, body: Row, headers: Row) => ({ params: { panel_id: id }, headers: { ...KEY, ...headers }, body });
const deactivateReq = (id: string, headers: Row, body: Row = {}) => ({ params: { panel_id: id }, headers: { ...KEY, ...headers }, body });
const panelsOf = (w: World, code: string) => w['ast_panels']!.filter((p) => p['code'] === code && p['tenant_id'] === A).sort((a, b) => a['version_no'] - b['version_no']);
const abxOf = (w: World, panelId: string) => w['ast_panel_antibiotics']!.filter((a) => a['panel_id'] === panelId).sort((a, b) => a['sort_order'] - b['sort_order']);
const MGR = [MANAGE];

describe('C10-T10 M30 createAstPanel (S-23, T-E1, 409 micro.code_duplicate)', () => {
  it('creates version 1: 201, AstPanelDto (antibiotics in request order with sort_order 0..), rows written panel first then antibiotics, created_by = caller, current (superseded_at null); asks only micro.config.manage', async () => {
    const w = mkWorld(); const s = setup(w, MGR);
    const res = await run('createAstPanel', create(panelBody('syn_new_panel')), s.ctx);
    expect(res.status).toBe(201);
    expect(schemaErrors('AstPanelDto', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ code: 'syn_new_panel', version_no: 1, version: 1, display: 'Synthetic syn_new_panel', default_method: 'mic', organism_code: ECOLI, specimen_site_code: SITE_A, is_active: true });
    expect(res.body.organism_group_code).toBeUndefined(); expect(res.body.superseded_at).toBeUndefined();
    expect(res.body.antibiotics.map((a: Row) => [a['antibiotic_code'], a['sort_order'], a['method'], a['is_reported_default']])).toEqual([['syn_cip', 0, undefined, true], ['syn_amp', 1, 'zone_diameter', false], ['syn_tob', 2, undefined, true]]);
    const [p] = panelsOf(w, 'syn_new_panel');
    expect(p).toMatchObject({ tenant_id: A, version_no: 1, version: 1, is_active: true, superseded_at: null, created_by: ACTOR_USER, updated_by: ACTOR_USER });
    expect(abxOf(w, p!['id']).map((a) => [a['antibiotic_code'], a['sort_order'], a['method'] ?? null, a['is_reported_default']])).toEqual([['syn_cip', 0, null, true], ['syn_amp', 1, 'zone_diameter', false], ['syn_tob', 2, null, true]]);
    const order = writesOf(s.log).map((l) => l.table);
    expect(order.indexOf('ast_panels')).toBeLessThan(order.indexOf('ast_panel_antibiotics'));
    expect(s.calls.assertRole.map((x) => x['permission'])).toEqual([MANAGE]);
    expect(s.calls.access).toEqual([]);
  });

  it('S-23: a caller without micro.config.manage (technologist / read-only / nobody) -> 403, nothing written', async () => {
    for (const grants of [[WORK], [READ], [WORK, READ], []]) {
      const w = mkWorld(); const before = structuredClone(w); const s = setup(w, grants);
      expectCode(await failure(run('createAstPanel', create(panelBody('syn_new_panel')), s.ctx)), 'auth.forbidden', 403);
      expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
    }
  });

  it('code already used by a current panel of the tenant -> 409 micro.code_duplicate (partial unique ast_panels__tenant_id_code__p_uq, TRD §12), nothing written; the same code in another tenant is no clash', async () => {
    const w = mkWorld(); const s = setup(w, MGR); const before = structuredClone(w);
    expectCode(await failure(run('createAstPanel', create(panelBody('syn_p_rec')), s.ctx)), 'micro.code_duplicate', 409);
    expect(w['ast_panels']).toEqual(before['ast_panels']); expect(w['ast_panel_antibiotics']).toEqual(before['ast_panel_antibiotics']);
    const w2 = mkWorld(); w2['ast_panels']!.push(panel(u(0x50aa), 'syn_other_tenant', { tenant_id: B }));
    expect((await run('createAstPanel', create(panelBody('syn_other_tenant')), setup(w2, MGR).ctx)).status).toBe(201);
  });

  it.each([
    ['both organism_code and organism_group_code (scope CHECK)', { organism_group_code: GNR }, undefined],
    ['unknown organism_code', { organism_code: 'syn_org_nope' }, '/organism_code'],
    ['unknown organism_group_code', { organism_code: undefined, organism_group_code: 'syn_group_nope' }, '/organism_group_code'],
    ['unknown specimen_site_code', { specimen_site_code: 'syn_site_nope' }, '/specimen_site_code'],
    ['unknown antibiotic_code', { antibiotics: [{ antibiotic_code: 'syn_amp', is_reported_default: true }, { antibiotic_code: 'syn_nope', is_reported_default: true }] }, '/antibiotics/1/antibiotic_code'],
    ['the same antibiotic + method twice', { antibiotics: [{ antibiotic_code: 'syn_amp', is_reported_default: true }, { antibiotic_code: 'syn_amp', is_reported_default: false }] }, '/antibiotics/1/antibiotic_code'],
    ['no antibiotics', { antibiotics: [] }, undefined], ['61 antibiotics', { antibiotics: Array.from({ length: 61 }, (_, i) => ({ antibiotic_code: `syn_a${i}`, is_reported_default: true })) }, undefined],
    ['bad code', { code: 'Bad Code' }, undefined], ['empty display', { display: '' }, undefined], ['bad default_method', { default_method: 'disc' }, undefined],
    ['version_no from the client', { version_no: 5 }, undefined], ['superseded_at from the client', { superseded_at: NOW_ISO }, undefined], ['tenant_id from the client', { tenant_id: B }, undefined], ['is_active from the client', { is_active: false }, undefined],
  ] as [string, Row, string | undefined][])('validation: %s -> 400 common.validation_failed%s, nothing written', async (_n, over, path) => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w, MGR);
    expectInvalid(await failure(run('createAstPanel', create(panelBody('syn_new_panel', over)), s.ctx)), path);
    expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
  });
});

describe('C10-T10 M31 versionAstPanel — supersede then insert (AC-14.2 analogue; ast_panels__tenant_id_code__p_uq)', () => {
  const v2 = (over: Row = {}) => { const { code: _c, ...rest } = panelBody('syn_p_rec', { organism_code: STAPH, specimen_site_code: SITE_B, display: 'Version two', ...over }); return rest; };
  it('a new version: same code, version_no 2, v1 gets superseded_at = now, v2 is current with its own antibiotic rows; v1 and its antibiotics and the isolates pointing at v1 are untouched; 200 + AstPanelDto; asks only micro.config.manage', async () => {
    const w = mkWorld(); const s = setup(w, MGR);
    const v1Abx = structuredClone(abxOf(w, P.rec)); const isoBefore = structuredClone(row(w, 'isolates', I.rec));
    const res = await run('versionAstPanel', versionReq(P.rec, v2(), ifm(1)), s.ctx);
    expect(res.status).toBe(200);
    expect(schemaErrors('AstPanelDto', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ code: 'syn_p_rec', version_no: 2, display: 'Version two', is_active: true, version: 1 });
    expect(res.body.id).not.toBe(P.rec);
    expect(res.body.antibiotics.map((a: Row) => [a['antibiotic_code'], a['sort_order']])).toEqual([['syn_cip', 0], ['syn_amp', 1], ['syn_tob', 2]]);
    const rows = panelsOf(w, 'syn_p_rec');
    expect(rows.map((r) => r['version_no'])).toEqual([1, 2]);
    expect(iso(rows[0]!['superseded_at'])).toBe(NOW_ISO); expect(rows[1]!['superseded_at'] ?? null).toBeNull();
    expect(rows[0]).toMatchObject({ display: 'Synthetic syn_p_rec', default_method: 'mic', is_active: true });
    expect(abxOf(w, P.rec)).toEqual(v1Abx);
    expect(abxOf(w, rows[1]!['id']).map((a) => a['antibiotic_code'])).toEqual(['syn_cip', 'syn_amp', 'syn_tob']);
    expect(row(w, 'isolates', I.rec)).toEqual(isoBefore);                                                            // finalised isolates keep the version they used
    expect(s.calls.assertRole.map((x) => x['permission'])).toEqual([MANAGE]);
    const order = writesOf(s.log).map((l) => `${l.op} ${l.table}`);
    expect(order.indexOf('UPDATE ast_panels')).toBeLessThan(order.indexOf('INSERT ast_panels'));
  });

  it('If-Match: missing -> 428, stale -> 409 common.version_conflict; nothing superseded; body with `code` / version_no -> 400; another tenant\'s panel -> 404; no micro.config.manage -> 403', async () => {
    const w = mkWorld(); const before = structuredClone(w); const s = setup(w, MGR);
    expectCode(await failure(run('versionAstPanel', versionReq(P.rec, v2(), {}), s.ctx)), 'common.precondition_required', 428);
    expectCode(await failure(run('versionAstPanel', versionReq(P.rec, v2(), ifm(7)), s.ctx)), 'common.version_conflict', 409);
    expectInvalid(await failure(run('versionAstPanel', versionReq(P.rec, { ...v2(), code: 'syn_p_rec' }, ifm(1)), s.ctx)));
    expectInvalid(await failure(run('versionAstPanel', versionReq(P.rec, { ...v2(), version_no: 9 }, ifm(1)), s.ctx)));
    expectInvalid(await failure(run('versionAstPanel', versionReq(P.rec, v2({ antibiotics: [{ antibiotic_code: 'syn_nope', is_reported_default: true }] }), ifm(1)), s.ctx)), '/antibiotics/0/antibiotic_code');
    expectCode(await failure(run('versionAstPanel', versionReq(P.bPanel, v2(), ifm(1)), s.ctx)), 'common.not_found', 404);
    expect(w).toEqual(before);
    for (const grants of [[WORK], [READ], []]) expectCode(await failure(run('versionAstPanel', versionReq(P.rec, v2(), ifm(1)), setup(mkWorld(), grants).ctx)), 'auth.forbidden', 403);
  });
});

describe('C10-T10 M32 deactivateAstPanel / M29 listAstPanels', () => {
  it('M32: If-Match required (428) / stale (409); deactivate -> is_active false, version + 1, AstPanelDto; the panel is no longer picked by precedence; asks only micro.config.manage; body {} only', async () => {
    const w = mkWorld(['o']); const s = setup(w, MGR);
    expectCode(await failure(run('deactivateAstPanel', deactivateReq(P.o, {}), s.ctx)), 'common.precondition_required', 428);
    expectCode(await failure(run('deactivateAstPanel', deactivateReq(P.o, ifm(9)), s.ctx)), 'common.version_conflict', 409);
    expectInvalid(await failure(run('deactivateAstPanel', deactivateReq(P.o, ifm(1), { is_active: false }), s.ctx)));
    const res = await run('deactivateAstPanel', deactivateReq(P.o, ifm(1)), s.ctx);
    expect(res.status).toBe(200);
    expect(schemaErrors('AstPanelDto', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ id: P.o, is_active: false, version: 2 });
    expect(row(w, 'ast_panels', P.o)).toMatchObject({ is_active: false, version: 2, updated_by: ACTOR_USER });
    expect(s.calls.assertRole.map((x) => x['permission']).at(-1)).toBe(MANAGE);
    const s2 = setup(w, [WORK]);                                                                                      // no other panel left for E. coli: M11 finds none
    expectInvalid(await failure(run('assignAstPanel', assign(I.eco, 3), s2.ctx)), '/ast_panel_id');
  });
  it('M32: no micro.config.manage -> 403; another tenant\'s panel -> 404; nothing written', async () => {
    for (const [grants, id, status] of [[[WORK], P.o, 403], [[MANAGE], P.bPanel, 404]] as [string[], string, number][]) {
      const w = mkWorld(['o']); const before = structuredClone(w); const s = setup(w, grants);
      expectCode(await failure(run('deactivateAstPanel', deactivateReq(id, ifm(1)), s.ctx)), status === 403 ? 'auth.forbidden' : 'common.not_found', status);
      expect(writesOf(s.log)).toEqual([]); expect(w).toEqual(before);
    }
  });

  it('M29: default = current versions only (superseded hidden), include_superseded=true shows them, organism_code / organism_group_code narrow the list; AstPanelDto with antibiotics in sort order; tenant-isolated; asks only micro.culture.read', async () => {
    const w = mkWorld(['o', 'g']); const s = setup(w, [READ]);
    const dflt = await run('listAstPanels', { params: {}, query: {}, headers: {}, body: undefined }, s.ctx);
    expect(dflt.status).toBe(200);
    expect(responseErrors('listAstPanels', dflt.body)).toEqual([]);
    const codes = dflt.body.data.map((p: Row) => p['code']);
    expect(codes).toContain('syn_p_rec'); expect(codes).toContain('syn_p_o'); expect(codes).not.toContain('syn_p_old'); expect(codes).not.toContain('syn_p_b');
    const rec = dflt.body.data.find((p: Row) => p['code'] === 'syn_p_rec');
    expect(rec.antibiotics.map((a: Row) => a['sort_order'])).toEqual([0, 1, 2, 3, 4, 5]);
    const all = await run('listAstPanels', { params: {}, query: { include_superseded: true }, headers: {}, body: undefined }, s.ctx);
    expect(all.body.data.map((p: Row) => p['code'])).toContain('syn_p_old');
    expect(all.body.data.some((p: Row) => p['code'] === 'syn_p_b')).toBe(false);
    const byOrg = await run('listAstPanels', { params: {}, query: { organism_code: ECOLI }, headers: {}, body: undefined }, s.ctx);
    expect(byOrg.body.data.map((p: Row) => p['code']).sort()).toEqual(['syn_p_dead', 'syn_p_o']);
    const byGroup = await run('listAstPanels', { params: {}, query: { organism_group_code: GNR }, headers: {}, body: undefined }, s.ctx);
    expect(byGroup.body.data.map((p: Row) => p['code'])).toEqual(['syn_p_g']);
    expect(s.calls.assertRole.every((x) => x['permission'] === READ)).toBe(true);
    for (const grants of [[MANAGE], [WORK], []]) expectCode(await failure(run('listAstPanels', { params: {}, query: {}, headers: {}, body: undefined }, setup(mkWorld(), grants).ctx)), 'auth.forbidden', 403);
  });
});
