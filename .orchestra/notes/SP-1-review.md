CHANGES
1. tests/spikes/SP-1.decision.test.mjs:1 — stale copy still tracked at unowned root `tests/` (spec/program/01-CHUNK-MAP.md:16; arbiter ruling step 1 said `git mv`, commit cc22dad added a copy instead). Fix (tester): `git rm tests/spikes/SP-1.decision.test.mjs`; keep only `db/tests/spikes/SP-1.decision.test.mjs`.

Checked OK: `node --test db/tests/spikes/SP-1.decision.test.mjs` → pass 8, fail 0. Record db/meta/decisions/SP-1.md covers done_when (session_id+aal present, aal1/aal2; `LIMS_CORE_JWT_ALG` = `ES256`; session_id stable across refresh); pinned digest; no JWT/key material; no secrets/PHI. RLS/permissions/idempotency/rate tier/error codes: N/A (decision-record spike, no DB/API surface).
Not a defect for this task (planner): `db/` is C0-0B ONLY (01-CHUNK-MAP.md:107), and `meta/decisions/` is not in its listed meta files; lane C0-0A assignment needs confirmation. SP-2/3/5/8 tests also still at root `tests/spikes/`.
