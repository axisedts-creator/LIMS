APPROVE

Scope reviewed: `git diff 7de49f988..HEAD` (only code change: homecollection/__tests__/sync/effects.test.ts:308 — setSettings moved after pushWorld per LD-376, setup only, no assertion changed) plus the full T0B-SALES-1 branch diff vs main for the done_when.

Checked:
- Names verbatim: 15 sales operationIds of T0C-SALES-1 registered in partners/index.ts and removed from pendingOperations; 4 partner-ticket ids left pending (LD-373). homecollection updateCollectorFlags registered, pending list emptied. Permissions partners.sales.read / partners.sales.manage (LD-321).
- Tenant isolation: every statement in sales.repo.ts / collectorFlags.repo.ts binds tenant_id = $1 (RLS second wall, migration 20261117210000 of T0C); arrays cast `::uuid[]`; foreign / unknown ids -> common.not_found; collector flags other-tenant membership -> FK 23503 -> not_found.
- Rules in domain layer before SQL (sales.rules.ts + service): level 1..8 int, level unique (pre-check + 23505 backstop), no self manager, manager same tenant + active (FOR SHARE) + no loop (recursive walk with visited guard), tenant advisory lock shared with the trigger for the concurrency case, dates ordered, field paths on every validation error; If-Match / version conflict on updates.
- getSalesTree = one WITH RECURSIVE, depth cap 8, path cycle guard; listRepresentativeClients = one paged statement with outstanding + last bill date; non-manage readers scoped to own subtree (getActor().permissions, fail closed).
- Collector flags additive (no row = both true); allow_collection=false refused on assignHomeVisit and left out of H12; existing homecollection suites unchanged in assertions.
- Writes audited via app.tg_row_audit (tests assert audit rows); no request body logged; no secrets; edited paths within the brief's list.
- Verify: run1/run2/run3 logs each show main command 85 files / 3492 passed | 1 skipped and timing command 2 files / 6 passed (LD-355 retry command).

Non-blocking notes for the lead (not defects of this task; contract has precedence):
1. "deactivated representative refused unless clients are reassigned in the same request": deactivateSalesRepresentative has no request body in the T0C-SALES-1 contract, so only refuse + unassign-first is implemented/tested. Recorded in notes/T0B-SALES-1-impl.md and -tests.md but no `.orchestra/cr/` file exists; raise a CR if the same-request reassign is wanted.
2. "never offered for a pickup assignment": partners pickup assignee is free text (pickup.service.ts:257), so there is no server-side collector list to filter; allow_pickup is exposed on H12 for UIs. Same CR remark.
