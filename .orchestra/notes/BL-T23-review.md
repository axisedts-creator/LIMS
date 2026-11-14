APPROVE

Re-review after 9a2d69b3. Last open item fixed: credit_party.md no longer lists `Ctrl+Enter` for the Terms tab, and the Terms line now says terms are changed elsewhere (matches CreditPartyDetail.tsx:2, read views). Remaining Ctrl+Enter lines (invoice, daily_cash, cash-shift, settings, worklist) were checked against code in the previous pass and are unchanged. Reviewer re-ran: bl-t23 vitest 25/25 pass; copy-scan "54 files clean". Scope (owned help/manual paths + notes/tests only), IRD wording neutral, no PHI/secrets, no invented names.
