# Nepal migration agent — launch

One agent = one cloud Claude Code session. Main thread: Opus 5.5, effort medium (`.claude/agents/nepal-migration.md`). It spawns Sonnet 5.5, effort high (`nepal-coder`) per slice. Nothing runs on a laptop.

## Before you start it (5 min, you)
1. **Stop the laptop `C1` lane** (close its supervisor window). Otherwise two agents build `infra/` and merge-conflict.
2. Cloud environment network: allow the hosts the stack build needs (npm/PyPI are on by default; container registries are not). If a pull is blocked the agent will request it; approve it.
3. Decide `TOPOLOGY`. `spec` = 2 Nepal VMs + a third location (required for real patient data, 04 S1/I1). `single-host-staging` = one box, synthetic data only. A single server cannot hold real PHI under the spec.

## Start
Claude Code on the web → new session on this repo/branch → model **Opus 5.5**, effort **medium** → paste:

```
Read .claude/agents/nepal-migration.md and follow it exactly as your operating protocol (you are the lead; use the nepal-coder agent for all code).
KIT_DEADLINE=<UTC ISO>  FREEZE_AT=<UTC ISO>  TOPOLOGY=<spec|single-host-staging>
Work only on the branch you were given. No PR.
```

## What you get
`infra/cutover/STATUS.md` (ledger, honest PASS/FAIL/NOT RUN), `PLAN.md`, `CUTOVER.md` (your step-by-step for the server build), `SERVER-TESTS.md` + `server-smoke.sh` (what only the Nepal box can prove), CRs in `.orchestra/cr/`.

## What it cannot do
Reach or log into the Nepal server; issue TLS certs; test real disks/IOPS/WireGuard/ISP; build the whole spec'd web app (19 chunks) — it delivers whatever slices pass their task gate and lists the rest.
