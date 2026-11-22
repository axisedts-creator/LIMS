# T0D-BUILD-3 dispute (writer): 2 of 59 api tests ask for an access-log action the spec does not give
Tests: build3.access-review.test.ts > "audit (LD-189)" > "one access/audit entry ... action from the seeded access-action list" and "the audit write fails: the handler rejects".
Why they are wrong as written:
- C2 02-TRD §9 (the access-log table, lines ~505-526) lists every operation that writes `ctx.audit.access`; recordAccessReview is NOT on it.
- No code in db/seeds/003_audit__g_cs_access_actions.sql fits "access review recorded" (closest: permission.change / role.change / settings.change, all mean a change that did not happen). CLAUDE.md: never invent or misuse a code.
- The audit entry IS written: trigger `access_reviews__audit` (app.tg_row_audit, db/migrations/20261105001300_identity__create_identity_schema.sql:958) records every INSERT in the request tx; a failed audit write rolls the insert back. That matches the brief's "writes an audit entry" and C2 05-SCHEMA §2 (access_reviews has the audit trigger).
Ruling asked (lead): (a) accept the row-audit trigger and retire/revise the two cases, or (b) name a seed code (or a CR for a new code `access_review.record`) and I add one `ctx.audit.access({action, entityType:'access_review', entityId, outcome:'allowed'})` in service/access-review.service.ts (one line).
Everything else is implemented; the other 57 api + 28 web cases pass.
