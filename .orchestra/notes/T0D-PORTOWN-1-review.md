APPROVE

Reviewed git diff d7b13e5ef..HEAD (T0D-PORTOWN-1, LD-305, CR-C0-0B-ADMINFIX-1).
- Fix: services/api/src/core/ports/registry.ts:100-101, a one-line change in the portsFor getter only: `consumers[port]?.includes(module) || owners[port] === module`. `owners` is the resolvePorts option (default PORT_OWNERS, core/module.ts:108), so it uses the same table the boot check validates. The LD-305 citation comment is present. No change to PORT_CONSUMERS, contracts, modules or assertRole. The diff touches only 2 code files, both in the brief's file list.
- Non-owner, non-listed path unchanged: dev/ci/staging still log and throw common.internal; production still logs, sets the metric and returns the port. No detail is leaked.
- Tests: services/api/src/core/ports/__tests__ was re-run here: 3 files, 160/160 pass. The new cases cover every done_when item: owner reads in all envs with no log and no metric; the non-owner throw in dev/ci/staging; the production metric; a listed consumer unchanged; an exact-set sweep (only the owner gains); owning one port grants no other; a missing consumers key; a fake-resolved owned port.
- One existing case was replaced ("no implicit owner access", billing read throws). This is justified: it asserted the exact behaviour LD-305 reverses. The non-owner throw is re-asserted on the same port.
- done_when (5) checked independently: the only non-test owner self-read is identity -> IdentityPort (identity/index.ts, service/audit-export.service.ts). The catalog/lab index.ts hits are comments only.
- No PHI, no secrets, no invented names. RLS and rate tier do not apply (no DB or route change).
- Not verified here: audit.chain.test.ts (the impl notes report the PORT_CONSUMERS pin passes, with 7 shadow-mode assertRole failures owned by T0B-ADMINFIX-1). DB-backed suites were also not run.
