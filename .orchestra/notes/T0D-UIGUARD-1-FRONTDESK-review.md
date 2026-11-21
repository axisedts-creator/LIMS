APPROVE

Reviewed `git diff de722f298..HEAD` (2 commits, 15 files) for T0D-UIGUARD-1-FRONTDESK.

- Done when (1) rule 4: orders/[order_id] and patients/[patient_id] error.tsx draw kit ErrorState (digest as requestId, Retry); no raw message/stack (02-CV §2.4 kept).
- (2) rule 5: Visits and TRF attachments tables always render header; empty = kit EmptyRow + PlaceholderRows.
- (3) FRONTDESK legacy blocks removed from uiguard1.exceptions.ts by tester and from notes/T0D-UIGUARD-1-exceptions.md by writer (LD-441 ownership respected); nothing added; pinned registration-form entries kept.
- (4) rule 7: raw h2/ul/li replaced with kit Card title rows or role=heading / role=list; no FRONTDESK rule 7 entry left (LD-439 b).
- Display only: no route, permission, contract, operation, API or field-name change. No tokens.json, kit.css or shell.css change; the frontdesk.css selector uses tokens only. No PHI in logs, no secrets. No admin/platform/(auth)/(platform) path touched. Worklist (T0D-UIDASH-2) untouched. ReceiptPrintView.tsx (billing) is in scope because the removed FRONTDESK rule 7 entry named it.
- rs-c4.screens snapshots re-recorded by the writer (LD-440); diff is markup only.

Checks run by reviewer: uiguard1 config 36/36 pass; fd-t13 70/70, fd-t14 98/98, regscreen2 87/87 pass. rs-c4: 6 failures, none caused by this diff. 5 rs-c4.static failures come from billing discount-policy files and permissions (discounts.actions.ts, billing.discount_policy.*) that this diff does not touch. The "Daily cash" snapshot failure is order-dependent, as the writer's notes say. These failures are pre-existing and belong to whoever owns the discount-policy work.

Non-blocking: discount-approvals/error.tsx and worklist/error.tsx still use FrontdeskError, which already wraps ErrorState, so the two rewritten error.tsx files duplicate it. Not a defect.
