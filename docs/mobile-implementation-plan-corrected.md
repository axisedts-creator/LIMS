# Mobile implementation plan (corrected)

Corrects `final_microservices_mobile_implementation_plan.md` v2.0.0 against this repository
(`C:\LIMS`, branch `ui/redesign`, checked 2026-11-25). The original was verified against a
different checkout (`c:\LIMS-mhn`); several of its names and premises do not hold here.

Rule for every step: names come from `spec/`. Anything missing is a CR
(`spec/program/04-CHANGE-REQUESTS.md`), not an invention.

## What changed from v2.0.0

| v2.0.0 claim | Finding in this repo | Action |
|---|---|---|
| Deploy a renderer container with CPU/RAM limits | Already in `infra/compose/lims/compose.app.yml` (`render_net`, `mem_limit: 1536m`, `cpus: 2`, `pids_limit: 512`) | Dropped |
| Env `RENDERER_PORT`, `RENDERER_SHARED_TOKEN`, `LIMS_RENDERER_URL`, `LIMS_RENDERER_TOKEN` | Do not exist. Real: `LIMS_REPORTING_RENDERER_URL`, `LIMS_REPORTING_RENDERER_TOKEN_FILE` (worker), `LIMS_RENDERER_TOKEN_FILE` (renderer). Secrets are files, never env values (C1 AC-19.1) | Fixed in step 1 |
| Wiring the renderer client finishes rendering | `unwiredSandbox` and `unwiredAssembler` are stubs on the same tasks | Step 1 covers all three |
| Phlebo sync freezes on a bad mutation; add quarantine | Server already answers per mutation (`applied`, `duplicate`, `held`, `rejected`); client applies them. Batch-level 4xx is `SyncStatus.blocked` and covers 426/409 | Step 3: reproduce first |
| `held_by_dependency`, `SyncStatus.quarantined`, `quarantineBatchWithCausalHold` | Do not exist; `held` is already a server outcome | Dropped |
| New `services/mobile-bff`, `'mobile'` in `BFF_KINDS` | No such service. `BFF_KINDS` is `staff_web`, `partner`, `portal`. Patient app already calls `/v1/engagement/me/...` directly | Step 4: deferred, needs CR |
| `app.resolve_session_row`, patient Ed25519 JWT | Not found in this repo | Removed |
| Redis Pub/Sub for SSE, Redis idempotency | Spec allows Valkey for the rate-limit cache only and bans Redis queues (C0 02-TRD). Idempotency already lives in core | Removed |
| Khalti callback `/khalti/{callback_token}/success` | Route is `/v1/payments/callbacks/khalti/{callback_token}` | Fixed |
| Callback verifies HMAC then settles, locks slot, allocates invoice in one transaction | Callback input never changes state; `applyCheck` (gateway status lookup) does. Khalti has no HMAC. Callback does not touch `billing.fiscal_counters` | Description removed; server left as is |
| Job `billing.sync_cbms` | Name is `billing.cbms_sync` | Fixed |
| `check-gapless-invoices.sql` | Does not exist. Closest: worker billing `integrity_check` task | Gate rewritten |
| Feed in 150 ms on simulated 3G; 70% smaller payloads; 120 ms | No measurement; 150 ms is below 3G round-trip time | Removed |

## Steps

### 1. Wire the worker's render clients

Problem: `services/worker/src/jobs/reporting/index.ts` passes `unwiredRenderer`,
`unwiredSandbox` and `unwiredAssembler`, so every render fails with
`reporting.render_unavailable`.

- Renderer: build the client from `loadRendererConfig`
  (`services/api/src/modules/reporting/config.ts`) and `createRenderClient`, reading the token
  from the file. Follow `services/api/src/modules/reporting/ports/renderPort.lazy.ts`.
- Sandbox (`/internal/sanitize`) and assembler (`/internal/assemble`): wire the C6-T12 clients
  the same way (`LIMS_REPORTING_SANDBOX_TOKEN_FILE` is already in compose).
- Keep the stubs as the fallback when config is absent, so failures stay retryable and loud.
- No compose changes expected; confirm the worker already receives all three env keys.

Done when: an integration test renders one report version through the real renderer container
and stores a PDF; with config absent the task still fails with `reporting.render_unavailable`.

### 2. Patient app checkout on the existing payments module

Server side exists. Client work only, in `apps/patient_app`.

- Create the intent with `orderId`, `gateway`, `idempotencyKey`, `returnUrl`, `cancelUrl`.
- `returnUrl`/`cancelUrl` must pass `returnUrlAllowlist`. Open point: confirm whether a custom
  scheme is accepted. Prefer HTTPS app links / universal links; if the allowlist needs a new
  entry format, raise a CR.
- On return, read `intent_id` and `outcome` (`settled`, `failed`, `pending`) and then fetch the
  intent status from the API. Never trust the redirect query alone. Handle `pending` with a
  poll and a visible waiting state.
- Callback routes for reference: `/v1/payments/callbacks/esewa/{callback_token}/success`,
  `.../failure`, `/v1/payments/callbacks/khalti/{callback_token}`.

Done when: widget and integration tests cover settled, failed, pending-then-settled, user
cancel, app killed mid-payment, and a replayed return link.

### 3. Phlebo sync: reproduce before changing

- Write a test against the current engine: 500 queued mutations, 5 with invalid barcodes.
  Expected today: 495 `applied`, 5 `rejected`, queue drains.
- If it passes, close this step with the test kept as a regression guard.
- If the server answers a batch-level 400 instead, the fix belongs on the server
  (per-mutation `rejected`), not in a new client state. A new local state would also have to
  be reflected in wipe gating and `max_device_seq_acked`.

### 4. Mobile BFF: deferred

Not started until both hold:

1. A measured problem on a real device (payload size or round trips) that one aggregated
   endpoint in the existing API module cannot fix.
2. An approved CR for the new BFF kind, its key-file env, and its client-IP trust rule.

## Database changes

Unchanged from v2.0.0, with one addition from `db/tools/check-migrations.ts`: a
`CONCURRENTLY` file is non-transactional and must contain exactly `SET ROLE lims_owner;`
followed by one `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` statement. `DROP`
elsewhere requires the `cr-approved-breaking` label.

## Quality gates

1. Render: one report version rendered end to end through the renderer container in CI.
2. Renderer isolation: 50 concurrent renders do not raise API registration p95 beyond its
   current baseline (record the baseline first).
3. Sync: the 500/5 test from step 3.
4. Fiscal numbering: 100 concurrent invoice issues leave no gap or duplicate, checked by the
   billing `integrity_check` task.
5. Tenant isolation: existing RLS tests pass for every route the patient app calls.

## Progress (2026-11-25)

- Step 1 done in code: `services/worker/src/jobs/reporting/clients.ts` (lazy renderer, sanitize
  and assemble clients) replaces the three stubs in `index.ts`. Tests:
  `__tests__/clients.test.ts`. Not yet run against the real renderer / pdf-sandbox containers.
- Step 2 finding: `apps/patient_app/lib/features/payments/` already has `pay_due_screen.dart`
  and `payment_result_screen.dart`. `assertReturnUrlAllowed` accepts HTTPS only, so a
  `patient_app://` return URL is rejected with `payments.return_url_not_allowed`; app links
  are required. Remaining scope needs an audit of the existing screens, not a new build.
- Step 3 finding: a wrong or unknown barcode is answered per mutation. A mutation whose
  payload fails `validateMutationPayload` fails the whole batch in `parseEnvelope` (400), and
  the client re-sends the same frozen body, so sync stays `blocked`. The client does not
  validate payload shape per type at enqueue. Fix location is a contract decision (server
  per-mutation `rejected` vs client-side shape validation at enqueue): needs a CR.
- Step 3 resolved client-side. C17 02-TRD §6.3 step 1 makes batch-level envelope validation
  the intended server behaviour, so the server stays strict. The phlebo app now refuses a
  schema-invalid payload at enqueue (`lib/features/outbox/data/mutation_payload.dart`, a
  mirror of the server's `validateMutationPayload` plus the GPS range check). Open: a row
  already in a device's outbox from an older build is not rescued; that needs a CR.

## Progress, second pass (2026-11-25)

- Step 1 proven end to end: `services/renderer/src/__tests__/worker-clients.e2e.test.ts` runs
  the worker clients against the real renderer server (Chromium) and the real PDF sandbox
  (qpdf): render, assemble with page stamps, sanitize, bad hash, wrong token. In-process
  servers, not the compose containers. The sandbox clients refuse HTTP redirects.
- Step 2 closed without changes: the patient app payment flow already exists and never trusts
  the return link (HTTPS app link `/payments/{payment_request_id}/done`, result read from the
  API only). Its 51 tests pass.
- Step 3 gate added: `apps/phlebo_app/__tests__/sync_engine_bulk_test.dart` (500 queued, 5
  rejected by the server: 495 applied, queue drains in one cycle).
- Validator drift guard: `packages/test-fixtures/homecollection/mutation-payload-cases.json`
  (100 cases, from `generate.py`) is run by both the server validator and the Dart mirror.
- `db_ci_guards_test.dart` fixed for CRLF checkouts (comment stripping split on `\r?\n`).
- Gapless numbering and tenant isolation already have suites: `counter.concurrency.test.ts`,
  `counter.live.test.ts` and the generated probes under `db/tests/isolation`.
  Rerun with the standard setup (pinned image 17.6.1.136, seeds, generated probes):
  - Live counter test: 7 of 7 pass. Gapless numbering gate is green.
  - Isolation, 104 suites for billing, engagement, homecollection, payments: 88 pass, 16 fail
    (33 assertions). No failure is a cross-tenant read. Kinds:
    - 21 writes refused with `P0001` (trigger) or `23514` (check) where the probe expects
      `42501` / `23503`. The write is blocked either way.
    - 6 "patient claims read 0 rows" on engagement `settings`, `number_counters`,
      `portal_content` and three `cs_*` tables: the policies grant patients SELECT on
      own-tenant rows, the probe registry says these tables are not shared. One of the two
      is wrong; needs an owner decision.
    - 5 fixture rows of `engagement.booking_centres` not seeded by the probe.
    - 1 `homecollection.mutations__batch__fk`: the FK is `DEFERRABLE INITIALLY DEFERRED`, so
      the probe's statement-time check cannot see the refusal. Not verified at commit time.
  No SQL, migration, policy or probe was changed in this work.
- Step 4 (mobile BFF) stays deferred: needs a measured problem and an approved CR.
- Not done: the 50-concurrent-render latency gate (needs a running API and a recorded
  baseline), a run inside the compose containers, a device run of `integration_test/`.

## Progress, third pass (2026-11-25)

- Change requests filed in `.orchestra/cr/MOBILE-GATES-1.nonblocking.md`: (a) ANY_T tables in
  the isolation probes, (b) probes that never reach RLS behind insert guards / CHECKs,
  (c) `booking_centres` probe fixture, (d) deferred FK probe, (e) stuck device outbox rows,
  (f) renderer image not buildable. `db/` is centrally owned, so none of (a)-(d) was edited.
- Load gate: 50 simultaneous renders through the worker client on a 2-context pool: 50 ok,
  0 refused, 14.6 s, renderer healthy afterwards (`worker-clients.e2e.test.ts`). The effect
  on API latency was NOT measured (no running API with a baseline).
- Container run: `Dockerfile.renderer` does not build. `corepack enable` fixed; the next
  failure (TS2307 on `packages/shared-ts/src/bsdate`) and three more image gaps are in CR (f).
  The renderer process entry now loads the template registry (`startFromEnv`); before, every
  report template would have been an unknown template in the container.
- Mobile BFF: no CR filed. A CR needs a problem statement and none has been measured.

## Not verified

- Server behaviour for an invalid barcode in `/sync/mutations` (per-mutation vs batch error).
- Whether `returnUrlAllowlist` accepts non-HTTPS schemes.
- SSE/WebSocket use in the API, internal mTLS, the "21 schemas" count.
- Anything in `c:\LIMS-mhn`.
