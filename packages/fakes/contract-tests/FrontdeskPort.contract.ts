// packages/fakes/contract-tests/FrontdeskPort.contract.ts — IC §4.3 case list (CV §8.4). Runs against the fake (C0) and the
// real C4 implementation. Callers exercised: C14 (purpose `lab_display`, staff/system) and C15 (`getOrderSummary`, staff or
// system) — 08 A19 D-110, CR-C14-009, CR-C15-014.
// Harness extensions used by cases 11/12 [CONV]: `impl.__deliver(ctx, eventType, payload)` runs the C4 event consumer;
// `impl.__orderFlags(ctx, orderId)` lists `frontdesk.order_flags` kinds. A real-impl harness wires both.
import { beforeEach, describe, expect, it } from "vitest";

type Harness = { impl: any; seed(f: object): Promise<void>; ctxFor(k: string, over?: object): any; events: any; rollback(tx: unknown): void };
const id = (n: number) => `01900000-0000-7000-8000-0000000c4${n.toString(16).padStart(3, "0")}`;
const A = "01900000-0000-7000-8000-00000000000a";
const B = "01900000-0000-7000-8000-00000000000b";
const PA = id(1), PB = id(2), PA2 = id(3), OA = id(10), OB = id(11), OA_C2 = id(12), OH = id(13);
const T1 = id(20), T_INACTIVE = id(21), C1 = id(30), C2 = id(31), BR = id(32), BOOK = id(40), BOOK2 = id(41);
const CONSENTS = { sms: true, whatsapp: false, email: true, shareWithReferrer: false, consentTextVersion: "v1" };
const PERMS = ["frontdesk.patient.read", "frontdesk.order.read", "lab.worklist.read", "homecollection.visit.assign", "partners.manifest.receive", "engagement.link.issue"];

async function lims(p: Promise<unknown> | (() => Promise<unknown>), code: string) {
  let e: any;
  try { await (typeof p === "function" ? p() : p); } catch (x) { e = x; }
  expect(e, `expected ${code}, call resolved`).toBeDefined();
  expect(e.code).toBe(code);
}
const patient = (pid: string, tenantId: string, n: number, phone = `+9779800000${n}00`) => ({
  id: pid, tenantId, patientCode: `P-${n}`, fullName: `Test Patient 00${40 + n}`, sex: "female", birthOn: "1990-01-01",
  ageAtOrder: { years: 36, months: 0, days: 0 }, phoneE164: phone, email: `p${n}@example.com`, consents: CONSENTS, status: "active",
});
const order = (orderId: string, tenantId: string, patientId: string, centreId: string, extra: object = {}) => ({
  orderId, tenantId, registrationNo: `0001SY0000${orderId.slice(-2)}`, patientId, branchId: BR, centreId, visitType: "opd", billingMode: "cash",
  priority: "routine", status: "registered", source: "front_desk", items: [], registeredAt: "2026-11-05T04:15:00.000Z", version: 1, ...extra,
});

export function runFrontdeskPortContract(makeImpl: () => Promise<Harness>, _opts: { phase1Stub?: boolean } = {}): void {
  let h: Harness;
  beforeEach(async () => {
    h = await makeImpl();
    await h.seed({
      patients: [patient(PA, A, 1), patient(PB, B, 2), patient(PA2, A, 3, "+977980000099")],
      orders: [order(OA, A, PA, C1), order(OB, B, PB, C1), order(OA_C2, A, PA, C2),
        order(OH, A, PA, C1, { source: "home_collection", sourceRefId: BOOK2 })],
      orderables: [{ id: T1, tenantId: null, kind: "test", testIds: [T1], isActive: true }, { id: T_INACTIVE, tenantId: null, kind: "test", testIds: [T_INACTIVE], isActive: false }],
      actors: [
        { actorId: h.ctxFor("A").actor.id, tenantId: A, permissions: PERMS, centreIds: null },
        { actorId: h.ctxFor("A:user:centre1").actor.id, tenantId: A, permissions: PERMS, centreIds: [C1] },
        { actorId: h.ctxFor("A:user:nolink").actor.id, tenantId: A, permissions: PERMS.filter((p) => p !== "engagement.link.issue"), centreIds: null },
      ],
    });
  });
  const sys = () => h.ctxFor("A:system");
  const booking = (over: object = {}) => ({
    source: "partner_manifest", partnerId: id(50), sourceRefId: id(60), patient: { patientId: PA }, branchId: BR, centreId: C1,
    orderableIds: [T1], priority: "routine", confirmImmediately: true, idempotencyKey: "manifest:line-1", ...over,
  });
  const hook = (name: string) => {
    const f = h.impl[name] ?? (h as any)[name];
    if (typeof f !== "function") throw new Error(`harness lacks ${name}`);
    return f.bind(h.impl);
  };

  describe("FrontdeskPort contract (IC §4.3)", () => {
    it("(1) summary of other tenant's order → not_found", async () => {
      await lims(h.impl.getOrderSummary(h.ctxFor("A"), { orderId: OB }), "common.not_found");
      await expect(h.impl.getOrderSummary(h.ctxFor("A"), { orderId: OA })).resolves.toMatchObject({ orderId: OA });
    });
    it("(2) centre-scoped actor, other centre → not_found", async () => {
      await lims(h.impl.getOrderSummary(h.ctxFor("A:user:centre1"), { orderId: OA_C2 }), "common.not_found");
      await expect(h.impl.getOrderSummary(h.ctxFor("A:user:centre1"), { orderId: OA })).resolves.toMatchObject({ centreId: C1 });
    });
    it("(3) demographics purpose `instrument_host_query` returns no name/phone", async () => {
      const d = await h.impl.getPatientDemographics(sys(), { patientId: PA, purpose: "instrument_host_query" });
      expect(d.fullName).toBeUndefined();
      expect(d.phoneE164).toBeUndefined();
      expect(d.sex).toBe("female");
      expect(d.status).toBe("active");
    });
    it("(4) `notification` returns consents", async () => {
      const d = await h.impl.getPatientDemographics(sys(), { patientId: PA, purpose: "notification" });
      expect(d.consents).toEqual(CONSENTS);
      expect(d.phoneE164).toBeDefined();
    });
    it("(5) createOrderFromBooking replay with same key → same orderId + `replayed: true`", async () => {
      const a = await h.impl.createOrderFromBooking(sys(), booking());
      const b = await h.impl.createOrderFromBooking(sys(), booking());
      expect(a.replayed).toBe(false);
      expect(b).toMatchObject({ orderId: a.orderId, registrationNo: a.registrationNo, replayed: true });
    });
    it("(6) same sourceRefId new key → `frontdesk.booking_already_converted`", async () => {
      await h.impl.createOrderFromBooking(sys(), booking());
      await lims(h.impl.createOrderFromBooking(sys(), booking({ idempotencyKey: "manifest:line-1-retry" })), "frontdesk.booking_already_converted");
    });
    it("(7) `confirmImmediately: true` emits `frontdesk.order.created.v1` once (event spy)", async () => {
      const r = await h.impl.createOrderFromBooking(sys(), booking());
      await h.impl.createOrderFromBooking(sys(), booking());
      expect(r.status).toBe("registered");
      const ev = h.events.ofType("frontdesk.order.created.v1");
      expect(ev).toHaveLength(1);
      expect(ev[0].tenantId).toBe(A);
      expect(ev[0].payload.order_id).toBe(r.orderId);
    });
    it("(8) `false` emits nothing", async () => {
      const r = await h.impl.createOrderFromBooking(sys(), booking({ confirmImmediately: false }));
      expect(r.status).toBe("pre_registered");
      expect(h.events.ofType("frontdesk.order.created.v1")).toHaveLength(0);
    });
    it("(9) inactive orderable → `catalog.test_inactive`", async () => {
      await lims(h.impl.createOrderFromBooking(sys(), booking({ orderableIds: [T_INACTIVE] })), "catalog.test_inactive");
    });
    it("(10) new patient without required consents → `frontdesk.consent_required`", async () => {
      await lims(h.impl.createOrderFromBooking(sys(), booking({ patient: { newPatient: { fullName: "Test Patient 0077", sex: "male" } } })), "frontdesk.consent_required");
    });
    it("(11) `home_collection` `booking.confirmed` → no order", async () => {
      const ev = (bookingId: string, kind: string) => ({ booking_id: bookingId, patient_id: PA, branch_id: BR, centre_id: C1, booking_kind: kind,
        slot_start: "2026-11-06T03:00:00.000Z", slot_end: "2026-11-06T03:30:00.000Z", orderable_ids: [T1], confirmed_at: "2026-11-05T04:15:00.000Z" });
      await hook("__deliver")(sys(), "engagement.booking.confirmed.v1", ev(BOOK, "home_collection"));
      // no order was created for BOOK: converting it now is not "already converted"
      await expect(h.impl.createOrderFromBooking(sys(), booking({ source: "engagement_booking", partnerId: undefined, sourceRefId: BOOK, idempotencyKey: "bk-1" })))
        .resolves.toMatchObject({ replayed: false });
      // control: a centre-visit booking does create one
      await hook("__deliver")(sys(), "engagement.booking.confirmed.v1", ev(id(42), "centre_visit"));
      await lims(h.impl.createOrderFromBooking(sys(), booking({ source: "engagement_booking", partnerId: undefined, sourceRefId: id(42), idempotencyKey: "bk-2" })), "frontdesk.booking_already_converted");
    });
    it("(12) cancel with a linked registered home order → review item = `frontdesk.order_flags` row kind `booking_cancelled_after_registration`", async () => {
      await hook("__deliver")(sys(), "engagement.booking.cancelled.v1", { booking_id: BOOK2, patient_id: PA, booking_kind: "home_collection", reason_code: "patient_request",
        cancelled_by_kind: "patient", order_id: OH, cancelled_at: "2026-11-05T04:15:00.000Z" });
      expect(await hook("__orderFlags")(sys(), OH)).toContain("booking_cancelled_after_registration");
      expect((await h.impl.getOrderSummary(sys(), { orderId: OH })).status).toBe("registered");   // order itself untouched
    });
    it("(13) batch omits other-tenant ids", async () => {
      const r = await h.impl.getPatientDemographicsBatch(sys(), { patientIds: [PA, PB, id(99)], purpose: "label_print" });
      expect(r.map((d: any) => d.patientId)).toEqual([PA]);
    });
    it("(14) `lab_display` returns no phone (C14 caller, staff and system)", async () => {
      for (const ctx of [h.ctxFor("A"), sys()]) {
        const d = await h.impl.getPatientDemographics(ctx, { patientId: PA, purpose: "lab_display" });
        expect(d.phoneE164).toBeUndefined();
        expect(d.email).toBeUndefined();
        expect(d.fullName).toBe("Test Patient 0041");
        expect(d.patientCode).toBe("P-1");
      }
      await lims(h.impl.getPatientDemographics(h.ctxFor("A:patient"), { patientId: PA, purpose: "lab_display" }), "auth.forbidden");
    });
    it("(15) `notification` by user actor returns `contactPresence` only", async () => {
      const d = await h.impl.getPatientDemographics(h.ctxFor("A"), { patientId: PA, purpose: "notification" });
      expect(d.contactPresence).toEqual({ phone: true, email: true });
      expect(d.phoneE164).toBeUndefined();
      expect(d.email).toBeUndefined();
      expect(d.consents).toEqual(CONSENTS);
    });
    it("(16) self-registration replay", async () => {
      const input = { fullName: "Test Patient 0088", sex: "male", phoneE164: "+977980000088", consents: CONSENTS, idempotencyKey: "selfreg:acc-1" };
      const a = await h.impl.createSelfRegisteredPatient(sys(), input);
      const b = await h.impl.createSelfRegisteredPatient(sys(), input);
      expect(a.replayed).toBe(false);
      expect(b).toMatchObject({ patientId: a.patientId, patientCode: a.patientCode, replayed: true });
      await lims(h.impl.createSelfRegisteredPatient(h.ctxFor("A"), { ...input, idempotencyKey: "selfreg:acc-2" }), "auth.forbidden");
    });
    it("(17) duplicate-suspected still new id", async () => {
      const r = await h.impl.createSelfRegisteredPatient(sys(), { fullName: "Test Patient 0043", sex: "female", phoneE164: "+977980000099", consents: CONSENTS, idempotencyKey: "selfreg:dup" });
      expect(r.duplicateSuspected).toBe(true);
      expect(r.patientId).not.toBe(PA2);
    });
    it("(18) `patient_app_link` refused without `engagement.link.issue`", async () => {
      await lims(h.impl.getPatientDemographics(h.ctxFor("A:user:nolink"), { patientId: PA, purpose: "patient_app_link" }), "auth.forbidden");
      const d = await h.impl.getPatientDemographics(h.ctxFor("A"), { patientId: PA, purpose: "patient_app_link" });
      expect(d).toMatchObject({ fullName: "Test Patient 0041", phoneE164: "+97798000001" + "00", status: "active" });
    });
    it("C15 caller: getOrderSummary by staff or system resolves; patient/portal actor → auth.forbidden (D-110)", async () => {
      await expect(h.impl.getOrderSummary(sys(), { orderId: OA })).resolves.toMatchObject({ orderId: OA, registrationNo: expect.any(String) });
      for (const k of ["A:patient", "A:portal"]) await lims(h.impl.getOrderSummary(h.ctxFor(k), { orderId: OA }), "auth.forbidden");
    });
    it("rolled-back tx leaves no order and no event", async () => {
      const ctx = sys();
      const r = await h.impl.createOrderFromBooking(ctx, booking());
      h.rollback(ctx.tx);
      await lims(h.impl.getOrderSummary(sys(), { orderId: r.orderId }), "common.not_found");
      expect(h.events.ofType("frontdesk.order.created.v1")).toHaveLength(0);
    });
  });
}
