Title: CR-C16-xxx: E12 deleteMyAccount cannot revoke suspended links (or deactivate their addresses) as the patient actor
From chunk: C16            To owner: C16 (05-SCHEMA §4 guard + RLS policy table) / lead ruling
Type: schema
Blocking? yes — T-AC1 (06-IMPLEMENTATION-PLAN row T-AC1, "deletion effects per TRD 4.14") for any account that has a `suspended` link; test "BLOCKED (CR T-AC1): an account with a suspended link is deleted completely" is `it.skip`.
Problem (US-EN-19.1/19.2, TRD §4.14: on deletion all links are revoked and addresses deactivated):
  1. `links__suspend__ck` forces `suspend_reason`/`suspended_at` NULL once a suspended link becomes `revoked`, but `guard_patient_link_update` (05-SCHEMA §4, l.1287) does not let a patient actor change those columns -> P0001 `immutable_row` -> E12 returns `common.internal` (500).
  2. addresses UPDATE for patients is `PAT_ACC_PID` (05-SCHEMA policy table l.1336) and `app.engagement_patient_ids()` returns only `status='active'` links (l.1506-1510), so addresses of a patient whose link is `suspended` cannot be deactivated by the patient actor (UPDATE matches 0 rows silently).
Proposed change (exact), pick one:
  (a) In `guard_patient_link_update`, add `suspend_reason`, `suspended_at` to `v_allowed` only when `NEW.status = 'revoked'` (and OLD.status = 'suspended'); widen addresses patient UPDATE policy to `PAT_ACC` (account_id = app.engagement_account_id()) for the `is_active true -> false` transition only.
  (b) Run the E12 link + address writes under the engagement system actor (same pattern as C2 session revoke, 08 A28.2); no guard/RLS change.
Backward compatible? yes for both (a: widens patient permission narrowly; b: no schema change).
Tenant/security impact: (a) RLS change on `addresses` (patient may only deactivate own-account rows; no PHI field added) — REQ-SEC-024/096/097. (b) system actor used inside a patient request; must be scoped to `account_id = caller's account` in code.
IRD/regulatory impact: none (no billing change).
Alternatives considered: leaving suspended links untouched on delete (violates TRD §4.14); clearing suspend_* via a separate staff path (no staff actor present in E12).
Tests that will prove it: unskip the BLOCKED test in `services/api/src/modules/engagement/service/__tests__/account.handlers.test.ts`; world `account.world.ts` emulates the ruled guard/policy; DB RLS test that a patient can deactivate own-account addresses of a suspended-link patient (option a) and cannot touch another account's rows.
