Title: CR-C6-029: LabPort reads for the offline print marker (reporting must stop importing lab code and querying lab.results)
From chunk: C6            To owner: C0-0C (implementing chunk C5 lab must agree)
Type: port
Blocking? no — the code works today; this CR removes a 02-CONVENTIONS §1.3 violation (REQ-ARCH-076) and a cross-schema query (04-CHANGE-REQUESTS §1).
Status: DRAFT, not filed. CR number is the next free one found by grep (highest seen: CR-C6-028); owner to confirm. File name is not an orchestra task id.

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
T0B-SYNC-4 done_when (3): the offline print marker is stored pending with the results the report version shows, and settles when every result is final on the server.
`services/api/src/modules/reporting/sync/printMarker.adapter.ts` does two things no port covers:
  1. line 11 imports `readResultState` from `../../lab/sync/resultEnter.adapter.js` as its default `readResult` seam (status, version, specimen status of one result, under the lab centre scope).
  2. `reportResults` (lines 17-24) runs `SELECT id FROM lab.results WHERE ... order_item_id = ANY(...) AND is_reportable AND status <> 'cancelled'` from the reporting module.
`contracts/ports/LabPort.ts` has `getOrderResults(orderId, scope)` but nothing keyed by result id or order item ids that returns status and version. Item 1 is frozen in `tools/lint/tests/tree-cross-module.baseline.json`.

Proposed change (exact): add to `contracts/ports/LabPort.ts` (names and shapes are a PROPOSAL for the owner to fix):

  /** Current state of results, filtered by the SAME centre scope as the online lab service (REQ-SEC-017). A result that is unknown,
   *  of another tenant, or out of the caller's scope is omitted (indistinguishable). */
  getResultStates(ctx: RequestContext, input: { resultIds: readonly Uuidv7[] /* 1..2000 */ }): Promise<readonly {
    resultId: Uuidv7; status: Code; version: number; specimenStatus?: Code;
  }[]>;

  /** Ids of reportable, not cancelled results of the given order items, ordered by id, at most 2000. */
  listReportableResultIds(ctx: RequestContext, input: { orderItemIds: readonly Uuidv7[] }): Promise<readonly Uuidv7[]>;

Implementation in C5: `getResultStates` wraps the existing `readResultState` query; `listReportableResultIds` is the query now in reporting, moved unchanged.
Reporting then builds its default seams from `ctx.ports.LabPort`. The `ReadResult` type in `core/sync/offlineSignoffs.ts` is unchanged.

Open point found on 2026-11-25 while trying to implement (owner decision needed before this CR can land):
  Offline sync adapters run inside core operations, so `ctx.ports` is `portsFor('core')` (services/api/src/core/pipeline/index.ts:117).
  `core` is not in PORT_CONSUMERS for LabPort (contracts/ports/generated/port-consumers.ts, generated from 03-IC §4.x), so a read of
  `ctx.ports.LabPort` throws common.internal in dev/ci and logs port_consumer_not_listed in production (core/ports/registry.ts:101-107).
  Either the sync engine must hand each adapter the port view of the adapter's own module (reporting is a listed LabPort consumer), or 03-IC must
  list core as a consumer. Not implemented; the direct import stays in the baseline until this is decided.

Update 2026-11-25 (working tree, uncommitted): the IMPORT is removed without a contract change, by alternative (a): `core/sync/index.ts` builds the
  default adapter with `createReportPrintMarkerAdapter({ readResult: readResultState })`; `printMarker.adapter.ts` has no lab import and its
  module-level default fails closed (common.service_unavailable) if a result state is needed without an injected reader.
  STILL OPEN for this CR: the `lab.results` query in `reportResults` (reporting reads the lab schema) — needs `listReportableResultIds` and the
  consumer decision above.

Backward compatible? yes — additive methods; `createReportPrintMarkerAdapter(deps)` keeps its injectable seams, so existing tests that inject `readResult` / `resultsOfReport` do not change.
Tenant/security impact: no RLS change, no new PHI field, no new public surface. Centre-scope filtering moves behind the lab port, so it cannot drift from the lab service (REQ-SEC-017). Reporting stops reading the `lab` schema.
IRD/regulatory impact: n/a.
Alternatives considered:
  (a) Inject lab's `readResultState` at the composition root `services/api/src/core/sync/index.ts` — removes the import without a contract change, but leaves the `lab.results` query in reporting and breaks tests that use the exported `reportPrintMarkerAdapter` with default seams.
  (b) A published read view `lab.v_pub_*` — 01-CHUNK-MAP §4 reserves those for reporting-style reads by C8/C13/C16, and it would not carry the centre-scope rule.
  (c) Reuse `getOrderResults` — keyed by order, not by report version items; returns more PHI than the marker needs.
Tests that will prove it:
  - Port contract tests: out-of-scope and other-tenant result ids are omitted; cancelled and non-reportable results are not listed.
  - Existing `core/sync/__tests__/adapters/printMarker.live.test.ts` and `resultVerify.live.test.ts` stay green.
  - `tools/lint/tests/tree-cross-module.test.mjs`: the reporting → lab entry leaves the baseline; `no-foreign-schema-sql` shows no `lab.` in reporting.
