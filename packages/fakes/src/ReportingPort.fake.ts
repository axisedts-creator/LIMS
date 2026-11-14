// packages/fakes/src/ReportingPort.fake.ts — fake of IC §4.7 (owner C6).
import type { ReportingPort } from "@lims/contracts/ports/ReportingPort";
import { TENANT_A, TENANT_B, actorType, err, forbidden, idFor, invalid, makeFake, notFound, nowOf, requireStr, sha256Hex, tenantOf, type FakeOpts } from "./base";

export interface ReportVersionFixture {
  /** report version id (seed-merge key) */
  id: string; tenantId: string; reportId: string; versionNo: number; orderId: string; patientId: string; partnerId?: string | null; centreId?: string | null;
  kind: "final" | "partial" | "preliminary" | "amended" | "addendum"; status: "valid" | "superseded"; released: boolean; releasedAt: string | null;
  panelNames: string[]; smartSummary?: object | null;
}
export interface ReportingFixtures {
  reports: ReportVersionFixture[];
  /** TenantSettings.reportLinkTtlDays per tenant (30–90, 04 A10). */
  linkTtlDays: Record<string, number>;
  /** Partner actor id → partner id (`app.current_partner_id()`); patient actor id → patient ids (`app.engagement_patient_ids()`). */
  partnerOfActor: Record<string, string>;
  patientIdsOfActor: Record<string, string[]>;
  /** Patient phone numbers used by redeemPortalLinkForApp (synthetic, non-routable). */
  patientPhones: Record<string, string>;
}

const defaults = (seed: number): ReportingFixtures => {
  const r = (tenantId: string, n: number, o: Partial<ReportVersionFixture> = {}): ReportVersionFixture => ({
    id: idFor(seed, 0x631 + n), tenantId, reportId: idFor(seed, 0x601 + n), versionNo: 1, orderId: idFor(seed, 0x611 + n), patientId: idFor(seed, 0x621 + n), partnerId: null,
    centreId: null, kind: "final", status: "valid", released: true, releasedAt: "2026-11-04T04:15:00.000Z", panelNames: ["Synthetic Panel"], ...o,
  });
  return {
    reports: [r(TENANT_A, 0), r(TENANT_A, 1, { released: false, releasedAt: null }), r(TENANT_B, 2)],
    linkTtlDays: { [TENANT_A]: 30, [TENANT_B]: 60 },
    partnerOfActor: {},
    patientIdsOfActor: {},
    patientPhones: { [idFor(seed, 0x621)]: "+9779800000001" },
  };
};

const LIMIT_MAX = 100;   // [CONV] page size cap
const DAY_MS = 86_400_000;

export function createFakeReportingPort(opts: FakeOpts<ReportingFixtures>) {
  return makeFake<ReportingFixtures, ReportingPort>(defaults, opts, ({ fixtures: f, nextId, seed }) => {
    const links = new Map<string, { tenantId: string; reportId: string; versionNo: number; channel: string; recipientKind: string; expiresAt: string; failures: number }>();
    /** Rows the actor may see at all (released versions; partner/patient actors limited to their own). */
    const visible = (ctx: any) => {
      const t = tenantOf(ctx);
      const type = actorType(ctx);
      return f.reports.filter((r) => {
        if (r.tenantId !== t || !r.released) return false;
        if (type === "partner") return r.partnerId != null && r.partnerId === f.partnerOfActor[ctx.actor.id];
        if (type === "patient") return (f.patientIdsOfActor[ctx.actor.id] ?? []).includes(r.patientId);
        return true;
      });
    };
    const summary = (r: ReportVersionFixture) => ({
      reportId: r.reportId, versionNo: r.versionNo, orderId: r.orderId, patientId: r.patientId, kind: r.kind, status: r.status,
      releasedAt: r.releasedAt!, panelNames: [...r.panelNames], smartSummaryAvailable: r.smartSummary != null,
    });
    const order = (a: ReportVersionFixture, b: ReportVersionFixture) =>
      b.releasedAt!.localeCompare(a.releasedAt!) || a.reportId.localeCompare(b.reportId) || a.versionNo - b.versionNo;
    const keyOf = (r: ReportVersionFixture) => `${r.releasedAt}|${r.reportId}|${r.versionNo}`;

    return {
      async getReleasedReports(ctx, input) {
        const filter: any = input.filter ?? {};
        const set = ["orderId", "patientId", "partnerId", "centreId"].filter((k) => filter[k] !== undefined);
        if (set.length !== 1) throw invalid("exactly_one_filter");
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw invalid("limit_out_of_range");
        let after: string | undefined;
        if (input.cursor !== undefined) {
          try { after = Buffer.from(String(input.cursor), "base64url").toString("utf8"); } catch { after = undefined; }
          if (!after || after.split("|").length !== 3) throw err("common.invalid_cursor");
        }
        const k = set[0]!;
        const rows = visible(ctx)
          .filter((r) => (r as any)[k] === filter[k])
          .filter((r) => filter.includeSuperseded || r.status !== "superseded")
          .filter((r) => (!filter.releasedFrom || r.releasedAt! >= filter.releasedFrom) && (!filter.releasedTo || r.releasedAt! <= filter.releasedTo))
          .sort(order);
        const start = after === undefined ? 0 : rows.findIndex((r) => order(r, { ...r, ...parse(after!) } as any) > 0);
        const page = start < 0 ? [] : rows.slice(start, start + limit);
        const more = start >= 0 && start + limit < rows.length;
        return { items: page.map(summary), ...(more ? { nextCursor: Buffer.from(keyOf(page.at(-1)!)).toString("base64url") } : {}) } as any;
      },
      async issuePortalLink(ctx, input) {
        const t = tenantOf(ctx);
        if (!["user", "system"].includes(actorType(ctx))) throw forbidden();
        if (!["whatsapp", "sms", "email", "print_qr", "patient_app"].includes(input.channel)) throw invalid("channel_invalid");
        if (!["patient", "referrer", "centre", "partner"].includes(input.recipientKind)) throw invalid("recipient_kind_invalid");
        const versions = f.reports.filter((r) => r.tenantId === t && r.reportId === input.reportId);
        if (!versions.length) throw notFound();
        const released = versions.filter((r) => r.released);
        const v = input.versionNo === undefined ? released.sort((a, b) => b.versionNo - a.versionNo)[0] : versions.find((r) => r.versionNo === input.versionNo);
        if (!v) { if (input.versionNo === undefined) throw err("reporting.report_not_released"); throw notFound(); }
        if (!v.released) throw err("reporting.report_not_released");
        if (v.status === "superseded") throw err("reporting.report_superseded");
        const linkId = nextId();
        const token = (await sha256Hex(`${seed}:${linkId}`)).slice(0, 32);       // 128-bit, deterministic per seed (fake only)
        const expiresAt = new Date(Date.parse(nowOf(ctx)) + (f.linkTtlDays[t] ?? 30) * DAY_MS).toISOString();
        links.set(token, { tenantId: t, reportId: v.reportId, versionNo: v.versionNo, channel: input.channel, recipientKind: input.recipientKind, expiresAt, failures: 0 });
        return { linkId, url: `https://portal.invalid/r/${token}`, expiresAt } as any;
      },
      async openReleasedReportFile(ctx, input) {
        const r = visible(ctx).find((x) => x.reportId === input.reportId && x.versionNo === input.versionNo);
        if (!r) throw notFound();
        const sha256 = await sha256Hex(`${r.reportId}:${r.versionNo}`);
        return { reportVersionId: r.id, reportId: r.reportId, versionNo: r.versionNo, status: r.status,
          contentType: "application/pdf", byteSize: 1024, sha256, signedUrl: `https://storage.invalid/reports/${sha256}.pdf`,
          expiresAt: new Date(Date.parse(nowOf(ctx)) + 300_000).toISOString(), ...(r.smartSummary ? { smartSummary: r.smartSummary } : {}) } as any;
      },
      async redeemPortalLinkForApp(ctx, input) {
        const bad = () => err("reporting.link_invalid");
        const t = tenantOf(ctx);
        const l = typeof input.linkToken === "string" ? links.get(input.linkToken) : undefined;
        if (!l || l.tenantId !== t) throw bad();
        if (actorType(ctx) !== "patient" || l.failures >= 5) { l.failures++; throw bad(); }
        const r = f.reports.find((x) => x.tenantId === t && x.reportId === l.reportId && x.versionNo === l.versionNo);
        const ok = r && l.expiresAt > nowOf(ctx) && l.recipientKind === "patient" && ["sms", "whatsapp"].includes(l.channel)
          && requireStr(input.phoneE164) === f.patientPhones[r.patientId];
        if (!ok) { l.failures++; throw bad(); }
        return { patientId: r.patientId, reportId: r.reportId, versionNo: r.versionNo, releasedAt: r.releasedAt! } as any;
      },
    };
  });
}

function parse(key: string): Pick<ReportVersionFixture, "releasedAt" | "reportId" | "versionNo"> {
  const [releasedAt, reportId, v] = key.split("|");
  return { releasedAt: releasedAt!, reportId: reportId!, versionNo: Number(v) };
}
