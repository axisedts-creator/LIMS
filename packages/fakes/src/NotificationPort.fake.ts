// packages/fakes/src/NotificationPort.fake.ts — fake of IC §4.8 (owner C6). Outbox only: no provider is ever called (REQ-SEC-136).
import type { NotificationPort } from "@lims/contracts/ports/NotificationPort";
import { TENANT_A, TENANT_B, checkIdempotencyKey, err, idFor, invalid, makeFake, notFound, nowOf, requireStr, tenantOf, type FakeOpts } from "./base";

type Channel = "sms" | "whatsapp" | "email";
type ParamKind = "short_text" | "label_text" | "url" | "staff_url" | "otp_code";
export interface NotificationFixtures {
  /** Template registry (IC §4.8 "Templates seeded by C6"); declared params are the only allowed keys (non-PHI, 04 R6). */
  templates: { id: string; code: string; purpose: string; channels: Channel[]; params: Record<string, ParamKind>; staffOnly?: boolean }[];
  /** Resolvable recipients (patient/referrer/centre/partner) with their consent matrix (REQ-SEC-005). */
  recipients: { id: string; tenantId: string; kind: "patient" | "referrer" | "centre" | "partner"; phoneE164: string | null; email: string | null;
    consent: Record<Channel, boolean> }[];
  /** Emulates IdentityPort.getStaffNotificationContact (08 A4.2) — the fake stays self-contained [CONV]. */
  staffContacts: { id: string; tenantId: string; membershipId: string; email: string | null; status: "invited" | "active" | "deactivated";
    actorType: string; locked: boolean; permissions: string[] }[];
  /** Tenant channel switches (TenantSettings.channels). */
  channels: Record<string, { smsEnabled: boolean; whatsappEnabled: boolean; emailEnabled: boolean }>;
  /** Origin of LIMS_ORIGIN_STAFF_WEB for `staff_url` params / linkUrl (synthetic). */
  staffWebOrigin: string;
}

const defaults = (seed: number): NotificationFixtures => {
  const tpl = (n: number, code: string, purpose: string, channels: Channel[], params: Record<string, ParamKind>, staffOnly = false) =>
    ({ id: idFor(seed, 0x801 + n), code, purpose, channels, params, ...(staffOnly ? { staffOnly } : {}) });
  const all = { sms: true, whatsapp: true, email: true };
  return {
    templates: [
      tpl(0, "frontdesk.registration_confirmation", "registration_confirmation", ["sms", "whatsapp"], { lab_name: "short_text", ref: "short_text" }),
      tpl(1, "frontdesk.recollection_request", "recollection_request", ["sms", "whatsapp"], { lab_name: "short_text" }),
      tpl(2, "analytics.report_ready", "scheduled_report_ready", ["email"], { schedule_name: "label_text" }, true),
      tpl(3, "engagement.login_otp", "otp", ["sms"], { otp_code: "otp_code" }),
      tpl(4, "homecollection.visit_assigned", "visit_assignment", ["sms"], { route_date: "short_text", visit_count: "short_text" }),
      tpl(5, "reporting.dues_due", "dues_reminder", ["sms", "whatsapp"], { lab_name: "short_text", amount_text: "short_text", url: "url" }),
      // CR-C16-009 (as modified by 08 R13): C16 reminder templates, TRD §4.11. Params are non-PHI: lab, date(-time), booking number.
      tpl(6, "engagement.follow_up_reminder", "follow_up_reminder", ["sms"], { lab_name: "short_text", datetime: "short_text" }),
      tpl(7, "engagement.booking_reminder", "booking_reminder", ["sms"], { lab_name: "short_text", datetime: "short_text", booking_no: "short_text" }),
    ],
    recipients: [
      { id: idFor(seed, 0x811), tenantId: TENANT_A, kind: "patient", phoneE164: "+9779800000011", email: "patient-0011@example.com", consent: all },
      { id: idFor(seed, 0x812), tenantId: TENANT_B, kind: "patient", phoneE164: "+9779800000012", email: "patient-0012@example.com", consent: all },
    ],
    staffContacts: [],
    channels: { [TENANT_A]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true }, [TENANT_B]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true } },
    staffWebOrigin: "https://staff.lims.invalid",
  };
};

const OTP_PER_HOUR = 3;                                   // 04 A9
const HOUR_MS = 3_600_000;
const SHORT_TEXT_RE = /^[\p{L}\p{N} .,:/#()-]{1,40}$/u;   // [CONV] fake charset for `short_text` (C6 02-TRD owns the real one)
const STAFF_ROUTE_RE = /^\/analytics\/report-runs\/[0-9a-f-]{36}$/;   // staff.analytics.report_run (contracts/routes.yaml)

export function createFakeNotificationPort(opts: FakeOpts<NotificationFixtures>) {
  return makeFake<NotificationFixtures, NotificationPort>(defaults, opts, ({ fixtures: f, nextId }) => {
    // ponytail: provider-failure injection (affects later delivery status) is not modelled — the port call never sees it.
    const outbox: { deliveryId: string; tenantId: string; key: string; status: string; purpose: string; phone: string | null; at: string; tx: unknown }[] = [];

    const staffUrlOk = (v: unknown) => {
      try { const u = new URL(String(v)); return u.origin === f.staffWebOrigin && STAFF_ROUTE_RE.test(u.pathname) && !u.search && !u.hash; } catch { return false; }
    };
    const checkParam = (kind: ParamKind, v: unknown, staffLink: boolean): boolean => {
      if (typeof v !== "string") return false;
      switch (kind) {
        case "short_text": return SHORT_TEXT_RE.test(v);
        case "label_text": return v.length >= 1 && v.length <= 80 && !v.includes("://") && !/www\./i.test(v);
        case "otp_code": return /^\d{4,8}$/.test(v);
        case "url": return /^https:\/\/[^\s]+$/.test(v);
        case "staff_url": return staffLink && staffUrlOk(v);
      }
    };

    const send = (channel: Channel) => async (ctx: any, input: any) => {
      checkIdempotencyKey(input.idempotencyKey);                       // P-40 / A22.0 first
      const t = tenantOf(ctx);
      const prior = outbox.find((d) => d.tenantId === t && d.key === input.idempotencyKey);
      if (prior) return { deliveryId: prior.deliveryId, status: prior.status, replayed: true };

      const tpl = f.templates.find((x) => x.code === input.templateCode);
      if (!tpl || !tpl.channels.includes(channel) || tpl.purpose !== input.purpose) throw err("reporting.notification_template_unknown");
      const rcp = input.recipient ?? {};
      const staffLink = input.purpose === "scheduled_report_ready" && rcp.kind === "staff";
      const params = input.params ?? {};
      if (typeof params !== "object" || Array.isArray(params)) throw err("reporting.notification_params_invalid");
      const keys = Object.keys(params);
      if (keys.some((k) => !(k in tpl.params)) || Object.keys(tpl.params).some((k) => !keys.includes(k))) throw err("reporting.notification_params_invalid");
      for (const [k, kind] of Object.entries(tpl.params)) if (!checkParam(kind, params[k], staffLink)) throw err("reporting.notification_params_invalid");
      if (input.linkUrl !== undefined || channel === "email") {
        const ok = tpl.code === "analytics.report_ready" ? staffUrlOk(input.linkUrl) : /^https:\/\/[^\s]+$/.test(String(input.linkUrl));
        if (!ok) throw err("reporting.notification_params_invalid");
      }

      // Resolve the contact (callers never pass phone numbers, except phone_otp before a patient id exists).
      let status: "queued" | "suppressed_no_consent" | "suppressed_no_contact" | "suppressed_channel_disabled" = "queued";
      let phone: string | null = null, email: string | null = null, consent = true;
      if (rcp.kind === "staff") {
        requireStr(rcp.membershipId);
        const c = f.staffContacts.find((x) => x.tenantId === t && x.membershipId === rcp.membershipId);
        const eligible = staffLink && !!c && c.status === "active" && c.actorType === "user" && !c.locked
          && typeof rcp.requiredPermission === "string" && c.permissions.includes(rcp.requiredPermission);
        email = eligible ? c!.email : null;
        if (!eligible || !email) status = "suppressed_no_contact";      // other purposes keep the Phase-1 staff suppression
      } else if (tpl.staffOnly) {
        throw err("reporting.notification_template_unknown");
      } else if (rcp.kind === "phone_otp") {
        if (input.purpose !== "otp" || !/^\+[1-9]\d{6,14}$/.test(String(rcp.phoneE164))) throw invalid("recipient_invalid");
        phone = rcp.phoneE164;
      } else {
        const idKey = ({ patient: "patientId", referrer: "referrerId", centre: "centreId", partner: "partnerId" } as Record<string, string>)[rcp.kind];
        if (!idKey) throw invalid("recipient_invalid");
        const r = f.recipients.find((x) => x.tenantId === t && x.kind === rcp.kind && x.id === rcp[idKey]);
        if (!r) throw notFound();
        phone = r.phoneE164; email = r.email; consent = r.consent[channel] === true;
      }

      const now = nowOf(ctx);
      if (input.purpose === "otp" && phone) {
        const recent = outbox.filter((d) => d.tenantId === t && d.purpose === "otp" && d.phone === phone && Date.parse(now) - Date.parse(d.at) < HOUR_MS);
        if (recent.length >= OTP_PER_HOUR) throw err("common.rate_limited");
      }
      if (status === "queued") {
        const sw = f.channels[t] ?? { smsEnabled: false, whatsappEnabled: false, emailEnabled: false };
        const enabled = channel === "sms" ? sw.smsEnabled : channel === "whatsapp" ? sw.whatsappEnabled : sw.emailEnabled;
        if (!enabled) status = "suppressed_channel_disabled";
        else if (!consent) status = "suppressed_no_consent";
        else if (!(channel === "email" ? email : phone)) status = "suppressed_no_contact";
      }
      const deliveryId = nextId();
      outbox.push({ deliveryId, tenantId: t, key: input.idempotencyKey, status, purpose: input.purpose, phone, at: now, tx: ctx.tx });
      return { deliveryId, status, replayed: false };
    };

    return {
      sendSms: send("sms"),
      sendWhatsAppTemplate: send("whatsapp"),
      sendEmailLink: send("email"),
      /** The caller's transaction rolled back: its delivery rows are gone (outbox in ctx.tx, REQ-ARCH-038). */
      __onRollback(tx: unknown) { for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i]!.tx === tx) outbox.splice(i, 1); },
    } as any;
  });
}
