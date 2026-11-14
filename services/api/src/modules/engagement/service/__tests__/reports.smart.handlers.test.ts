// C16.T-P4 — E24 getMySmartSummary (patient): the stored approved summary as SmartSummaryView, access log smart_summary.view
// (06-PLAN row T-P4; 02-TRD §5 E24 + SmartSummaryView, §6.2 (no port call), §9.4 access log; 01-PRD US-EN-09.2-4; 04-UI-UX A14 source line "served by E24 from engagement.smart_summaries (never SmartReportPort)";
//  07-SECURITY P-L1 / P-L5 / P-L6, rule 2 (smart-summary text never in logs), rule 7 (smart_summary.view access log, CR-C16-019)). Fails now: handlers/index.ts maps getMySmartSummary to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec fixes behaviour, not names; same convention as reports.handlers.test.ts):
//   handlers.getMySmartSummary({params:{report_id, version_no}, query:{}, headers}, ctx) -> {status:200, body:SmartSummaryView, headers:{cache-control:'no-store'}}; ctx = world.patientCtx(account, {ports:{..}}).
//   Order: fail closed without request context (auth.unauthenticated) / without IdentityPort (common.service_unavailable) -> IdentityPort.assertRole(ctx, {permission:'reporting.portal.view'}) before any query -> params validation (400 common.validation_failed)
//   -> read engagement.patient_reports (caller's ACTIVE links, link.visible_from) + engagement.smart_summaries + settings.smart_report_in_app in plain SQL, tenant_id bound -> map -> ctx.audit.access({action:'smart_summary.view', entityType:'report', entityId: report_id, outcome:'allowed'}) only for a 200.
//   Stored `summary` = the camelCase C6 SmartSummary snapshot without id keys (what fetch_smart_summary.test.ts pins), bound as object or JSON string. The view picks fields: health_score{value,band}, panels[{panel_code, display_name?, status}], deranged[{direction,severity,text}], advice[{text}],
//   follow_ups[{interval_days,text}], trends[{direction}], disclaimer_text?, approved_at (= the row's approved_at). Nothing else (schema additionalProperties:false): no ids, no suggestedTestCode / name, no analyteName, no explanationText, no formula data.
//   404 common.not_found, one and the same for: unknown / foreign / other-tenant / hidden (visible_from, suspended, revoked) report, a version without a stored summary, smart_report_in_app = false (hidden), a stored row whose status is not 'approved' (defence in depth).
//   E24 reads ONLY the local copy: zero ReportingPort / SmartReportPort calls, no rate-limit tier other than `general` (the pipeline's, not the handler's). An OLDER (superseded) version with a stored summary is still served (US-EN-09.4 "shown as superseded"; the app marks it).
// NOT pinned: disclaimer_text when the snapshot has none (server default vs. omitted); ETag; body key order.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ID, TENANT_B, T0, makeLinkWorld } from '../../__tests__/link.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const PHONE_A = '+99001000001', PHONE_B = '+99001000002';
const X = ID(0x800), Y = ID(0x801), X2 = ID(0x802), ORDER_X = ID(0x820), ORDER_Y = ID(0x822), RPT = ID(0x830);
const DAY = 86_400_000, T = Date.parse(T0);
const iso = (ms: number) => new Date(T + ms).toISOString();
const HDR = { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' };
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };
const shape = (e: any) => ({ code: e.code, statusCode: e.statusCode, detail: e.detail });
const hdr = (res: any, n: string) => { const k = Object.keys(res?.headers ?? {}).find((h) => h.toLowerCase() === n); return k ? String(res.headers[k]) : undefined; };

const T1 = 'Synthetic: your LDL is higher than the usual range.', A1 = 'Synthetic: eat more fibre.', F1 = 'Synthetic: repeat the lipid panel.', DISC = 'Synthetic disclaimer text.';
/** The stored copy (ids already stripped by the task) plus fields the view must NOT echo. */
const stored = (o: Record<string, any> = {}) => ({
  status: 'approved', templateLibraryVersion: 'lib-2026.1', approvedAt: '2026-03-01T05:00:00.000Z', language: 'en', builtAt: '2026-03-01T04:50:00.000Z',
  healthScore: { value: 82, band: 'good', formulaVersion: 'hs-1', panelsScored: 2, explanationText: 'Synthetic explanation.' },
  panels: [{ panelCode: 'SYN_LIPID', status: 'borderline', displayName: 'Synthetic Lipid Profile' }, { panelCode: 'SYN_CBC', status: 'in_range' }],
  deranged: [{ direction: 'high', severity: 'borderline', text: T1, analyteName: 'Synthetic LDL' }], advice: [{ text: A1 }],
  followUps: [{ suggestedTestCode: 'SYN_HBA1C', suggestedTestName: 'Synthetic HbA1c', intervalDays: 90, text: F1 }],
  trends: [{ direction: 'improved', analyteName: 'Synthetic LDL', unitCode: 'mg_dl', points: [{ approvedAt: '2026-01-01T04:00:00.000Z', valueNumeric: '130.0' }] }], disclaimerText: DISC, ...o,
});
const EXPECTED = (v = 1) => ({
  report_id: RPT, version_no: v, health_score: { value: 82, band: 'good' }, panels: [{ panel_code: 'SYN_LIPID', display_name: 'Synthetic Lipid Profile', status: 'borderline' }, { panel_code: 'SYN_CBC', status: 'in_range' }],
  deranged: [{ direction: 'high', severity: 'borderline', text: T1 }], advice: [{ text: A1 }], follow_ups: [{ interval_days: 90, text: F1 }], trends: [{ direction: 'improved' }], disclaimer_text: DISC,
});

let seq = 0xa00;
function setup(o: { setting?: boolean } = {}) {
  const w = makeLinkWorld({ maxAccountsPerPatient: 10 });
  w.setSetting('smart_report_in_app', o.setting ?? true);
  const a1 = w.seedAccount(PHONE_A), a2 = w.seedAccount(PHONE_B);
  const linkX = w.seedLink(a1['id'], X), linkY = w.seedLink(a2['id'], Y);
  const portCalls: string[] = [];
  const spy = (n: string) => new Proxy({}, { get: (_t, m) => async () => { portCalls.push(`${n}.${String(m)}`); throw new Error('E24 reads the local copy only'); } });
  const ctxOf = (who: Record<string, any> = a1, over: Record<string, any> = {}) => w.patientCtx(who, { ports: { ...w.ports, ReportingPort: spy('ReportingPort'), SmartReportPort: spy('SmartReportPort') }, ...over });
  /** A projected report version plus (optionally) its stored summary. */
  const report = (over: Record<string, any> = {}, summary: Record<string, any> | null = stored()) => {
    const r: Record<string, any> = { tenant_id: w.tenantId, report_id: RPT, version_no: 1, order_id: ORDER_X, patient_id: X, report_kind: 'final', status: 'valid', released_at: iso(-DAY), supersedes_version_no: null, panel_names: ['Synthetic Lipid Profile'],
      smart_summary_available: summary !== null, created_by: ID(0x7aa), updated_by: ID(0x7aa), created_at: w.now(), updated_at: w.now(), ...over };
    w.t['patient_reports']!.push(r);
    let s: Record<string, any> | undefined;
    if (summary !== null) { s = { id: ID(++seq), tenant_id: r['tenant_id'], order_id: r['order_id'], report_id: r['report_id'], report_version_no: r['version_no'], patient_id: r['patient_id'], summary, template_library_version: 'lib-2026.1',
      approved_at: '2026-03-01T05:00:00.000Z', fetched_at: w.now(), created_by: ID(0x7aa) }; w.t['smart_summaries']!.push(s); }
    return { r, s };
  };
  const get = (p: { report_id?: unknown; version_no?: unknown } = {}, who: Record<string, any> = a1) =>
    w.inTx(() => (handlers as any).getMySmartSummary({ params: { report_id: RPT, version_no: 1, ...p }, query: {}, headers: { ...HDR } }, ctxOf(who)));
  return { w, a1, a2, linkX, linkY, portCalls, ctxOf, report, get };
}
type Fx = ReturnType<typeof setup>;
const access = (f: Fx) => f.w.audit.filter((a) => a['action'] === 'smart_summary.view');

describe('contract sanity', () => {
  it('E24: reporting.portal.view, general tier, 200 SmartSummaryView / 404, no idempotency', () => {
    expect(opOf('getMySmartSummary')).toMatchObject({ 'x-permission': 'reporting.portal.view', 'x-idempotency': 'none', 'x-rate-limit-tier': 'general' });
    expect(Object.keys(opOf('getMySmartSummary').responses)).toEqual(expect.arrayContaining(['200', '404']));
    expect(spec.components.schemas.SmartSummaryView.additionalProperties).toBe(false);
  });
});

describe('guards', () => {
  it('assertRole(reporting.portal.view) is the first thing, before any statement', async () => {
    const f = setup(); f.report(); await f.get();
    expect(f.w.identity.calls[0]).toMatchObject({ permission: 'reporting.portal.view', at: 0 });
  });
  it('without the permission -> auth.forbidden, no statement, no access log; holding only reporting.portal.download is not enough', async () => {
    for (const grants of [[], ['reporting.portal.download']]) {
      const f = setup(); f.report(); f.w.identity.grants = grants;
      expect((await rejection(f.get())).code).toBe('auth.forbidden'); expect(f.w.stmts).toHaveLength(0); expect(f.w.audit).toEqual([]);
    }
  });
  it('a non-patient actor is refused with auth.forbidden before any query', async () => {
    const f = setup(); f.report(); const staff = f.ctxOf(f.a1, { actor: { type: 'user', id: ID(0x7aa) } });
    const e = await rejection(f.w.inTx(() => (handlers as any).getMySmartSummary({ params: { report_id: RPT, version_no: 1 }, query: {}, headers: { ...HDR } }, staff)));
    expect(e.code).toBe('auth.forbidden'); expect(f.w.stmts).toHaveLength(0);
  });
  it('fails closed: no request context -> auth.unauthenticated; no IdentityPort -> common.service_unavailable (never served unauthorised)', async () => {
    const f = setup(); f.report();
    const bare = { ...f.ctxOf(), tenantId: undefined };
    expect((await rejection((handlers as any).getMySmartSummary({ params: { report_id: RPT, version_no: 1 }, query: {}, headers: { ...HDR } }, bare))).code).toBe('auth.unauthenticated');
    const noIdp = f.ctxOf(f.a1, { ports: {} });
    expect((await rejection(f.w.inTx(() => (handlers as any).getMySmartSummary({ params: { report_id: RPT, version_no: 1 }, query: {}, headers: { ...HDR } }, noIdp)))).code).toBe('common.service_unavailable');
  });
  it('bad params -> 400 common.validation_failed (report_id not a uuid; version_no 0, 10000, 1.5, "abc"), nothing queried beyond the role check, no access log', async () => {
    const f = setup(); f.report();
    for (const p of [{ report_id: 'nope' }, { version_no: 0 }, { version_no: 10000 }, { version_no: 1.5 }, { version_no: 'abc' }, { report_id: "' OR 1=1 --" }]) {
      const e = await rejection(f.get(p)); expect(e.code, JSON.stringify(p)).toBe('common.validation_failed');
    }
    expect(f.w.writes()).toHaveLength(0); expect(access(f)).toHaveLength(0);
  });
});

describe('US-EN-09.2 the stored approved summary is served as returned', () => {
  it('200, schema-valid SmartSummaryView with exactly the displayed fields; approved_at from the stored row; Cache-Control no-store', async () => {
    const f = setup(); f.report(); const res = JSON.parse(JSON.stringify(await f.get()));
    expect(res.status).toBe(200); expect(res.body).toMatchObject(EXPECTED()); expect(schemaErrors('SmartSummaryView', res.body)).toEqual([]);
    expect(Date.parse(res.body.approved_at)).toBe(Date.parse('2026-03-01T05:00:00.000Z')); expect(hdr(res, 'cache-control')).toMatch(/no-store/i);
  });
  it('texts are returned exactly as stored (no client-side or server-side rewording): deranged, advice, follow-up, disclaimer', async () => {
    const f = setup(); f.report({}, stored({ deranged: [{ direction: 'low', severity: 'critical', text: '  Synthetic <b>text</b> — with “quotes” & 100% symbols  ' }], advice: [{ text: 'Eins\nZwei' }], disclaimerText: 'Synthetic disclaimer · verbatim.' }));
    const b = (await f.get()).body; expect(b.deranged[0]).toEqual({ direction: 'low', severity: 'critical', text: '  Synthetic <b>text</b> — with “quotes” & 100% symbols  ' }); expect(b.advice[0].text).toBe('Eins\nZwei'); expect(b.disclaimer_text).toBe('Synthetic disclaimer · verbatim.');
  });
  it('the view never echoes ids, suggested test code / name, analyte names, explanation text, formula data or points (P1, REQ-SEC-070)', async () => {
    const f = setup(); f.report({}, stored({ followUps: [{ ruleId: ID(0xf01), suggestedTestCode: 'SYN_HBA1C', suggestedTestName: 'Synthetic HbA1c', intervalDays: 90, text: F1 }], panels: [{ panelCode: 'SYN_LIPID', status: 'borderline', resultIds: [ID(0xf02)], displayName: 'Synthetic Lipid Profile' }] }));
    const s = JSON.stringify((await f.get()).body); expect(s).not.toMatch(/SYN_HBA1C|Synthetic HbA1c|Synthetic LDL|Synthetic explanation|hs-1|formula|130\.0|mg_dl|0000-7000-8000-000000000f0|ruleId|resultIds|suggested/i);
    expect(s).not.toContain(String(X)); expect(s).not.toContain(String(ORDER_X));
  });
  it('a summary without health score / disclaimer / trends is valid: optional parts are omitted, not null', async () => {
    const f = setup(); f.report({}, (({ healthScore: _h, disclaimerText: _d, ...rest }) => ({ ...rest, trends: [] }))(stored())); const res = JSON.parse(JSON.stringify(await f.get()));
    expect(schemaErrors('SmartSummaryView', res.body)).toEqual([]); expect(res.body).not.toHaveProperty('health_score'); expect(res.body.trends).toEqual([]);
  });
  it('the summary JSON may be bound as a JSON string (jsonb driver form) and is read the same', async () => {
    const f = setup(); const { s } = f.report(); s!['summary'] = JSON.stringify(stored()); expect((await f.get()).body).toMatchObject(EXPECTED());
  });
  it('reads only the local copy: zero ReportingPort / SmartReportPort calls (08 A2.3), no write besides the access log, the request is tenant-scoped in every statement', async () => {
    const f = setup(); f.report(); await f.get();
    expect(f.portCalls).toEqual([]); expect(f.w.writes()).toHaveLength(0);
    for (const s of f.w.stmts.filter((x) => /engagement\.|\b(patient_reports|smart_summaries|settings|account_patient_links)\b/i.test(x.text))) expect(s.text).toMatch(/tenant_id/i);
  });
});

describe('access log smart_summary.view (07-SECURITY rule 7, CR-C16-019)', () => {
  it('a 200 writes ONE access-log row: smart_summary.view on the report, outcome allowed; no summary text in it, nothing PHI in logs / metrics', async () => {
    const f = setup(); f.report(); await f.get();
    expect(access(f)).toHaveLength(1); expect(access(f)[0]).toMatchObject({ action: 'smart_summary.view', entityType: 'report', entityId: RPT, outcome: 'allowed' });
    for (const s of [T1, A1, F1, DISC, 'Synthetic Lipid Profile']) expect(f.w.observed()).not.toContain(s);
  });
  it('every 404 writes none', async () => {
    const f = setup(); f.report(); await rejection(f.get({ version_no: 2 })); await rejection(f.get({}, f.a2)); expect(f.w.audit).toEqual([]);
  });
});

describe('404 for everything the caller must not see (P-L1, P-L5, P-L6) — one indistinguishable error', () => {
  it('P-L1: account A2 (not linked to X) gets the same 404 as for an unknown report id; its own summary works', async () => {
    const f = setup(); f.report(); const foreign = await rejection(f.get({}, f.a2)); const unknown = await rejection(f.get({ report_id: ID(0x8ff) }));
    expect(foreign.code).toBe('common.not_found'); expect(shape(foreign)).toEqual(shape(unknown));
    f.report({ report_id: ID(0x831), patient_id: Y, order_id: ORDER_Y }); expect((await f.get({ report_id: ID(0x831) }, f.a2)).status).toBe(200);
    expect((await rejection(f.get({ report_id: ID(0x831) }, f.a1))).code).toBe('common.not_found');
  });
  it('a version without a stored summary (none attached / draft never stored) -> 404', async () => {
    const f = setup(); f.report({}, null); expect((await rejection(f.get())).code).toBe('common.not_found');
  });
  it('feature disabled (smart_report_in_app = false) -> 404 even though the copy exists; switching it back on shows it again', async () => {
    const f = setup({ setting: false }); f.report(); expect((await rejection(f.get())).code).toBe('common.not_found'); expect(access(f)).toHaveLength(0);
    f.w.setSetting('smart_report_in_app', true); expect((await f.get()).status).toBe(200);
  });
  it('defence in depth: a stored row whose snapshot status is not "approved" is never served', async () => {
    for (const status of ['draft', 'Approved', undefined]) { const f = setup(); f.report({}, stored({ status })); expect((await rejection(f.get())).code, String(status)).toBe('common.not_found'); }
  });
  it('rows of another tenant are never served, even with a matching report id / version (REQ-SEC-024)', async () => {
    const f = setup(); f.report({ tenant_id: TENANT_B }); expect((await rejection(f.get())).code).toBe('common.not_found');
  });
  it('visible_from (P-L6): a report released 1 ms before is 404, released exactly at visible_from is served (>=)', async () => {
    const f = setup(); f.linkX['visible_from'] = iso(-10 * DAY);
    f.report({ released_at: iso(-10 * DAY - 1) }); expect((await rejection(f.get())).code).toBe('common.not_found');
    f.report({ report_id: ID(0x832), released_at: iso(-10 * DAY) }); expect((await f.get({ report_id: ID(0x832) })).status).toBe(200);
  });
  it('suspended and revoked links hide the summary (P-L5)', async () => {
    const f = setup(); f.report(); Object.assign(f.linkX, { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: f.w.now() });
    expect((await rejection(f.get())).code).toBe('common.not_found');
    const g = setup(); g.report(); Object.assign(g.linkX, { status: 'revoked', revoked_by_kind: 'patient', revoked_at: g.w.now(), is_active: false });
    expect((await rejection(g.get())).code).toBe('common.not_found');
  });
  it('one account, two profiles: both patients\' summaries are served; a third patient\'s is not', async () => {
    const f = setup(); f.w.seedLink(f.a1['id'], X2, { relationship: 'child' });
    f.report(); f.report({ report_id: ID(0x833), patient_id: X2, order_id: ID(0x823) }); f.report({ report_id: ID(0x834), patient_id: Y, order_id: ORDER_Y });
    expect((await f.get()).status).toBe(200); expect((await f.get({ report_id: ID(0x833) })).status).toBe(200); expect((await rejection(f.get({ report_id: ID(0x834) }))).code).toBe('common.not_found');
  });
});

describe('US-EN-09.4 newer version', () => {
  it('v1 (superseded) keeps its summary and is still served; v2 has its own; the two never mix', async () => {
    const f = setup(); f.report({ status: 'superseded', released_at: iso(-3 * DAY) });
    f.report({ version_no: 2, report_kind: 'amended', supersedes_version_no: 1 }, stored({ healthScore: { value: 64, band: 'fair', formulaVersion: 'hs-1', panelsScored: 2 }, advice: [{ text: 'Synthetic: version two advice.' }] }));
    const v1 = (await f.get({ version_no: 1 })).body, v2 = (await f.get({ version_no: 2 })).body;
    expect(v1).toMatchObject({ version_no: 1, health_score: { value: 82, band: 'good' }, advice: [{ text: A1 }] }); expect(v2).toMatchObject({ version_no: 2, health_score: { value: 64, band: 'fair' }, advice: [{ text: 'Synthetic: version two advice.' }] });
  });
  it('v2 without a stored summary (not approved yet) does not fall back to v1\'s: 404', async () => {
    const f = setup(); f.report({ status: 'superseded' }); f.report({ version_no: 2, supersedes_version_no: 1 }, null); expect((await rejection(f.get({ version_no: 2 }))).code).toBe('common.not_found');
  });
});
