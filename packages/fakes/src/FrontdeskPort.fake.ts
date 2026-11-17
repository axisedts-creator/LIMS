// packages/fakes/src/FrontdeskPort.fake.ts — FrontdeskPort fake (IC §4.3; C0 TRD §5.4; D-110 callers C14/C15).
import type { FrontdeskPort, OrderSummary, PatientDemographics, DemographicsPurpose } from "@lims/contracts/ports/FrontdeskPort";
import {
  FIXED_NOW, TENANTS, actorIdFor, actorType, checkIdempotencyKey, forbidden, idFor, invalid, makeFake, notFound, err,
  requireStr, tenantOf, type FakeOpts,
} from "./base";

type Row<T> = T & { tenantId: string };
export interface FrontdeskPatientRow {
  id: string; tenantId: string; patientCode: string; fullName: string; sex: PatientDemographics["sex"]; birthOn?: string;
  ageAtOrder?: { years: number; months: number; days: number }; phoneE164?: string; email?: string;
  consents: PatientDemographics["consents"]; status: PatientDemographics["status"];
}
export interface FrontdeskActorRow { actorId: string; tenantId: string; permissions: string[]; centreIds: string[] | null /* null = all centres */ }
export interface FrontdeskOrderableRow { id: string; tenantId: string | null; kind: "test" | "panel"; testIds: string[]; isActive: boolean; hasPrice?: boolean }
export interface FrontdeskFixtures {
  patients: FrontdeskPatientRow[];
  orders: Row<OrderSummary & { idempotencyKey?: string }>[];
  orderables: FrontdeskOrderableRow[];
  actors: FrontdeskActorRow[];
  orderFlags: { id: string; tenantId: string; orderId: string; kind: string }[];
}

const STAFF_PERMS = [
  "frontdesk.patient.read", "frontdesk.order.read", "lab.worklist.read", "lab.result.enter", "homecollection.visit.assign",
  "partners.manifest.receive", "engagement.link.issue",
];
const CONSENTS = { sms: true, whatsapp: false, email: true, shareWithReferrer: false, consentTextVersion: "v1" };

function defaults(seed: number): FrontdeskFixtures {
  const id = (n: number) => idFor(seed, n);
  const fx: FrontdeskFixtures = { patients: [], orders: [], orderables: [], actors: [], orderFlags: [] };
  (["A", "B"] as const).forEach((k, i) => {
    const t = TENANTS[k];
    const base = 0x100 * (i + 1);
    fx.actors.push({ actorId: actorIdFor(k, "user"), tenantId: t, permissions: STAFF_PERMS, centreIds: null });
    fx.patients.push({
      id: id(base + 1), tenantId: t, patientCode: `P-${k}-0001`, fullName: `Test Patient 00${41 + i}`, sex: "female",
      birthOn: "1990-01-01", ageAtOrder: { years: 36, months: 10, days: 4 }, phoneE164: `+97798000000${i}0`,
      email: `patient${i}@example.com`, consents: CONSENTS, status: "active",
    });
    fx.orderables.push({ id: id(base + 2), tenantId: t, kind: "test", testIds: [id(base + 3)], isActive: true });
    fx.orders.push({                                                      // orderId first: mergeFixtures keys rows by the first *Id field
      orderId: id(base + 4), tenantId: t, registrationNo: "0001SY000001", patientId: id(base + 1), branchId: id(base + 5),
      centreId: id(base + 6), visitType: "opd", billingMode: "cash", priority: "routine", status: "registered", source: "front_desk",
      items: [{ orderItemId: id(base + 7), orderableId: id(base + 2), orderableKind: "test", testIds: [id(base + 3)], priority: "routine", status: "active", outsourced: false }],
      registeredAt: FIXED_NOW, version: 1,
    });
  });
  return fx;
}

/** Allowlist per purpose (IC §4.3 "Field allowlist by purpose"); patientId + status always [CONV]. */
const ALLOW: Record<DemographicsPurpose, string[]> = {
  report_render: ["fullName", "sex", "ageAtOrder", "birthOn", "patientCode"],
  label_print: ["fullName", "sex", "ageAtOrder", "patientCode"],
  notification: ["phoneE164", "email", "consents"],
  instrument_host_query: ["sex", "ageAtOrder"],
  portal_display: ["maskedName", "sex", "ageAtOrder"],
  partner_display: ["maskedName", "sex", "ageAtOrder"],
  smart_report: ["sex", "ageAtOrder"],
  home_visit: ["fullName", "phoneE164", "consents", "birthOn", "sex"],
  result_evaluation: ["sex", "ageAtOrder", "birthOn"],
  lab_display: ["fullName", "sex", "ageAtOrder", "patientCode"],
  patient_app_link: ["fullName", "sex", "birthOn", "phoneE164"],
};
/** user-actor permission needed per purpose; system actors pass [CONV: frontdesk.patient.read where IC names none]. */
const PURPOSE_PERMS: Partial<Record<DemographicsPurpose, string[]>> = {
  lab_display: ["lab.worklist.read", "lab.status_board.read"],
  patient_app_link: ["engagement.link.issue"],
  result_evaluation: ["lab.result.enter", "lab.result.verify"],
};
const mask = (name: string) => name.split(/\s+/).map((w) => `${w[0] ?? ""}***`).join(" ");

export function createFakeFrontdeskPort(opts: FakeOpts<FrontdeskFixtures>) {
  let cur: { deliver(ctx: any, type: string, payload: any): Promise<void>; flags(ctx: any, orderId: string): string[] };
  const fake = makeFake(defaults, opts, (s) => {
    const fx = s.fixtures;
    const keys = new Map<string, { tx: unknown; result: any }>();         // `${tenant}|${method}|${key}`
    const created = new Map<unknown, string[]>();                         // tx → orderIds (rollback)
    const actorOf = (ctx: any) => fx.actors.find((a) => a.actorId === ctx?.actor?.id && a.tenantId === ctx.tenantId);
    const can = (ctx: any, perms: string[]) => !!actorOf(ctx)?.permissions.some((p) => perms.includes(p));
    const staffOrSystem = (ctx: any) => { if (!["user", "system"].includes(actorType(ctx))) throw forbidden(); };

    const visibleOrder = (ctx: any, orderId: unknown) => {
      const t = tenantOf(ctx);
      const o = fx.orders.find((x) => x.orderId === orderId && x.tenantId === t);
      if (!o) throw notFound();
      const a = actorOf(ctx);
      if (actorType(ctx) === "user" && a?.centreIds && !a.centreIds.includes(o.centreId)) throw notFound();   // RLS centre scope
      return o;
    };
    const checkPurpose = (ctx: any, purpose: DemographicsPurpose) => {
      if (!(purpose in ALLOW)) throw invalid("purpose_invalid");
      const type = actorType(ctx);
      if (type === "system") return;
      if (type === "device" && purpose === "instrument_host_query") return;
      if (type !== "user") throw forbidden();
      if (!can(ctx, PURPOSE_PERMS[purpose] ?? ["frontdesk.patient.read"])) throw forbidden();
    };
    const project = (ctx: any, p: FrontdeskPatientRow, purpose: DemographicsPurpose): PatientDemographics => {
      const out: any = { patientId: p.id };
      const nonSystemNotification = purpose === "notification" && actorType(ctx) !== "system";
      for (const f of ALLOW[purpose]) {
        if (nonSystemNotification && (f === "phoneE164" || f === "email")) continue;
        if (f === "maskedName") out.fullName = mask(p.fullName);
        else if ((p as any)[f] !== undefined) out[f] = (p as any)[f];
      }
      if (nonSystemNotification) out.contactPresence = { phone: !!p.phoneE164, email: !!p.email };
      out.status = p.status;
      return out;
    };
    const consentsOk = (c: any) => !!c && typeof c === "object" && typeof c.consentTextVersion === "string" && c.consentTextVersion.length > 0;
    const replay = (ctx: any, method: string, key: string) => {
      const hit = keys.get(`${ctx.tenantId}|${method}|${key}`);
      return hit ? { ...hit.result, replayed: true } : undefined;
    };

    async function createOrder(ctx: any, input: any, viaEvent = false) {
      const t = tenantOf(ctx);
      checkIdempotencyKey(input.idempotencyKey);
      const source = input.source;
      if (!["engagement_booking", "home_collection", "partner_manifest"].includes(source)) throw invalid("source_invalid");
      const sys = actorType(ctx) === "system";
      if (!viaEvent) {
        const ok = source === "engagement_booking" ? sys
          : source === "home_collection" ? sys || can(ctx, ["homecollection.visit.assign"])
          : sys || can(ctx, ["partners.manifest.receive"]);
        if (!ok) throw forbidden();
      }
      const r = replay(ctx, "createOrderFromBooking", input.idempotencyKey);
      if (r) return r;
      const sourceRefId = requireStr(input.sourceRefId, "sourceRefId_required");
      if (fx.orders.some((o) => o.tenantId === t && o.sourceRefId === sourceRefId && o.source === source)) throw err("frontdesk.booking_already_converted");
      if (source === "partner_manifest" && !input.partnerId) throw invalid("partnerId_required");
      const ids: unknown[] = input.orderableIds;
      if (!Array.isArray(ids) || ids.length === 0) throw invalid("orderableIds_required");
      const orderables = ids.map((oid) => {
        const o = fx.orderables.find((x) => x.id === oid && (x.tenantId === t || x.tenantId === null));
        if (!o) throw notFound();
        if (!o.isActive) throw err("catalog.test_inactive");
        if (o.hasPrice === false) throw err("catalog.no_price");
        return o;
      });
      let patientId: string;
      if (input.patient?.patientId) {
        const p = fx.patients.find((x) => x.id === input.patient.patientId && x.tenantId === t);
        if (!p) throw notFound();
        patientId = p.id;
      } else if (input.patient?.newPatient) {
        const np = input.patient.newPatient;
        if (!consentsOk(np.consents)) throw err("frontdesk.consent_required");
        patientId = s.nextId();
        fx.patients.push({ id: patientId, tenantId: t, patientCode: `P-${patientId.slice(-6)}`, fullName: requireStr(np.fullName), sex: np.sex ?? "unknown",
          birthOn: np.birthOn, phoneE164: np.phoneE164, consents: np.consents, status: "active" });
      } else throw invalid("patient_required");
      const orderId = s.nextId();
      const seq = fx.orders.filter((o) => o.tenantId === t).length + 1;
      const status = input.confirmImmediately === true ? "registered" : "pre_registered";
      const order: Row<OrderSummary> = {
        orderId, tenantId: t, registrationNo: `0001SY${String(seq).padStart(6, "0")}`, patientId,
        branchId: input.branchId, centreId: input.centreId, visitType: "opd", billingMode: input.creditPartyId ? "credit" : "cash",
        ...(input.creditPartyId ? { creditPartyId: input.creditPartyId } : {}), ...(input.referrerId ? { referrerId: input.referrerId } : {}),
        priority: input.priority === "urgent" ? "urgent" : "routine", status, source, sourceRefId,
        items: orderables.map((o) => ({ orderItemId: s.nextId(), orderableId: o.id, orderableKind: o.kind, testIds: o.testIds, priority: input.priority === "urgent" ? "urgent" : "routine", status: "active", outsourced: false })),
        ...(status === "registered" ? { registeredAt: ctx.now() } : {}), version: 1,
        ...(input.partnerId ? { partnerId: input.partnerId } : {}),
      };
      fx.orders.push(order);
      (created.get(ctx.tx) ?? created.set(ctx.tx, []).get(ctx.tx)!).push(orderId);
      if (status === "registered" && s.events) {
        await s.events.publish(ctx.tx, "frontdesk.order.created.v1", {
          tenantId: t, idempotencyKey: `frontdesk.order.created:${orderId}`, aggregate: { type: "order", id: orderId },
          payload: { order_id: orderId, patient_id: patientId, branch_id: order.branchId, centre_id: order.centreId, visit_type: "opd",
            billing_mode: order.billingMode, priority: order.priority, collection_mode: source === "home_collection" ? "home" : source === "partner_manifest" ? "partner" : "centre",
            source, source_ref_id: sourceRefId, registered_at: order.registeredAt,
            items: order.items.map((i) => ({ order_item_id: i.orderItemId, orderable_id: i.orderableId, orderable_kind: i.orderableKind, test_ids: i.testIds, priority: i.priority })) },
        });
      }
      const result = { orderId, registrationNo: order.registrationNo, status, replayed: false };
      keys.set(`${t}|createOrderFromBooking|${input.idempotencyKey}`, { tx: ctx.tx, result });
      return result;
    }

    cur = {
      /** C4 event consumers (IC §4.3 cases 11/12): booking.confirmed / booking.cancelled. */
      async deliver(ctx, type, p) {
        const t = tenantOf(ctx);
        if (type === "engagement.booking.confirmed.v1") {
          if (p.booking_kind === "home_collection") return;                  // C17 creates the order on visit (08 R7)
          await createOrder(ctx, { source: "engagement_booking", sourceRefId: p.booking_id, patient: { patientId: p.patient_id }, branchId: p.branch_id,
            centreId: p.centre_id, orderableIds: p.orderable_ids, priority: "routine", confirmImmediately: false, idempotencyKey: `booking:${p.booking_id}` }, true);
        } else if (type === "engagement.booking.cancelled.v1") {
          const o = fx.orders.find((x) => x.tenantId === t && (x.orderId === p.order_id || x.sourceRefId === p.booking_id));
          if (o && o.status !== "pre_registered" && o.status !== "cancelled") fx.orderFlags.push({ id: s.nextId(), tenantId: t, orderId: o.orderId, kind: "booking_cancelled_after_registration" });
          else if (o) o.status = "cancelled";
        }
      },
      flags: (ctx, orderId) => fx.orderFlags.filter((f) => f.tenantId === ctx.tenantId && f.orderId === orderId).map((f) => f.kind),
    };

    const methods: FrontdeskPort & { __onRollback(tx: unknown): void } = {
      async getOrderSummary(ctx, input) {
        tenantOf(ctx); staffOrSystem(ctx);                                   // C15: staff or system (D-110)
        const { tenantId: _t, idempotencyKey: _k, ...o } = visibleOrder(ctx, input.orderId) as any;
        return o;
      },
      async getPatientDemographics(ctx, input) {
        const t = tenantOf(ctx);
        checkPurpose(ctx, input.purpose);
        const p = fx.patients.find((x) => x.id === input.patientId && x.tenantId === t);
        if (!p) throw notFound();
        return project(ctx, p, input.purpose);
      },
      createOrderFromBooking: (ctx, input) => createOrder(ctx, input),
      async getPatientDemographicsBatch(ctx, input) {
        const t = tenantOf(ctx);
        checkPurpose(ctx, input.purpose);
        if (!Array.isArray(input.patientIds) || input.patientIds.length > 200) throw invalid("patientIds_invalid");
        return input.patientIds.flatMap((pid) => {
          const p = fx.patients.find((x) => x.id === pid && x.tenantId === t);
          return p ? [project(ctx, p, input.purpose)] : [];
        });
      },
      async createSelfRegisteredPatient(ctx, input) {
        const t = tenantOf(ctx);
        if (actorType(ctx) !== "system") throw forbidden();
        checkIdempotencyKey(input.idempotencyKey);
        const r = replay(ctx, "createSelfRegisteredPatient", input.idempotencyKey);
        if (r) return r;
        if (!consentsOk(input.consents)) throw err("frontdesk.consent_required");
        const phone = requireStr(input.phoneE164, "phoneE164_required");
        const duplicateSuspected = fx.patients.some((p) => p.tenantId === t && p.phoneE164 === phone);
        const patientId = s.nextId();
        const patientCode = `P-${patientId.slice(-6)}`;
        fx.patients.push({ id: patientId, tenantId: t, patientCode, fullName: requireStr(input.fullName), sex: input.sex ?? "unknown", birthOn: input.birthOn,
          phoneE164: phone, consents: input.consents, status: "active" });
        const result = { patientId, patientCode, duplicateSuspected, replayed: false };
        keys.set(`${t}|createSelfRegisteredPatient|${input.idempotencyKey}`, { tx: ctx.tx, result });
        return result;
      },
      __onRollback(tx) {
        const ids = created.get(tx) ?? [];
        fx.orders = fx.orders.filter((o) => !ids.includes(o.orderId));
        for (const [k, v] of keys) if (v.tx === tx) keys.delete(k);
        created.delete(tx);
      },
    };
    return methods;
  });
  /** Test hooks for the contract suite (C4 event consumers + `frontdesk.order_flags` read); not part of the port. */
  return Object.assign(fake, {
    __deliver: (ctx: any, type: string, payload: any) => cur.deliver(ctx, type, payload),
    __orderFlags: (ctx: any, orderId: string) => cur.flags(ctx, orderId),
  });
}
