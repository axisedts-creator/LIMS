APPROVE
# FD-T06 review round 2 (reviewer) — diff 9b6c69a6..a90cbe8f

Round-1 items all resolved:
1. `registration.service.ts:384` period_month = `today.slice(0, 7)` (A.D. month, tenant tz; `today` from :314). Matches CreditChargeDto pattern `^[0-9]{4}-(0[1-9]|1[0-2])$` (contracts/openapi/frontdesk.yaml:3743).
2. status = `'uninvoiced'` (05-SCHEMA.md:1050).
3. Count mismatch now throws `common.internal` (:383), no whole-net fallback; registration.test.ts credit case asserts period_month, status and sum of amounts = NET.
4. CR-C4-FD-T06-002 (`.orchestra/cr/FD-T06-retry-quote-ext.md`, To C0-0C) written in template form and cited at :266 and :305.

Round-1 "checked, no defect" list still holds (only lines above changed). Reviewer re-ran Docker-free: registration.static + events.publish + unit + quote.static = 65/65 pass. DB suite (FD-T06.pg.sh) not re-run by reviewer; writer reports 89/89.
