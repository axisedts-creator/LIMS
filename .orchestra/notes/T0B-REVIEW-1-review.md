APPROVE

T0B-REVIEW-1 review (reviewer), diff 055d42a6..HEAD.
- Scope: only .orchestra/cr/T0B-REVIEW-1.{1,2,3}.nonblocking.md, tests/db/T0B-REVIEW-1.reports.test.mjs, T0B-REVIEW-1 notes. No db/spec/services change (LD-232 RULES met).
- done_when: three CRs, one per LD-232 item, each with Intent / Current behaviour / Callers / Proposal / Tests. Ran `node --test tests/db/T0B-REVIEW-1.reports.test.mjs`: 8/8 pass.
- Facts spot-checked against tree: grant at reporting migration :1029; ON CONFLICT ... DO NOTHING at :1227 (needs no UPDATE); provider_events__update__tenant at db/policies/reporting.sql:210; mfa_factors__*__own use `IS NOT DISTINCT FROM` (identity.sql:103-107), the NULL=NULL leak is real; number_counters policies ANY_T (engagement.sql:448-452); app.current_actor_type() exists; key regex in CR 2 matches number_counters__key__ck; pre-auth OTP runs as actor type patient, so CR 2 keeps OTP/linkfail/booking paths working. Spec ids exist (C6 05-SCHEMA §1 row, grant table; C16 05-SCHEMA ANY_T, matrix).
- Proposals only narrow: ALTER POLICY adding conjuncts, AS RESTRICTIVE policies, no GRANT. Names follow `<table>__<cmd>__<scope>`.
- No PHI, no secrets. Static only: proposals not run against a database (no Docker); the lead takes each CR to the founder.
