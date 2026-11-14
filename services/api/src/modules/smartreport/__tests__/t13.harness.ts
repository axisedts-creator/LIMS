// C14 T13 real-implementation harness for runSmartReportPortContract (not a test file; synthetic data only).
// Same ContractHarness shape as packages/fakes/src/harness.ts. The REAL port runs over the T12 emulators: repositories are vi.mock'd by the TEST file
// (summaries/bindings/library/blocks/rules/mappings/groups/codedSets -> ./t12.fakes.js); IdentityPort/FrontdeskPort/LabPort/CatalogPort are fakes built from the
// contract fixtures. The real summary.service + engine build every summary. Nothing here knows the port's internals, only its public signature.
//
// seed(fixtures) = merge by id into a store, then REBUILD the whole world from the store (resets summaries/bindings = "resets the impl's mutable state"):
//   tenants[t]   -> IdentityPort featureFlags.smart_report = enabled; libraryApproved -> ONE approved library version (version_no 1, min_groups_scored = minGroupsScored,
//                   trend on, starter blocks/rules, a mapping per analyte of the tenant's orders -> group = panelCode, a group setting per panelCode, one follow-up
//                   block+rule per followUpRules row of the tenant: block text 'Repeat {test_name} after {interval_days} days.', test name has no digit).
//   orders[o]    -> FrontdeskPort order (patientId, centre) + LabPort approved results (one item per panelCode, flag/value/unit/referenceRangeSnapshot from the fixture);
//                   LabPort.approvedSetHash = sha256(approvedSetHash fixture) so an amendment (new hash string) changes it.
//   history[h]   -> LabPort.getAnalyteHistory points (source 'lis', unit of the current result), filtered by tenant + patient + analyte + before/since.
//   reviewStatus != 'pending' -> the harness plays the reviewer: it builds the summary with the real service, then marks the stored row rejected / approved.
// Each buildSummary call is one transaction: the advisory lock taken through ctx.tx is released when the call settles (like a commit/rollback).
import { createHash } from 'node:crypto';
import { TENANTS } from '../../../../../../packages/fakes/src/base';
import { createEventSpy } from '../../../../../../packages/fakes/src/event-spy';
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness';
import { buildOrGet } from '../summary.service.js';
import { starterLibrary, type LibInput } from './t10.fixtures.js';
import { loadLibrary, seed as seedLibraries, world as lib } from './t11.fakes.js';
import { CatalogPort, FrontdeskPort, LabPort as BaseLab, makeCtx, seed as seedWorld, w } from './t12.fakes.js';

type Row = Record<string, any>;
const hid = (n: number): string => `01900000-7300-7000-8000-${n.toString(16).padStart(12, '0')}`;
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const RESULT_APPROVED_AT = '2026-11-04T04:00:00.000Z';

export function realPortHarness(getImpl: () => any): () => Promise<ContractHarness> {
  return async () => {
    const store = { tenants: new Map<string, Row>(), orders: new Map<string, Row>(), history: new Map<string, Row>(), rules: new Map<string, Row>() };
    const keyOf = (tenantId: string): 'A' | 'B' => (tenantId === TENANTS.A ? 'A' : 'B');
    const baseCtxFor = makeCtxFor();

    const IdentityPort = {
      async getTenantSettings(ctx: any, input: { keys: string[] }) {
        const enabled = store.tenants.get(ctx.tenantId)?.enabled === true;
        const all: Row = { featureFlags: enabled ? { smart_report: true } : {} };
        return Object.fromEntries((input?.keys ?? Object.keys(all)).map((k) => [k, all[k]]));
      },
    };
    const LabPort = {
      async getOrderResults(ctx: any, input: { orderId: string; scope: string }) {
        const r = await BaseLab.getOrderResults(ctx, input);                       // tenant-scoped: another tenant's order -> common.not_found
        return { ...r, approvedSetHash: sha256Hex(String(store.orders.get(input.orderId)?.approvedSetHash)) };
      },
      async getAnalyteHistory(ctx: any, input: Row) {
        const unitOf = (analyteId: string): string | undefined => {
          for (const o of store.orders.values()) if (o.tenantId === ctx.tenantId) for (const r of o.results) if (r.analyteId === analyteId) return r.unitCode;
          return undefined;
        };
        return {
          series: (input.analyteIds as string[]).map((analyteId) => ({
            analyteId,
            points: [...store.history.values()]
              .filter((h) => h.tenantId === ctx.tenantId && h.patientId === input.patientId && h.analyteId === analyteId && h.approvedAt < input.before && h.approvedAt >= input.since)
              .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt)).slice(0, input.limitPerAnalyte)
              .map((h) => ({ source: 'lis', resultId: h.resultId, approvedAt: h.approvedAt, valueNumeric: h.valueNumeric, unitCode: unitOf(analyteId) })),
          })),
        };
      },
    };
    const ports = { IdentityPort, FrontdeskPort, LabPort, CatalogPort };

    function ctxFor(actorKey: string, over?: Row): any {
      const base: any = baseCtxFor(actorKey, over);
      const t = makeCtx(keyOf(base.tenantId), 'system');
      return Object.assign(base, { tx: over?.tx ?? t.tx, ports, log: t.log, metrics: t.metrics, commitOnError: t.commitOnError, release: t.release });
    }
    /** One call = one transaction: the advisory lock is released when it settles. */
    const impl = { buildSummary: async (ctx: any, input: unknown) => { try { return await getImpl().buildSummary(ctx, input); } finally { ctx.release?.(); } } };

    function rebuildWorld(): void {
      seedWorld(); seedLibraries();
      w.orders = []; w.tests = new Map(); w.results = new Map();
      const panels = [...new Set([...store.orders.values()].flatMap((o) => o.results.map((r: Row) => r.panelCode as string)))].sort();
      const testIdOfPanel = (p: string): string => hid(0x200 + panels.indexOf(p));
      const itemIdOfPanel = (p: string): string => hid(0x250 + panels.indexOf(p));
      const rules = [...store.rules.values()];
      const followTestId = (code: string): string => hid(0x300 + [...new Set(rules.map((r) => r.suggestedTestCode as string))].sort().indexOf(code));

      for (const o of store.orders.values()) {
        w.orders.push({ tenantId: o.tenantId, orderId: o.id, patientId: o.patientId, centreId: hid(keyOf(o.tenantId) === 'A' ? 0xa201 : 0xb201) });
        w.results.set(o.id, o.results.map((r: Row) => ({
          resultId: r.resultId, orderItemId: itemIdOfPanel(r.panelCode), testId: testIdOfPanel(r.panelCode), analyteId: r.analyteId, versionNo: 1, status: 'approved', origin: 'manual',
          commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false, approvedAt: RESULT_APPROVED_AT, valueNumeric: r.valueNumeric,
          ...(r.unitCode !== undefined && { unitCode: r.unitCode }), flag: r.flag,
          ...(r.refLow !== undefined || r.refHigh !== undefined ? { referenceRangeSnapshot: { referenceRangeId: hid(0x600), version: 1, ...(r.refLow !== undefined && { low: r.refLow }), ...(r.refHigh !== undefined && { high: r.refHigh }) } } : {}),
        })));
      }
      for (const tenantId of new Set([...store.tenants.keys(), ...[...store.orders.values()].map((o) => o.tenantId as string)])) {
        const tOrders = [...store.orders.values()].filter((o) => o.tenantId === tenantId);
        for (const p of panels) {
          const analytes = new Map<string, Row>();
          for (const o of tOrders) for (const r of o.results) if (r.panelCode === p) analytes.set(r.analyteId, { id: r.analyteId, code: r.analyteId, name: r.analyteName, resultType: 'numeric', reportable: true, sortOrder: (analytes.size + 1) * 10 });
          if (analytes.size > 0) w.tests.set(`${tenantId}:${testIdOfPanel(p)}`, { id: testIdOfPanel(p), code: p, name: p, isActive: true, departmentId: hid(0xd001), departmentCode: 'LAB', specimenTypeCodes: ['BLOOD'], workflowType: 'standard', revision: 1, analytes: [...analytes.values()] });
        }
        const tRules = rules.filter((r) => r.tenantId === tenantId);
        for (const r of tRules) w.tests.set(`${tenantId}:${followTestId(r.suggestedTestCode)}`, { id: followTestId(r.suggestedTestCode), code: r.suggestedTestCode, name: r.suggestedTestName ?? 'Glycated haemoglobin test', isActive: true, analytes: [] });

        const t = store.tenants.get(tenantId);
        if (t?.libraryApproved !== true) continue;
        const l: LibInput = starterLibrary();
        const byAnalyte = new Map<string, string>();
        for (const o of tOrders) for (const r of o.results) if (!byAnalyte.has(r.analyteId)) byAnalyte.set(r.analyteId, r.panelCode);
        l.mappings = [...byAnalyte].map(([analyteId, groupCode], i) => ({ id: hid(0x400 + i), analyteId, groupCode }));
        tRules.forEach((r, i) => {
          l.blocks.push({ id: hid(0x500 + i), blockKey: `followup.rule${i}`, kind: 'followup', textEn: 'Repeat {test_name} after {interval_days} days.' });
          l.rules.push({ id: r.id, ruleKind: 'followup', triggerKind: 'analyte', analyteId: r.analyteId, direction: r.direction, minSeverity: 'borderline', priority: 100, blockId: hid(0x500 + i), blockKind: 'followup', suggestedTestId: followTestId(r.suggestedTestCode), intervalDays: r.intervalDays });
        });
        const vid = hid(0x100 + (keyOf(tenantId) === 'A' ? 0 : 1));
        loadLibrary(tenantId, vid, l, { status: 'approved', version_no: 1, min_groups_scored: t.minGroupsScored, content_sha256: sha256Hex(`lib:${tenantId}`), approved_at: new Date('2026-11-01T00:00:00.000Z'), approved_by_membership_id: hid(0x700) });
        for (const m of lib.mappings) if (m.tenant_id === tenantId) m.trend_enabled = true;
        [...new Set(byAnalyte.values())].sort().forEach((code, i) => lib.groupSettings.push({ id: hid(0x800 + i), tenant_id: tenantId, library_version_id: vid, group_code: code, display_en: code, display_ne: null, score_weight: 1, sort_order: (i + 1) * 10, is_shown: true, is_active: true, version: 1 }));
      }
    }

    /** The reviewer: build with the real service, then mark the stored summary rejected / approved. */
    async function review(): Promise<void> {
      for (const o of store.orders.values()) {
        if (o.reviewStatus === 'pending' || o.reviewStatus === undefined) continue;
        const c = ctxFor(`${keyOf(o.tenantId)}:system`);
        try { await buildOrGet(c, { orderId: o.id }); } catch { continue; } finally { c.release(); }   // no library -> nothing to review
        const row = w.summaries.find((s) => s.tenant_id === o.tenantId && s.order_id === o.id)!;
        if (o.reviewStatus === 'approved') Object.assign(row, { status: 'approved', approved_at: o.approvedAt ?? '2026-11-05T04:00:00.000Z', approved_by_membership_id: o.approvedByMembershipId ?? hid(0x701), version: row.version + 1 });
        else Object.assign(row, { status: 'rejected', rejected_at: '2026-11-05T04:00:00.000Z', rejected_by_membership_id: hid(0x701), reject_reason_code: 'wording_problem', version: row.version + 1 });
      }
    }

    const events = createEventSpy();
    return {
      impl, events, ctxFor,
      async seed(f: Row) {
        for (const [id, t] of Object.entries(f.tenants ?? {})) store.tenants.set(id, t as Row);
        for (const o of (f.orders ?? []) as Row[]) store.orders.set(o.id, o);
        for (const h of (f.history ?? []) as Row[]) store.history.set(h.resultId, h);
        for (const r of (f.followUpRules ?? []) as Row[]) store.rules.set(r.id, r);
        rebuildWorld(); await review();
      },
      rollback(tx: unknown) { events.rollback(tx); },
    };
  };
}
