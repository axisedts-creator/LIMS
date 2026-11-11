APPROVE

Reviewed `git diff 37d7f4c..HEAD` (AN-T01). Checked against plan row AN-T01, TRD §9.3/§9.4/§11, 04-UI-UX §1.
- API: manifest name/openapi verbatim; 30 operationIds = analytics.yaml (core validateManifest fails boot on drift); stubs 501 only when LIMS_CORE_ENV=dev, else LimsError `common.internal` (CV fail-closed); no request echo, no logging, no PHI/secrets. Permissions = 5 `analytics.*` codes of permissions.yaml, verbatim. Config: all 18 `LIMS_ANALYTICS_*` keys + defaults = TRD §11, fail-fast naming the key.
- Worker: 8 tasks, 12 subscriptions (= IC §3.25 C8 list, parsed from spec in test, = EVENT_CONSUMERS.analytics), 4 per_tenant crons, maxAttempts/taskOptions = §9.4 literal. Stubs throw (no silent ack).
- Web: 6 entries verbatim §1; `g r` replaces `g m` (clash with instruments.messages) — allowed by §1 "on conflict C8 picks another"; `g r` unused elsewhere.
- No DB/RLS, idempotency, or rate-tier surface in this task (n/a). Only owned paths touched (+ orchestra notes).

Non-blocking notes (not defects of this task):
1. TRD §9.3 table gives max_attempts 3 for sweep_recent/sweep_nightly/purge/backfill and 2 for self_check; §9.4 literal omits them, so those tasks get the core default. Spec self-conflict — raise a CR (C8 spec owner) before AN-T04/AN-T05 implement those tasks.
2. Reviewer did not execute tests (no `pnpm install` in this worktree); relied on writer/arbiter run reports (api 117/117, worker 10/10, web 6/6).
