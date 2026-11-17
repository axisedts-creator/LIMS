// tools/codegen/gen-access-actions.ts (C0-0C, T0C-05) — 02-TRD §5.3 `gen-access-actions` (05-SCHEMA §3.7, 08 A13 P-3).
// Seed = C0 base list (05-SCHEMA §3.7) ∪ the 03-IC §13.1 YAML block.
import { parse } from "yaml";

// 05-SCHEMA §3.7 "C0 base list" [CONV; chunks add codes by CR to 03-IC §13.1].
export const C0_BASE_ACCESS_ACTIONS = [
  "report.view", "report.print", "report.download", "report.bulk_download", "report.release_override",
  "invoice.view", "invoice.print", "invoice.reprint", "data.export", "patient.view", "trf.view", "consent.change",
  "role.change", "permission.change", "membership.lock", "membership.unlock", "session.revoke",
  "support_session.open", "support_session.close", "auth.login_success", "auth.login_failure", "auth.mfa_failure",
  "auth.password_reset", "auth.otp_sent", "auth.otp_failure", "dead_letter.replay", "dead_letter.discard",
];

const CODE = /^[a-z_]+\.[a-z_]+$/; // 05-SCHEMA g_cs_access_actions__code__ck

export function accessActionsFromIC(icText: string): string[] {
  const s = icText.indexOf("### 13.1 Access-log action codes");
  if (s < 0) throw new Error("03-IC §13.1 not found");
  const m = /```yaml\n([\s\S]*?)\n```/.exec(icText.slice(s));
  if (!m) throw new Error("03-IC §13.1 YAML block not found");
  const list = parse(m[1]!);
  if (!Array.isArray(list)) throw new Error("03-IC §13.1 block is not a YAML list");
  return list.map(String);
}

export function genAccessActions(icText: string, header: string, sqlHeader: string): { ts: string; sql: string } {
  const codes = [...new Set([...C0_BASE_ACCESS_ACTIONS, ...accessActionsFromIC(icText)])].sort();
  for (const c of codes) if (!CODE.test(c)) throw new Error(`access action ${c} violates ${CODE}`);
  const ts = `${header}
export type AccessAction =
${codes.map((c) => `  | ${JSON.stringify(c)}`).join("\n")};

export const ACCESS_ACTIONS: readonly AccessAction[] = [
${codes.map((c) => `  ${JSON.stringify(c)},`).join("\n")}
];
`;
  // display = code [CONV]: the 03-IC block keeps display text only as comments.
  // LD-30/LD-41: class-G seed runs as lims_owner; DO NOTHING (spec requires no updates; changes go by migration).
  const sql = `${sqlHeader}
SET LOCAL ROLE lims_owner;

INSERT INTO audit.g_cs_access_actions (code, display, sort_order) VALUES
${codes.map((c, i) => `  ('${c}', '${c}', ${(i + 1) * 10})`).join(",\n")}
ON CONFLICT (code) DO NOTHING;
`;
  return { ts, sql };
}
