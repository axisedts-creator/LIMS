APPROVE
# FD-T09 re-review (reviewer) — diff 54bbb15d..ec0f311a

Prior finding #1 resolved: order.service.ts:349 removal guard now `removable !== true` (fails closed per 03-IC §3.2, 02-TRD:482); change.test.ts:317 covers lab-omitted item -> 409 `frontdesk.order_not_editable`, no writes, no billing calls. Comment rewording (FOR UPDATE -> row lock) is cosmetic, keeps FD-T08 static test green.

Re-ran: tests/frontdesk/FD-T09.pg.sh 80/80; frontdesk non-DB vitest 366/366; tsc 0 errors in modules/frontdesk.

Still open, non-blocking (accepted via CR): retry-once on billing.counter_busy/40P01 (.orchestra/cr/FD-T06-retry-quote-ext.md); supplementary InvoiceDto composition (.orchestra/cr/FD-T09-invoice-dto.md). All other checks from the first pass unchanged and OK.
