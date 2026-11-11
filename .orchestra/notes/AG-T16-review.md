APPROVE

Re-review after 33f53a03 + f75de9aa. Both prior items fixed:
1. Rollback now durable: rollback() writes root\rolled-back.json (launcher-only); Run() loads it; Download/Stage return *Error rolled_back before any status write, so update-state.json keeps `rolled_back` (AC-15.3). Tests: rollback_persist_test.go (Stage/Download refuse + status kept + no HTTP hit; new Launcher on same root refuses re-staged pending.json).
2. 3/day download cap (03-APP-FLOW 3.6) enforced per version via download-attempts.json, pruned at 24 h; TestDownloadRetryCapThreePerDay covers 4th-attempt refusal, per-version scope, and allow after 24 h.

Scope: only owned paths + own notes. No DB/RLS/route surface; no PHI/secrets; token still redacted. Reviewer ran `go vet ./internal/update/ ./cmd/launcher/` (clean) and `go test -count=1 ./internal/update/ ./cmd/launcher/` (ok, ok).

Non-blocking: Policy nil in cmd/launcher (downgrade always refused, fail-closed); signed-exe positive case opt-in, not run; rolled-back.json never pruned (fix needs new version number) — noted in impl notes.
