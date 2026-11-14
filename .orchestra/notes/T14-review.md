APPROVE
# T14 re-review (reviewer) — diff 25cb23a..92eed5e

Ran T14-verify.cmd: 3 files, 104/104 pass.

Prior defects resolved:
1. DESCRIPTION_MAX 300 vs contract 500 — CR filed `.orchestra/cr/T14.md` (1), follows 04-CHANGE-REQUESTS §2 template, referenced at role.service.ts:47.
2. Batched signout job_key/payload — same CR (2), referenced at role.service.ts:245; [CONV] noted in T14-impl.md.
Fix commit touches only role.service.ts comments + notes/cr; no behaviour change.

Carried notes (not blocking): `identity.gotrue_signout` not yet in `core.g_task_registry` seeds (enqueue would raise `unknown_task_identifier` on a live DB until registered); default SQL repo not exercised against Postgres.
