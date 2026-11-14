// packages/fakes/contract-tests/NotificationPort.contract.ts — IC §4.8 contract cases (CV §8.4). Runs against the fake (C0) and the
// real C6 implementation. Fixture shape = NotificationFixtures (a real harness translates it; staffContacts stand for
// IdentityPort.getStaffNotificationContact answers).
import { describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

const id = (n: number) => `01900000-0000-7000-8000-0000000c8${n.toString(16).padStart(3, "0")}`;
const PAT_OK = id(1), PAT_NOCONSENT = id(2), PAT_B = id(3);
const M_OK = id(0x11), M_NOPERM = id(0x12), M_INACTIVE = id(0x13), M_DEVICE = id(0x14), M_LOCKED = id(0x15), M_NOEMAIL = id(0x16);
const STAFF_ORIGIN = "https://staff.lims.invalid";
const RUN_URL = `${STAFF_ORIGIN}/analytics/report-runs/${id(0x21)}`;
const PERM = "analytics.dashboard.read";

async function rejects(p: Promise<unknown>, code: string) {
  const e: any = await p.then(() => undefined, (x) => x);
  expect(e, `expected ${code}, call resolved`).toBeDefined();
  expect(e.code).toBe(code);
}

async function setup(makeImpl: () => Promise<ContractHarness>) {
  const h = await makeImpl();
  const tA = h.ctxFor("A").tenantId, tB = h.ctxFor("B").tenantId;
  const all = { sms: true, whatsapp: true, email: true };
  const patient = (pid: string, tenantId: string, n: number, consent = all) =>
    ({ id: pid, tenantId, kind: "patient", phoneE164: `+97798000000${n}`, email: `patient-00${n}@example.com`, consent });
  const staff = (membershipId: string, o: object = {}) => ({ id: membershipId, tenantId: tA, membershipId, email: `staff-${membershipId.slice(-3)}@example.com`,
    status: "active", actorType: "user", locked: false, permissions: [PERM], ...o });
  await h.seed({
    recipients: [patient(PAT_OK, tA, 21), patient(PAT_NOCONSENT, tA, 22, { ...all, sms: false }), patient(PAT_B, tB, 23)],
    staffContacts: [staff(M_OK), staff(M_NOPERM, { permissions: [] }), staff(M_INACTIVE, { status: "deactivated" }), staff(M_DEVICE, { actorType: "device" }),
      staff(M_LOCKED, { locked: true }), staff(M_NOEMAIL, { email: null })],
    channels: { [tA]: { smsEnabled: true, whatsappEnabled: false, emailEnabled: true }, [tB]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true } },
    staffWebOrigin: STAFF_ORIGIN,
  });
  return h;
}

const reg = (patientId: string, idempotencyKey: string, params: Record<string, string> = { lab_name: "Synthetic Lab", ref: "0001SY000001" }) => ({
  recipient: { kind: "patient", patientId }, templateCode: "frontdesk.registration_confirmation", purpose: "registration_confirmation", params, idempotencyKey,
});
const report = (membershipId: string, idempotencyKey: string, scheduleName = "Weekly collections", requiredPermission: string | undefined = PERM) => ({
  recipient: { kind: "staff", membershipId, ...(requiredPermission ? { requiredPermission } : {}) }, templateCode: "analytics.report_ready",
  purpose: "scheduled_report_ready", params: { schedule_name: scheduleName }, idempotencyKey, linkUrl: RUN_URL,
});
const sys = (h: ContractHarness) => h.ctxFor("A:system");

export function runNotificationPortContract(makeImpl: () => Promise<ContractHarness>, opts: { phase1Stub?: boolean } = {}): void {
  // No phase stub exists for NotificationPort (08 R9): the phase1Stub subset is empty.
  describe.skipIf(!!opts.phase1Stub)("NotificationPort contract (IC §4.8)", () => {
    it("(1) no consent → suppressed_no_consent", async () => {
      const h = await setup(makeImpl);
      await expect(h.impl.sendSms(sys(h), reg(PAT_NOCONSENT, "n-1"))).resolves.toMatchObject({ status: "suppressed_no_consent", replayed: false });
      await expect(h.impl.sendSms(sys(h), reg(PAT_OK, "n-1b"))).resolves.toMatchObject({ status: "queued" });
    });

    it("(2) unknown template → reporting.notification_template_unknown", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.sendSms(sys(h), { ...reg(PAT_OK, "n-2"), templateCode: "frontdesk.no_such_template" }), "reporting.notification_template_unknown");
    });

    it("(3) PHI-like param key not declared → reporting.notification_params_invalid", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.sendSms(sys(h), reg(PAT_OK, "n-3", { lab_name: "Synthetic Lab", ref: "0001SY000001", test_name: "CBC" })), "reporting.notification_params_invalid");
    });

    it("(4) replay same key → same deliveryId, replayed: true", async () => {
      const h = await setup(makeImpl);
      const a: any = await h.impl.sendSms(sys(h), reg(PAT_OK, "n-4"));
      const b: any = await h.impl.sendSms(sys(h), reg(PAT_OK, "n-4"));
      expect(a.replayed).toBe(false);
      expect(b).toEqual({ ...a, replayed: true });
    });

    it("(5) channel disabled → suppressed_channel_disabled", async () => {
      const h = await setup(makeImpl);
      await expect(h.impl.sendWhatsAppTemplate(sys(h), reg(PAT_OK, "n-5"))).resolves.toMatchObject({ status: "suppressed_channel_disabled" });
    });

    it("(6) 4th OTP send in an hour to same phone → common.rate_limited", async () => {
      const h = await setup(makeImpl);
      const otp = (k: string) => ({ recipient: { kind: "phone_otp", phoneE164: "+9779800000031" }, templateCode: "engagement.login_otp", purpose: "otp",
        params: { otp_code: "123456" }, idempotencyKey: k });
      for (const k of ["otp-1", "otp-2", "otp-3"]) await expect(h.impl.sendSms(sys(h), otp(k))).resolves.toMatchObject({ status: "queued" });
      await rejects(h.impl.sendSms(sys(h), otp("otp-4")), "common.rate_limited");
    });

    it("(7) call inside a rolled-back tx leaves no delivery row", async () => {
      const h = await setup(makeImpl);
      const ctx = sys(h);
      const a: any = await h.impl.sendSms(ctx, reg(PAT_OK, "n-7"));
      h.rollback(ctx.tx);
      const b: any = await h.impl.sendSms(sys(h), reg(PAT_OK, "n-7"));   // same key: not a replay, the row is gone
      expect(b.replayed).toBe(false);
      expect(b.deliveryId).not.toBe(a.deliveryId);
    });

    it("(8) recipient in other tenant → common.not_found", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.sendSms(sys(h), reg(PAT_B, "n-8")), "common.not_found");
    });

    it("(9) staff recipient + scheduled_report_ready + analytics.report_ready → e-mail via getStaffNotificationContact, queued", async () => {
      const h = await setup(makeImpl);
      await expect(h.impl.sendEmailLink(sys(h), report(M_OK, "n-9"))).resolves.toMatchObject({ status: "queued", replayed: false });
    });

    it("(10) staff recipient not eligible (no requiredPermission, inactive, not user, locked) or email null → suppressed_no_contact", async () => {
      const h = await setup(makeImpl);
      const cases: [string, string | undefined][] = [[M_NOPERM, PERM], [M_INACTIVE, PERM], [M_DEVICE, PERM], [M_LOCKED, PERM], [M_NOEMAIL, PERM], [M_OK, "billing.invoice.read"]];
      for (const [i, [m, perm]] of cases.entries())
        await expect(h.impl.sendEmailLink(sys(h), report(m, `n-10-${i}`, "Weekly collections", perm)), m).resolves.toMatchObject({ status: "suppressed_no_contact" });
    });

    it("(11) staff recipient for any other purpose → suppressed_no_contact", async () => {
      const h = await setup(makeImpl);
      const r: any = await h.impl.sendSms(sys(h), { recipient: { kind: "staff", membershipId: M_OK }, templateCode: "homecollection.visit_assigned",
        purpose: "visit_assignment", params: { route_date: "2026-11-05", visit_count: "4" }, idempotencyKey: "n-11" });
      expect(r.status).toBe("suppressed_no_contact");
    });

    it("(12) schedule_name (label_text) of 81 characters, or containing :// or www. → reporting.notification_params_invalid", async () => {
      const h = await setup(makeImpl);
      for (const [i, bad] of ["x".repeat(81), "see https://x.invalid", "visit www.lab"].entries())
        await rejects(h.impl.sendEmailLink(sys(h), report(M_OK, `n-12-${i}`, bad)), "reporting.notification_params_invalid");
      await expect(h.impl.sendEmailLink(sys(h), report(M_OK, "n-12-ok", "x".repeat(80)))).resolves.toMatchObject({ status: "queued" });
    });
  });
}
