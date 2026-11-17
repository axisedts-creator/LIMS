APPROVE

Re-review of `git diff 633df067..HEAD` after the review-fix commits (1134fb3a tests, 385fce36 writer).
I checked all 3 prior findings and each one is resolved:
1. The invented sub-codes are gone. Duplicate key (`/code` | `/display_name`) and immutable `/centre_id` now use `common.field_invalid`, which is in the registry (03 §8:2473). The other sub-codes used (`common.field_required`, `common.unknown_field`) are in the registry too.
2. Both list SELECTs now use `LIMIT 200`, matching the contract's `maxItems: 200`. A new test asserts the cap.
3. On create, 42501/23503 now map to `400 common.validation_failed` on `/centre_id`. Update keeps `common.not_found`, which `updateQueue`/`updateCounter` declare in x-error-codes (engagement.yaml:5009, 5276). The tests now expect forbidden|validation_failed only.
Ran `.orchestra/notes/T-Q1-verify.cmd`: 107/107 pass. Not exercised: real-Postgres RLS (the tests use a fake tx), and lint.
Open (not a defect, spec is silent): `board_version` is not bumped on PUT. Track it under T-Q2/T-Q5.
