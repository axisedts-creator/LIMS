ROLE: REVIEWER. Read-only except `.orchestra/notes/{TASK}-review.md`.
Review `git diff {BASE}..HEAD` for task {TASK} of chunk {CHUNK} against the spec sections it implements. Check: names verbatim from 03/08; tenant isolation (RLS ENABLE+FORCE, policies, cast `::uuid[]`); permissions, idempotency, rate tier, error codes; no PHI in logs; no secrets; only owned paths; tests really cover the done_when/ACs; nothing invented.
First line of the review file must be exactly `APPROVE` or `CHANGES`. If CHANGES: numbered list, each with file:line and the exact fix. Only real defects, no style nits.
