# 05 — Definition of Done (gates every agent must pass)

There are three levels: **PR**, **chunk**, and **integration**. A chunk is not done because its own tests pass. It is done when its integration gate passes against the real implementations of its dependencies.

## 1. PR gate (CI enforces; a PR cannot merge without all of these)

1. **Path ownership:** the PR touches only paths owned by the author chunk (`01-CHUNK-MAP.md` §3). Exception: a CR PR to C0, which must reference the CR id.
2. **Builds and types:** TypeScript strict typecheck; `dart analyze` with no errors; `go vet`; lint clean.
3. **Tests pass:** unit + integration tests of the touched package(s).
4. **Contract checks:**
   - generated clients are up to date (codegen produces no diff);
   - `oasdiff` shows no breaking change without a version bump;
   - every endpoint handler matches its OpenAPI operation (request/response validation tests);
   - event payloads validate against `contracts/events/*.schema.json`.
5. **Tenant isolation:**
   - every new or changed endpoint has a cross-tenant probe test: tenant B's credentials can neither read nor mutate tenant A's resource, and the expected response is the documented not-found/forbidden code from `contracts/errors.yaml`;
   - every new table has an RLS probe in `db/tests` (a C0 PR).
6. **Security scans:** secret scan clean (gitleaks or equivalent; REQ-SEC per 02 §7); dependency audit has no known-critical vulnerabilities; no banned dependency (`02-CONVENTIONS.md`).
7. **Migrations (C0 PRs only):**
   - forward-only;
   - linted (tool per 04 S13 — BLOCKED B10; until decided, a manual review checklist is used);
   - applied on a fresh DB and on a DB holding the previous release's seed.
8. **No PHI in fixtures/logs:** fixtures come from `packages/test-fixtures` (synthetic); a log-scan test asserts that no fields from the PHI list in `02-CONVENTIONS.md` appear in log output.
9. **Docs:** the owning chunk's affected document(s) are updated in the same PR when behaviour, schema or API changed. User-manual pages are updated for UI changes.

## 2. Task gate (each task in a chunk's `06-IMPLEMENTATION-PLAN.md`)

A task is done when its "done-when" criteria and listed tests pass, **and** the acceptance criteria it maps to in `01-PRD.md` are demonstrably met. That means an automated test for each Given/When/Then, or a recorded manual check where automation is impossible (for example, real analyser hardware).

## 3. Chunk gate

1. All tasks done; every PRD user story is either accepted or explicitly deferred with a CR or blocker reference.
2. Every port the chunk *implements* passes the shared contract suite in `packages/fakes/contract-tests/`, the same suite the fake passes.
3. Every event the chunk *produces* is emitted on exactly the trigger defined in `03-INTERFACE-CATALOG.md`, verified by tests.
4. Every event the chunk *consumes* is handled idempotently: a duplicate `event_id` is a no-op, which a test proves.
5. Performance targets in the chunk's TRD are met on the reference dataset (04 §14 capacity assumptions; seed generator at 1× and 10× lab volume).
6. Security doc (`07-SECURITY.md`) checklist is complete, with every listed test present and passing.
7. Observability: logs, metrics and alerts listed in the TRD exist; the dashboards/alerts are registered with C1.
8. User-manual pages and in-app help exist for every screen (IRD Procedure 2074 cl.6(ढ) — 04 L26 — is mandatory for billing; required for all modules by program rule).
9. **Every addendum is recorded as applied or not applicable (08 A25 P-60).** Each chunk's 02-TRD change-history table has one row per 08 Addendum (A1 onward). The row is either 'applied <date> — <P-/D-/A-items that touch this chunk, with the files changed>' or 'not applicable'. A chunk whose table stops before the latest addendum is not 'done'. The final sweep checks this by script (every chunk × every addendum id).

## 4. Security sign-off (required for chunk gate and for security-relevant CRs)

The reviewer — an agent that did not write the code, or the founder — confirms:
- every applicable REQ-SEC ID in the chunk's `07-SECURITY.md` has an implementation location and a test;
- no new foreign touchpoint exists outside 04 §11 (or it has founder approval);
- no endpoint or job uses a BYPASSRLS role (04 D5);
- no SECURITY DEFINER function exists outside the C0 inventory (04 D7);
- tokens, OTPs and rate limits match 04 §3 and §4 exactly.

## 5. Integration gate (per wave)

1. Fakes are switched off for every dependency whose owner has passed its chunk gate.
2. End-to-end scenarios from the chunk App Flow documents run on staging. At minimum these are walk-in registration → bill → collect → analyser result → verify → approve → release → WhatsApp link → OTP → download → QR verify; rejection/recollection; amendment; cancelled invoice/credit note; cross-tenant attempt at each step.
3. Restore drill on staging (04 I3) passes before a wave is declared production-ready.
4. IRD-specific checks (C4) pass against the latest IRD requirements actually obtained (B6). Until IRD documents are received, the billing module is marked **not certifiable**. It is not presented as IRD-approved.
