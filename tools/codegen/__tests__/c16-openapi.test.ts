// T0C-10.C16 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/engagement.yaml (C16 transcription of spec/chunks/C16-patient-engagement/02-TRD.md §5.1–§5.4; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for engagement.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) engagement = TRD §5 tables (98 operations: E1–E3 pre-auth, E10–E51 + T3b patient, S/Q/L/R/M/N/T staff, Q9 display), method+path under /v1/engagement,
//     x-permission (one code), security (patientPreAuth | bearerJwt | queueDisplayToken), x-idempotency, tier, success statuses, specific + common error codes,
//     Idempotency-Key on required rows, If-Match on IM rows, X-Lims-App-Version/-Platform on every patient op, Cache-Control: no-store on patient 2xx;
// (5) shape pins from §5.1–§5.4 (query params, enums, bounds, patterns, x-coded-set without enum, DTO fields, patient allowlist: no tenant/patient/account/link ids);
// (6) "Prism smoke" offline: examples validate (ajv), every JSON 2xx has an example, examples synthetic; (7) package.json `mock:engagement` script.
// Not testable here: Prism actually serving the file (prism not installed), generated-client freshness (codegen-fresh suite), runtime behaviour (access log, allowlist mapper, rate limits).
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - every op lists five common codes (validation_failed, auth.forbidden, auth.unauthenticated, rate_limited, internal); common.not_found only on ops with a path
//    parameter ("object ops"); engagement.app_version_unsupported on every patient op (E1–E51, T3b) and on no staff/display op; the other 401 codes ("auth.token_*") are not pinned;
//  - IM rows (If-Match declared): E11 E12 E18 E19 E36 E39 E40 E51 S4 S5 S9 S10 S13 Q1c-update Q2c-update Q6×5 Q7 L2 L4 R3 M1b-update M5 N3 N4 T2 — header + common.version_conflict +
//    common.precondition_required pinned; S13 ("absent = create") pins header + version_conflict only; E46 is not IM; deactivateSlotBlackout (S11), Q8 and S14 pin no If-Match either way
//    (TRD silent); E33's reschedule If-Match travels in the body (`replaces_booking_version`), not as a header;
//  - Optional-idem ops pin no Idempotency-Key header presence either way (wave-1 convention); required ones pin header + the three IDEM codes; "none" ones pin no header;
//    S11 create is required, list is none, deactivate is not pinned; Q8 all none (TRD justification text);
//  - privileged permissions (permissions.yaml: engagement.membership_plan.manage, engagement.settings.manage) add auth.mfa_required (TRD "privileged, aal2"); no other op lists it;
//  - E1–E3 are not public (x-permission engagement.auth.challenge, x-public absent); E3 uses the same patientPreAuth scheme as E1/E2;
//  - coded-set names follow wave-1 `<module>.<set>`: engagement.booking_cancel_reasons (S4 reason_code), engagement.reminder_reasons (R2), engagement.enquiry_categories (E49), no enum;
//  - booking_kind enum = centre_visit|home_collection (05-SCHEMA CHECKs); Profile.relationship enum is shared by L1;
//  - lists unpaginated in the TRD ({data: …}) return `{data}` only; "page of X" returns `{data, page}`; list-of-enquiries items do not require `messages` (TRD "messages omitted");
//  - Cache-Control: no-store pinned on 2xx of E10–E51, T3b and L1 (TRD "PHI responses"; L1 states no-store); latitude/longitude are DecimalString (type string), range not pinned.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C16-patient-engagement/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/engagement.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const permissions: any = parse(readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8"));
const PRIVILEGED = new Set<string>((permissions.permissions ?? []).filter((p: any) => p.privileged).map((p: any) => p.code));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "engagement";
const PFX = "/v1/engagement";

const VC = "common.version_conflict", PRE = "common.precondition_required", MFA = "auth.mfa_required", NF = "common.not_found";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const FIVE = ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
const APPV = "engagement.app_version_unsupported", FD = "common.feature_disabled";
const SU = "engagement.slot_unavailable", SOW = "engagement.slot_outside_window", ONB = "engagement.orderable_not_bookable", AR = "engagement.address_required";
const BLR = "engagement.booking_limit_reached", BNC = "engagement.booking_not_cancellable", BIT = "engagement.booking_invalid_transition";
const LCI = "engagement.link_code_invalid", LLR = "engagement.link_limit_reached", QC = "engagement.queue_closed", QTI = "engagement.queue_token_invalid_transition";
const EIT = "engagement.enquiry_invalid_transition", RIT = "engagement.reminder_invalid_transition";
const KINDS = ["centre_visit", "home_collection"];
const REL = ["self", "child", "parent", "spouse", "sibling", "other"];

type Actor = "pre" | "P" | "S" | "D";
type Spec = {
  row: string; id: string; method: string; path: string; perm: string; actor: Actor; idem: "none" | "optional" | "required" | "any"; tier: string;
  status: number[]; err: string[]; im: boolean | "any"; imPre?: boolean; paged?: boolean;
};
const N = "none" as const, O = "optional" as const, R = "required" as const, ANY = "any" as const;
type Opt = Partial<Pick<Spec, "tier" | "im" | "imPre" | "paged">>;
const mk = (actor: Actor) => (row: string, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number[], err: string[], o: Opt = {}): Spec =>
  ({ row, id, method, path, perm, actor, idem, tier: "general", status, err, im: false, ...o });
const E = mk("P"), PA = mk("pre"), ST = mk("S"), DD = mk("D");
const IM = { im: true as const }, IMX = { im: true as const, imPre: false }, L = { paged: true };
const PRI = "/me/profiles", BK = "/me/bookings", AD = "/me/addresses", EQ = "/me/enquiries", TK = "/queue-tokens/{token_id}", QD = "/queue-displays";
const BOOK_ERR = [SU, SOW, ONB, AR, BLR, BNC, FD];

const SPECS: Spec[] = [
  PA("E1", "getPatientAppConfig", "GET", "/app/config", "engagement.auth.challenge", N, [200], []),
  PA("E2", "requestPatientOtp", "POST", "/auth/otp-challenges", "engagement.auth.challenge", N, [202], [FD], { tier: "otp_request" }),
  PA("E3", "verifyPatientOtp", "POST", "/auth/otp-challenges/verify", "engagement.auth.challenge", N, [200], ["auth.otp_invalid", "auth.otp_attempts_exhausted"], { tier: "otp_verify" }),
  E("E10", "getMyAccount", "GET", "/me", "engagement.self.read", N, [200], []),
  E("E11", "updateMyAccount", "PATCH", "/me", "engagement.self.manage", O, [200], [VC, PRE], IM),
  E("E12", "deleteMyAccount", "POST", "/me/delete", "engagement.self.manage", R, [204], [...IDEM, VC, PRE], IM),
  E("E13", "listMyProfiles", "GET", PRI, "engagement.self.read", N, [200], []),
  E("E14", "redeemLinkCode", "POST", `${PRI}/redeem-code`, "engagement.link.redeem", R, [200, 201], [LCI, LLR, ...IDEM]),
  E("E15", "redeemReportLink", "POST", `${PRI}/redeem-report-link`, "engagement.link.redeem", R, [200, 201], [LCI, LLR, ...IDEM]),
  E("E16", "createSelfRegistration", "POST", `${PRI}/self-registrations`, "engagement.self.manage", R, [202], [LLR, FD, ...IDEM]),
  E("E17", "getSelfRegistration", "GET", `${PRI}/self-registrations/{self_registration_id}`, "engagement.self.read", N, [200], []),
  E("E18", "updateMyProfile", "PATCH", `${PRI}/{profile_id}`, "engagement.self.manage", O, [200], [VC, PRE], IM),
  E("E19", "removeMyProfile", "POST", `${PRI}/{profile_id}/remove`, "engagement.self.manage", O, [204], [VC, PRE], IM),
  E("E20", "listMyOrders", "GET", "/me/orders", "engagement.self.read", N, [200], [], L),
  E("E21", "getMyOrder", "GET", "/me/orders/{order_id}", "engagement.self.read", N, [200, 304], []),
  E("E22", "listMyReports", "GET", "/me/reports", "reporting.portal.view", N, [200], [], L),
  E("E23", "downloadMyReport", "GET", "/me/reports/{report_id}/versions/{version_no}/file", "reporting.portal.download", N, [200], ["common.dependency_unavailable"], { tier: "report_download" }),
  E("E24", "getMySmartSummary", "GET", "/me/reports/{report_id}/versions/{version_no}/smart-summary", "reporting.portal.view", N, [200], []),
  E("E30", "listMyBookableItems", "GET", "/me/bookable-items", "engagement.self.read", N, [200], [FD], L),
  E("E31", "listMyBookingCentres", "GET", "/me/booking-centres", "engagement.self.read", N, [200], [FD]),
  E("E32", "listMyAvailableSlots", "GET", "/me/slots", "engagement.booking.create", N, [200], [SOW]),
  E("E33", "createMyBooking", "POST", BK, "engagement.booking.create", R, [201], [...BOOK_ERR, ...IDEM]),
  E("E34", "listMyBookings", "GET", BK, "engagement.self.read", N, [200], [], L),
  E("E35", "getMyBooking", "GET", `${BK}/{booking_id}`, "engagement.self.read", N, [200], []),
  E("E36", "cancelMyBooking", "POST", `${BK}/{booking_id}/cancel`, "engagement.booking.cancel", R, [200], [BNC, BIT, ...IDEM, VC, PRE], IM),
  E("E37", "listMyAddresses", "GET", AD, "engagement.self.read", N, [200], []),
  E("E38", "createMyAddress", "POST", AD, "engagement.self.manage", R, [201], [LLR, ...IDEM]),
  E("E39", "updateMyAddress", "PUT", `${AD}/{address_id}`, "engagement.self.manage", O, [200], [VC, PRE], IM),
  E("E40", "deactivateMyAddress", "POST", `${AD}/{address_id}/deactivate`, "engagement.self.manage", O, [204], [VC, PRE], IM),
  E("E41", "createPaymentRequest", "POST", "/me/orders/{order_id}/payment-requests", "engagement.payment.create", R, [200, 202], [FD, ...IDEM]),
  E("E42", "getPaymentRequest", "GET", "/me/payment-requests/{payment_request_id}", "engagement.payment.create", N, [200], []),
  E("E45", "listMyNotifications", "GET", "/me/notifications", "engagement.self.read", N, [200], [], L),
  E("E46", "markMyNotificationsRead", "POST", "/me/notifications/bulk-mark-read", "engagement.self.manage", O, [200], []),
  E("E47", "listMyMemberships", "GET", "/me/memberships", "engagement.self.read", N, [200], []),
  E("E48", "listMyEnquiries", "GET", EQ, "engagement.self.read", N, [200], [], L),
  E("E49", "createMyEnquiry", "POST", EQ, "engagement.enquiry.create", R, [201], [FD, EIT, ...IDEM]),
  E("E50", "getMyEnquiry", "GET", `${EQ}/{enquiry_id}`, "engagement.self.read", N, [200], []),
  E("E51", "replyMyEnquiry", "POST", `${EQ}/{enquiry_id}/messages`, "engagement.enquiry.create", R, [200], [EIT, ...IDEM, VC, PRE], IM),
  E("T3b", "listMyCodedSet", "GET", "/me/coded-sets/{set_name}", "engagement.self.read", N, [200], []),

  ST("S1", "listBookings", "GET", "/bookings", "engagement.booking.read", N, [200], [], L),
  ST("S2", "getBooking", "GET", "/bookings/{booking_id}", "engagement.booking.read", N, [200], []),
  ST("S3", "createBookingForPatient", "POST", "/bookings", "engagement.booking.manage", R, [201], [...BOOK_ERR, ...IDEM]),
  ST("S4", "cancelBooking", "POST", "/bookings/{booking_id}/cancel", "engagement.booking.cancel", R, [200], [BIT, ...IDEM, VC, PRE], IM),
  ST("S5", "checkInBooking", "POST", "/bookings/{booking_id}/check-in", "engagement.booking.manage", R, [200], [BIT, QC, ...IDEM, VC, PRE], IM),
  ST("S6", "getSlotAvailability", "GET", "/slots", "engagement.booking.read", N, [200], []),
  ST("S7", "listSlotTemplates", "GET", "/slot-templates", "engagement.slot.manage", N, [200], []),
  ST("S8", "createSlotTemplate", "POST", "/slot-templates", "engagement.slot.manage", R, [201], [...IDEM]),
  ST("S9", "updateSlotTemplate", "PUT", "/slot-templates/{template_id}", "engagement.slot.manage", O, [200], [VC, PRE], IM),
  ST("S10", "deactivateSlotTemplate", "POST", "/slot-templates/{template_id}/deactivate", "engagement.slot.manage", O, [200], [VC, PRE], IM),
  ST("S11", "listSlotBlackouts", "GET", "/slot-blackouts", "engagement.slot.manage", N, [200], []),
  ST("S11", "createSlotBlackout", "POST", "/slot-blackouts", "engagement.slot.manage", R, [], [...IDEM]),
  ST("S11", "deactivateSlotBlackout", "POST", "/slot-blackouts/{blackout_id}/deactivate", "engagement.slot.manage", ANY, [], [], { im: "any" }),
  ST("S12", "listBookableItems", "GET", "/bookable-items", "engagement.bookable_item.manage", N, [200], [], L),
  ST("S13", "upsertBookableItem", "PUT", "/bookable-items/{orderable_id}", "engagement.bookable_item.manage", R, [200], ["catalog.test_inactive", ...IDEM, VC], IMX),
  ST("S14", "syncBookableItems", "POST", "/bookable-items/sync", "engagement.bookable_item.manage", O, [202], [], { im: "any" }),
  ST("Q1a", "listQueues", "GET", "/queues", "engagement.queue.operate", N, [200], []),
  ST("Q1b", "listQueueDefinitions", "GET", "/queue-setup/queues", "engagement.queue.manage", N, [200], []),
  ST("Q1c", "createQueue", "POST", "/queues", "engagement.queue.manage", R, [], [...IDEM]),
  ST("Q1c", "updateQueue", "PUT", "/queues/{queue_id}", "engagement.queue.manage", O, [200], [VC, PRE], IM),
  ST("Q2a", "listCounters", "GET", "/queue-counters", "engagement.queue.operate", N, [200], []),
  ST("Q2b", "listCounterDefinitions", "GET", "/queue-setup/counters", "engagement.queue.manage", N, [200], []),
  ST("Q2c", "createCounter", "POST", "/queue-counters", "engagement.queue.manage", R, [], [...IDEM]),
  ST("Q2c", "updateCounter", "PUT", "/queue-counters/{counter_id}", "engagement.queue.manage", O, [200], [VC, PRE], IM),
  ST("Q3", "issueQueueToken", "POST", "/queue-tokens", "engagement.queue.operate", R, [201], [QC, ...IDEM]),
  ST("Q4", "listQueueTokens", "GET", "/queue-tokens", "engagement.queue.operate", N, [200], [], L),
  ST("Q5", "callNextQueueToken", "POST", "/queues/{queue_id}/call-next", "engagement.queue.operate", O, [200, 204], []),
  ST("Q6", "recallQueueToken", "POST", `${TK}/recall`, "engagement.queue.operate", O, [200], [QTI, VC, PRE], IM),
  ST("Q6", "startServingQueueToken", "POST", `${TK}/serve`, "engagement.queue.operate", O, [200], [QTI, VC, PRE], IM),
  ST("Q6", "completeQueueToken", "POST", `${TK}/complete`, "engagement.queue.operate", O, [200], [QTI, VC, PRE], IM),
  ST("Q6", "skipQueueToken", "POST", `${TK}/skip`, "engagement.queue.operate", O, [200], [QTI, VC, PRE], IM),
  ST("Q6", "cancelQueueToken", "POST", `${TK}/cancel`, "engagement.queue.operate", O, [200], [QTI, VC, PRE], IM),
  ST("Q7", "transferQueueToken", "POST", `${TK}/transfer`, "engagement.queue.operate", R, [200], [QTI, QC, ...IDEM, VC, PRE], IM),
  ST("Q8", "listQueueDisplays", "GET", QD, "engagement.queue.manage", N, [200], [], { im: "any" }),
  ST("Q8", "pairQueueDisplay", "POST", QD, "engagement.queue.manage", N, [201], [], { im: "any" }),
  ST("Q8", "revokeQueueDisplay", "POST", `${QD}/{display_id}/revoke`, "engagement.queue.manage", O, [], [], { im: "any" }),
  DD("Q9", "getQueueBoard", "GET", "/queue-board", "engagement.queue.board_read", N, [200, 304], []),
  ST("L1", "issueLinkCode", "POST", "/link-codes", "engagement.link.issue", N, [201], [LLR, FD]),
  ST("L2", "revokeLinkCode", "POST", "/link-codes/{link_code_id}/revoke", "engagement.link.revoke", O, [204], [VC, PRE], IM),
  ST("L3", "listPatientAppLinks", "GET", "/patients/{patient_id}/app-links", "engagement.link.read", N, [200], []),
  ST("L4", "revokeAppLink", "POST", "/app-links/{link_id}/revoke", "engagement.link.revoke", O, [200], [VC, PRE], IM),
  ST("R1", "listReminders", "GET", "/reminders", "engagement.reminder.read", N, [200], [], L),
  ST("R2", "createReminder", "POST", "/reminders", "engagement.reminder.manage", R, [201], [...IDEM]),
  ST("R3", "cancelReminder", "POST", "/reminders/{reminder_id}/cancel", "engagement.reminder.manage", O, [200], [RIT, VC, PRE], IM),
  ST("R4", "listFollowUpSuggestions", "GET", "/patients/{patient_id}/follow-up-suggestions", "engagement.reminder.read", N, [200], []),
  ST("M1a", "listMembershipPlans", "GET", "/membership-plans", "engagement.membership.read", N, [200], []),
  ST("M1b", "createMembershipPlan", "POST", "/membership-plans", "engagement.membership_plan.manage", R, [], [MFA, ...IDEM]),
  ST("M1b", "updateMembershipPlan", "PUT", "/membership-plans/{plan_id}", "engagement.membership_plan.manage", O, [200], [MFA, VC, PRE], IM),
  ST("M2", "enrolMembership", "POST", "/memberships", "engagement.membership.enrol", R, [201], ["engagement.membership_overlap", "engagement.plan_inactive", ...IDEM]),
  ST("M3", "listPatientMemberships", "GET", "/patients/{patient_id}/memberships", "engagement.membership.read", N, [200], []),
  ST("M4", "lookupMembershipCard", "POST", "/memberships/lookup", "engagement.membership.read", N, [200], []),
  ST("M5", "cancelMembership", "POST", "/memberships/{membership_id}/cancel", "engagement.membership.enrol", O, [200], [VC, PRE], IM),
  ST("N1", "listEnquiries", "GET", "/enquiries", "engagement.enquiry.read", N, [200], [], L),
  ST("N2", "getEnquiry", "GET", "/enquiries/{enquiry_id}", "engagement.enquiry.read", N, [200], []),
  ST("N3", "replyEnquiry", "POST", "/enquiries/{enquiry_id}/messages", "engagement.enquiry.respond", R, [200], [EIT, ...IDEM, VC, PRE], IM),
  ST("N4", "closeEnquiry", "POST", "/enquiries/{enquiry_id}/close", "engagement.enquiry.respond", O, [200], [EIT, VC, PRE], IM),
  ST("T1", "getEngagementSettings", "GET", "/settings", "engagement.booking.read", N, [200], []),
  ST("T2", "updateEngagementSettings", "PUT", "/settings", "engagement.settings.manage", O, [200], [MFA, "engagement.setting_out_of_range", VC, PRE], IM),
  ST("T3a", "listEngagementCodedSet", "GET", "/coded-sets/{set_name}", "engagement.booking.read", N, [200], []),
];
const TOTAL = 98;
const ROWS = [...new Set(SPECS.map((s) => s.row))];

// ---- §5.1 DTOs: "?" marks optional (TRD "field?")
const DTO: Record<string, string[]> = {
  Account: ["id", "phone_masked", "status", "reminders_opt_out", "last_login_at?", "created_at", "version"],
  Profile: ["profile_id", "display_name", "relationship", "method", "status", "history_from?", "patient_code?"],
  SelfRegistration: ["id", "relationship", "status", "failure_code?", "profile_id?"],
  PatientOrder: ["order_id", "profile_id", "registered_at", "stage", "payment_due", "balance_due?", "specimen_count", "report_count", "centre_display_name?", "booking_id?"],
  PatientReport: ["report_id", "version_no", "order_id", "profile_id", "kind", "status", "released_at", "panel_names", "smart_summary_available", "supersedes_version_no?"],
  SmartSummaryView: ["report_id", "version_no", "approved_at", "health_score?", "panels", "deranged", "advice", "follow_ups", "trends", "disclaimer_text?"],
  BookableItem: ["orderable_id", "kind", "code", "display_name", "indicative_price?", "booking_kinds", "sex_restriction?"],
  BookingCentre: ["centre_id", "display_name", "address_text?", "booking_kinds"],
  Slot: ["slot_start", "slot_end", "remaining", "booking_kind", "centre_id"],
  Booking: ["id", "booking_no", "profile_id?", "booking_kind", "centre_id", "centre_display_name", "slot_start", "slot_end", "status", "items", "home_address_id?", "cancellable_until?",
    "cancel_reason_code?", "created_via", "version"],
  Address: ["id", "profile_id", "label", "address_text", "landmark?", "municipality?", "ward_no?", "district?", "latitude?", "longitude?", "contact_phone_e164?", "version"],
  PaymentRequest: ["id", "order_id", "gateway", "status", "review", "amount?", "action?", "failure_code?", "expires_at?"],
  Notification: ["id", "kind", "entity_type?", "entity_id?", "profile_id?", "route_id?", "created_at", "read_at?"],
  MembershipCard: ["membership_id", "profile_id", "plan_display_name", "card_no", "card_token", "valid_from", "valid_to", "status"],
  Enquiry: ["id", "category_code", "subject", "status", "profile_id?", "last_message_at", "messages", "version"],
  QueueToken: ["id", "queue_id", "token_label", "status", "priority", "counter_id?", "issued_at", "called_at?", "call_count", "booking_id?", "version"],
  QueueBoard: ["centre_display_name", "board_version", "generated_at", "now_calling", "waiting"],
  Reminder: ["id", "patient_id", "kind", "reason_code?", "source", "due_at", "status", "sent_at?", "failure_code?", "version"],
};
const DTO_EXTRA: Record<string, string[]> = { // components that exist besides the 18 §5.1 DTOs (field lists live in 05-SCHEMA; names from TRD §5.2–5.4)
  PatientOrderDetail: [], AppConfig: [], AppLink: [], SlotTemplate: [], SlotBlackout: [], Queue: [], QueueCounter: [], QueueDisplay: [], MembershipPlan: [], Membership: [], EngagementSettings: [],
};
const STAFF_BOOKING_EXTRA = ["patient_id", "account_present", "order_id", "queue_token_id", "checked_in_at", "cancelled_by_kind"];
const APP_LINK_EXTRA = ["link_id", "account_phone_masked", "patient_id", "suspend_reason", "revoked_at", "revoked_reason_code"];
const LIST_PAGED: Record<string, string> = { listMyOrders: "PatientOrder", listMyReports: "PatientReport", listMyBookableItems: "BookableItem", listMyBookings: "Booking", listMyNotifications: "Notification" };
const LIST_DATA: Record<string, string> = { listMyBookingCentres: "BookingCentre", listMyAddresses: "Address", listMyMemberships: "MembershipCard", listMyAvailableSlots: "Slot" };
const ONE: Record<string, string> = { getMyAccount: "Account", updateMyAccount: "Account", redeemLinkCode: "Profile", redeemReportLink: "Profile", getSelfRegistration: "SelfRegistration",
  createSelfRegistration: "SelfRegistration", updateMyProfile: "Profile", getMyOrder: "PatientOrder", getMySmartSummary: "SmartSummaryView", createMyBooking: "Booking", getMyBooking: "Booking",
  cancelMyBooking: "Booking", createMyAddress: "Address", updateMyAddress: "Address", createPaymentRequest: "PaymentRequest", getPaymentRequest: "PaymentRequest", createMyEnquiry: "Enquiry",
  getMyEnquiry: "Enquiry", replyMyEnquiry: "Enquiry", issueQueueToken: "QueueToken", callNextQueueToken: "QueueToken", recallQueueToken: "QueueToken", startServingQueueToken: "QueueToken",
  completeQueueToken: "QueueToken", skipQueueToken: "QueueToken", cancelQueueToken: "QueueToken", getQueueBoard: "QueueBoard", createReminder: "Reminder", cancelReminder: "Reminder",
  replyEnquiry: "Enquiry", closeEnquiry: "Enquiry" };
const PHI_PARAMS = ["barcode", "registration_no", "booking_no", "card_no", "token_label", "phone", "phone_e164", "email", "full_name", "name"];
const FORBIDDEN_ANY = ["tenant_id"];
const FORBIDDEN_PATIENT = ["tenant_id", "patient_id", "account_id", "link_id"];
const SERVER_AUTH = ["tenant_id", "account_id", "created_by", "content_sha256", "created_at", "updated_at"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("engagement.yaml (T0C-10.C16)", () => {
  const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  const doc: any = text ? parse(text) : { paths: {}, components: {} };
  const ops: Record<string, { method: string; path: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(doc.paths ?? {}))
    for (const m of METHODS) if (item?.[m]) ops[item[m].operationId] = { method: m.toUpperCase(), path, op: item[m] };

  const deref = (n: any): any => {
    if (!n?.$ref) return n;
    const [file, ptr] = n.$ref.split("#");
    let cur: any = file === "_common.yaml" ? common : doc;
    for (const k of ptr.split("/").slice(1)) cur = cur?.[k.replace(/~1/g, "/").replace(/~0/g, "~")];
    return deref(cur);
  };
  const props = (s: any): Record<string, any> => {
    const n = deref(s) ?? {};
    return Object.assign({}, ...(n.allOf ?? []).map(props), n.properties ?? {});
  };
  const reqd = (s: any): string[] => {
    const n = deref(s) ?? {};
    return [...(n.required ?? []), ...(n.allOf ?? []).flatMap(reqd)];
  };
  const keys = (s: any) => Object.keys(props(s));
  const sorted = (s: any) => keys(s).sort();
  const schema = (n: string) => doc.components?.schemas?.[n];
  const prop = (n: string, f: string) => deref(props(schema(n))[f]);
  const bodySchema = (id: string) => deref(ops[id]?.op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const params = (id: string) => (ops[id]?.op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((q: any) => q?.name === pname);
  const pschema = (id: string, pname: string) => deref(param(id, pname)?.schema);
  const names = (id: string, where = "query") => params(id).filter((q: any) => q?.in === where).map((q: any) => q.name);
  const okResp = (id: string, code?: string) => {
    const e = Object.entries<any>(ops[id].op.responses).find(([c]) => (code ? c === code : /^2/.test(c)));
    expect(e, `${id}: no ${code ?? "2xx"} response`).toBeDefined();
    return deref(e![1]);
  };
  const okSchema = (id: string, code?: string) => deref(okResp(id, code).content?.["application/json"]?.schema);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const ex = () => expect(existsSync(FILE), "contracts/openapi/engagement.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const coded = (s: any, set: string) => {
    expect(s?.["x-coded-set"], "x-coded-set").toBe(set);
    expect(s.enum, "coded-set field must not declare enum").toBeUndefined();
  };
  const item = (s: any) => deref(deref(s).items);
  const enumIs = (s: any, want: unknown[]) => expect([...(s?.enum ?? [])].sort(), `enum of ${JSON.stringify(s)}`).toEqual([...want].sort());
  const int = (s: any, min: number, max: number) => expect([s?.type, s?.minimum, s?.maximum]).toEqual(["integer", min, max]);
  const len = (s: any, min: number | undefined, max: number) => expect([s?.minLength, s?.maxLength]).toEqual([min, max]);
  const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()) => {
    const n = deref(s);
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const a of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) walk(a, fn, seen);
    for (const q of Object.values(n.properties ?? {})) walk(q, fn, seen);
    if (n.items) walk(n.items, fn, seen);
  };
  const dtoReq = (f: string[]) => f.filter((x) => !x.endsWith("?"));
  const dtoOpt = (f: string[]) => f.filter((x) => x.endsWith("?")).map((x) => x.slice(0, -1));
  const dtoKeys = (f: string[]) => f.map((x) => x.replace(/\?$/, "")).sort();
  const shape = (s: any, fields: string[], label: string) => {
    expect(sorted(s), `${label} fields`).toEqual(dtoKeys(fields));
    expect(reqd(s), `${label} required`).toEqual(expect.arrayContaining(dtoReq(fields)));
    for (const o of dtoOpt(fields)) expect(reqd(s), `${label}.${o} optional`).not.toContain(o);
  };
  const superset = (s: any, base: string[], extra: string[], label: string) => {
    expect(keys(s), label).toEqual(expect.arrayContaining([...dtoKeys(base), ...extra]));
  };
  const dataOf = (id: string) => item(props(okSchema(id)).data);
  const patientOps = SPECS.filter((s) => s.actor === "pre" || s.actor === "P");

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/engagement.yaml missing").toBe(true));
    it("first non-comment line is `openapi: 3.0.3`", () => {
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
      expect(first?.trim()).toBe("openapi: 3.0.3");
    });
    it("info.title and version present; no `nullable: true` (no null on the wire, CV §4.2)", () => {
      expect(typeof doc.info?.title).toBe("string");
      expect(typeof doc.info?.version).toBe("string");
      expect(text.length, "empty").toBeGreaterThan(0);
      expect(text).not.toMatch(/nullable:\s*true/);
    });
    it("the LD-103 decision is cited in a comment", () => expect(text).toMatch(/LD-103/));
  });

  describe("repo spec lint is green (AC-0C-1.4, rules 1–8)", () => {
    it("lintRepo reports no violation", async () => {
      ex();
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      ex();
      const dir = mkdtempSync(join(tmpdir(), "c16-engagement-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/engagement.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "engagement.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("engagement.no_such_error"); });
      expect(v.some((x) => x.rule === "4" && /error code/.test(x.message))).toBe(true);
    });
    it("object schema without additionalProperties:false fails", async () => {
      const v = await mutate((d) => {
        const s = Object.values<any>(d.components?.schemas ?? {}).find((x) => x?.type === "object" && x.additionalProperties === false);
        delete s.additionalProperties;
      });
      expect(v.some((x) => x.rule === "3")).toBe(true);
    });
    it("operation without x-rate-limit-tier fails", async () => {
      const v = await mutate((d) => { delete firstOp(d, (o) => "x-rate-limit-tier" in o)["x-rate-limit-tier"]; });
      expect(v.some((x) => x.rule === "4" && /x-rate-limit-tier/.test(x.message))).toBe(true);
    });
    it("an operation with both x-permission and x-public fails (exactly one)", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-public"] = "bogus public justification text"; });
      expect(v.some((x) => x.rule === "4" && /exactly one/.test(x.message))).toBe(true);
    });
    it("a coded-set field that also declares enum fails (rule 6)", async () => {
      const v = await mutate((d) => {
        const s = Object.values<any>(d.components?.schemas ?? {}).flatMap((x: any) => Object.values<any>(x?.properties ?? {})).find((x) => "x-coded-set" in x);
        s.enum = ["a"];
      });
      expect(v.some((x) => x.rule === "6")).toBe(true);
    });
  });

  describe("engagement equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5.2–5.4 rows = test rows (row id, operationIds, first permission)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("### 5.2 "));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.5 "));
      expect(start).toBeGreaterThanOrEqual(0);
      const rows = new Map<string, { ids: string[]; perm: string }>();
      let last = "";
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        const row = (c[1] ?? "").trim();
        if (!/^[A-Z]\d+[a-z]?$/.test(row)) continue;
        const ids = [...(c[2] ?? "").matchAll(/`([a-z][A-Za-z0-9]+)`/g)].map((m) => m[1]);
        // S9 / S10 say "same" (as the row above) in the permission column
        const perm = /`((?:engagement|reporting)\.[a-z_.]+)`/.exec(c.slice(3).join("|"))?.[1] ?? last;
        last = perm;
        rows.set(row, { ids, perm });
      }
      expect([...rows.keys()].sort(), "row ids").toEqual([...ROWS].sort());
      for (const row of ROWS) {
        const mine = SPECS.filter((s) => s.row === row);
        expect(rows.get(row)!.ids.sort(), `${row} operationIds`).toEqual(mine.map((s) => s.id).sort());
        for (const s of mine) expect(rows.get(row)!.perm, `${row} ${s.id} permission`).toBe(s.perm);
      }
    });
    T("every path is /v1/engagement/… with tags [engagement]; no human number in a path; no PHI query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [q, it_] of Object.entries<any>(doc.paths ?? {})) {
        expect(q.startsWith(`${PFX}/`), q).toBe(true);
        expect(q).not.toMatch(/\{(registration_no|barcode|booking_no|card_no|token_label|phone|email)\}/);
        for (const m of METHODS) if (it_[m]) expect(it_[m].tags, `${m} ${q}`).toEqual([name]);
      }
      for (const id of Object.keys(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  const SEC: Record<Actor, any[]> = { pre: [{ patientPreAuth: [] }], P: [{ bearerJwt: [] }], S: [{ bearerJwt: [] }], D: [{ queueDisplayToken: [] }] };
  describe.each(SPECS)("$row $id", (r) => {
    const o = ops[r.id]?.op;
    it("exists at the TRD method + path", () => {
      has(r.id);
      expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${PFX}${r.path}`);
    });
    it(`has tags, summary, x-idempotency (TRD Idem), x-rate-limit-tier ${r.tier}, x-error-codes`, () => {
      has(r.id);
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      if (r.idem !== "any") expect(o["x-idempotency"]).toBe(r.idem);
      expect(["none", "optional", "required"]).toContain(o["x-idempotency"]);
      expect(o["x-rate-limit-tier"]).toBe(r.tier);
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${r.perm} (one code), never x-public; security ${Object.keys(SEC[r.actor][0])[0]}; tenant context only`, () => {
      has(r.id);
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual(SEC[r.actor]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status(es)", () => {
      has(r.id);
      const codes = Object.keys(o.responses ?? {});
      for (const c of r.status) expect(codes, `want ${c}`).toContain(String(c));
      expect(codes.some((c) => /^[23]/.test(c)), "some 2xx/3xx").toBe(true);
    });
    it("lists the TRD specific error codes plus the common codes (not_found on object ops, 426 on patient ops, mfa on privileged)", () => {
      has(r.id);
      const want = [...FIVE, ...r.err];
      if (r.path.includes("{")) want.push(NF);
      if (r.actor === "P" || r.actor === "pre") want.push(APPV);
      for (const c of want) expect(o["x-error-codes"], c).toContain(c);
      if (r.actor === "S" || r.actor === "D") expect(o["x-error-codes"], "426 is for patient ops only").not.toContain(APPV);
      if (r.im === false) expect(o["x-error-codes"], "no If-Match on this op").not.toContain(PRE);
      if (PRIVILEGED.has(r.perm)) expect(o["x-error-codes"], "privileged permission").toContain(MFA);
      else expect(o["x-error-codes"], "non-privileged op").not.toContain(MFA);
    });
    it("Idempotency-Key header where x-idempotency required, none where none; If-Match on IM rows", () => {
      has(r.id);
      const ps = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im === true) expect(ps).toMatch(/IfMatch|If-Match/);
      if (r.im === false) expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    if (r.paged)
      it("takes cursor + limit (max 200, default 50)", () => {
        has(r.id);
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
        const lim = pschema(r.id, "limit");
        expect([lim?.maximum, lim?.default]).toEqual([200, 50]);
      });
  });

  describe("patient operations: app headers, no-store, 426 (TRD §5 intro)", () => {
    T("every patient op (E1–E51, T3b) requires X-Lims-App-Version (pattern) and X-Lims-App-Platform (android|ios)", () => {
      for (const s of patientOps) {
        const v = param(s.id, "X-Lims-App-Version"), p = param(s.id, "X-Lims-App-Platform");
        expect(v?.in, `${s.id} version header`).toBe("header");
        expect(v?.required, `${s.id} version required`).toBe(true);
        expect(deref(v.schema).pattern, `${s.id} version pattern`).toBe("^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,4}$");
        expect(p?.in, `${s.id} platform header`).toBe("header");
        expect(p?.required, `${s.id} platform required`).toBe(true);
        enumIs(deref(p.schema), ["android", "ios"]);
      }
    });
    T("staff and display ops do not take the app headers", () => {
      for (const s of SPECS.filter((x) => x.actor === "S" || x.actor === "D"))
        for (const h of ["X-Lims-App-Version", "X-Lims-App-Platform"]) expect(names(s.id, "header"), `${s.id} ${h}`).not.toContain(h);
    });
    T("2xx of E10–E51, T3b and L1 carries Cache-Control: no-store (PHI)", () => {
      for (const s of [...SPECS.filter((x) => x.actor === "P"), ...SPECS.filter((x) => x.id === "issueLinkCode")])
        for (const [c, r0] of Object.entries<any>(ops[s.id].op.responses).filter(([c]) => /^2/.test(c))) {
          const h = deref(r0).headers ?? {};
          const k = Object.keys(h).find((x) => x.toLowerCase() === "cache-control");
          expect(k, `${s.id} ${c} Cache-Control`).toBeDefined();
          expect(JSON.stringify(deref(h[k!])), `${s.id} ${c}`).toContain("no-store");
        }
    });
    T("E21 and Q9 take If-None-Match, declare 304 and an ETag on 200", () => {
      for (const id of ["getMyOrder", "getQueueBoard"]) {
        expect(names(id, "header"), id).toContain("If-None-Match");
        expect(Object.keys(ops[id].op.responses), id).toContain("304");
        const h = Object.keys(deref(ops[id].op.responses["200"]).headers ?? {}).map((x) => x.toLowerCase());
        expect(h, `${id} ETag`).toContain("etag");
      }
    });
    T("E23 streams application/pdf with Content-Disposition; version_no is an integer path parameter", () => {
      const r = okResp("downloadMyReport", "200");
      expect(Object.keys(r.content ?? {})).toEqual(["application/pdf"]);
      expect(Object.keys(r.headers ?? {}).map((x) => x.toLowerCase())).toContain("content-disposition");
      expect(pschema("downloadMyReport", "version_no").type).toBe("integer");
      expect(param("downloadMyReport", "version_no").in).toBe("path");
    });
  });

  describe("query and path parameters (TRD §5.2–5.4)", () => {
    const req = (id: string, ...f: string[]) => f.forEach((x) => expect(param(id, x)?.required, `${id}?${x} required`).toBe(true));
    const opt = (id: string, ...f: string[]) => f.forEach((x) => { expect(param(id, x), `${id}?${x}`).toBeDefined(); expect(param(id, x).required, `${id}?${x} optional`).not.toBe(true); });
    T("patient list/query parameter names", () => {
      expect(names("listMyOrders")).toEqual(expect.arrayContaining(["profile_id", "stage", "cursor", "limit"]));
      expect(names("listMyReports")).toEqual(expect.arrayContaining(["profile_id", "order_id", "include_superseded", "cursor", "limit"]));
      expect(names("listMyBookableItems")).toEqual(expect.arrayContaining(["booking_kind", "query", "cursor", "limit"]));
      expect(names("listMyBookingCentres")).toEqual(["booking_kind"]);
      expect(names("listMyAvailableSlots")).toEqual(expect.arrayContaining(["booking_kind", "centre_id", "date_from", "date_to"]));
      expect(names("listMyBookings")).toEqual(expect.arrayContaining(["status", "cursor", "limit"]));
      expect(names("listMyAddresses")).toEqual(["profile_id"]);
      expect(names("listMyNotifications")).toEqual(expect.arrayContaining(["unread_only", "cursor", "limit"]));
      expect(names("listMyEnquiries")).toEqual(expect.arrayContaining(["cursor", "limit"]));
    });
    T("patient param types, requiredness and bounds", () => {
      opt("listMyOrders", "profile_id", "stage");
      expect(pschema("listMyOrders", "profile_id").format).toBe("uuid");
      opt("listMyReports", "profile_id", "order_id", "include_superseded");
      expect(pschema("listMyReports", "include_superseded").type).toBe("boolean");
      for (const f of ["profile_id", "order_id"]) expect(pschema("listMyReports", f).format, f).toBe("uuid");
      req("listMyBookableItems", "booking_kind");
      enumIs(pschema("listMyBookableItems", "booking_kind"), KINDS);
      opt("listMyBookableItems", "query");
      expect(pschema("listMyBookableItems", "query").maxLength).toBe(40);
      req("listMyBookingCentres", "booking_kind");
      enumIs(pschema("listMyBookingCentres", "booking_kind"), KINDS);
      req("listMyAvailableSlots", "booking_kind", "date_from", "date_to");
      opt("listMyAvailableSlots", "centre_id");
      expect(pschema("listMyAvailableSlots", "centre_id").format).toBe("uuid");
      for (const f of ["date_from", "date_to"]) expect(pschema("listMyAvailableSlots", f).format, f).toBe("date");
      opt("listMyNotifications", "unread_only");
      expect(pschema("listMyNotifications", "unread_only").type).toBe("boolean");
      opt("listMyAddresses", "profile_id");
    });
    T("sort enums where the TRD names a sort", () => {
      if (param("listMyOrders", "sort")) enumIs(pschema("listMyOrders", "sort"), ["-registered_at"]);
      if (param("listMyReports", "sort")) enumIs(pschema("listMyReports", "sort"), ["-released_at"]);
      if (param("listMyBookings", "sort")) enumIs(pschema("listMyBookings", "sort"), ["-slot_start"]);
      if (param("listBookings", "sort")) enumIs(pschema("listBookings", "sort"), ["slot_start", "-slot_start"]);
      if (param("listQueueTokens", "sort")) enumIs(pschema("listQueueTokens", "sort"), ["issued_at"]);
      if (param("listEnquiries", "sort")) enumIs(pschema("listEnquiries", "sort"), ["-last_message_at"]);
    });
    T("staff list/query parameter names and requiredness", () => {
      expect(names("listBookings")).toEqual(expect.arrayContaining(["centre_id", "booking_kind", "status", "slot_start_from", "slot_start_to", "cursor", "limit"]));
      req("listBookings", "slot_start_from", "slot_start_to");
      opt("listBookings", "centre_id", "booking_kind", "status");
      enumIs(pschema("listBookings", "booking_kind"), KINDS);
      for (const f of ["slot_start_from", "slot_start_to"]) expect(pschema("listBookings", f).format, f).toBe("date-time");
      expect(names("getSlotAvailability")).toEqual(expect.arrayContaining(["centre_id", "booking_kind", "date_from", "date_to"]));
      req("getSlotAvailability", "centre_id", "booking_kind", "date_from", "date_to");
      expect(names("listSlotTemplates")).toEqual(expect.arrayContaining(["centre_id", "is_active"]));
      opt("listSlotTemplates", "centre_id", "is_active");
      expect(names("listBookableItems")).toEqual(expect.arrayContaining(["is_active", "query", "cursor", "limit"]));
      expect(names("listQueues")).toEqual(expect.arrayContaining(["centre_id", "is_active"]));
      req("listQueues", "centre_id");
      expect(names("listQueueDefinitions")).toEqual(expect.arrayContaining(["centre_id", "is_active"]));
      opt("listQueueDefinitions", "centre_id", "is_active");
      req("listCounters", "centre_id");
      opt("listCounterDefinitions", "centre_id", "is_active");
      expect(names("listQueueTokens")).toEqual(expect.arrayContaining(["centre_id", "queue_id", "status", "business_date", "cursor", "limit"]));
      req("listQueueTokens", "centre_id");
      opt("listQueueTokens", "queue_id", "status", "business_date");
      expect(pschema("listQueueTokens", "business_date").format).toBe("date");
      expect(names("listReminders")).toEqual(expect.arrayContaining(["patient_id", "status", "due_from", "due_to", "cursor", "limit"]));
      req("listReminders", "due_from", "due_to");
      opt("listReminders", "patient_id", "status");
      expect(names("listMembershipPlans")).toEqual(["is_active"]);
      expect(names("listEnquiries")).toEqual(expect.arrayContaining(["status", "category_code", "cursor", "limit"]));
      opt("listEnquiries", "status", "category_code");
    });
    T("set_name path param: T3a booking_cancel_reasons|reminder_reasons|enquiry_categories; T3b booking_cancel_reasons|enquiry_categories", () => {
      enumIs(pschema("listEngagementCodedSet", "set_name"), ["booking_cancel_reasons", "reminder_reasons", "enquiry_categories"]);
      enumIs(pschema("listMyCodedSet", "set_name"), ["booking_cancel_reasons", "enquiry_categories"]);
      expect(param("listEngagementCodedSet", "set_name").in).toBe("path");
    });
    T("path ids (`*_id`) are required uuids; every path parameter is required", () => {
      for (const id of Object.keys(ops))
        for (const q of params(id).filter((x: any) => x?.in === "path")) {
          expect(q.required, `${id}:${q.name}`).toBe(true);
          if (/_id$/.test(q.name)) expect(deref(q.schema)?.format, `${id}:${q.name}`).toBe("uuid");
        }
    });
  });

  describe("request bodies (TRD §5.2–5.4)", () => {
    const r = (id: string) => [...reqd(bodySchema(id))].sort();
    T("E2 otp challenge: phone_e164, app_instance_id uuid, app_platform; all required", () => {
      const s = "requestPatientOtp";
      expect(bp(s, "phone_e164").type).toBe("string");
      expect(bp(s, "app_instance_id").format).toBe("uuid");
      enumIs(bp(s, "app_platform"), ["android", "ios"]);
      expect(r(s)).toEqual(["app_instance_id", "app_platform", "phone_e164"]);
    });
    T("E3 verify: code ^[0-9]{6}$ required", () => {
      expect(bp("verifyPatientOtp", "code").pattern).toBe("^[0-9]{6}$");
      expect(r("verifyPatientOtp")).toEqual(["code"]);
    });
    T("E11 reminders_opt_out boolean; E12 confirm must be true; E18 relationship enum", () => {
      expect(bp("updateMyAccount", "reminders_opt_out").type).toBe("boolean");
      enumIs(bp("deleteMyAccount", "confirm"), [true]);
      expect(r("deleteMyAccount")).toEqual(["confirm"]);
      enumIs(bp("updateMyProfile", "relationship"), REL);
    });
    T("E14 code 10–13 ^[0-9A-Za-z -]+$; E15 link_url ≤2000; both required", () => {
      const c = bp("redeemLinkCode", "code");
      len(c, 10, 13);
      expect(c.pattern).toBe("^[0-9A-Za-z -]+$");
      expect(r("redeemLinkCode")).toEqual(["code"]);
      expect(bp("redeemReportLink", "link_url").maxLength).toBe(2000);
      expect(r("redeemReportLink")).toEqual(["link_url"]);
    });
    T("E16 self-registration: relationship self|child, full_name 1–200, sex enum, age_years 0–150, consents, consent_text_version ≤32", () => {
      const s = "createSelfRegistration";
      enumIs(bp(s, "relationship"), ["self", "child"]);
      len(bp(s, "full_name"), 1, 200);
      enumIs(bp(s, "sex"), ["male", "female", "other", "unknown"]);
      expect(bp(s, "birth_on")).toBeDefined();
      int(bp(s, "age_years"), 0, 150);
      for (const f of ["sms_consent", "whatsapp_consent"]) expect(bp(s, f).type, f).toBe("boolean");
      expect(bp(s, "consent_text_version").maxLength).toBe(32);
      expect(r(s)).toEqual(["consent_text_version", "full_name", "relationship", "sex", "sms_consent", "whatsapp_consent"]);
      for (const f of ["birth_on", "age_years"]) expect(r(s), f).not.toContain(f);
    });
    T("E33 / S3 booking: kind enum, slot_start, orderable_ids 1..50 uuids; E33 replaces_booking_id + replaces_booking_version in the body", () => {
      for (const s of ["createMyBooking", "createBookingForPatient"]) {
        enumIs(bp(s, "booking_kind"), KINDS);
        expect(bp(s, "slot_start").format, s).toBe("date-time");
        expect(bp(s, "centre_id").format, s).toBe("uuid");
        const ids = bp(s, "orderable_ids");
        expect([ids.minItems, ids.maxItems], s).toEqual([1, 50]);
        expect(item(ids).format, s).toBe("uuid");
        expect(r(s), s).toEqual(expect.arrayContaining(["booking_kind", "slot_start", "orderable_ids"]));
        for (const f of ["centre_id", "home_address_id", "replaces_booking_id"]) expect(r(s), f).not.toContain(f);
      }
      const m = "createMyBooking";
      expect(bp(m, "profile_id").format).toBe("uuid");
      expect(r(m)).toContain("profile_id");
      expect(bp(m, "home_address_id").format).toBe("uuid");
      expect(bp(m, "replaces_booking_id").format).toBe("uuid");
      expect(bp(m, "replaces_booking_version").type).toBe("integer");
      const s3 = "createBookingForPatient";
      expect(bp(s3, "patient_id").format).toBe("uuid");
      expect(r(s3)).toContain("patient_id");
      expect(keys(bp(s3, "home_address")), "staff-entered address fields").toEqual(expect.arrayContaining(["address_text"]));
      expect(keys(bp(s3, "home_address"))).not.toContain("id");
    });
    T("E38 address body = Address minus id/version; E39 same; bounds from §5.1", () => {
      for (const s of ["createMyAddress", "updateMyAddress"]) {
        expect(keys(bodySchema(s)), s).toEqual(expect.arrayContaining(["label", "address_text"]));
        for (const f of ["id", "version"]) expect(keys(bodySchema(s)), `${s}.${f}`).not.toContain(f);
        enumIs(bp(s, "label"), ["home", "work", "other"]);
        expect(bp(s, "address_text").maxLength, s).toBe(300);
        expect(bp(s, "landmark").maxLength, s).toBe(120);
        expect(bp(s, "municipality").maxLength, s).toBe(80);
        expect(bp(s, "district").maxLength, s).toBe(60);
        int(bp(s, "ward_no"), 1, 99);
        for (const f of ["latitude", "longitude"]) expect(bp(s, f).type, `${s}.${f}`).toBe("string");
        expect(r(s), s).toEqual(expect.arrayContaining(["label", "address_text"]));
        for (const f of ["landmark", "municipality", "ward_no", "district", "latitude", "longitude", "contact_phone_e164"]) expect(r(s), `${s}.${f}`).not.toContain(f);
      }
    });
    T("E41 gateway esewa|khalti required; E46 ids 1..200 uuids required", () => {
      enumIs(bp("createPaymentRequest", "gateway"), ["esewa", "khalti"]);
      expect(r("createPaymentRequest")).toEqual(["gateway"]);
      const ids = bp("markMyNotificationsRead", "ids");
      expect([ids.minItems, ids.maxItems]).toEqual([1, 200]);
      expect(item(ids).format).toBe("uuid");
      expect(r("markMyNotificationsRead")).toEqual(["ids"]);
    });
    T("E49 enquiry: category_code coded-set (no enum), subject 1–120, message 1–2000, profile_id? uuid", () => {
      const s = "createMyEnquiry";
      coded(bp(s, "category_code"), "engagement.enquiry_categories");
      len(bp(s, "subject"), 1, 120);
      len(bp(s, "message"), 1, 2000);
      expect(bp(s, "profile_id").format).toBe("uuid");
      expect(r(s)).toEqual(["category_code", "message", "subject"]);
    });
    T("E51 / N3 reply: message 1–2000 required", () => {
      for (const s of ["replyMyEnquiry", "replyEnquiry"]) {
        len(bp(s, "message"), 1, 2000);
        expect(r(s), s).toEqual(["message"]);
      }
    });
    T("S4 cancel: reason_code coded-set engagement.booking_cancel_reasons (no enum), required; S5 check-in fields", () => {
      coded(bp("cancelBooking", "reason_code"), "engagement.booking_cancel_reasons");
      expect(r("cancelBooking")).toEqual(["reason_code"]);
      const s = "checkInBooking";
      expect(bp(s, "issue_token").type).toBe("boolean");
      expect(bp(s, "queue_id").format).toBe("uuid");
      expect(bp(s, "priority")).toBeDefined();
      expect(r(s)).toEqual(["issue_token"]);
    });
    T("S8 / S9 slot template body: weekdays, HH:MM, slot_minutes 5–240, capacity 1–100, effective_from; effective_to optional", () => {
      for (const s of ["createSlotTemplate", "updateSlotTemplate"]) {
        expect(bp(s, "centre_id").format, s).toBe("uuid");
        enumIs(bp(s, "booking_kind"), KINDS);
        const w = bp(s, "weekdays");
        expect([w.minItems, w.maxItems, w.uniqueItems], s).toEqual([1, 7, true]);
        int(item(w), 1, 7);
        for (const f of ["start_local", "end_local"]) {
          const re = new RegExp(bp(s, f).pattern ?? "$^");
          expect(re.test("08:30"), `${s}.${f} accepts 08:30`).toBe(true);
          for (const bad of ["8:30", "24:00", "12:60", "12:5"]) expect(re.test(bad), `${s}.${f} rejects ${bad}`).toBe(false);
        }
        int(bp(s, "slot_minutes"), 5, 240);
        int(bp(s, "capacity"), 1, 100);
        expect(bp(s, "effective_from").format, s).toBe("date");
        expect(bp(s, "effective_to").format, s).toBe("date");
        expect(r(s), s).toEqual(["booking_kind", "capacity", "centre_id", "effective_from", "end_local", "slot_minutes", "start_local", "weekdays"]);
      }
    });
    T("S11 create blackout: centre_id, booking_kind?, starts_at, ends_at, reason_code holiday|maintenance|other, note ≤200", () => {
      const s = "createSlotBlackout";
      expect(bp(s, "centre_id").format).toBe("uuid");
      enumIs(bp(s, "booking_kind"), KINDS);
      for (const f of ["starts_at", "ends_at"]) expect(bp(s, f).format, f).toBe("date-time");
      enumIs(bp(s, "reason_code"), ["holiday", "maintenance", "other"]);
      expect(bp(s, "note").maxLength).toBe(200);
      expect(r(s)).toEqual(["centre_id", "ends_at", "reason_code", "starts_at"]);
    });
    T("S13 upsert bookable item: booking_kinds 1..2, sort_order 0–9999, is_active; four required", () => {
      const s = "upsertBookableItem";
      expect(bp(s, "orderable_kind").type).toBe("string");
      const k = bp(s, "booking_kinds");
      expect([k.minItems, k.maxItems]).toEqual([1, 2]);
      enumIs(item(k), KINDS);
      int(bp(s, "sort_order"), 0, 9999);
      expect(bp(s, "is_active").type).toBe("boolean");
      expect(r(s)).toEqual(["booking_kinds", "is_active", "orderable_kind", "sort_order"]);
    });
    T("Q1c queue body: code ^[a-z0-9_]{1,32}$, display_name ≤60, token_prefix, sort_order, is_active; create + update", () => {
      for (const s of ["createQueue", "updateQueue"]) {
        expect(bp(s, "centre_id").format, s).toBe("uuid");
        expect(bp(s, "code").pattern, s).toBe("^[a-z0-9_]{1,32}$");
        expect(bp(s, "display_name").maxLength, s).toBe(60);
        expect(bp(s, "token_prefix").type, s).toBe("string");
        expect(bp(s, "sort_order"), s).toBeDefined();
        expect(bp(s, "is_active").type, s).toBe("boolean");
        expect(r(s), s).toEqual(["centre_id", "code", "display_name", "is_active", "sort_order", "token_prefix"]);
      }
    });
    T("Q2c counter body: centre_id, display_name ≤40, sort_order, is_active", () => {
      for (const s of ["createCounter", "updateCounter"]) {
        expect(bp(s, "centre_id").format, s).toBe("uuid");
        expect(bp(s, "display_name").maxLength, s).toBe(40);
        expect(bp(s, "is_active").type, s).toBe("boolean");
        expect(r(s), s).toEqual(["centre_id", "display_name", "is_active", "sort_order"]);
      }
    });
    T("Q3 issue token {queue_id, priority?, booking_id?}; Q5 {counter_id}; Q6 serve counter_id optional; Q7 {to_queue_id}", () => {
      expect(bp("issueQueueToken", "queue_id").format).toBe("uuid");
      expect(bp("issueQueueToken", "booking_id").format).toBe("uuid");
      expect(bp("issueQueueToken", "priority")).toBeDefined();
      expect(r("issueQueueToken")).toEqual(["queue_id"]);
      expect(bp("callNextQueueToken", "counter_id").format).toBe("uuid");
      expect(r("callNextQueueToken")).toEqual(["counter_id"]);
      expect(bp("startServingQueueToken", "counter_id").format).toBe("uuid");
      expect(r("startServingQueueToken")).not.toContain("counter_id");
      expect(bp("transferQueueToken", "to_queue_id").format).toBe("uuid");
      expect(r("transferQueueToken")).toEqual(["to_queue_id"]);
    });
    T("Q8 pair display: centre_id, display_name ≤40, queue_ids 1..10 uuids; all required", () => {
      const s = "pairQueueDisplay";
      expect(bp(s, "centre_id").format).toBe("uuid");
      expect(bp(s, "display_name").maxLength).toBe(40);
      const q = bp(s, "queue_ids");
      expect([q.minItems, q.maxItems]).toEqual([1, 10]);
      expect(item(q).format).toBe("uuid");
      expect(r(s)).toEqual(["centre_id", "display_name", "queue_ids"]);
    });
    T("L1 issue link code: enums, phone_e164 optional; L4 reason_code enum", () => {
      const s = "issueLinkCode";
      expect(bp(s, "patient_id").format).toBe("uuid");
      enumIs(bp(s, "relationship"), REL);
      enumIs(bp(s, "consented_by"), ["patient", "guardian"]);
      enumIs(bp(s, "identity_check_method"), ["photo_id", "guardian_photo_id", "known_patient"]);
      enumIs(bp(s, "bind_phone"), ["record", "other"]);
      expect(bp(s, "phone_e164").type).toBe("string");
      expect(r(s)).toEqual(["bind_phone", "consented_by", "identity_check_method", "patient_id", "relationship"]);
      enumIs(bp("revokeAppLink", "reason_code"), ["patient_request", "suspected_misuse", "staff_error", "other"]);
      expect(r("revokeAppLink")).toEqual(["reason_code"]);
    });
    T("R2 reminder: reason_code coded-set engagement.reminder_reasons (no enum), due_at, patient_id, source_ref_id? uuid", () => {
      const s = "createReminder";
      coded(bp(s, "reason_code"), "engagement.reminder_reasons");
      expect(bp(s, "due_at").format).toBe("date-time");
      expect(bp(s, "patient_id").format).toBe("uuid");
      expect(bp(s, "source_ref_id").format).toBe("uuid");
      expect(r(s)).toEqual(["due_at", "patient_id", "reason_code"]);
    });
    T("M1b plan body: code ^[A-Z0-9_]{2,20}$, display_name ≤60, description ≤300, price_list_id uuid, validity_days 30–1095, is_active", () => {
      for (const s of ["createMembershipPlan", "updateMembershipPlan"]) {
        expect(bp(s, "code").pattern, s).toBe("^[A-Z0-9_]{2,20}$");
        expect(bp(s, "display_name").maxLength, s).toBe(60);
        expect(bp(s, "description").maxLength, s).toBe(300);
        expect(bp(s, "price_list_id").format, s).toBe("uuid");
        int(bp(s, "validity_days"), 30, 1095);
        expect(bp(s, "is_active").type, s).toBe("boolean");
        expect(r(s), s).toEqual(["code", "display_name", "is_active", "price_list_id", "validity_days"]);
      }
    });
    T("M2 enrol {patient_id, plan_id, valid_from IsoDate}; M4 lookup = exactly one of card_token | card_no; M5 reason_code enum", () => {
      expect(bp("enrolMembership", "patient_id").format).toBe("uuid");
      expect(bp("enrolMembership", "plan_id").format).toBe("uuid");
      expect(bp("enrolMembership", "valid_from").format).toBe("date");
      expect(r("enrolMembership")).toEqual(["patient_id", "plan_id", "valid_from"]);
      const alts = (bodySchema("lookupMembershipCard").oneOf ?? []).map(deref);
      expect(alts.length, "xor: oneOf with two alternatives").toBe(2);
      expect(alts.map((a: any) => reqd(a).join(",")).sort()).toEqual(["card_no", "card_token"]);
      enumIs(bp("cancelMembership", "reason_code"), ["patient_request", "staff_error", "other"]);
      expect(r("cancelMembership")).toEqual(["reason_code"]);
    });
    T("T2 settings update takes a body object", () => expect(keys(bodySchema("updateEngagementSettings")).length).toBeGreaterThan(0));
    T("no request body names a server-authority field; patient bodies never name patient_id / account_id / link_id", () => {
      for (const id of Object.keys(ops)) {
        for (const f of SERVER_AUTH) expect(keys(bodySchema(id) ?? {}), `${id}.${f}`).not.toContain(f);
      }
      for (const s of SPECS.filter((x) => x.actor === "P" || x.actor === "pre"))
        for (const f of ["patient_id", "account_id", "link_id", "tenant_id"]) expect(keys(bodySchema(s.id) ?? {}), `${s.id}.${f}`).not.toContain(f);
    });
  });

  describe("response shapes (TRD §5.1–5.4)", () => {
    T("every §5.1 DTO and every other named object is a closed component", () => {
      for (const n of [...Object.keys(DTO), ...Object.keys(DTO_EXTRA)]) {
        expect(schema(n), n).toBeDefined();
        expect(schema(n).additionalProperties, `${n} closed`).toBe(false);
      }
    });
    T("§5.1 DTO field lists exactly (required = non-optional)", () => {
      for (const [n, f] of Object.entries(DTO)) shape(schema(n), f, n);
    });
    T("Account/Profile/SelfRegistration enums and bounds", () => {
      expect(prop("Account", "phone_masked").type).toBe("string");
      len(prop("Profile", "display_name"), undefined, 120);
      enumIs(prop("Profile", "relationship"), REL);
      enumIs(prop("Profile", "method"), ["link_code", "report_link", "self_registered"]);
      enumIs(prop("Profile", "status"), ["active", "pending"]);
      expect(prop("SelfRegistration", "relationship")).toBeDefined();
      enumIs(prop("SelfRegistration", "status"), ["queued", "created", "failed"]);
    });
    T("PatientOrder / PatientOrderDetail: Money balance, counts; detail = order + specimens[] + reports[] + etag", () => {
      expect(prop("PatientOrder", "payment_due").type).toBe("boolean");
      expect(keys(prop("PatientOrder", "balance_due"))).toEqual(["amount_paisa", "currency"]);
      superset(schema("PatientOrderDetail"), DTO.PatientOrder, ["specimens", "reports", "etag"], "PatientOrderDetail");
      expect(reqd(schema("PatientOrderDetail"))).toEqual(expect.arrayContaining(["specimens", "reports", "etag"]));
      const sp = item(prop("PatientOrderDetail", "specimens"));
      expect(Object.keys(props(sp)).sort()).toEqual(["collected_at", "received_at", "specimen_ref", "stage"]);
      expect(reqd(sp)).toEqual(expect.arrayContaining(["specimen_ref", "stage"]));
      for (const f of ["collected_at", "received_at"]) expect(reqd(sp), f).not.toContain(f);
      expect(item(prop("PatientOrderDetail", "reports"))).toEqual(deref(schema("PatientReport")));
      for (const f of ["patient_id", "order_no", "registration_no"]) expect(keys(schema("PatientOrder")), f).not.toContain(f);
    });
    T("PatientReport: kind is x-extensible (final|partial|preliminary|amended|addendum), status valid|superseded, panel_names ≤20 × ≤120", () => {
      const k = prop("PatientReport", "kind");
      expect(k["x-extensible"], "x-extensible: true (unknown value passed through)").toBe(true);
      if (k.enum) expect(k.enum).toEqual(expect.arrayContaining(["final", "partial", "preliminary", "amended", "addendum"]));
      enumIs(prop("PatientReport", "status"), ["valid", "superseded"]);
      const p = prop("PatientReport", "panel_names");
      expect(p.maxItems).toBe(20);
      expect(item(p).maxLength).toBe(120);
      expect(prop("PatientReport", "smart_summary_available").type).toBe("boolean");
    });
    T("SmartSummaryView (patient): health_score {value 0–100, band}, panels/deranged/advice/follow_ups/trends sub-shapes, texts ≤2000, no ids exposed", () => {
      const v = "SmartSummaryView";
      const hs = prop(v, "health_score");
      expect(Object.keys(props(hs)).sort()).toEqual(["band", "value"]);
      int(deref(props(hs).value), 0, 100);
      expect(Object.keys(props(item(prop(v, "panels")))).sort()).toEqual(["display_name", "panel_code", "status"]);
      expect(reqd(item(prop(v, "panels")))).not.toContain("display_name");
      const d = item(prop(v, "deranged"));
      expect(Object.keys(props(d)).sort()).toEqual(["direction", "severity", "text"]);
      expect(Object.keys(props(item(prop(v, "advice")))).sort()).toEqual(["text"]);
      const f = item(prop(v, "follow_ups"));
      expect(Object.keys(props(f)).sort()).toEqual(["interval_days", "text"]);
      int(deref(props(f).interval_days), 0, 3650);
      expect(Object.keys(props(item(prop(v, "trends")))).sort()).toEqual(["direction"]);
      for (const s of [d, item(prop(v, "advice")), f]) expect(deref(props(s).text).maxLength).toBe(2000);
      expect(prop(v, "disclaimer_text").maxLength).toBe(2000);
      for (const id of ["analyte_id", "result_id", "summary_id", "template_block_id", "rule_id", "llm_text"]) {
        let found = false;
        walk(schema(v), (n) => { if (id in props(n)) found = true; });
        expect(found, `SmartSummaryView must not expose ${id}`).toBe(false);
      }
    });
    T("BookableItem / BookingCentre / Slot / Booking enums and bounds", () => {
      enumIs(prop("BookableItem", "kind"), ["test", "panel"]);
      enumIs(item(prop("BookableItem", "booking_kinds")), KINDS);
      enumIs(item(prop("BookingCentre", "booking_kinds")), KINDS);
      enumIs(prop("Slot", "booking_kind"), KINDS);
      int(prop("Slot", "remaining"), 0, 9);
      enumIs(prop("Booking", "booking_kind"), KINDS);
      enumIs(prop("Booking", "created_via"), ["app", "staff"]);
      enumIs(prop("Booking", "status"), ["confirmed", "checked_in", "completed", "cancelled"]);
      const it_ = item(prop("Booking", "items"));
      expect(Object.keys(props(it_)).sort()).toEqual(["display_name", "indicative_price", "orderable_id"]);
      expect(reqd(it_)).toEqual(expect.arrayContaining(["orderable_id", "display_name"]));
      expect(reqd(it_)).not.toContain("indicative_price");
      for (const f of STAFF_BOOKING_EXTRA) expect(keys(schema("Booking")), `patient Booking must not carry staff field ${f}`).not.toContain(f);
    });
    T("Address bounds; PaymentRequest enums + action; Enquiry messages; QueueBoard nested shapes", () => {
      enumIs(prop("Address", "label"), ["home", "work", "other"]);
      expect(prop("Address", "address_text").maxLength).toBe(300);
      expect(prop("Address", "landmark").maxLength).toBe(120);
      int(prop("Address", "ward_no"), 1, 99);
      for (const f of ["latitude", "longitude"]) expect(prop("Address", f).type, f).toBe("string");
      enumIs(prop("PaymentRequest", "gateway"), ["esewa", "khalti"]);
      enumIs(prop("PaymentRequest", "status"), ["queued", "ready", "completed", "failed", "expired"]);
      expect(prop("PaymentRequest", "review").type).toBe("boolean");
      const a = prop("PaymentRequest", "action");
      expect(Object.keys(props(a)).sort()).toEqual(["kind", "url"]);
      enumIs(deref(props(a).kind), ["redirect", "form_post"]);
      expect(reqd(a).sort()).toEqual(["kind", "url"]);
      const m = item(prop("Enquiry", "messages"));
      expect(Object.keys(props(m)).sort()).toEqual(["author_kind", "body", "created_at"]);
      enumIs(deref(props(m).author_kind), ["patient", "staff"]);
      expect(reqd(m).sort()).toEqual(["author_kind", "body", "created_at"]);
      const nc = item(prop("QueueBoard", "now_calling"));
      expect(Object.keys(props(nc)).sort()).toEqual(["called_at", "counter_display_name", "queue_display_name", "token_label"]);
      const w = item(prop("QueueBoard", "waiting"));
      expect(Object.keys(props(w)).sort()).toEqual(["queue_display_name", "waiting_count"]);
      for (const f of ["patient_id", "profile_id", "booking_id", "display_name", "full_name"]) expect(keys(nc), `board row ${f}`).not.toContain(f);
    });
    T("paged list ops return {data, page} with the TRD item DTO", () => {
      for (const [id, dto] of Object.entries(LIST_PAGED)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(expect.arrayContaining(["data", "page"]));
        expect(item(props(s).data), id).toEqual(deref(schema(dto)));
      }
    });
    T("unpaginated list ops return {data} only; caps: slots ≤500, addresses ≤10", () => {
      for (const [id, dto] of Object.entries(LIST_DATA)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(["data"]);
        expect(item(props(s).data), id).toEqual(deref(schema(dto)));
      }
      expect(deref(props(okSchema("listMyAvailableSlots")).data).maxItems).toBe(500);
      expect(deref(props(okSchema("listMyAddresses")).data).maxItems).toBe(10);
    });
    T("single-object ops return (at least) the properties of their DTO", () => {
      for (const [id, dto] of Object.entries(ONE))
        expect(keys(okSchema(id)), id).toEqual(expect.arrayContaining(DTO[dto] ? dtoKeys(DTO[dto]) : keys(schema(dto))));
    });
    T("#E14/#E15 declare both 200 and 201 with Profile; E41 declares 200 and 202 with PaymentRequest", () => {
      for (const id of ["redeemLinkCode", "redeemReportLink"]) for (const c of ["200", "201"]) expect(keys(okSchema(id, c)), `${id} ${c}`).toEqual(expect.arrayContaining(dtoKeys(DTO.Profile)));
      for (const c of ["200", "202"]) expect(keys(okSchema("createPaymentRequest", c)), c).toEqual(expect.arrayContaining(dtoKeys(DTO.PaymentRequest)));
    });
    T("E1 AppConfig: features, min_app_version, consent, gateways, prefixes, calendar_display, timezone, order_poll_seconds; no lab_display_name", () => {
      const s = okSchema("getPatientAppConfig");
      expect(keys(s)).toEqual(expect.arrayContaining(["features", "min_app_version", "consent", "gateways", "allowed_phone_prefixes", "support_phone", "calendar_display", "timezone", "order_poll_seconds"]));
      expect(keys(s)).not.toContain("lab_display_name");
      expect(Object.keys(props(props(s).features)).sort()).toEqual(["app", "bookings", "enquiries", "home_collection", "membership", "payments", "smart_report"]);
      expect(Object.keys(props(props(s).min_app_version)).sort()).toEqual(["android", "ios"]);
      expect(Object.keys(props(props(s).consent)).sort()).toEqual(["text", "text_version"]);
      enumIs(deref(props(s).calendar_display), ["AD", "BS", "AD_BS", "BS_AD"]);
      expect(reqd(s)).not.toContain("support_phone");
    });
    T("E2 202 challenge {challenge_token (43), expires_at, resend_after_seconds, code_length}; E3 200 session", () => {
      const c = okSchema("requestPatientOtp");
      expect(sorted(c)).toEqual(["challenge_token", "code_length", "expires_at", "resend_after_seconds"]);
      len(deref(props(c).challenge_token), 43, 43);
      const v = okSchema("verifyPatientOtp");
      expect(sorted(v)).toEqual(["access_expires_at", "access_token", "account", "session_expires_at", "session_token"]);
      len(deref(props(v).session_token), 43, 43);
      expect(deref(props(v).access_token).maxLength).toBe(4096);
      expect(keys(props(v).account)).toEqual(expect.arrayContaining(dtoKeys(DTO.Account)));
    });
    T("E13 {data: Profile[] ≤10, pending: SelfRegistration[], paused_count}; E46 results[{id, outcome updated|not_found}]", () => {
      const s = okSchema("listMyProfiles");
      expect(sorted(s)).toEqual(["data", "paused_count", "pending"]);
      expect(deref(props(s).data).maxItems).toBe(10);
      expect(item(props(s).data)).toEqual(deref(schema("Profile")));
      expect(item(props(s).pending)).toEqual(deref(schema("SelfRegistration")));
      expect(deref(props(s).paused_count).type).toBe("integer");
      const b = okSchema("markMyNotificationsRead");
      expect(keys(b)).toEqual(["results"]);
      const r_ = item(props(b).results);
      expect(Object.keys(props(r_)).sort()).toEqual(["id", "outcome"]);
      enumIs(deref(props(r_).outcome), ["updated", "not_found"]);
    });
    T("E31 + coded sets: {data: [{code, display, sort_order}]} for T3a and T3b", () => {
      for (const id of ["listEngagementCodedSet", "listMyCodedSet"]) {
        expect(keys(okSchema(id)), id).toEqual(["data"]);
        expect(Object.keys(props(dataOf(id))).sort(), id).toEqual(["code", "display", "sort_order"]);
      }
    });
    T("staff Booking responses = Booking + patient_id, account_present, order_id?, queue_token_id?, checked_in_at?, cancelled_by_kind?; S2 adds transitions[]", () => {
      for (const id of ["getBooking", "createBookingForPatient", "cancelBooking"]) superset(okSchema(id), DTO.Booking, STAFF_BOOKING_EXTRA, id);
      superset(item(props(okSchema("listBookings")).data), DTO.Booking, STAFF_BOOKING_EXTRA, "listBookings item");
      for (const id of ["listBookings"]) expect(keys(okSchema(id))).toEqual(expect.arrayContaining(["data", "page"]));
      for (const f of ["patient_id", "account_present"]) expect(reqd(item(props(okSchema("listBookings")).data)), f).toContain(f);
      const t = item(props(okSchema("getBooking")).transitions);
      expect(Object.keys(props(t)).sort()).toEqual(["actor_type", "from", "occurred_at", "reason_code", "to"]);
      expect(reqd(t)).not.toContain("reason_code");
    });
    T("S5 {booking, token?}; S6 {data: Slot + capacity, booked, overbooked}; S9/S10/S11 + affected{…}", () => {
      const c = okSchema("checkInBooking");
      expect(sorted(c)).toEqual(["booking", "token"]);
      expect(reqd(c)).toEqual(["booking"]);
      const sl = dataOf("getSlotAvailability");
      superset(sl, DTO.Slot, ["capacity", "booked", "overbooked"], "S6 slot");
      expect(deref(props(sl).overbooked).type).toBe("boolean");
      superset(okSchema("updateSlotTemplate"), [], ["affected"], "S9");
      expect(Object.keys(props(prop_(okSchema("updateSlotTemplate"), "affected")))).toEqual(["overbooked_slots"]);
      for (const id of ["deactivateSlotTemplate", "createSlotBlackout", "deactivateSlotBlackout"]) {
        const ok = okSchema(id);
        expect(Object.keys(props(prop_(ok, "affected"))), id).toEqual(["future_bookings"]);
      }
      expect(keys(okSchema("listSlotTemplates"))).toEqual(["data"]);
      expect(keys(okSchema("listSlotBlackouts"))).toEqual(["data"]);
      expect(keys(dataOf("listSlotTemplates"))).toEqual(expect.arrayContaining(["centre_id", "booking_kind", "weekdays", "start_local", "end_local", "slot_minutes", "capacity", "effective_from"]));
    });
    T("S12 page of BookableItem + {is_active, synced_at, price_source}; S14 202 {}", () => {
      superset(dataOf("listBookableItems"), DTO.BookableItem, ["is_active", "synced_at", "price_source"], "S12 item");
      superset(okSchema("upsertBookableItem"), DTO.BookableItem, [], "S13");
      expect(keys(okSchema("syncBookableItems"))).toEqual([]);
    });
    T("Q-list responses are {data: Queue[] | QueueCounter[]}; Q4 page of QueueToken; Q5 200 QueueToken + 204; Q7 {from, to}; Q8 pair {display, display_token (43)}", () => {
      for (const id of ["listQueues", "listQueueDefinitions"]) expect(item(props(okSchema(id)).data), id).toEqual(deref(schema("Queue")));
      for (const id of ["listCounters", "listCounterDefinitions"]) expect(item(props(okSchema(id)).data), id).toEqual(deref(schema("QueueCounter")));
      expect(item(props(okSchema("listQueueTokens")).data)).toEqual(deref(schema("QueueToken")));
      expect(keys(okSchema("listQueueTokens"))).toEqual(expect.arrayContaining(["data", "page"]));
      expect(Object.keys(ops.callNextQueueToken.op.responses)).toEqual(expect.arrayContaining(["200", "204"]));
      const t = okSchema("transferQueueToken");
      expect(sorted(t)).toEqual(["from", "to"]);
      expect(deref(props(t).from)).toEqual(deref(schema("QueueToken")));
      const p = okSchema("pairQueueDisplay", "201");
      expect(sorted(p)).toEqual(["display", "display_token"]);
      len(deref(props(p).display_token), 43, 43);
      expect(deref(props(p).display)).toEqual(deref(schema("QueueDisplay")));
      expect(keys(schema("QueueDisplay")), "display token is never part of the stored display DTO").not.toContain("display_token");
    });
    T("L1 201 {link_code_id, code, expires_at, bound_phone_masked}; L3 {data: AppLink[], codes[]}; AppLink = Profile + staff fields", () => {
      expect(sorted(okSchema("issueLinkCode"))).toEqual(["bound_phone_masked", "code", "expires_at", "link_code_id"]);
      const l = okSchema("listPatientAppLinks");
      expect(sorted(l)).toEqual(["codes", "data"]);
      expect(item(props(l).data)).toEqual(deref(schema("AppLink")));
      superset(schema("AppLink"), DTO.Profile, APP_LINK_EXTRA, "AppLink");
      for (const f of ["link_id", "account_phone_masked", "patient_id"]) expect(reqd(schema("AppLink")), f).toContain(f);
      expect(Object.keys(props(item(props(l).codes))).sort()).toEqual(["expires_at", "issued_at", "link_code_id", "status"]);
      superset(okSchema("revokeAppLink"), DTO.Profile, APP_LINK_EXTRA, "L4");
    });
    T("R4 {data: [{report_id, version_no, released_at, interval_days, due_on, has_reminder}]}; no test codes or text (P1)", () => {
      const i = dataOf("listFollowUpSuggestions");
      expect(Object.keys(props(i)).sort()).toEqual(["due_on", "has_reminder", "interval_days", "released_at", "report_id", "version_no"]);
    });
    T("R1 page of Reminder; M1a {data: MembershipPlan[]}; M2/M3/M4/M5 Membership; N1 page of Enquiry without required messages; N2 + patient_id?", () => {
      expect(item(props(okSchema("listReminders")).data)).toEqual(deref(schema("Reminder")));
      expect(item(props(okSchema("listMembershipPlans")).data)).toEqual(deref(schema("MembershipPlan")));
      for (const id of ["enrolMembership", "lookupMembershipCard", "cancelMembership"]) expect(deref(okSchema(id))).toEqual(deref(schema("Membership")));
      expect(item(props(okSchema("listPatientMemberships")).data)).toEqual(deref(schema("Membership")));
      for (const id of ["listEnquiries", "listMyEnquiries"]) {
        const i = item(props(okSchema(id)).data);
        expect(reqd(i), `${id}: messages omitted`).not.toContain("messages");
        expect(keys(i), id).toEqual(expect.arrayContaining(["id", "category_code", "subject", "status", "last_message_at", "version"]));
      }
      superset(okSchema("getEnquiry"), DTO.Enquiry, ["patient_id"], "N2");
      expect(reqd(okSchema("getEnquiry"))).not.toContain("patient_id");
    });
    T("T1/T2 return EngagementSettings", () => {
      for (const id of ["getEngagementSettings", "updateEngagementSettings"]) expect(deref(okSchema(id)), id).toEqual(deref(schema("EngagementSettings")));
    });
    T("patient allowlist: no patient-op response (and no patient DTO) names tenant_id, patient_id, account_id or link_id", () => {
      for (const s of SPECS.filter((x) => x.actor === "P"))
        for (const [, r0] of Object.entries<any>(ops[s.id].op.responses ?? {}))
          walk(deref(r0)?.content?.["application/json"]?.schema, (n) => { for (const f of FORBIDDEN_PATIENT) expect(Object.keys(props(n)), `${s.id}.${f}`).not.toContain(f); });
    });
    T("no schema names tenant_id (tenant scope is the token, not the wire)", () => {
      for (const [n, s] of Object.entries<any>(doc.components?.schemas ?? {}))
        for (const f of FORBIDDEN_ANY) expect(Object.keys(props(s)), `${n}.${f}`).not.toContain(f);
      for (const { op } of Object.values(ops))
        for (const [, r0] of Object.entries<any>(op.responses ?? {}))
          walk(deref(r0)?.content?.["application/json"]?.schema, (n) => { for (const f of FORBIDDEN_ANY) expect(Object.keys(props(n)), f).not.toContain(f); });
    });
  });

  // helper used above: property of an object schema, dereferenced
  function prop_(s: any, f: string) { return deref(props(s)[f]); }

  describe("authentication surface", () => {
    T("no operation is public: no x-public; security per actor (pre-auth / bearer / display token)", () => {
      for (const [id, { op }] of Object.entries(ops)) expect(op["x-public"], id).toBeUndefined();
      expect(SPECS.filter((s) => s.actor === "D").map((s) => s.id)).toEqual(["getQueueBoard"]);
      expect(SPECS.filter((s) => s.actor === "pre").map((s) => s.id)).toEqual(["getPatientAppConfig", "requestPatientOtp", "verifyPatientOtp"]);
    });
    T("privileged permissions (membership_plan.manage, settings.manage) always list auth.mfa_required", () => {
      for (const [id, { op }] of Object.entries(ops)) if (PRIVILEGED.has(op["x-permission"])) expect(op["x-error-codes"], id).toContain(MFA);
    });
    T("patient-session and pre-auth ops carry the right tier; only E2 / E3 / E23 are non-general", () => {
      const non = Object.entries(ops).filter(([, { op }]) => op["x-rate-limit-tier"] !== "general").map(([id]) => id).sort();
      expect(non).toEqual(["downloadMyReport", "requestPatientOtp", "verifyPatientOtp"]);
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "engagement.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`engagement.yaml#${ptr}`);
      expect(validate, `cannot resolve ${ptr}`).toBeDefined();
      expect(validate!(example), `${ptr}: ${JSON.stringify(validate!.errors?.[0])}`).toBe(true);
    };
    const exampleValues = (): unknown[] => {
      const out: unknown[] = [];
      const w = (x: any) => {
        if (Array.isArray(x)) x.forEach(w);
        else if (x && typeof x === "object") {
          for (const [k, v] of Object.entries<any>(x)) {
            if (k === "example") out.push(v);
            else if (k === "examples" && v && typeof v === "object") for (const e of Object.values<any>(v)) out.push(e?.value);
            else w(v);
          }
        }
      };
      w(doc);
      return out;
    };
    it("every JSON request/response example matches its schema; at least one per JSON-bearing operation", () => {
      ex();
      let n = 0;
      for (const { method, path, op } of Object.values(ops)) {
        const base = `/paths/${esc(path)}/${method.toLowerCase()}`;
        const media: [string, any][] = [];
        const rb = op.requestBody;
        if (rb?.content?.["application/json"]) media.push([`${base}/requestBody/content/application~1json`, rb.content["application/json"]]);
        for (const [code, r0] of Object.entries<any>(op.responses ?? {}))
          if (!r0.$ref && r0.content?.["application/json"]) media.push([`${base}/responses/${code}/content/application~1json`, r0.content["application/json"]]);
        for (const [q, m] of media)
          for (const [k, e] of Object.entries<any>(m.examples ?? {})) {
            if (m.schema) check(`${q}/schema`, e.value);
            n++;
            expect(k.length).toBeGreaterThan(0);
          }
      }
      expect(n).toBeGreaterThanOrEqual(80);
    });
    it("every operation with a JSON 2xx response has an example Prism can serve", () => {
      ex();
      expect(Object.keys(ops).length).toBe(TOTAL);
      for (const s of SPECS) {
        const { op, path, method } = ops[s.id];
        const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^2/.test(c));
        expect(two.length, `${method} ${path}: no 2xx`).toBeGreaterThan(0);
        for (const [c, r0] of two) {
          const j = deref(r0).content?.["application/json"];
          if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
        }
      }
    });
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking token or IP", () => {
      ex();
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      expect(blob, "no JWT-shaped value").not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });

  describe("mock script (wave-1 convention)", () => {
    it("package.json has `mock:engagement` = prism mock contracts/openapi/engagement.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:engagement"];
      expect(mine, "mock:engagement script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/engagement\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:engagement" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
