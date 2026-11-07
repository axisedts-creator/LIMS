// packages/fakes/src/LabPort.fake.ts — LabPort fake (IC §4.5 "Fake must support"; C0 TRD §5.4).
import type { LabPort } from "@lims/contracts/ports/LabPort";
import {
  TENANT_A, TENANT_B, LimsError, checkIdempotencyKey, forbidden, idFor, invalid, makeFake, notFound, nowOf, sha256Hex, tenantOf,
  type FakeOpts,
} from "./base";

type Row = Record<string, any> & { id: string; tenantId: string };
export interface LabFixtures {
  /** Permission grants per actor id (user actors); system actors are tenant-wide [CONV]. */
  grants: Record<string, string[]>;
  orders: Row[];        // { patientId, centreId, priority, patient: { sex, ageDays? } }
  items: Row[];         // { orderId, testId, departmentId, workflowType, cancelled?, reportedAt? }
  specimens: Row[];     // { orderId, barcode, specimenTypeCode, status, itemIds[], receivedAt?, collectedAt?, isActive, replacesSpecimenId?, version }
  results: Row[];       // ResultView fields + { resultedAt?, lastPhase?, lastPayloadVersion? }
  mappings: Row[];      // { instrumentId, instrumentCode, analyteId, testId } (outbound/host-query mapping)
  criticalLimits: Row[]; // { analyteId, low?, high? }
  qcHolds: Row[];       // { instrumentId, analyteId } (programmable QC hold ⇒ outcome `held`)
  amendmentReasons: string[];
}

const MODULE_WORKFLOWS = ["microbiology", "anatomic", "molecular"];
const BEYOND_PENDING = ["resulted", "verified", "approved"];

function defaults(seed: number): LabFixtures {
  const id = (n: number) => idFor(seed, n);
  const row = (n: number, tenantId: string, r: Record<string, unknown>): Row => ({ id: id(n), tenantId, ...r });
  const res = (n: number, tenantId: string, item: number, status: string, extra: Record<string, unknown> = {}): Row =>
    row(n, tenantId, { orderItemId: id(item), testId: id(0x50), analyteId: id(0x60), versionNo: 1, status, origin: "manual",
      commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false, ...extra });
  return {
    grants: {},
    orders: [
      row(1, TENANT_A, { patientId: id(0x70), centreId: id(0x80), priority: "routine", patient: { sex: "female", ageDays: 12000 } }),
      row(2, TENANT_B, { patientId: id(0x71), centreId: id(0x81), priority: "routine", patient: { sex: "male", ageDays: 9000 } }),
    ],
    items: [
      row(0x11, TENANT_A, { orderId: id(1), testId: id(0x50), departmentId: id(0x90), workflowType: "standard" }),
      row(0x12, TENANT_B, { orderId: id(2), testId: id(0x50), departmentId: id(0x90), workflowType: "standard" }),
    ],
    specimens: [
      row(0x21, TENANT_A, { orderId: id(1), barcode: "SYN-A-0001", specimenTypeCode: "BLOOD", status: "received", itemIds: [id(0x11)],
        receivedAt: "2026-11-05T03:00:00.000Z", isActive: true, version: 1 }),
      row(0x22, TENANT_B, { orderId: id(2), barcode: "SYN-B-0001", specimenTypeCode: "BLOOD", status: "received", itemIds: [id(0x12)],
        receivedAt: "2026-11-05T03:00:00.000Z", isActive: true, version: 1 }),
    ],
    results: [res(0x31, TENANT_A, 0x11, "approved", { valueNumeric: "13.40", approvedAt: "2026-11-05T04:00:00.000Z" }), res(0x32, TENANT_B, 0x12, "pending")],
    mappings: [row(0x41, TENANT_A, { instrumentId: id(0xa0), instrumentCode: "HGB", analyteId: id(0x60), testId: id(0x50) })],
    criticalLimits: [],
    qcHolds: [],
    amendmentReasons: ["correction", "module_phase_progression", "supplementary_report", "module_preliminary_update"],
  };
}

export function createFakeLabPort(opts: FakeOpts<LabFixtures>) {
  return makeFake<LabFixtures, LabPort>(defaults, opts, ({ fixtures: fx, events, nextId }) => {
    const ingestKeys = new Map<string, { outcome: string; resultId?: string; specimenId?: string; reasonCode?: string }>();
    const holds = new Map<string, { heldResultIds: string[]; reviewFlaggedResultIds: string[] }>();
    const moduleKeys = new Map<string, { resultId: string; versionNo: number; status: string }>();

    const mine = <T extends Row>(rows: T[], ctx: any) => { const t = tenantOf(ctx); return rows.filter((r) => r.tenantId === t); };
    const order = (ctx: any, orderId: unknown) => { const o = mine(fx.orders, ctx).find((x) => x.id === orderId); if (!o) throw notFound(); return o; };
    const perms = (ctx: any): string[] => fx.grants[ctx?.actor?.id] ?? [];
    const has = (ctx: any, p: string) => ctx?.actor?.type === "system" || perms(ctx).includes(p);
    const itemsOf = (ctx: any, orderId: string) => mine(fx.items, ctx).filter((i) => i.orderId === orderId);
    const resultsOf = (ctx: any, itemId: string) => mine(fx.results, ctx).filter((r) => r.orderItemId === itemId);
    const view = (r: Row) => {
      const { tenantId: _t, resultedAt: _ra, lastPhase: _lp, lastPayloadVersion: _lv, id, ...v } = r;
      return { resultId: id, ...v };
    };
    const hashOf = (rs: Row[]) => sha256Hex(rs.map((r) => `${r.id}:${r.versionNo}`).sort().join("\n"));
    const publish = (ctx: any, type: string, key: string, aggId: string, payload: Record<string, unknown>) =>
      events?.publish(ctx.tx, type, { tenantId: tenantOf(ctx), idempotencyKey: key, aggregate: { type: "result", id: aggId }, payload });
    const critical = async (ctx: any, r: Row, direction: "low" | "high" | "abnormal") => {
      const o = fx.orders.find((x) => x.id === fx.items.find((i) => i.id === r.orderItemId)?.orderId)!;
      await publish(ctx, "lab.critical_value.detected.v1", `critical:${r.id}:${r.versionNo}:${nowOf(ctx)}`, r.id, {
        critical_event_id: nextId(), result_id: r.id, result_version_no: r.versionNo, order_id: o.id, patient_id: o.patientId,
        centre_id: o.centreId, analyte_id: r.analyteId, direction, detected_at: nowOf(ctx),
      });
    };
    const pendingTests = (ctx: any, s: Row, instrumentId?: string) => s.itemIds.map((itemId: string) => {
      const item = mine(fx.items, ctx).find((i) => i.id === itemId);
      const pend = resultsOf(ctx, itemId).filter((r) => r.status === "pending"
        && (!instrumentId || fx.mappings.some((m) => m.tenantId === s.tenantId && m.instrumentId === instrumentId && m.analyteId === r.analyteId)));
      return item && pend.length ? { orderItemId: itemId, testId: item.testId, analyteIds: pend.map((r) => r.analyteId) } : undefined;
    }).filter(Boolean);
    const receivable = (s: Row) => !!s.receivedAt && !["rejected", "discarded"].includes(s.status);

    return {
      async getOrderResults(ctx, input) {
        const o = order(ctx, input.orderId);
        const approvedOnly = input.scope === "approved";
        if (!approvedOnly && !has(ctx, "lab.result.read")) throw forbidden();
        const items = itemsOf(ctx, o.id).map((i) => ({ orderItemId: i.id, testId: i.testId, departmentId: i.departmentId,
          results: resultsOf(ctx, i.id).filter((r) => !approvedOnly || r.status === "approved").map(view) }));
        const approved = itemsOf(ctx, o.id).flatMap((i) => resultsOf(ctx, i.id)).filter((r) => r.status === "approved");
        const specimens = mine(fx.specimens, ctx).filter((s) => s.orderId === o.id).map((s) => ({
          specimenId: s.id, specimenTypeCode: s.specimenTypeCode, status: s.status, collectedAt: s.collectedAt, receivedAt: s.receivedAt,
          ...(approvedOnly ? { barcode: s.barcode } : {}),
        }));
        return { orderId: o.id, specimens, items, approvedSetHash: await hashOf(approved) } as any;
      },

      async getPendingTestsForBarcode(ctx, input) {
        const s = mine(fx.specimens, ctx).find((x) => x.barcode === input.barcode);
        if (!s) throw new LimsError("lab.specimen_not_found");
        if (!receivable(s)) throw new LimsError("lab.specimen_not_receivable");
        const o = order(ctx, s.orderId);
        return { specimenId: s.id, priority: o.priority, patient: o.patient, tests: pendingTests(ctx, s) } as any;
      },

      async ingestInstrumentResult(ctx, input) {
        tenantOf(ctx);
        const key = [input.instrumentId, input.sampleBarcode, input.instrumentAnalyteCode, input.instrumentResultTime ?? ""].join("|");
        const prev = ingestKeys.get(key);
        if (prev && !["unmatched", "rejected_state"].includes(prev.outcome)) return { outcome: "duplicate", resultId: prev.resultId, specimenId: prev.specimenId };
        const done = (o: { outcome: string; resultId?: string; specimenId?: string; reasonCode?: string }) => { ingestKeys.set(key, o); return o as any; };
        const s = mine(fx.specimens, ctx).find((x) => x.barcode === input.sampleBarcode);
        if (!s || input.mappingStatus !== "mapped" || !input.analyteId) return done({ outcome: "unmatched", specimenId: s?.id, reasonCode: s ? "mapping_not_found" : "barcode_not_found" });
        const r = mine(fx.results, ctx).find((x) => s.itemIds.includes(x.orderItemId) && x.analyteId === input.analyteId && x.status !== "cancelled");
        if (!r) return done({ outcome: "unmatched", specimenId: s.id, reasonCode: "result_not_found" });
        if (r.status === "approved") return done({ outcome: "rejected_state", resultId: r.id, specimenId: s.id, reasonCode: "result_locked" });
        Object.assign(r, { status: "resulted", origin: "instrument", instrumentId: input.instrumentId, valueNumeric: input.valueNumeric,
          valueText: input.valueRaw, unitCode: input.unitCode, resultedAt: input.instrumentResultTime ?? input.receivedAt ?? nowOf(ctx), flag: "N" });
        const lim = mine(fx.criticalLimits, ctx).find((l) => l.analyteId === r.analyteId);
        const v = Number(input.valueNumeric);
        if (lim && input.valueNumeric !== undefined && !Number.isNaN(v)) {
          if (lim.low !== undefined && v < Number(lim.low)) { r.flag = "LL"; await critical(ctx, r, "low"); }
          else if (lim.high !== undefined && v > Number(lim.high)) { r.flag = "HH"; await critical(ctx, r, "high"); }
        }
        const held = mine(fx.qcHolds, ctx).some((h) => h.instrumentId === input.instrumentId && h.analyteId === r.analyteId);
        if (held) r.onHold = true;
        return done({ outcome: held ? "held" : "applied", resultId: r.id, specimenId: s.id });
      },

      async holdResultsSince(ctx, input) {
        tenantOf(ctx);
        const k = `${tenantOf(ctx)}|${input.qcRunId}`;
        const prev = holds.get(k);
        if (prev) return prev;
        const out = { heldResultIds: [] as string[], reviewFlaggedResultIds: [] as string[] };
        for (const r of mine(fx.results, ctx)) {
          if (r.instrumentId !== input.instrumentId || !input.analyteIds.includes(r.analyteId) || !r.resultedAt || r.resultedAt < input.since) continue;
          if (r.status === "cancelled") continue;
          if (r.status === "approved") { r.qcReviewRequired = true; out.reviewFlaggedResultIds.push(r.id); } else { r.onHold = true; out.heldResultIds.push(r.id); }
        }
        holds.set(k, out);
        return out;
      },

      async submitModuleResult(ctx, input) {
        checkIdempotencyKey(input.idempotencyKey);
        const t = tenantOf(ctx);
        const replay = moduleKeys.get(`${t}|${input.idempotencyKey}`);
        if (replay) return { ...replay, replayed: true } as any;
        const item = mine(fx.items, ctx).find((i) => i.id === input.orderItemId);
        if (!item) throw notFound();
        const ref = input.payloadRef;
        if (!MODULE_WORKFLOWS.includes(item.workflowType) || !ref || !["micro", "anatomic"].includes(ref.module)) throw new LimsError("lab.module_result_invalid");
        const r = resultsOf(ctx, item.id).find((x) => !input.analyteId || x.analyteId === input.analyteId);
        if (!r) throw notFound();
        if (r.lastPayloadVersion !== undefined && ref.versionNo < r.lastPayloadVersion) throw new LimsError("lab.module_result_stale");
        const now = nowOf(ctx);
        if (r.status === "approved") {
          if (!has(ctx, "lab.result.amend")) throw new LimsError("lab.result_locked");
          const code = input.amendment?.reasonCode;
          if (!code) throw new LimsError("lab.amendment_reason_required");
          if (!fx.amendmentReasons.includes(code)) throw invalid("amendment_reason_unknown");
          const micro = ref.module === "micro";
          if (code === "module_phase_progression" && !(micro && input.reportPhase === "final" && r.lastPhase === "preliminary")) throw new LimsError("lab.module_result_invalid");
          if (code === "module_preliminary_update" && !(micro && input.reportPhase === "preliminary")) throw new LimsError("lab.module_result_invalid");
          if (code === "supplementary_report" && ref.module !== "anatomic") throw new LimsError("lab.module_result_invalid");
          const prevNo = r.versionNo;
          Object.assign(r, { versionNo: prevNo + 1, status: "approved", origin: "module", moduleRef: { ...ref }, valueText: input.summaryText,
            flag: input.flag, lastPhase: input.reportPhase, lastPayloadVersion: ref.versionNo,
            amendment: { previousVersionNo: prevNo, reasonCode: code, reasonText: input.amendment?.reasonText, amendedAt: now } });
          await publish(ctx, "lab.result.amended.v1", `amend:${r.id}:${r.versionNo}`, r.id, {
            result_id: r.id, previous_version_no: prevNo, new_version_no: r.versionNo, order_id: item.orderId, order_item_id: item.id,
            test_id: r.testId, analyte_id: r.analyteId, amendment_reason_code: code, amended_at: now,
            amended_by_membership_id: ctx.actor?.membershipId ?? ctx.actor?.id,
          });
        } else {
          Object.assign(r, { status: "resulted", origin: "module", moduleRef: { ...ref }, valueText: input.summaryText, flag: input.flag,
            lastPhase: input.reportPhase, lastPayloadVersion: ref.versionNo, resultedAt: input.submittedAt ?? now,
            verifiedAt: undefined, verifiedByMembershipId: undefined });
        }
        if (input.isCritical) await critical(ctx, r, "abnormal");
        const out = { resultId: r.id, versionNo: r.versionNo, status: r.status };
        moduleKeys.set(`${t}|${input.idempotencyKey}`, out);
        return { ...out, replayed: false } as any;
      },

      async getOrderItemProcessingState(ctx, input) {
        const type = ctx?.actor?.type;
        if (type !== "system" && !(type === "user" && (has(ctx, "frontdesk.order.read") || has(ctx, "frontdesk.order.edit")))) throw forbidden();
        const o = order(ctx, input.orderId);
        const specs = mine(fx.specimens, ctx).filter((s) => s.orderId === o.id);
        return itemsOf(ctx, o.id).map((i) => {
          const linked = specs.filter((s) => s.itemIds.includes(i.id));
          const rs = resultsOf(ctx, i.id);
          const received = linked.some((s) => s.status !== "rejected" && s.receivedAt);
          const entered = rs.some((r) => BEYOND_PENDING.includes(r.status));
          const rejectedNoRecollection = linked.length > 0 && linked.every((s) => s.status === "rejected" && !specs.some((x) => x.replacesSpecimenId === s.id));
          const processingStatus = i.cancelled || rejectedNoRecollection ? "cancelled" : i.reportedAt ? "reported" : !received && !entered ? "not_started" : "in_progress";
          return { orderItemId: i.id, removable: !received && !entered, ...(received ? { reasonCode: "specimen_received" } : entered ? { reasonCode: "result_entered" } : {}), processingStatus };
        }) as any;
      },

      async listPendingForInstrument(ctx, input) {
        tenantOf(ctx);
        const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
        const rows = mine(fx.specimens, ctx)
          .filter((s) => receivable(s) && (!input.receivedSince || s.receivedAt >= input.receivedSince) && (!input.cursor || s.id > input.cursor))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((s) => ({ s, tests: pendingTests(ctx, s, input.instrumentId) }))
          .filter((x) => x.tests.length > 0);
        const page = rows.slice(0, limit).map(({ s, tests }) => {
          const o = fx.orders.find((x) => x.id === s.orderId)!;
          return { specimenId: s.id, barcode: s.barcode, priority: o.priority, patient: o.patient, tests };
        });
        return { items: page, ...(rows.length > limit ? { nextCursor: page.at(-1)!.specimenId } : {}) } as any;
      },

      async lookupSpecimens(ctx, input: any) {
        const type = ctx?.actor?.type;
        if (type === "device") throw forbidden();
        const isOrderForm = typeof input.orderId === "string";
        if (type !== "system" && !(has(ctx, "lab.specimen.read") || (isOrderForm && has(ctx, "homecollection.visit.read")))) throw forbidden();
        const all = mine(fx.specimens, ctx);
        let hit: Row[];
        if (typeof input.barcode === "string") hit = all.filter((s) => s.barcode === input.barcode);
        else if (Array.isArray(input.specimenIds)) {
          if (input.specimenIds.length < 1 || input.specimenIds.length > 200) throw invalid("specimen_ids_count");
          hit = all.filter((s) => input.specimenIds.includes(s.id));
        } else if (isOrderForm) hit = all.filter((s) => s.orderId === input.orderId && (!input.statuses || input.statuses.includes(s.status)));
        else throw invalid("selector_required");
        return hit.map((s) => {
          const o = fx.orders.find((x) => x.id === s.orderId)!;
          return { specimenId: s.id, barcode: s.barcode, orderId: s.orderId, patientId: o.patientId, centreId: o.centreId,
            processingCentreId: s.processingCentreId, specimenTypeCode: s.specimenTypeCode, containerCode: s.containerCode, status: s.status,
            isActive: s.isActive, replacesSpecimenId: s.replacesSpecimenId, parentSpecimenId: s.parentSpecimenId, version: s.version };
        }) as any;
      },

      async getAnalyteHistory(ctx, input) {
        tenantOf(ctx);
        const ids: string[] = input.analyteIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) throw invalid("analyte_ids_count");
        const limit = input.limitPerAnalyte;
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw invalid("limit_per_analyte");
        const orderIds = new Set(mine(fx.orders, ctx).filter((o) => o.patientId === input.patientId && o.id !== input.excludeOrderId).map((o) => o.id));
        const itemOrder = new Map(mine(fx.items, ctx).filter((i) => orderIds.has(i.orderId)).map((i) => [i.id, i.orderId]));
        const pts = mine(fx.results, ctx).filter((r) => r.status === "approved" && itemOrder.has(r.orderItemId) && r.approvedAt
          && r.approvedAt < input.before && (!input.since || r.approvedAt >= input.since));
        return { series: ids.map((analyteId) => ({ analyteId, points: pts.filter((r) => r.analyteId === analyteId)
          .sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1)).slice(0, limit)
          .map((r) => ({ source: "lis", resultId: r.id, orderId: itemOrder.get(r.orderItemId), versionNo: r.versionNo, approvedAt: r.approvedAt,
            valueNumeric: r.valueNumeric, unitCode: r.unitCode, flag: r.flag })) })) } as any;
      },
    };
  });
}
