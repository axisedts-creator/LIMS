// packages/fakes/src/QualityPort.fake.ts — C9 QualityPort fake (IC §4.11). Default = Phase-1 behaviour: every tenant has
// auto-verification disabled (deny/feature_disabled) and no QC plans for unknown instrument/analyte pairs (no_qc_data).
// Phase-2 behaviour is programmed through fixtures (tenants[].autoVerificationEnabled, qcPlans, autoVerifyLimits).
import type { QualityPort, AutoVerifyReason } from "@lims/contracts/ports/QualityPort";
import { TENANT_A, TENANT_B, idFor, makeFake, nowOf, tenantOf, type FakeOpts } from "./base";

export interface QcRunFixture {
  runId: string; at: string; outcome: "accepted" | "warning" | "rejected";
  closedAt?: string;                 // a rejected run stays open (out_of_control) until closedAt
  violatedRules?: string[];
}
export interface QualityFixtures {
  tenants: Record<string, { autoVerificationEnabled: boolean; ruleSetVersion: string; shadowRuleSetVersion?: string }>;
  qcPlans: { id: string; tenantId: string; instrumentId: string; analyteId: string; validityHours: number; runs: QcRunFixture[] }[];
  /** Auto-verify limits per rule-set version; only rows of the tenant's active `ruleSetVersion` decide (shadow never does). */
  autoVerifyLimits: { id: string; tenantId: string; analyteId: string; ruleSetVersion: string; low?: string; high?: string }[];
}

const defaults = (seed: number): QualityFixtures => ({
  tenants: {
    [TENANT_A]: { autoVerificationEnabled: false, ruleSetVersion: "av-1" },
    [TENANT_B]: { autoVerificationEnabled: false, ruleSetVersion: "av-1" },
  },
  qcPlans: [TENANT_A, TENANT_B].map((t, i) => ({
    id: idFor(seed, 0x10 + i), tenantId: t, instrumentId: idFor(seed, 0x20 + i), analyteId: idFor(seed, 0x30 + i), validityHours: 24,
    runs: [{ runId: idFor(seed, 0x40 + i), at: "2026-11-05T01:00:00.000Z", outcome: "accepted" as const }],
  })),
  autoVerifyLimits: [TENANT_A, TENANT_B].map((t, i) => ({
    id: idFor(seed, 0x50 + i), tenantId: t, analyteId: idFor(seed, 0x30 + i), ruleSetVersion: "av-1", low: "3.5", high: "5.5",
  })),
});

type QcStatus = Awaited<ReturnType<QualityPort["qcStatusFor"]>>;
const ms = (iso: string) => Date.parse(iso);

export function createFakeQualityPort(opts: FakeOpts<QualityFixtures>) {
  return makeFake(defaults, opts, ({ fixtures }) => {
    function qcStatus(tenantId: string, instrumentId: unknown, analyteId: unknown, at: string): QcStatus {
      const plan = fixtures.qcPlans.find((p) => p.tenantId === tenantId && p.instrumentId === instrumentId && p.analyteId === analyteId);
      if (!plan) return { status: "no_qc_data" };
      const runs = plan.runs.filter((r) => ms(r.at) <= ms(at)).sort((a, b) => ms(a.at) - ms(b.at));
      const lastOk = runs.filter((r) => r.outcome !== "rejected").at(-1);
      const base = lastOk ? { lastInControlRunAt: lastOk.at } : {};
      const open = runs.filter((r) => r.outcome === "rejected" && (!r.closedAt || ms(r.closedAt) > ms(at))).at(-1);
      // an open rejected run masks every newer accepted run (IC §4.11 case 8)
      if (open) return { status: "out_of_control", ...base, currentRunId: open.runId, violatedRules: open.violatedRules ?? [] };
      if (!lastOk || ms(at) - ms(lastOk.at) > plan.validityHours * 3600_000) return { status: "no_qc_data", ...base };
      if (lastOk.outcome === "warning") return { status: "warning", ...base, currentRunId: lastOk.runId, violatedRules: lastOk.violatedRules ?? ["1-2s"] };
      return { status: "in_control", ...base, currentRunId: lastOk.runId };
    }

    const port: QualityPort = {
      async canAutoVerify(ctx, rc) {
        const tenantId = tenantOf(ctx);
        const t = fixtures.tenants[tenantId];
        const reasons: AutoVerifyReason[] = [];
        if (!t?.autoVerificationEnabled) reasons.push("feature_disabled");
        if (!rc.instrumentId) reasons.push("manual_origin");
        if ((rc.instrumentFlags ?? []).length > 0) reasons.push("instrument_flag");
        if (rc.isCritical) reasons.push("critical");
        if (rc.deltaCheckFailed) reasons.push("delta_failure");
        const lim = fixtures.autoVerifyLimits.find((l) => l.tenantId === tenantId && l.analyteId === rc.analyteId && l.ruleSetVersion === t?.ruleSetVersion);
        if (!lim) reasons.push("rule_missing");
        else {
          const v = Number(rc.valueNumeric);
          if (rc.valueNumeric === undefined || !Number.isFinite(v) || (lim.low !== undefined && v < Number(lim.low)) || (lim.high !== undefined && v > Number(lim.high))) {
            reasons.push("outside_autoverify_limits");
          }
        }
        if (rc.instrumentId) {
          const q = qcStatus(tenantId, rc.instrumentId, rc.analyteId, rc.resultedAt ?? nowOf(ctx)).status;
          if (q === "out_of_control") reasons.push("qc_out_of_control");
          else if (q === "no_qc_data") reasons.push("qc_no_data");
          else if (q === "warning") reasons.push("qc_warning");
        }
        // invariant: allow only when no reason applies (shadowRuleSetVersion is never consulted)
        return { decision: reasons.length === 0 ? "allow" : "deny", reasons, ...(t ? { ruleSetVersion: t.ruleSetVersion } : {}) };
      },
      async qcStatusFor(ctx, input) {
        return qcStatus(tenantOf(ctx), input.instrumentId, input.analyteId, input.at ?? nowOf(ctx));
      },
    };
    return port;
  });
}
