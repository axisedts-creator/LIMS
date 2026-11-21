# T0D-UIGUARD-1 exceptions

Mirror of apps/web/src/core/__tests__/uiguard1.exceptions.ts (tester-owned registry). One line per entry: route, rule N, reason.
STANDING = real obstacles (pinned rs-c2.static admin pages, registration entry form, label print sheet, catch-all placeholder).
Other groups = LD-434 legacy baseline (CR-C0-0D-UIGUARD-1 option A); the heading is the follow-up task id the lead queues. When the follow-up fixes a file its entries go stale and the guard fails until the tester deletes them.

## STANDING (7 entries, 5 routes)

- /frontdesk/registrations/new rule 3: registration entry form: frontdesk.css bold totals and registration number (template 6)
- /frontdesk/registrations/new rule 5: registration entry form: the test line grid is an entry grid, not a list (template 6)
- /frontdesk/orders/[order_id] rule 3: registration entry form: shares frontdesk.css with the registration entry form
- /anatomic/cases/[case_id]/labels rule 3: label sheet: print layout of a physical label (label-sheet.css) needs a bold first line
- /[...slug] rule 1: catch-all placeholder for module routes without a page; not a screen (CR T0D-14)

# Rule 7 (T0D-UIGUARD-2, LD-436 R7, LD-439 c): no raw h1 to h4, no raw ul or ol for page structure. One entry per route; heading = follow-up area task.

## STANDING (catch-all)

- /[...slug] rule 7: catch-all placeholder for module routes without a page; not a screen (CR T0D-14): raw h1 in page.tsx

## T0D-UIGUARD-1-PAYMENTS (rule 7: 2 entries)

- /payments/refunds rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-PAYMENTS: rule 7 broken in RefundsList.tsx, consoleParts.tsx
- /payments/review rule 7: legacy baseline LD-436, fix in T0D-UIGUARD-1-PAYMENTS: rule 7 broken in ReviewQueue.tsx, consoleParts.tsx

