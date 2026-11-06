# 04 — Change Requests (how a chunk asks for a change to something it doesn't own)

Applies to everything centrally owned by C0: `db/`, `contracts/`, `packages/*`, every `core/` folder. It also covers any request from one chunk to another chunk's port or event behaviour.

## 1. When a CR is required

| You need… | CR? |
|---|---|
| A new table, column, index, constraint, view, RLS policy, enum or coded-set value in the DDL | **Yes** (to C0-0B) |
| A new or changed endpoint, request/response field, or error code | **Yes** (to C0-0C) |
| A new event, or a change to an event payload | **Yes** (to C0-0C; producer chunk must agree) |
| A new port method, or a change to a port signature or semantics | **Yes** (to C0-0C; implementing chunk must agree) |
| A new shared UI component or design token | **Yes** (to C0-0D) |
| A change to a shared lib (`shared-ts`, `shared-dart`) | **Yes** (to C0-0A) |
| A bug in another chunk's implementation of a port | **Yes** (to that chunk; label `bug`) |
| Anything inside your own owned paths | No |
| A test-only helper inside your own paths | No |

**Never** work around a missing contract by:
- writing SQL against another schema;
- adding an undeclared HTTP field;
- copying a shared component and modifying the copy.

## 2. CR template (file as an issue, labels `cr` + `to:<chunk>` + `from:<chunk>`)

```
Title: CR-<from>-<nnn>: <one line>
From chunk: Cxx            To owner: C0-0B | C0-0C | C0-0D | C0-0A | Cyy
Type: schema | api | event | port | ui-kit | shared-lib | bug
Blocking? yes/no  (if yes: what task in your 06-IMPLEMENTATION-PLAN is blocked)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
Proposed change (exact): DDL / OpenAPI diff / JSON Schema diff / TS signature diff
Backward compatible? yes/no — if no: who breaks (list chunks) and migration plan
Tenant/security impact: RLS change? new PHI field? new public surface? (cite REQ-SEC IDs)
IRD/regulatory impact (billing changes only): cite 04 L-rows
Alternatives considered:
Tests that will prove it:
```

## 3. Handling rules

1. **Classification by owner.**
   - *Additive, backward-compatible* changes: a nullable column, a new optional field, a new endpoint, a new event version. The owner may approve these alone.
   - *Breaking* changes: rename, removal, type change, semantics change. These need sign-off from every consuming chunk listed in `01-CHUNK-MAP.md` §5.1 / §6 and the doc owner (founder).
2. **Breaking contract changes ship as a new version.** For example, `.v2` events or `/v2` endpoints. The old version keeps working until every consumer has migrated. `oasdiff` in CI blocks unflagged breaking OpenAPI changes (04 S19/T7).
3. **Turnaround target (process decision, adjustable by the founder):**
   - Blocking CRs: triage within one working day.
   - Non-blocking CRs: batched daily.
4. **The requester keeps working against the fake.** When a CR is merged, C0 regenerates the clients/fakes and posts the merge in the CR thread. The requester then switches.
5. **Documents follow code.** When a CR changes a chunk's schema or API, the owning chunk's `05-SCHEMA.md` / `02-TRD.md` and this log are updated in the same PR. A PR that changes `db/` or `contracts/` without a CR reference fails CI (PR-template check). Program-level arbitration of batches of CRs is recorded in `08-CR-REGISTER.md`; its §2 decisions are binding until applied.
6. **Security-relevant CRs** (new public endpoint, new PHI field, RLS change, new foreign touchpoint) also need the security checklist sign-off in `05-DEFINITION-OF-DONE.md` §4. New foreign touchpoints additionally need founder approval (04 §11, B11).

## 4. CR log

| CR | From → To | Type | Summary | Status | Merged in |
|---|---|---|---|---|---|
| CR-C0-001 … CR-C18-010 (220) | all | all | Arbitrated 2026-11-06 | see `08-CR-REGISTER.md` §3 | apply phase |
