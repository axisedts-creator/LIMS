APPROVE

Re-review (round 2) of `git diff 4246a23a..HEAD`, focused on the fixes in 84d03968d and 5bf159f86 for the round-1 CHANGES. Runs: finctrl1 391/391, fd-t13 70/70, rs-c2 74/74, all green.

Round-1 items:
1. Limit/authority id keying: CR filed at .orchestra/cr/T0D-FINCTRL-1.md (item 1, options A/B, A recommended). The limits and authorities pages pass `idPending` (catalogue key billing.discounts.reason.user_id_pending), so Add New (both screens) and Edit (limits) are disabled and the reason is shown. Deactivate still works because it uses the API row ids. Resolved pending the CR ruling.
2. Invented cash figures: daily-cash/page.tsx passes `null` when the read is refused. DailyCollectionScreen shows "—" plus billing.daily_summary.sessions_unavailable. The `sessions = []` default still applies only to undefined. A new test pins the null case. Resolved.
3. Ledger statement fiscal year filter: CR item 2 filed and listed as open in T0D-FINCTRL-1-impl.md. Resolved as deferred.

Non-blocking follow-ups for the tester after the CR ruling:
- No test pins the idPending disabled state and its reason text.
- No test yet checks that the screens send the id the API is keyed on.
