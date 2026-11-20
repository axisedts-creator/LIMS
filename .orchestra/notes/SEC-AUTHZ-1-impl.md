# SEC-AUTHZ-1 impl (writer)
Files: `tests/security/classify-authz.mjs`, `tests/security/authz-classification.json` (= its stdout), `.orchestra/cr/SEC-AUTHZ-1.1.nonblocking.md`. Nothing else changed.
Counts (1018): guarded-exact 604, guarded-other 55, unguarded 211, stub 38, inconclusive 30 (each with a reason), platform 34, public 13, session-flow 6, callback-token 6, device 9, portal 9, patient-pre-auth 3.
[CONV] class by contract first (platform.*, the 6 LD-235 session ops, security scheme, x-public), then static handler -> same-module call walk (depth 6) for `assertRole`; a known permission code found in the reachable code counts as asserted (upper bound for guarded-other, can overstate guarded-exact).
[CONV] verifier A's per-operation list is outside the repo, so the CR reconciles by totals and states the differences (platform/scheme carve-out, unguarded merged, inconclusive 97 -> 30, stub 33 -> 38).
[CONV] 02-TRD "7.2" is C2 02-TRD 7.2 (assertRole); C0 02-TRD 7.2 is the worker manifest. The CR quotes C2 7.2 and says so.
Tests: `node --test tests/security/authz-classification.test.mjs` = 19 pass, 0 fail. No lint/typecheck run (plain .mjs outside any package).
Open: classifier exports `loadModule/findHandler/walk` for debugging; the 30 inconclusive and 55 guarded-other need a human read before SEC-GATE-2; services/ calls via ctx.services are not followed.
