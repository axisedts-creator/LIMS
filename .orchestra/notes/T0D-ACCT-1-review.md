APPROVE
# T0D-ACCT-1 review round 3 (reviewer, 2026-11-17)
Re-checked diff 095c49546..HEAD against round-2 items; rest of ea3dcdbf6..HEAD unchanged since rounds 1-2 (names, permissions, Idempotency-Key, If-Match, append only, no logs/secrets/PHI, owned paths only, routes additive, CR filed for a list endpoint).
1. Done: AccountSummaryScreen.tsx:39-40 partial Banner only when failed > 0; separate truncated Banner with catalogue key billing.accounts.summary.truncated (messages.ts). Tests cover truncated-only, both, failed-only.
2. Done: accounts.server.ts:134-140 retries only ApiError 429, waits 1000 ms, max 3 attempts, then counts failed; non-429 not retried. Tests cover retry-then-success, give-up after 3, no retry on 403.
Ran `.orchestra/notes/T0D-ACCT-1-verify.cmd`: 8 files, 191/191 pass.

Non-blocking (carry to follow-ups): AccountSummaryScreen has no isRowHeader column; pocket of other users is a UI gate only, T0B-ACCT-2 must enforce server side; summary still N calls per view until the CR list endpoint lands.
