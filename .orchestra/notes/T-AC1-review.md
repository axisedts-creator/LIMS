APPROVE
# T-AC1 re-review (reviewer) — diff b33d193d..a27cfae1

Round-1 items checked:
1. Fixed. `account.service.ts:73-75`: the order is now payments, then addresses, then links. The world emulates PAT_ACC_PID for addresses UPDATE (`account.world.ts:93,103`). New test "addresses BEFORE links" checks the statement order and that AD_1/AD_2 end up inactive.
2. Handled as the round-1 review asked. `.orchestra/cr/T-AC1.md` follows the template and gives options (a) and (b). The world tolerance for suspend_* is removed (`account.world.ts:111-112`). The suspended-link test is `it.skip` and marked BLOCKED by the CR. Default seed L_ACTIVE2 is now active.

Still valid from round 1: names, permissions, idempotency, `no-store`, audit with no PHI, owned paths only, no secrets.
Ran: `npx vitest run .../account.handlers.test.ts`: 39 passed, 1 skipped (the CR-blocked test).
Open (not a T-AC1 defect, waits on the lead's ruling): E12 still returns 500 for an account with a suspended link until the CR is ruled. After the ruling, unskip the test.
