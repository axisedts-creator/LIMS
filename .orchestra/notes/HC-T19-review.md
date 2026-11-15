APPROVE

Re-review after writer commit 92cbac07b (review fixes).
- Finding 1 fixed: Review reason is `CodedSelect codedSet="homecollection.review_reasons"` (04-UI-UX §2.2). The props match the kit's CodedSelectProps (code/display/isActive, onChange(code)), and the unused `Select` import is gone.
- Finding 2 fixed: the primary button reads Apply, Discard or Confirm by decision, so the E2E `getByRole('button', { name: /^discard/i })` can now resolve.
- Re-ran HC-T19 vitest config: 4 files, 96/96 pass.

Carried over, not blocking: the Tubes "Clock" column needs a CR (`clock_suspect` is not in VisitDetailDto, 02-TRD:214). E2E not run (needs compose). US-16 access-log rows are asserted in HC-T13 (API).

Earlier checks still hold: names verbatim, Idempotency-Key and If-Match sent, phone only via H21, no PHI or secrets, owned paths only, LD-140 followed, no DB or RLS in this diff.
