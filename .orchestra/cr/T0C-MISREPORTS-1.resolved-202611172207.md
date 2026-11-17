Title: CR-C0-MISREPORTS-1: Re-decide B13 / 04 L19 (no "commission", no amount payable) versus the LD-321 commission and TDS MIS reports
From chunk: C0-foundation-contracts (task T0C-MISREPORTS-1)            To owner: C0-0C (analytics contract), C8 (copy rule), founder (B13 decision)
Type: api
Blocking? yes — T0C-MISREPORTS-1 (and T0B-MISREPORTS-1, T0D-MISREPORTS-1 behind it)

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
The task brief (LD-321, done_when item 2) requires analytics report definitions "two level commission report (commission_bp from the settings)" and "TDS report (commission payable and tds_bp withheld per party and period)". The spec forbids both the word and the content:
- spec/research/04-consolidated-decisions.md:174 L19 — "referral-incentive reporting only, never labelled \"commission\", payouts outside the system or behind a tenant flag"; :237 B13 "Reporting only, no \"commission\" label".
- spec/program/06-GLOSSARY.md:50 — the word must never appear on any system document or UI label.
- spec/chunks/C8-analytics-mis/01-PRD.md:60 IS-07 — "no rate, no amount payable, no payout"; :143 and 02-TRD.md:875,903 — no API field in C8 contains "commission" (CI grep).
- Test tools/codegen/__tests__/c8-openapi.test.ts:147-149 enforces this on contracts/openapi/analytics.yaml; test tools/codegen/__tests__/misreports1-openapi.test.ts requires code two_level_commission and columns commission_bp, commission_paisa, commission_payable_paisa in the same file. No implementation can pass both.
- spec/program/12-REFERENCE-SOFTWARE-GAP.md:94,127 already lists this as open: "Confirm that B13 still holds, given the current software pays commission."

Proposed change (exact): the founder/client decides ONE of:
(A) B13 holds: amend the brief and misreports1 test — drop the per-party rate and payable amount from the two level report and the TDS report (volume and net billed per parent/sub party only, as IS-07), use neutral names (e.g. code two_level_referral, no *_bp / *_payable columns), and drop or defer the TDS report; c8-openapi.test.ts:147 unchanged.
(B) B13 is replaced: add an addendum to 08-CR-REGISTER that supersedes 04 L19 / B13 / GLOSSARY "Commission" / C8 PRD IS-07 and :143 for named report codes, stating the allowed word, that rates and payable amounts may be shown (report only, no money moves), the tenant flag that gates them (referral_incentive_report or a new one) and the permission (analytics.referral_report.read, privileged, IC 03:3194); then c8-openapi.test.ts:147 and the c8-no-commission CI grep are narrowed by that addendum.
Backward compatible? (A) yes. (B) yes for the API (additive), but C8 copy rule and CI job c8-no-commission (CR-C8-015) change.
Tenant/security impact: no RLS change; (B) exposes per-referrer money (rate, payable, TDS) — must stay behind the privileged permission and tenant flag (D-44, 08-CR-REGISTER.md:2385; REQ-SEC-096).
IRD/regulatory impact: 04 L19 (NMC referral-commission prohibition, NHPC codes, TDS on referral payouts — UNVERIFIED). Needs the founder/client legal position; LD-310 blanket authority excludes money decisions.
Alternatives considered: rename words only (incentive_bp, incentive_payable_paisa) — rejected: still violates IS-07 "no rate, no amount payable" and only evades the grep.
Tests that will prove it: c8-openapi.test.ts and misreports1-openapi.test.ts both green against the same analytics.yaml after the chosen option; c8-no-commission CI job green.
