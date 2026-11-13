# 03 — Interface Catalog (events, ports, published views, routes, error codes, vocabulary, state machines)

Status: DECISION, 2026-11-05 (rev. 2: lead accepted additions A1–A8 and resolutions X1–X12, with X11 changed to single-input-object signatures). Owner of the files this describes: **C0** (`contracts/**`, `db/**` views). This document is the human-readable source C0 transcribes into `contracts/events/*.schema.json`, `contracts/ports/*.ts`, `contracts/errors.yaml`, `contracts/routes.yaml` and the `v_pub_*` DDL.
Precedence: 00 → 04 → `01-CHUNK-MAP.md` §5.1 (names fixed) → this file → chunk docs. Rules (casing, envelope semantics, outbox, idempotency, RLS) are in `02-CONVENTIONS.md` (02-CV); this file gives the shapes.

Names in 01 §5.1 are used **verbatim**; nothing is renamed. Interfaces added after the first draft were accepted by the lead on 2026-11-05 and are folded into the main sections; §5 logs each addition (A1–A8) and each binding resolution (X1–X12). (The additions were drafted as "P1–P8"; they are renamed A1–A8 here only to avoid confusion with the PHI classes P0–P3.)

## 1. Conventions used in this file

| Item | Rule |
|---|---|
| Example data | Synthetic only (00 §7.5). Example ids use the visibly synthetic UUIDv7 family `01a1a98a-ac40-7000-8000-…` (tenant A `…a001`, tenant B `…b001`). Human numbers in examples follow the *shape* of Metro Labs formats observed in 00 §4 but are invented values. |
| PHI class (per event/port field set) | **P0** no personal data · **P1** pseudonymous ids only (UUIDs) · **P2** lab-linked identifiers or personal data (barcode, registration no, name, phone) · **P3** health data (ordered tests or results linked to a person/order, even pseudonymously). Events are P1 unless justified. |
| Ordering | All events: **at-least-once, unordered** delivery (02-CV §7.4). Where order matters the payload carries the full new state and `aggregate.seq`. |
| Retention (events) | `core.event_log` copy 90 days [CONV, 02-CV §5.11]; the domain records the event describes follow 04 I8 (reports 5 y, audit ≥5 y, raw analyser ≥1 y; legal periods BLOCKED B15). |
| `[CONV]` | Program convention (lead-architect choice; change by CR). |
| BLOCKED Bn / UNVERIFIED | As in 04. |

---

## 2. Event envelope

### 2.1 `contracts/events/_defs.v1.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:lims:event:_defs.v1",
  "$defs": {
    "Uuid":   { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    "Uuidv7": { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    "IsoUtc": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" },
    "Code":   { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[A-Za-z0-9_.:^+\\-]+$" },
    "Paisa":  { "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 },
    "Money":  { "type": "object", "additionalProperties": false, "required": ["amount_paisa", "currency"],
                "properties": { "amount_paisa": { "$ref": "#/$defs/Paisa" }, "currency": { "const": "NPR" } } },
    "ActorType": { "enum": ["user", "system", "device", "portal", "patient", "partner"] },
    "Actor": { "type": "object", "additionalProperties": false, "required": ["type", "id"],
               "properties": { "type": { "$ref": "#/$defs/ActorType" }, "id": { "$ref": "#/$defs/Uuid" },
                               "membership_id": { "$ref": "#/$defs/Uuidv7" },
                               "support_session_id": { "$ref": "#/$defs/Uuidv7" } } },
    "Priority": { "enum": ["routine", "urgent"] },
    "DecimalString": { "type": "string", "pattern": "^-?[0-9]{1,12}(\\.[0-9]{1,6})?$" },
    "SpecimenStatus": { "enum": ["ordered", "collected", "in_transit", "received", "aliquoted", "in_process",
                                 "resulted", "verified", "approved", "reported", "rejected",
                                 "recollection_ordered", "stored", "discarded"] },
    "ResultStatus": { "enum": ["pending", "resulted", "verified", "approved", "cancelled"] }
  }
}
```

Notes: `Uuid` accepts any RFC 9562 version (GoTrue user ids are not guaranteed to be v7); every id this system generates is `Uuidv7` (04 D9). Result values travel as `DecimalString` (no floats, preserves reported decimals) [CONV].

### 2.2 `contracts/events/_envelope.v1.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:lims:event:_envelope.v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["event_id", "event_type", "tenant_id", "occurred_at", "actor", "idempotency_key",
               "producer", "aggregate", "request_id", "payload"],
  "properties": {
    "event_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "event_type":      { "type": "string", "pattern": "^[a-z_]+\\.[a-z_]+\\.[a-z_]+\\.v[0-9]+$|^catalog\\.changed\\.v[0-9]+$" },
    "tenant_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "occurred_at":     { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "actor":           { "$ref": "urn:lims:event:_defs.v1#/$defs/Actor" },
    "idempotency_key": { "type": "string", "minLength": 1, "maxLength": 200 },
    "producer":        { "enum": ["frontdesk", "billing", "lab", "instruments", "reporting", "catalog",
                                  "payments", "quality", "engagement", "homecollection"] },
    "aggregate": { "type": "object", "additionalProperties": false, "required": ["type", "id", "seq"],
                   "properties": { "type": { "type": "string", "maxLength": 40 },
                                   "id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
                                   "seq":  { "type": "integer", "minimum": 1 } } },
    "request_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "causation_event_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "payload":            { "type": "object" }
  }
}
```

01 §5 R4 mandates `event_id`, `tenant_id`, `occurred_at`, `actor`, `idempotency_key`; the other envelope fields are [CONV] (02-CV §7.1). `catalog.changed.v1` has only two name segments before the version (name fixed by 01), hence the second alternative in the `event_type` pattern.

Every event schema file is (template; `<…>` and `[...]` are placeholders):

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:lims:event:<event_type>",
  "allOf": [
    { "$ref": "urn:lims:event:_envelope.v1" },
    { "properties": { "event_type": { "const": "<event_type>" }, "producer": { "const": "<module>" },
                      "aggregate": { "properties": { "type": { "const": "<aggregate type>" } } },
                      "payload": { "$ref": "#/$defs/Payload" } } }
  ],
  "$defs": { "Payload": { "type": "object", "additionalProperties": false, "required": [...], "properties": {...} } }
}
```

Below, §3 gives for every event the header table and the `Payload` definition (C0 wraps it in the frame above), plus one full example.

---

## 3. Events (23 from 01 §5.1 + 1 accepted addition, A5 + 1 from the CR register, §3.26)

### 3.1 `frontdesk.order.created.v1`

| Field | Value |
|---|---|
| Producer | C4 (`frontdesk`) |
| Consumers | C5 (create specimens + results skeleton), C6 (prepare report shell), C8 (counters), C17 (home-collection orders) |
| Trigger (exact) | Commit of the transaction in which an order **first** enters status `registered` — either created directly at the front desk, or a `pre_registered` order (from a booking/partner manifest/home visit) being confirmed. Not emitted for `pre_registered` orders. Emitted once per order. |
| Aggregate | `order`, seq = `frontdesk.orders.version` after commit |
| Idempotency key | `<order_id>:created` |
| Ordering | Always precedes `items_changed`/`cancelled` logically; consumers receiving `items_changed` for an unknown order fetch via `FrontdeskPort.getOrderSummary` (do not fail). |
| PHI class | **P3** (pseudonymous: orderable ids linked to patient_id). No name, phone, registration no. |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["order_id", "patient_id", "branch_id", "centre_id", "visit_type", "billing_mode", "priority",
               "collection_mode", "source", "registered_at", "items"],
  "properties": {
    "order_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "patient_id":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "branch_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "visit_type":      { "enum": ["opd", "ipd"] },
    "billing_mode":    { "enum": ["cash", "credit"] },
    "credit_party_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "referrer_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "priority":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Priority" },
    "collection_mode": { "enum": ["walk_in", "home", "centre", "partner"] },
    "source":          { "enum": ["front_desk", "engagement_booking", "home_collection", "partner_manifest"] },
    "source_ref_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "registered_at":   { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "items": { "type": "array", "minItems": 1, "maxItems": 200, "items": { "$ref": "#/$defs/Item" } }
  }
},
"Item": {
  "type": "object", "additionalProperties": false,
  "required": ["order_item_id", "orderable_id", "orderable_kind", "test_ids", "priority"],
  "properties": {
    "order_item_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "orderable_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "orderable_kind": { "enum": ["test", "panel"] },
    "test_ids": { "type": "array", "minItems": 1, "maxItems": 200,
                  "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } },
    "priority": { "$ref": "urn:lims:event:_defs.v1#/$defs/Priority" },
    "outsourced": { "type": "boolean" }
  }
}
```

Example:

```json
{
  "event_id": "01a1a98a-ac41-7000-8000-0000000e0001",
  "event_type": "frontdesk.order.created.v1",
  "tenant_id": "01a1a98a-ac40-7000-8000-00000000a001",
  "occurred_at": "2026-11-05T02:31:12.004Z",
  "actor": { "type": "user", "id": "6f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f", "membership_id": "01a1a98a-ac40-7000-8000-000000030001" },
  "idempotency_key": "01a1a98a-ac40-7000-8000-000000050001:created",
  "producer": "frontdesk",
  "aggregate": { "type": "order", "id": "01a1a98a-ac40-7000-8000-000000050001", "seq": 1 },
  "request_id": "01a1a98a-ac41-7000-8000-0000000f0001",
  "payload": {
    "order_id": "01a1a98a-ac40-7000-8000-000000050001",
    "patient_id": "01a1a98a-ac40-7000-8000-000000040001",
    "branch_id": "01a1a98a-ac40-7000-8000-000000010001",
    "centre_id": "01a1a98a-ac40-7000-8000-000000020002",
    "visit_type": "opd", "billing_mode": "cash",
    "referrer_id": "01a1a98a-ac40-7000-8000-000000140001",
    "priority": "routine", "collection_mode": "walk_in", "source": "front_desk",
    "registered_at": "2026-11-05T02:31:11.950Z",
    "items": [
      { "order_item_id": "01a1a98a-ac40-7000-8000-000000060001", "orderable_id": "01a1a98a-ac40-7000-8000-000000070001",
        "orderable_kind": "test", "test_ids": ["01a1a98a-ac40-7000-8000-000000070001"], "priority": "routine" },
      { "order_item_id": "01a1a98a-ac40-7000-8000-000000060002", "orderable_id": "01a1a98a-ac40-7000-8000-000000070002",
        "orderable_kind": "panel", "test_ids": ["01a1a98a-ac40-7000-8000-000000070011", "01a1a98a-ac40-7000-8000-000000070012"],
        "priority": "routine" }
    ]
  }
}
```

### 3.2 `frontdesk.order.items_changed.v1`

| Field | Value |
|---|---|
| Producer | C4 |
| Consumers | C5 (add/remove specimen requirements and result skeletons), C6 (report shell) |
| Trigger | Commit of a transaction that adds ≥1 item to, or removes ≥1 item from, an order in status `registered`/`in_progress`, where every removed item has **no** specimen in `received` or later and no result `resulted` or later (removal of processed items is rejected by C4 with `frontdesk.order_not_editable`). C4 may remove an item only when `LabPort.getOrderItemProcessingState` returns `removable: true` for it (§4.5; 08 A13 D-5). One event per transaction (batches all changes). |
| Aggregate | `order`, seq = order version |
| Idempotency key | `<order_id>:items:<order_version>` |
| PHI class | P3 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["order_id", "items_version", "added", "removed", "changed_at"],
  "properties": {
    "order_id":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "items_version": { "type": "integer", "minimum": 2 },
    "added":   { "type": "array", "maxItems": 200, "items": { "$ref": "urn:lims:event:frontdesk.order.created.v1#/$defs/Item" } },
    "removed": { "type": "array", "maxItems": 200, "items": {
      "type": "object", "additionalProperties": false, "required": ["order_item_id", "reason_code"],
      "properties": { "order_item_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
                      "reason_code": { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" } } } },
    "changed_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
Constraint: `added` and `removed` not both empty (producer check). Example payload:

```json
{ "order_id": "01a1a98a-ac40-7000-8000-000000050001", "items_version": 2,
  "added": [ { "order_item_id": "01a1a98a-ac40-7000-8000-000000060003", "orderable_id": "01a1a98a-ac40-7000-8000-000000070021",
               "orderable_kind": "test", "test_ids": ["01a1a98a-ac40-7000-8000-000000070021"], "priority": "urgent" } ],
  "removed": [], "changed_at": "2026-11-05T02:40:00.000Z" }
```

### 3.3 `frontdesk.order.cancelled.v1`

| Field | Value |
|---|---|
| Producer | C4 |
| Consumers | C5 (cancel open specimens/results), C6 (void report shell), C8; **C13** (partner manifest/order projection — 08 R13) |
| Trigger | Order transitions to `cancelled` (allowed only while no result of the order is `approved` — C4 rule; otherwise `frontdesk.order_cancel_not_allowed`). The invoice side (credit note) is a separate billing transaction and emits `billing.invoice.cancelled.v1`. |
| Aggregate | `order` |
| Idempotency key | `<order_id>:cancelled` |
| PHI class | P1 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["order_id", "reason_code", "cancelled_at", "requires_credit_note"],
  "properties": {
    "order_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "reason_code":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "cancelled_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "requires_credit_note": { "type": "boolean" }
  }
}
```
Example payload: `{ "order_id": "01a1a98a-ac40-7000-8000-000000050001", "reason_code": "patient_left", "cancelled_at": "2026-11-05T03:05:00.000Z", "requires_credit_note": true }`

### 3.4 `billing.invoice.issued.v1`

| Field | Value |
|---|---|
| Producer | C4 (`billing`) |
| Consumers | C8 |
| Trigger | Commit of the transaction that allocates the fiscal invoice number (gapless counter per (tenant, B.S. FY) — 04 L7; series granularity BLOCKED B6/L8, default per (tenant, FY)) and inserts the invoice with status `issued`. |
| Aggregate | `invoice`, seq = invoice version (1 at issue) |
| Idempotency key | `<invoice_id>:issued` |
| PHI class | P1 (amounts + ids; no line items, no test names) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["invoice_id", "invoice_no", "fiscal_year_bs", "invoice_kind", "branch_id", "issued_at", "totals"],
  "if":   { "required": ["is_periodic_credit_bill"], "properties": { "is_periodic_credit_bill": { "const": true } } },
  "then": { "required": ["credit_party_id"], "not": { "anyOf": [ { "required": ["order_id"] }, { "required": ["centre_id"] } ] } },
  "else": { "required": ["order_id", "centre_id"] },
  "properties": {
    "invoice_id":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "invoice_no":      { "type": "string", "minLength": 1, "maxLength": 40 },
    "fiscal_year_bs":  { "type": "string", "pattern": "^[0-9]{4}/[0-9]{2}$" },
    "invoice_kind":    { "enum": ["tax_invoice", "abbreviated_tax_invoice"] },
    "order_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "credit_party_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "is_periodic_credit_bill": { "type": "boolean" },
    "branch_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "issued_at":       { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "totals": { "type": "object", "additionalProperties": false,
      "required": ["gross", "discount", "exempt", "taxable", "vat", "other_tax", "net"],
      "properties": {
        "gross":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
        "discount":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
        "exempt":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
        "taxable":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
        "vat":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
        "other_tax": { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
        "net":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" } } }
  }
}
```
Notes: `abbreviated_tax_invoice` exists because 01 §4.1 lists it; its NPR 5,000 limit is UNVERIFIED (04 L9) and must be a tenant/config value, not a constant. VAT treatment of lab services is BLOCKED B7 (04 L15); `other_tax` is the slot for Health Service Tax (04 L25, BLOCKED B7). Either `order_id` (cash/OPD invoice) or `credit_party_id` with `is_periodic_credit_bill: true` (monthly credit bill, 00 E6) is present. `centre_id` absent for periodic credit bills (08 A13 D-1, 02-CV §7.2 P-5 `if`/`then`/`else` above); `branch_id` is always present (C4 TRD §8.1 states which branch a periodic bill carries). Consumer confirmation of the absence (P-5): C8 tolerates it (08 A13 D-1).

Example payload:
```json
{ "invoice_id": "01a1a98a-ac40-7000-8000-0000000b0001", "invoice_no": "082/83-000123", "fiscal_year_bs": "2082/83",
  "invoice_kind": "tax_invoice", "order_id": "01a1a98a-ac40-7000-8000-000000050001",
  "branch_id": "01a1a98a-ac40-7000-8000-000000010001", "centre_id": "01a1a98a-ac40-7000-8000-000000020002",
  "issued_at": "2026-11-05T02:31:15.120Z",
  "totals": { "gross": { "amount_paisa": 250000, "currency": "NPR" }, "discount": { "amount_paisa": 25000, "currency": "NPR" },
              "exempt": { "amount_paisa": 225000, "currency": "NPR" }, "taxable": { "amount_paisa": 0, "currency": "NPR" },
              "vat": { "amount_paisa": 0, "currency": "NPR" }, "other_tax": { "amount_paisa": 0, "currency": "NPR" },
              "net": { "amount_paisa": 225000, "currency": "NPR" } } }
```

### 3.5 `billing.balance.changed.v1`

| Field | Value |
|---|---|
| Producer | C4 (`billing`) |
| Consumers | C6 (hold-till-paid hints; the authoritative check is still `BillingPort.getReleaseEligibility`), C16 |
| Trigger | Commit of any transaction that changes the balance due of an order: invoice issued, invoice cancelled/credit note, ledger entry (payment) recorded, ledger reversal, discount applied after invoicing via credit note, gateway payment recorded. Not emitted if the computed balance is unchanged. |
| Aggregate | `order_balance` (id = order_id), seq = per-order balance version (monotonic) |
| Idempotency key | `<order_id>:balance:<balance_version>` |
| Ordering | Consumers keep the highest `aggregate.seq`; stale events ignored. |
| PHI class | P1 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["order_id", "balance_version", "invoiced", "paid", "credited", "balance_due", "cause", "release_eligible"],
  "properties": {
    "order_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "balance_version": { "type": "integer", "minimum": 1 },
    "invoiced":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
    "paid":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
    "credited":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
    "balance_due": { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
    "cause": { "enum": ["invoice_issued", "invoice_cancelled", "payment_recorded", "payment_reversed",
                        "credit_note_issued", "gateway_payment_recorded"] },
    "release_eligible": { "type": "boolean" },
    "release_basis": { "enum": ["paid_in_full", "zero_balance", "credit_party", "override", "policy_not_enforced",
                                "due_outstanding", "no_invoice"] }
  }
}
```
Example payload: `{ "order_id": "01a1a98a-ac40-7000-8000-000000050001", "balance_version": 3, "invoiced": {"amount_paisa": 225000, "currency": "NPR"}, "paid": {"amount_paisa": 225000, "currency": "NPR"}, "credited": {"amount_paisa": 0, "currency": "NPR"}, "balance_due": {"amount_paisa": 0, "currency": "NPR"}, "cause": "payment_recorded", "release_eligible": true, "release_basis": "paid_in_full" }`

### 3.6 `billing.invoice.cancelled.v1`

| Field | Value |
|---|---|
| Producer | C4 (`billing`) |
| Consumers | C8 |
| Trigger | Commit of the transaction that sets an `issued` invoice to `cancelled` **and** issues its credit note (cancel with reason — 04 L26 ज; invoices never edited or deleted — 04 L5). |
| Aggregate | `invoice`, seq = invoice version after cancel |
| Idempotency key | `<invoice_id>:cancelled` |
| PHI class | P1 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["invoice_id", "invoice_no", "fiscal_year_bs", "credit_note_id", "credit_note_no", "reason_code",
               "cancelled_at", "credited_total"],
  "properties": {
    "invoice_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "invoice_no":     { "type": "string", "maxLength": 40 },
    "fiscal_year_bs": { "type": "string", "pattern": "^[0-9]{4}/[0-9]{2}$" },
    "order_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "credit_note_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "credit_note_no": { "type": "string", "maxLength": 40 },
    "reason_code":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "cancelled_at":   { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "credited_total": { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" }
  }
}
```
Example payload: `{ "invoice_id": "01a1a98a-ac40-7000-8000-0000000b0001", "invoice_no": "082/83-000123", "fiscal_year_bs": "2082/83", "order_id": "01a1a98a-ac40-7000-8000-000000050001", "credit_note_id": "01a1a98a-ac40-7000-8000-0000000b0101", "credit_note_no": "CN-082/83-000007", "reason_code": "order_cancelled", "cancelled_at": "2026-11-05T03:06:00.000Z", "credited_total": {"amount_paisa": 225000, "currency": "NPR"} }`

### 3.7 `lab.specimen.status_changed.v1`

| Field | Value |
|---|---|
| Producer | C5 (`lab`) |
| Consumers | C6, C8, C13, C16, C17; **C9** (TAT alerts — A3); **C10, C11** (start culture / accession work when `to_status = received` — A4); **C4** (only `to_status = recollection_ordered`: upserts the `frontdesk.order_flags` row `kind = 'recollection_required'` for the old `specimen_id`, deduplicated with the `lab.specimen.rejected.v1` path by `order_flags__tenant_id_kind_specimen__p_uq` — 08 A13 D-6) |
| Trigger | Commit of **every** specimen state transition in §10.1 (including roll-up transitions `resulted/verified/approved/reported`, and creation of a recollection/aliquot specimen row, which is reported as `from_status` absent → `to_status`). One event per specimen per transition. |
| Aggregate | `specimen`, seq = specimen version |
| Idempotency key | `<specimen_id>:<to_status>:<specimen_version>` |
| Ordering | unordered; consumers apply only if `aggregate.seq` > last applied seq for that specimen |
| PHI class | P1 (no barcode — consumers that must show a barcode fetch it through an authorised endpoint) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["specimen_id", "order_id", "patient_id", "centre_id", "specimen_type_code", "to_status", "changed_at"],
  "properties": {
    "specimen_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_id":           { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "patient_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "processing_branch_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "specimen_type_code": { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "parent_specimen_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "replaces_specimen_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "from_status":        { "$ref": "urn:lims:event:_defs.v1#/$defs/SpecimenStatus" },
    "to_status":          { "$ref": "urn:lims:event:_defs.v1#/$defs/SpecimenStatus" },
    "changed_at":         { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "order_item_ids": { "type": "array", "maxItems": 200, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } }
  }
}
```
Example payload: `{ "specimen_id": "01a1a98a-ac40-7000-8000-000000090001", "order_id": "01a1a98a-ac40-7000-8000-000000050001", "patient_id": "01a1a98a-ac40-7000-8000-000000040001", "centre_id": "01a1a98a-ac40-7000-8000-000000020002", "processing_branch_id": "01a1a98a-ac40-7000-8000-000000010001", "specimen_type_code": "EDTA_WB", "from_status": "in_transit", "to_status": "received", "changed_at": "2026-11-05T03:20:41.300Z", "order_item_ids": ["01a1a98a-ac40-7000-8000-000000060001"] }`

### 3.8 `lab.specimen.rejected.v1`

| Field | Value |
|---|---|
| Producer | C5 |
| Consumers | C4 (recollection: new barcode on the same order; patient contact via NotificationPort), C16 (patient app notice), C17 (phlebotomist revisit) |
| Trigger | Commit of transition to `rejected` (§10.1). Emitted **in addition to** `lab.specimen.status_changed.v1` for the same transition. |
| Aggregate | `specimen` |
| Idempotency key | `<specimen_id>:rejected` |
| PHI class | P1. The free-text rejection comment is **not** in the event (may contain clinical text); consumers fetch it if authorised. |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["specimen_id", "order_id", "patient_id", "centre_id", "reason_code", "rejected_at",
               "recollection_required", "order_item_ids"],
  "properties": {
    "specimen_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_id":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "patient_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "reason_code": { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "rejected_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "recollection_required": { "type": "boolean" },
    "collected_by_membership_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "home_visit_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_item_ids": { "type": "array", "minItems": 1, "maxItems": 200, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } }
  }
}
```
`reason_code` is from the tenant-extensible coded set `lab.cs_rejection_reasons` (seed: `haemolysed`, `clotted`, `qns`, `mislabelled`, `unlabelled`, `wrong_container`, `delayed_transport` — 01 §2.1). Example payload: `{ "specimen_id": "01a1a98a-ac40-7000-8000-000000090001", "order_id": "01a1a98a-ac40-7000-8000-000000050001", "patient_id": "01a1a98a-ac40-7000-8000-000000040001", "centre_id": "01a1a98a-ac40-7000-8000-000000020002", "reason_code": "haemolysed", "rejected_at": "2026-11-05T03:25:00.000Z", "recollection_required": true, "order_item_ids": ["01a1a98a-ac40-7000-8000-000000060002"] }`

### 3.9 `lab.result.verified.v1`

| Field | Value |
|---|---|
| Producer | C5 |
| Consumers | C9 (auto-verification statistics, TAT), C8; **C12** (per-reportable consumption deduction — A2) |
| Trigger | Commit of result transition `resulted → verified` (first-level verification by a technologist; Phase 2 adds `mode: auto` when `QualityPort.canAutoVerify` allows — 04 R2). One event per result. |
| Aggregate | `result`, seq = result row version |
| Idempotency key | `<result_id>:verified:<result_version_no>:<result_row_version>` |
| PHI class | P3 (pseudonymous; no value) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["result_id", "result_version_no", "order_id", "order_item_id", "test_id", "analyte_id",
               "department_id", "origin", "mode", "verified_at"],
  "if": { "properties": { "mode": { "const": "manual" } } },
  "then": { "required": ["verified_by_membership_id"] },
  "else": { "not": { "required": ["verified_by_membership_id"] } },
  "properties": {
    "result_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "result_version_no": { "type": "integer", "minimum": 1 },
    "order_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_item_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "specimen_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "test_id":           { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "analyte_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "department_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "origin":            { "enum": ["instrument", "manual", "calculated", "module"] },
    "mode":              { "enum": ["manual", "auto"] },
    "verified_at":       { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "verified_by_membership_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "processing_branch_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" }
  }
}
```
`processing_branch_id` (optional, added by 08 §4.10, CR-C12-004): the branch whose lab processed the result (C12 store resolution). Notes (08 A13 D-2, 02-CV §7.2 P-5): `specimen_id` absent iff the result has no specimen (`TestDefinition.usesExistingMaterial`, CR-C11-009); `verified_by_membership_id` present iff `mode = manual` (`if`/`then`/`else` above). Consumer confirmation of the absence (P-5): C8, C9, C12 tolerate it (08 A13 D-2). Example payload: `{ "result_id": "01a1a98a-ac40-7000-8000-0000000a0001", "result_version_no": 1, "order_id": "01a1a98a-ac40-7000-8000-000000050001", "order_item_id": "01a1a98a-ac40-7000-8000-000000060001", "specimen_id": "01a1a98a-ac40-7000-8000-000000090001", "test_id": "01a1a98a-ac40-7000-8000-000000070001", "analyte_id": "01a1a98a-ac40-7000-8000-000000080001", "department_id": "01a1a98a-ac40-7000-8000-000000150001", "instrument_id": "01a1a98a-ac40-7000-8000-0000000d0001", "origin": "instrument", "mode": "manual", "verified_at": "2026-11-05T04:02:10.000Z", "verified_by_membership_id": "01a1a98a-ac40-7000-8000-000000030002", "processing_branch_id": "01a1a98a-ac40-7000-8000-000000010001" }`

### 3.10 `lab.result.approved.v1`

| Field | Value |
|---|---|
| Producer | C5 |
| Consumers | C6, C8, C14; **C11** (anatomic case status — CR-C11-011) |
| Trigger | Commit of result transition `verified → approved` by a user holding `lab.result.approve` (pathologist — 00 C5; 04 R1). After this the result is locked (§10.2). Not emitted for amendments (those emit `lab.result.amended.v1`). |
| Aggregate | `result` |
| Idempotency key | `<result_id>:approved:<result_version_no>` |
| PHI class | P3 (pseudonymous; no value) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["result_id", "result_version_no", "order_id", "order_item_id", "test_id", "analyte_id",
               "department_id", "approved_at", "approved_by_membership_id"],
  "properties": {
    "result_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "result_version_no": { "type": "integer", "const": 1 },
    "order_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_item_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "test_id":           { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "analyte_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "department_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "approved_at":       { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "approved_by_membership_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" }
  }
}
```
Example payload: `{ "result_id": "01a1a98a-ac40-7000-8000-0000000a0001", "result_version_no": 1, "order_id": "01a1a98a-ac40-7000-8000-000000050001", "order_item_id": "01a1a98a-ac40-7000-8000-000000060001", "test_id": "01a1a98a-ac40-7000-8000-000000070001", "analyte_id": "01a1a98a-ac40-7000-8000-000000080001", "department_id": "01a1a98a-ac40-7000-8000-000000150001", "approved_at": "2026-11-05T04:30:00.000Z", "approved_by_membership_id": "01a1a98a-ac40-7000-8000-000000030003" }`

### 3.11 `lab.result.amended.v1`

| Field | Value |
|---|---|
| Producer | C5 |
| Consumers | C6 (amended report version; old version marked superseded — 04 R1), C8, C14; **C11** (anatomic case status — CR-C11-011) |
| Trigger | Commit of an amendment: a new `result_versions` row (`version_no = previous + 1`) on an `approved` result, created by a user holding `lab.result.amend` (pathologist only — 00 C6), with a mandatory reason. The amended version is approved at creation. |
| Aggregate | `result` |
| Idempotency key | `<result_id>:amended:<new_version_no>` |
| PHI class | P3 (pseudonymous; no values, no reason text) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["result_id", "previous_version_no", "new_version_no", "order_id", "order_item_id", "test_id",
               "analyte_id", "amendment_reason_code", "amended_at", "amended_by_membership_id"],
  "properties": {
    "result_id":           { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "previous_version_no": { "type": "integer", "minimum": 1 },
    "new_version_no":      { "type": "integer", "minimum": 2 },
    "order_id":            { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_item_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "test_id":             { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "analyte_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "amendment_reason_code": { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "amended_at":          { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "amended_by_membership_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" }
  }
}
```
Example payload: `{ "result_id": "01a1a98a-ac40-7000-8000-0000000a0001", "previous_version_no": 1, "new_version_no": 2, "order_id": "01a1a98a-ac40-7000-8000-000000050001", "order_item_id": "01a1a98a-ac40-7000-8000-000000060001", "test_id": "01a1a98a-ac40-7000-8000-000000070001", "analyte_id": "01a1a98a-ac40-7000-8000-000000080001", "amendment_reason_code": "transcription_error", "amended_at": "2026-11-06T05:00:00.000Z", "amended_by_membership_id": "01a1a98a-ac40-7000-8000-000000030003" }`

### 3.12 `lab.order.ready_for_report.v1`

| Field | Value |
|---|---|
| Producer | C5 |
| Consumers | C6 |
| Trigger | After any transaction that approves or amends a result of an order, C5 evaluates the order: (a) **complete** — every non-cancelled order item has all reportable results `approved`; or (b) **partial** — tenant setting `partial_release_allowed = true` (IdentityPort settings) **and** at least one department group has all its items approved and that set differs from the last emitted set. Emitted when (a) or (b) holds for an approved-set not emitted before. Amendments always re-emit (the approved set's version vector changed). |
| Aggregate | `order` (lab's view; seq = lab-side order readiness counter) |
| Idempotency key | `<order_id>:ready:<approved_set_hash>` where `approved_set_hash` = SHA-256 hex of sorted `result_id:version_no` pairs |
| PHI class | P1 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["order_id", "completeness", "order_item_ids", "approved_set_hash", "contains_amendment", "ready_at"],
  "properties": {
    "order_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "completeness":      { "enum": ["complete", "partial"] },
    "order_item_ids":    { "type": "array", "minItems": 1, "maxItems": 200, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } },
    "department_ids":    { "type": "array", "maxItems": 50, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } },
    "approved_set_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "contains_amendment": { "type": "boolean" },
    "ready_at":          { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
Example payload: `{ "order_id": "01a1a98a-ac40-7000-8000-000000050001", "completeness": "complete", "order_item_ids": ["01a1a98a-ac40-7000-8000-000000060001", "01a1a98a-ac40-7000-8000-000000060002"], "approved_set_hash": "9f2c6d0b1e7a4c3f8d5b2a1e0c9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a10", "contains_amendment": false, "ready_at": "2026-11-05T04:30:01.000Z" }`

### 3.13 `lab.critical_value.detected.v1`

| Field | Value |
|---|---|
| Producer | C5 |
| Consumers | C6 (notification dispatch through NotificationPort / staff alert), C8 (critical-value log stats) |
| Trigger | Commit of a transaction that saves a result value (instrument, manual or calculated; at `resulted`, before verification) which lies outside the critical limits returned by `CatalogPort.criticalLimitsFor` for that patient's sex/age. One event per (result, version) crossing; a corrected re-entry that is no longer critical does not retract it (the log row records the correction). ISO 15189 requires a critical-result notification protocol (04 L21); the notification log itself is C5's (01 §2.2). |
| Aggregate | `result` |
| Idempotency key | `<result_id>:critical:<result_version_no>:<value_sha256_prefix16>` |
| PHI class | P3 (pseudonymous; **no value** in the event — staff fetch via LabPort/HTTP with authz) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["critical_event_id", "result_id", "result_version_no", "order_id", "patient_id", "centre_id",
               "analyte_id", "direction", "detected_at"],
  "properties": {
    "critical_event_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "result_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "result_version_no": { "type": "integer", "minimum": 1 },
    "order_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "patient_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "referrer_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "analyte_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "direction":         { "enum": ["low", "high", "abnormal"] },
    "detected_at":       { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
Example payload: `{ "critical_event_id": "01a1a98a-ac40-7000-8000-000000160001", "result_id": "01a1a98a-ac40-7000-8000-0000000a0002", "result_version_no": 1, "order_id": "01a1a98a-ac40-7000-8000-000000050001", "patient_id": "01a1a98a-ac40-7000-8000-000000040001", "centre_id": "01a1a98a-ac40-7000-8000-000000020002", "referrer_id": "01a1a98a-ac40-7000-8000-000000140001", "analyte_id": "01a1a98a-ac40-7000-8000-000000080002", "direction": "high", "detected_at": "2026-11-05T03:58:00.000Z" }`

### 3.14 `instruments.result.received.v1`

| Field | Value |
|---|---|
| Producer | C7 (`instruments`) |
| Consumers | C5 (apply to the matching specimen/result — **canonical path** for patient results), C9 (instrument stats), C10 (organism ID / AST records), C12 (consumption counts) |
| Trigger | Commit of the ingest transaction that (1) stored the raw message in the archive with message-level dedupe — HL7 `(instrument_id, MSH-10)`, ASTM `(instrument_id, sha256(raw))` (04 N10), (2) parsed it with the instrument's driver and (3) found the record is a **patient** result (QC records go to §3.15). One event per parsed result record (analyte/antibiotic/organism/attachment). Unmapped instrument codes still emit with `mapping_status: unmapped` so C5 can surface them. Also: commit of the `scan_attachment` transaction that marks an attachment clean, or of a reprocess/re-match transaction, that produces a record whose key was not published before (re-publication is suppressed by `core.event_log` uniqueness) (CR-C7-004). |
| Aggregate | `instrument_message` (id = archive row id), seq = 1 |
| Idempotency key | result-level key (04 N10): `<instrument_id>:<sample_barcode>:<instrument_analyte_code>:<instrument_result_time or 'none'>` |
| Ordering | unordered; reruns are distinguished by `instrument_result_time` and `is_rerun` |
| Driver rule (CR-C10-007) | For `organism_id`/`ast` records the isolate is carried inside `instrument_analyte_code` by a C7 driver rule: organism records `ORG:<isolate_seq|1>`, AST records `AST:<isolate_seq|1>:<antibiotic_code_raw>:<method>`, ≤ 64 chars (a longer code is rejected by the driver and logged). C5 ignores `organism_id`/`ast` records; C10 parses the composite code. Simulator fixtures carry two isolates with the same antibiotic. 04 N10 key unchanged (08 R13). |
| PHI class | **P3 + P2** — contains `sample_barcode` and result values. Justification: C5 must match by barcode and apply the value; no consumer could otherwise act without a port round-trip per record. Mitigation: no patient id/name; event_log retention 90 days; payload never logged (02-CV §9.2). |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["instrument_message_id", "instrument_id", "agent_id", "centre_id", "protocol", "sample_barcode",
               "record_kind", "instrument_analyte_code", "mapping_status", "received_at"],
  "properties": {
    "instrument_message_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "agent_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "protocol":       { "enum": ["astm", "hl7v2", "file_drop"] },
    "sample_barcode": { "type": "string", "minLength": 1, "maxLength": 40 },
    "record_kind":    { "enum": ["quantitative", "qualitative", "ordinal", "text", "organism_id", "ast", "attachment"] },
    "instrument_analyte_code": { "type": "string", "minLength": 1, "maxLength": 64 },
    "mapping_status": { "enum": ["mapped", "unmapped"] },
    "analyte_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "test_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "value_raw":      { "type": "string", "maxLength": 200 },
    "value_numeric":  { "$ref": "urn:lims:event:_defs.v1#/$defs/DecimalString" },
    "unit_raw":       { "type": "string", "maxLength": 32 },
    "unit_code":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "instrument_flags": { "type": "array", "maxItems": 20, "items": { "type": "string", "maxLength": 16 } },
    "instrument_result_time": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "instrument_clock_offset_seconds": { "type": "integer" },
    "received_at":    { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "is_rerun":       { "type": "boolean" },
    "captured_at":      { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "processing_kind":  { "enum": ["live", "reprocess", "rematch"] },
    "source_record_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "organism": { "type": "object", "additionalProperties": false, "required": ["organism_code_raw"],
      "properties": { "organism_code_raw": { "type": "string", "maxLength": 64 },
                      "organism_code": { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
                      "isolate_seq": { "type": "integer", "minimum": 1 } } },
    "ast": { "type": "object", "additionalProperties": false, "required": ["antibiotic_code_raw", "method", "raw_value"],
      "properties": { "antibiotic_code_raw": { "type": "string", "maxLength": 64 },
                      "antibiotic_code": { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
                      "isolate_seq": { "type": "integer", "minimum": 1 },
                      "method": { "enum": ["mic", "zone_diameter", "other"] },
                      "raw_value": { "type": "string", "maxLength": 32 },
                      "interpretation_raw": { "type": "string", "maxLength": 16 },
                      "standard": { "enum": ["CLSI", "EUCAST", "ECOFF", "unknown"] },
                      "standard_version": { "type": "string", "maxLength": 32 } } },
    "attachment": { "type": "object", "additionalProperties": false, "required": ["bucket", "object_path", "sha256", "mime_type"],
      "properties": { "bucket": { "type": "string", "maxLength": 63 },
                      "object_path": { "type": "string", "maxLength": 512 },
                      "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
                      "mime_type": { "enum": ["application/pdf", "image/png", "image/jpeg"] } } }
  }
}
```
Rules: `organism` required iff `record_kind = organism_id`; `ast` required iff `record_kind = ast` (store raw value + interpretation **as received**, plus standard + version when the instrument sends them — 04 D14); `attachment` required iff `record_kind = attachment` (picture/PDF import — 01 §3.5; object path first segment = tenant_id — 04 D15 pattern). Which fields a given analyser actually sends is UNVERIFIED per model (04 N6–N8, BLOCKED B2).

Example payload (quantitative):
```json
{ "instrument_message_id": "01a1a98a-ac40-7000-8000-0000000d1001", "instrument_id": "01a1a98a-ac40-7000-8000-0000000d0001",
  "agent_id": "01a1a98a-ac40-7000-8000-0000000d0101", "centre_id": "01a1a98a-ac40-7000-8000-000000020001",
  "protocol": "hl7v2", "sample_barcode": "E1100009999", "record_kind": "quantitative",
  "instrument_analyte_code": "HGB", "mapping_status": "mapped",
  "analyte_id": "01a1a98a-ac40-7000-8000-000000080001", "test_id": "01a1a98a-ac40-7000-8000-000000070001",
  "value_raw": "13.4", "value_numeric": "13.4", "unit_raw": "g/dL", "unit_code": "g_dl", "instrument_flags": [],
  "instrument_result_time": "2026-11-05T03:51:02.000Z", "instrument_clock_offset_seconds": -42,
  "received_at": "2026-11-05T03:51:05.410Z", "is_rerun": false,
  "captured_at": "2026-11-05T03:51:05.000Z", "processing_kind": "live", "source_record_id": "01a1a98a-ac40-7000-8000-0000000d2001" }
```
`processing_kind` absent = `live`; `captured_at` = agent capture time; `source_record_id` = parsed-record id in the C7 archive (08 §4.10).

### 3.15 `instruments.qc.received.v1`

| Field | Value |
|---|---|
| Producer | C7 |
| Consumers | C5 (QC **data capture**, Phase 1 — 04 §12), C9 (LJ/Westgard, Phase 2); **C12** (per-QC consumption deduction — A2) |
| Trigger | Commit of an ingest transaction whose parsed record the driver classifies as QC (control sample id / QC record type; mechanism per driver — 01 §2.5). One event per QC observation. |
| Aggregate | `instrument_message` |
| Idempotency key | `<instrument_id>:qc:<control_id_raw>:<instrument_analyte_code>:<instrument_result_time or sha256(raw)>` |
| PHI class | P0 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["instrument_message_id", "instrument_id", "centre_id", "control_id_raw", "instrument_analyte_code",
               "mapping_status", "value_raw", "received_at"],
  "properties": {
    "instrument_message_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "control_id_raw":  { "type": "string", "maxLength": 64 },
    "control_lot_raw": { "type": "string", "maxLength": 64 },
    "control_level":   { "type": "string", "maxLength": 16 },
    "instrument_analyte_code": { "type": "string", "maxLength": 64 },
    "mapping_status":  { "enum": ["mapped", "unmapped"] },
    "analyte_id":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "value_raw":       { "type": "string", "maxLength": 64 },
    "value_numeric":   { "$ref": "urn:lims:event:_defs.v1#/$defs/DecimalString" },
    "unit_raw":        { "type": "string", "maxLength": 32 },
    "instrument_flags": { "type": "array", "maxItems": 20, "items": { "type": "string", "maxLength": 16 } },
    "instrument_result_time": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "received_at":     { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "captured_at":     { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "processing_kind": { "enum": ["live", "reprocess", "rematch"] }
  }
}
```
Example payload: `{ "instrument_message_id": "01a1a98a-ac40-7000-8000-0000000d1002", "instrument_id": "01a1a98a-ac40-7000-8000-0000000d0001", "centre_id": "01a1a98a-ac40-7000-8000-000000020001", "control_id_raw": "QC-L2", "control_lot_raw": "LOT-SYN-01", "control_level": "2", "instrument_analyte_code": "HGB", "mapping_status": "mapped", "analyte_id": "01a1a98a-ac40-7000-8000-000000080001", "value_raw": "12.1", "value_numeric": "12.1", "unit_raw": "g/dL", "instrument_flags": [], "instrument_result_time": "2026-11-05T01:00:00.000Z", "received_at": "2026-11-05T01:00:03.000Z", "captured_at": "2026-11-05T01:00:02.000Z", "processing_kind": "live" }`

### 3.16 `instruments.agent.health_changed.v1`

| Field | Value |
|---|---|
| Producer | C7 |
| Consumers | C1 (alerting), C8 |
| Trigger | C7's heartbeat evaluator changes the computed state of an agent. Heartbeat interval 60 s (04 N11). States [CONV]: `online` (heartbeat within 3 intervals), `offline` (no heartbeat for >3 intervals = 180 s), `backlog` (online, but reported queue depth above the agent's configured threshold — threshold value set in C7 TRD), `degraded` (online, ≥1 configured instrument silent beyond its configured silence window — REQ-ARCH-061). Alert thresholds ("offline > N hours" — REQ-SEC-123) are C1 alert rules, not event triggers. |
| Aggregate | `agent`, seq = agent health version |
| Idempotency key | `<agent_id>:health:<health_version>` |
| PHI class | P0 |
| C1 delivery note | Binding (X6): C1 owns no `services/worker/src/jobs/` path (01 §3), so C1 consumes this **as metrics** exported by C7 (`lims_instruments_agent_state{agent_id,state}`) plus C1 alert rules, not as a job subscription. |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["agent_id", "centre_id", "to_state", "last_heartbeat_at", "agent_version", "queue_depth"],
  "properties": {
    "agent_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "from_state":        { "enum": ["online", "offline", "backlog", "degraded"] },
    "to_state":          { "enum": ["online", "offline", "backlog", "degraded"] },
    "last_heartbeat_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "agent_version":     { "type": "string", "maxLength": 32 },
    "queue_depth":       { "type": "integer", "minimum": 0 },
    "clock_offset_seconds": { "type": "integer" },
    "silent_instrument_ids": { "type": "array", "maxItems": 50, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } }
  }
}
```
Example payload: `{ "agent_id": "01a1a98a-ac40-7000-8000-0000000d0101", "centre_id": "01a1a98a-ac40-7000-8000-000000020001", "from_state": "online", "to_state": "offline", "last_heartbeat_at": "2026-11-05T05:10:00.000Z", "agent_version": "1.0.0-syn", "queue_depth": 12, "clock_offset_seconds": -42, "silent_instrument_ids": [] }`

Note: Metrics per CR-C1-003 (labels tenant_id, centre_id, agent_id[, state|agent_version]; four state series per agent, value 0/1).

### 3.17 `reporting.report.released.v1`

| Field | Value |
|---|---|
| Producer | C6 (`reporting`) |
| Consumers | C8, C13 (partner portal availability), C16 (patient app notification); **C5** (specimen roll-up `approved → reported`, status board "printed/ready" — A8); **C9** (total TAT — A3) |
| Trigger | Commit of the transaction that marks a rendered report version `released` after the release rules pass (hold-till-paid via `BillingPort.getReleaseEligibility` or an authorised override; partial/bulk release — 01 C6). Bulk release emits one event per report version. |
| Aggregate | `report`, seq = report row version |
| Idempotency key | `<report_id>:released:<version_no>` |
| PHI class | P1 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["report_id", "version_no", "order_id", "patient_id", "centre_id", "report_kind", "released_at",
               "release_basis", "audiences"],
  "properties": {
    "report_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "version_no":  { "type": "integer", "minimum": 1 },
    "order_id":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "patient_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "referrer_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "partner_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "report_kind": { "enum": ["final", "partial", "preliminary", "amended", "addendum"], "x-extensible": true },
    "order_item_ids": { "type": "array", "maxItems": 200, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } },
    "supersedes_version_no": { "type": "integer", "minimum": 1 },
    "released_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "release_basis": { "enum": ["paid_in_full", "zero_balance", "credit_party", "override", "policy_not_enforced"] },
    "audiences": { "type": "array", "minItems": 1, "maxItems": 5, "uniqueItems": true,
                   "items": { "enum": ["patient", "referrer", "centre", "partner", "print_only"] } }
  }
}
```
Example payload: `{ "report_id": "01a1a98a-ac40-7000-8000-0000000f0001", "version_no": 1, "order_id": "01a1a98a-ac40-7000-8000-000000050001", "patient_id": "01a1a98a-ac40-7000-8000-000000040001", "centre_id": "01a1a98a-ac40-7000-8000-000000020002", "referrer_id": "01a1a98a-ac40-7000-8000-000000140001", "report_kind": "final", "released_at": "2026-11-05T04:35:00.000Z", "release_basis": "paid_in_full", "audiences": ["patient", "referrer"], "order_item_ids": ["01a1a98a-ac40-7000-8000-000000060001"] }`

`report_kind` rule (08 R1): first match wins — (1) a section amended for a reason other than `module_phase_progression`/`module_preliminary_update`/`supplementary_report` with an earlier released version → `amended`; (2) else any `supplementary_report` section → `addendum`; (3) else any micro section in phase `preliminary` (including one amended with `module_preliminary_update`) → `preliminary`; (4) else `final`/`partial`. The enum is `x-extensible` (02-CV §7.2): consumers treat an unknown value as `amended` for display. `order_item_ids` (CR-C5-006 / C6-014) = order items contained in the released version. Exclusion set and label for `module_preliminary_update` (second micro preliminary after an approved preliminary): 08 A17 D-61.

### 3.18 `reporting.delivery.status_changed.v1`

| Field | Value |
|---|---|
| Producer | C6 |
| Consumers | C8 |
| Trigger | Commit of a delivery-status transition (`queued → sent → delivered → read`, any → `failed`, `failed → queued` on retry/fallback) recorded from provider callbacks or worker results (REQ-ARCH-040/084). Status `read` only where the channel reports it (WhatsApp). |
| Aggregate | `delivery`, seq = delivery version |
| Idempotency key | `<delivery_id>:<to_status>:<delivery_version>` |
| PHI class | P1 (no phone/email, no message text) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["delivery_id", "channel", "purpose", "recipient_kind", "to_status", "changed_at", "attempt_no"],
  "properties": {
    "delivery_id":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "report_id":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "report_version_no": { "type": "integer", "minimum": 1 },
    "channel":        { "enum": ["whatsapp", "sms", "email", "print", "portal"] },
    "purpose":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "recipient_kind": { "enum": ["patient", "referrer", "centre", "partner", "staff", "phone_otp"], "x-extensible": true },
    "from_status":    { "enum": ["queued", "sent", "delivered", "read", "failed", "suppressed"] },
    "to_status":      { "enum": ["queued", "sent", "delivered", "read", "failed", "suppressed"] },
    "failure_code":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "attempt_no":     { "type": "integer", "minimum": 1 },
    "fallback_of_delivery_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "changed_at":     { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "delivery_created_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
Example payload: `{ "delivery_id": "01a1a98a-ac40-7000-8000-0000000f0101", "report_id": "01a1a98a-ac40-7000-8000-0000000f0001", "report_version_no": 1, "channel": "whatsapp", "purpose": "report_ready", "recipient_kind": "patient", "from_status": "sent", "to_status": "delivered", "attempt_no": 1, "changed_at": "2026-11-05T04:36:10.000Z" }`

`recipient_kind` gains `phone_otp` and is `x-extensible` (08 A13 D-3; 02-CV §7.2): C8 counts an unknown value as `other`. C6 contract test "phone_otp delivery event validates".

`delivery_created_at` (08 A17 D-48; additive, R13, not in `required`): creation time of the delivery row. C6 always sets it. C8 dirties `deliveries @ bd(delivery_created_at)`; when it is absent, bd(changed_at) + nightly sweep.

### 3.19 `catalog.changed.v1`

| Field | Value |
|---|---|
| Producer | C3 (`catalog`) |
| Consumers | C4, C5, C6, C7 (cache invalidation); **C13**, **C16** (read-model refresh — 08 R13) |
| Trigger | Commit of any create/update/deactivate/new-version of a tenant catalog entity listed in `entity_type`. Global (G-table) changes arrive by migration/seed; after such a release C3's job emits one event per tenant with `entity_type: global_reference`. |
| Aggregate | `catalog` (id = tenant's catalog root id), seq = `catalog_revision` (per-tenant monotonic) |
| Idempotency key | `<tenant_id>:catalog:<catalog_revision>` |
| Ordering | consumers invalidate everything with revision ≤ event revision for that entity; never apply out of order (just invalidate) |
| PHI class | P0 (doctor/credit-party ids only) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["catalog_revision", "entity_type", "entity_id", "change_kind", "effective_from"],
  "properties": {
    "catalog_revision": { "type": "integer", "minimum": 1 },
    "entity_type": { "enum": ["department", "specimen_type", "container", "test", "analyte", "panel",
                              "reference_range", "critical_limit", "comment_code", "doctor", "credit_party",
                              "price_list", "surcharge_rule", "tat_target", "instrument_code_map", "global_reference",
                              "method", "unit", "value_set", "tax_rule", "catalog_import"], "x-extensible": true },
    "entity_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "change_kind": { "enum": ["created", "updated", "deactivated", "versioned"] },
    "effective_from": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
Example payload: `{ "catalog_revision": 418, "entity_type": "price_list", "entity_id": "01a1a98a-ac40-7000-8000-000000180001", "change_kind": "versioned", "effective_from": "2026-11-06T00:00:00.000Z" }`

`entity_type` is `x-extensible` (CR-C3-003; 02-CV §7.2): a consumer receiving an unknown value invalidates its whole catalog cache for the tenant.

One event per import commit (08 A13 D-21): a `catalog_master` / `referrers` / `credit_parties` import commit bumps `catalog_revision` once and emits one `catalog.changed.v1` with `entity_type: 'catalog_import'`, `entity_id = import_id`, `change_kind: 'updated'`; every affected `orderables.revision` is stamped with that revision. Consumers apply the unknown-value rule above (invalidate the whole tenant cache). A price-list import stays one `price_list` event.

### 3.20 `payments.intent.settled.v1`

| Field | Value |
|---|---|
| Producer | C15 (`payments`) — Phase 1.5–2 (04 §12) |
| Consumers | C4 |
| Trigger | Commit of the transition of a payment intent to `settled`, which requires server-to-server verification (eSewa status `COMPLETE` only; Khalti lookup `Completed` only; Fonepay mechanism UNVERIFIED/BLOCKED B8) **and** an exact amount match against the stored intent amount (04 P3/P4/P7; REQ-SEC-047/048). Canonical ledger write: C15 calls `BillingPort.recordGatewayPayment` **in the same transaction** (§4.4); C4's consumer of this event is the idempotent safety net (no-op if the ledger entry exists) plus follow-ups (receipt/notification). |
| Aggregate | `payment_intent`, seq = intent version |
| Idempotency key | `<gateway>:<gateway_txn_ref>:settled` (mirrors unique `(gateway, gateway_txn_id)` — 04 P6) |
| PHI class | P1 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["intent_id", "order_id", "gateway", "gateway_txn_ref", "amount", "verified_at", "verification_method"],
  "properties": {
    "intent_id":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "invoice_id":      { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "gateway":         { "enum": ["esewa", "khalti", "fonepay"] },
    "gateway_txn_ref": { "type": "string", "minLength": 1, "maxLength": 100 },
    "amount":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
    "verified_at":     { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "verification_method": { "enum": ["esewa_status_check", "khalti_lookup", "fonepay_verification"] },
    "ledger_entry_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" }
  }
}
```
`gateway_txn_ref` = eSewa `transaction_uuid` / Khalti `pidx` / Fonepay PRN (REQ-SEC-056: gateway references only). Example payload: `{ "intent_id": "01a1a98a-ac40-7000-8000-000000110001", "order_id": "01a1a98a-ac40-7000-8000-000000050001", "gateway": "khalti", "gateway_txn_ref": "SYNpidx0000000000000001", "amount": {"amount_paisa": 225000, "currency": "NPR"}, "verified_at": "2026-11-05T02:33:00.000Z", "verification_method": "khalti_lookup", "ledger_entry_id": "01a1a98a-ac40-7000-8000-0000000c0002" }`

### 3.21 `quality.qc_run.rejected.v1`

| Field | Value |
|---|---|
| Producer | C9 (`quality`) — Phase 2 |
| Consumers | C5 (calls its own hold logic = `LabPort.holdResultsSince` semantics) |
| Trigger | Commit of a QC run evaluation whose outcome is `rejected` under the configured Westgard rule set (rejection rules: 1-3s, 2-2s, R-4s within-run only, 4-1s, 10x, and the N=3 variants 2of3-2s, 3-1s, 6x/9x; N=2/4 variants 8x/12x; 1-2s is a warning only and never triggers this event; classic vs modern evaluation per lab flag — 04 L23). |
| Aggregate | `qc_run` |
| Idempotency key | `<qc_run_id>:rejected` |
| PHI class | P0 |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["qc_run_id", "instrument_id", "analyte_ids", "rules_violated", "rule_mode", "controls_per_run",
               "run_at", "hold_since", "rejected_at"],
  "properties": {
    "qc_run_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "analyte_ids":   { "type": "array", "minItems": 1, "maxItems": 100, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } },
    "rules_violated": { "type": "array", "minItems": 1, "maxItems": 12, "uniqueItems": true,
      "items": { "enum": ["1-3s", "2-2s", "R-4s", "4-1s", "10x", "2of3-2s", "3-1s", "6x", "8x", "9x", "12x"] } },
    "rule_mode":     { "enum": ["classic", "modern"] },
    "controls_per_run": { "type": "integer", "minimum": 1, "maximum": 6 },
    "run_at":        { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "last_in_control_run_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "hold_since":    { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "rejected_at":   { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
`hold_since` = `last_in_control_run_at` if known, else `run_at` minus the instrument's configured lookback (C9 TRD). Example payload: `{ "qc_run_id": "01a1a98a-ac40-7000-8000-000000100001", "instrument_id": "01a1a98a-ac40-7000-8000-0000000d0001", "analyte_ids": ["01a1a98a-ac40-7000-8000-000000080001"], "rules_violated": ["1-3s"], "rule_mode": "classic", "controls_per_run": 2, "run_at": "2026-11-05T06:00:00.000Z", "last_in_control_run_at": "2026-11-05T01:00:00.000Z", "hold_since": "2026-11-05T01:00:00.000Z", "rejected_at": "2026-11-05T06:00:05.000Z" }`

### 3.22 `engagement.booking.confirmed.v1`

| Field | Value |
|---|---|
| Producer | C16 (`engagement`) — Phase 3 (BLOCKED B1 may move earlier) |
| Consumers | C4 (`booking_kind = centre_visit` only: its consumer calls its own `createOrderFromBooking` logic → `pre_registered` order), C17 (`home_collection`: C17 creates the home visit and, at assignment, the order through `FrontdeskPort.createOrderFromBooking` — 08 R7) |
| Trigger | Commit of booking transition to `confirmed` (slot reserved, patient identity verified per C16 PRD). |
| Aggregate | `booking` |
| Idempotency key | `<booking_id>:confirmed` |
| PHI class | P3 (orderables linked to patient id). Home address is **not** in the event: `home_address_id` is a reference consumers resolve via authorised calls. |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["booking_id", "patient_id", "branch_id", "centre_id", "booking_kind", "slot_start", "slot_end",
               "orderable_ids", "confirmed_at"],
  "properties": {
    "booking_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "patient_id":   { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "branch_id":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":    { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "booking_kind": { "enum": ["centre_visit", "home_collection"] },
    "slot_start":   { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "slot_end":     { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "orderable_ids": { "type": "array", "minItems": 1, "maxItems": 50, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } },
    "home_address_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "referrer_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "confirmed_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
Patient identity across engagement and frontdesk: `patient_id` is the `frontdesk.patients` id (C16 resolves/creates via its flow before confirming; mechanism in C16 PRD). Example payload: `{ "booking_id": "01a1a98a-ac40-7000-8000-000000120001", "patient_id": "01a1a98a-ac40-7000-8000-000000040001", "branch_id": "01a1a98a-ac40-7000-8000-000000010001", "centre_id": "01a1a98a-ac40-7000-8000-000000020002", "booking_kind": "home_collection", "slot_start": "2026-11-06T01:15:00.000Z", "slot_end": "2026-11-06T01:45:00.000Z", "orderable_ids": ["01a1a98a-ac40-7000-8000-000000070002"], "home_address_id": "01a1a98a-ac40-7000-8000-000000190001", "confirmed_at": "2026-11-05T09:00:00.000Z" }`

### 3.23 `homecollection.collection.synced.v1`

| Field | Value |
|---|---|
| Producer | C17 (`homecollection`) — Phase 3 |
| Consumers | C4 (record captured payments as ledger entries), C5 (specimens → `collected`, then `in_transit`), **C16** (completes the `home_collection` booking named by `booking_id` — 08 A19 D-120). C4 and C5 tolerate `booking_id`. |
| Trigger | Commit of a sync upload transaction that applied ≥1 offline mutation for a visit (append-only idempotent mutations, server-wins — 04 S17; REQ-ARCH-067). One event per visit per upload batch. JWT must be valid at upload (no expired-token grace — 04 A7). |
| Aggregate | `home_visit`, seq = visit version |
| Idempotency key | `<visit_id>:sync:<sorted client_mutation_ids sha256>` |
| PHI class | P1 (no GPS, no names; location stays in `homecollection`) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["visit_id", "order_id", "phlebotomist_membership_id", "synced_at", "collections", "payments"],
  "properties": {
    "visit_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "order_id":  { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "phlebotomist_membership_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "booking_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "synced_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "collections": { "type": "array", "maxItems": 50, "items": {
      "type": "object", "additionalProperties": false,
      "required": ["client_mutation_id", "specimen_id", "barcode_verified", "collected_at_device"],
      "properties": { "client_mutation_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
                      "specimen_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
                      "barcode_verified": { "type": "boolean" },
                      "collected_at_device": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" } } } },
    "payments": { "type": "array", "maxItems": 10, "items": {
      "type": "object", "additionalProperties": false,
      "required": ["client_mutation_id", "payment_method_code", "amount", "captured_at_device"],
      "properties": { "client_mutation_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
                      "payment_method_code": { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
                      "amount": { "$ref": "urn:lims:event:_defs.v1#/$defs/Money" },
                      "reference": { "type": "string", "minLength": 1, "maxLength": 100 },
                      "captured_at_device": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" } } } }
  }
}
```
Constraint: `collections` and `payments` not both empty. `booking_id` (08 A19 D-120; P-5): present iff the visit has `kind = 'booking'` (C17 `visits.booking_id`); no payload field expresses the visit kind, so the condition is stated here and the field is not in `required`. The trigger also covers a dispatcher "apply" of a held collection (payments empty) (CR-C17-006). `collected_at_device` / `captured_at_device` = server-corrected capture time; `payments[].reference` = optional operator-entered payment reference (CR-C17-006). C4 uses `client_mutation_id` as the ledger entry's idempotency key (one ledger row per mutation). Example payload: `{ "visit_id": "01a1a98a-ac40-7000-8000-000000130001", "order_id": "01a1a98a-ac40-7000-8000-000000050002", "phlebotomist_membership_id": "01a1a98a-ac40-7000-8000-000000030009", "synced_at": "2026-11-06T02:40:00.000Z", "collections": [ { "client_mutation_id": "01a1a98a-ac40-7000-8000-0000001a0001", "specimen_id": "01a1a98a-ac40-7000-8000-000000090011", "barcode_verified": true, "collected_at_device": "2026-11-06T01:27:00.000Z" } ], "payments": [ { "client_mutation_id": "01a1a98a-ac40-7000-8000-0000001a0002", "payment_method_code": "cash", "amount": {"amount_paisa": 180000, "currency": "NPR"}, "captured_at_device": "2026-11-06T01:30:00.000Z" } ] }`

### 3.24 `engagement.booking.cancelled.v1` (accepted addition A5)

| Field | Value |
|---|---|
| Producer | C16 (`engagement`) — Phase 3 (BLOCKED B1 may move earlier) |
| Consumers | C4 (void the `pre_registered` order created from the booking; an order already `registered` is **not** cancelled automatically — C4 flags it for front-desk review), C17 (drop or unassign the home visit; a visit already `in_progress`/`completed` is flagged, not dropped). For `home_collection` bookings C4 looks up `booking_links (source 'home_collection', source_ref_id = home_visit_id)` and raises a review item if a registered order exists (08 R7). |
| Trigger | Commit of a booking transition from `confirmed` or `checked_in` to `cancelled` (C16 hand-off; by the patient in the app, by staff, or by C16's no-show/expiry rule — C16 PRD). Bookings cancelled before confirmation emit nothing (no consumer was told about them). |
| Aggregate | `booking`, seq = booking version |
| Idempotency key | `<booking_id>:cancelled` |
| Ordering | May arrive before `engagement.booking.confirmed.v1` is processed: consumers that have not yet seen the booking record the cancellation in their inbox-backed read model and ignore the later confirmation if `aggregate.seq` is lower. |
| PHI class | P1 (ids, codes and times only; no free-text reason) |

```json
"Payload": {
  "type": "object", "additionalProperties": false,
  "required": ["booking_id", "patient_id", "booking_kind", "reason_code", "cancelled_by_kind", "cancelled_at"],
  "properties": {
    "booking_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "patient_id":        { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "booking_kind":      { "enum": ["centre_visit", "home_collection"] },
    "reason_code":       { "$ref": "urn:lims:event:_defs.v1#/$defs/Code" },
    "cancelled_by_kind": { "enum": ["patient", "staff", "system"] },
    "order_id":          { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "home_visit_id":     { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "slot_start":        { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "cancelled_at":      { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }
  }
}
```
`order_id` is present when C4 had already created a pre-registration for the booking (known to C16 from C4's HTTP response or read model); `home_visit_id` when C17 had already created a visit. `reason_code` is from the tenant coded set `engagement.cs_booking_cancel_reasons` (seed [CONV]: `patient_request`, `no_show`, `slot_expired`, `duplicate`, `lab_unavailable`). Example payload: `{ "booking_id": "01a1a98a-ac40-7000-8000-000000120001", "patient_id": "01a1a98a-ac40-7000-8000-000000040001", "booking_kind": "home_collection", "reason_code": "patient_request", "cancelled_by_kind": "patient", "order_id": "01a1a98a-ac40-7000-8000-000000050002", "home_visit_id": "01a1a98a-ac40-7000-8000-000000130001", "slot_start": "2026-11-06T01:15:00.000Z", "cancelled_at": "2026-11-05T12:00:00.000Z" }`

### 3.25 Event summary matrix

| # | Event | Producer | Consumers | Aggregate | PHI | Idempotency key |
|---|---|---|---|---|---|---|
| 1 | frontdesk.order.created.v1 | C4 | C5 C6 C8 C17 | order | P3 | order:created |
| 2 | frontdesk.order.items_changed.v1 | C4 | C5 C6 | order | P3 | order:items:version |
| 3 | frontdesk.order.cancelled.v1 | C4 | C5 C6 C8 C13 | order | P1 | order:cancelled |
| 4 | billing.invoice.issued.v1 | C4 | C8 | invoice | P1 | invoice:issued |
| 5 | billing.balance.changed.v1 | C4 | C6 C16 | order_balance | P1 | order:balance:version |
| 6 | billing.invoice.cancelled.v1 | C4 | C8 | invoice | P1 | invoice:cancelled |
| 7 | lab.specimen.status_changed.v1 | C5 | C4 (`recollection_ordered` only — 08 A13 D-6) C6 C8 C9 C10 C11 C13 C16 C17 | specimen | P1 | specimen:status:version |
| 8 | lab.specimen.rejected.v1 | C5 | C4 C16 C17 | specimen | P1 | specimen:rejected |
| 9 | lab.result.verified.v1 | C5 | C8 C9 C12 | result | P3 | result:verified:v:rowv |
| 10 | lab.result.approved.v1 | C5 | C6 C8 C11 C14 | result | P3 | result:approved:v |
| 11 | lab.result.amended.v1 | C5 | C6 C8 C11 C14 | result | P3 | result:amended:v |
| 12 | lab.order.ready_for_report.v1 | C5 | C6 | order | P1 | order:ready:hash |
| 13 | lab.critical_value.detected.v1 | C5 | C6 C8 | result | P3 | result:critical:v:hash |
| 14 | instruments.result.received.v1 | C7 | C5 C9 C10 C12 | instrument_message | P3+P2 | 04 N10 result key |
| 15 | instruments.qc.received.v1 | C7 | C5 C9 C12 | instrument_message | P0 | instrument:qc:… |
| 16 | instruments.agent.health_changed.v1 | C7 | C1 (metrics) C8 | agent | P0 | agent:health:version |
| 17 | reporting.report.released.v1 | C6 | C5 C8 C9 C13 C16 | report | P1 | report:released:v |
| 18 | reporting.delivery.status_changed.v1 | C6 | C8 | delivery | P1 | delivery:status:version |
| 19 | catalog.changed.v1 | C3 | C4 C5 C6 C7 C13 C16 | catalog | P0 | tenant:catalog:revision |
| 20 | payments.intent.settled.v1 | C15 | C4 | payment_intent | P1 | gateway:txn:settled |
| 21 | quality.qc_run.rejected.v1 | C9 | C5 | qc_run | P0 | qc_run:rejected |
| 22 | engagement.booking.confirmed.v1 | C16 | C4 (centre_visit only — 08 R7) C17 | booking | P3 | booking:confirmed |
| 23 | homecollection.collection.synced.v1 | C17 | C4 C5 C16 (08 A19 D-120) | home_visit | P1 | visit:sync:hash |
| 24 | engagement.booking.cancelled.v1 (A5) | C16 | C4 (incl. home_collection review check — 08 R7) C17 | booking | P1 | booking:cancelled |
| 26 | instruments.calibration.received.v1 (08) | C7 | C12 | instrument_message | P0 | instrument:cal:… |

### 3.26 `instruments.calibration.received.v1` (08 §4.10, CR-C12-006)

| Field | Value |
|---|---|
| Producer | C7 (`instruments`) |
| Consumers | C12 (per-calibration consumption deduction) |
| Trigger | Commit that stores a parsed record a driver classifies as calibrator (only drivers whose official manual classifies calibrator records — BLOCKED B2). |
| Aggregate | `instrument_message` |
| Idempotency key | `<instrument_id>:cal:<instrument_analyte_code>:<instrument_result_time or sha256(raw)>` |
| PHI class | P0 |

```json
"Payload": { "type": "object", "additionalProperties": false,
  "required": ["instrument_message_id", "instrument_id", "centre_id", "instrument_analyte_code", "mapping_status", "received_at"],
  "properties": {
    "instrument_message_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":             { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_analyte_code": { "type": "string", "minLength": 1, "maxLength": 64 },
    "mapping_status":        { "enum": ["mapped", "unmapped"] },
    "analyte_id":            { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "test_id":               { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "calibrator_id_raw":     { "type": "string", "maxLength": 64 },
    "calibrator_lot_raw":    { "type": "string", "maxLength": 64 },
    "instrument_result_time": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "received_at":           { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" } } }
```
Example payload: `{ "instrument_message_id": "01a1a98a-ac40-7000-8000-0000000d1003", "instrument_id": "01a1a98a-ac40-7000-8000-0000000d0001", "centre_id": "01a1a98a-ac40-7000-8000-000000020001", "instrument_analyte_code": "GLU", "mapping_status": "mapped", "analyte_id": "01a1a98a-ac40-7000-8000-000000080002", "calibrator_id_raw": "CAL-SYN-1", "calibrator_lot_raw": "LOT-SYN-07", "instrument_result_time": "2026-11-05T00:45:00.000Z", "received_at": "2026-11-05T00:45:04.000Z" }`

---
## 4. Ports (all 10 from 01 §5.1; LabPort extended by accepted addition A1; §4.15–§4.17 added by the CR register 08)

General rules (02-CV §8): first argument `ctx: RequestContext`; run inside `ctx.tx` (never open their own transaction); tenant only from `ctx`; throw `LimsError` with a code from §8; TS member names camelCase; outputs are plain JSON-serialisable objects. Performance budgets below are **[CONV] targets** for in-process p95 at the 04 §14 capacity assumptions (N = 10 labs); they are validated by the load test of REQ-SEC-025, not facts.

### 4.1 `contracts/ports/common.ts`

```ts
// contracts/ports/common.ts  (C0)
export type Uuid = string & { readonly __brand: 'Uuid' };           // any RFC 9562 version (GoTrue subs)
export type Uuidv7 = string & { readonly __brand: 'Uuidv7' };       // ids this system generates (04 D9)
export type IsoUtc = string & { readonly __brand: 'IsoUtc' };       // 2026-11-05T04:15:00.000Z
export type IsoDate = string & { readonly __brand: 'IsoDate' };     // 1983-04-12 (A.D.)
export type DecimalString = string & { readonly __brand: 'DecimalString' }; // "13.40"
export type Code = string;                                          // coded-set code, ≤64 chars

export interface Money { readonly amountPaisa: number; readonly currency: 'NPR' } // safe integer paisa

export type ActorType = 'user' | 'system' | 'device' | 'portal' | 'patient' | 'partner';
export interface Actor {
  readonly type: ActorType;
  readonly id: Uuid;                 // user sub, system actor id, device/agent id, portal link id
  readonly membershipId?: Uuidv7;
  readonly supportSessionId?: Uuidv7;
}

/** Opaque DB transaction handle from the core; ports MUST use it for every query. */
export interface DbTx { readonly __brand: 'DbTx' }

export interface RequestContext {
  readonly tenantId: Uuidv7;
  readonly actor: Actor;
  readonly requestId: Uuidv7;
  readonly tx: DbTx;
  readonly now: () => IsoUtc;        // injected clock
  readonly ports: PortRegistry;      // other ports (a port impl may call other ports)
}

export interface PortRegistry {
  readonly CatalogPort: import('./CatalogPort').CatalogPort;
  readonly FrontdeskPort: import('./FrontdeskPort').FrontdeskPort;
  readonly BillingPort: import('./BillingPort').BillingPort;
  readonly LabPort: import('./LabPort').LabPort;
  readonly ReportingPort: import('./ReportingPort').ReportingPort;
  readonly IdentityPort: import('./IdentityPort').IdentityPort;
  readonly NotificationPort: import('./NotificationPort').NotificationPort;
  readonly PaymentProviderPort: import('./PaymentProviderPort').PaymentProviderPort;
  readonly SmartReportPort: import('./SmartReportPort').SmartReportPort;
  readonly QualityPort: import('./QualityPort').QualityPort;
  readonly BillingCommandPort: import('./BillingCommandPort').BillingCommandPort;   // added by 08 (§4.15; consumer allowlist: frontdesk only)
  readonly RenderPort: import('./RenderPort').RenderPort;                           // added by 08 (§4.16)
  readonly EngagementPort: import('./EngagementPort').EngagementPort;               // added by 08 (§4.17)
}
// Reserved, DEFER (B4): LegacyPatientImportPort, LegacyResultImportPort, LegacyDocumentImportPort, legacy-common.ts (08 §4.14).

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }

/** Generated from contracts/errors.yaml by tools/codegen (C0). */
export type ErrorCode = import('./generated/error-codes').ErrorCode;
export class LimsError extends Error {
  constructor(readonly code: ErrorCode, readonly safeDetail?: string, readonly fieldErrors?: readonly FieldError[]) {
    super(code);
  }
}
export interface FieldError { readonly path: string; readonly code: ErrorCode; readonly message: string }

export type Priority = 'routine' | 'urgent';
export type Sex = 'male' | 'female' | 'other' | 'unknown';
export type SpecimenStatus = 'ordered' | 'collected' | 'in_transit' | 'received' | 'aliquoted' | 'in_process'
  | 'resulted' | 'verified' | 'approved' | 'reported' | 'rejected' | 'recollection_ordered' | 'stored' | 'discarded';
export type ResultStatus = 'pending' | 'resulted' | 'verified' | 'approved' | 'cancelled';
```

Common errors every method may throw (not repeated per method): `common.not_found` (id not visible in this tenant/centre scope), `common.validation_failed` (input violates the declared type/limits), `common.internal`.

---

### 4.2 `CatalogPort` — owner C3; consumers C4, C5, C6, C7, C9, C10, C11, C12, C13, C14, C16 (`getTaxRate` added by 08 A2.2; `getPriceListStatus` added by 08 A24.1, consumer C16)

```ts
// contracts/ports/CatalogPort.ts
import type { RequestContext, Uuidv7, IsoUtc, IsoDate, Money, Code, DecimalString, Priority, Sex } from './common';
export const CATALOG_PORT_VERSION = 1 as const;

export type WorkflowType = 'standard' | 'narrative' | 'microbiology' | 'anatomic' | 'molecular' | 'attachment' | 'outsourced';
export type ResultType = 'numeric' | 'text' | 'ordinal' | 'coded' | 'attachment' | 'narrative';

export interface AnalyteDefinition {
  readonly id: Uuidv7; readonly code: Code; readonly name: string;
  readonly resultType: ResultType;
  readonly unitCode?: Code; readonly decimals?: number;          // display decimals
  readonly methodName?: string;                                  // printed "METHOD : …" (00 §4)
  readonly formula?: { readonly expression: string; readonly inputAnalyteCodes: readonly Code[];
                       readonly inputUnitCodes?: Readonly<Record<Code, Code>> };   // stored in master, not code (01 §2.2); inputUnitCodes added by 08
  readonly ordinalSetCode?: Code;                                // e.g. urine 1+/2+ (04 D14)
  readonly ordinalSetValues?: readonly { readonly code: string; readonly display: string; readonly sortOrder: number }[]; // active values of ordinalSetCode, sortOrder asc; present iff ordinalSetCode is set (08 A13 D-9; codes ^[A-Z0-9_+\-]{1,16}$)
  readonly reportable: boolean; readonly sortOrder: number;
  readonly reportSubheading?: string;                            // e.g. "RBC parameters" (00 §4)
  readonly printName?: string;                                   // added by 08 (CR-C3-001)
}
export interface TestDefinition {
  readonly id: Uuidv7; readonly code: Code; /* short name e.g. CBC (00 A6) */ readonly name: string;
  readonly departmentId: Uuidv7; readonly departmentCode: Code;
  readonly specimenTypeCodes: readonly Code[]; readonly containerCode?: Code;
  readonly workflowType: WorkflowType;
  readonly analytes: readonly AnalyteDefinition[];
  readonly tatTargetSeconds?: { readonly routine?: number; readonly urgent?: number }; // data only (C3 scope)
  readonly isActive: boolean; readonly revision: number;
  // added by 08 (CR-C3-001, R25, CR-C11-009)
  readonly departmentName?: string;                               // R25 (C6 report headings)
  readonly tatTargetSegment?: 'within_lab' | 'total';
  readonly specimenReportLabel?: string;                          // printed "Specimen:" line (00 §4)
  readonly usesExistingMaterial?: boolean;                        // CR-C11-009: C5 creates results without a specimen requirement
}
export interface PanelDefinition {
  readonly id: Uuidv7; readonly code: Code; readonly name: string;
  readonly panelKind: 'clinical' | 'package';                    // package = commercial bundle (00 §4 "HEALTH PACKAGE")
  readonly members: readonly { readonly kind: 'test' | 'panel'; readonly id: Uuidv7 }[];
  readonly sexRestriction?: 'male' | 'female';
  readonly isActive: boolean; readonly revision: number;
}
export interface ResolvedOrderables {
  readonly orderables: readonly { readonly orderableId: Uuidv7; readonly kind: 'test' | 'panel'; readonly testIds: readonly Uuidv7[] }[];
  readonly tests: readonly TestDefinition[];                     // de-duplicated
  readonly specimenRequirements: readonly { readonly specimenTypeCode: Code; readonly containerCode?: Code; readonly testIds: readonly Uuidv7[] }[];
  readonly catalogRevision: number;
}
export interface PriceQuery {
  readonly orderableId: Uuidv7;
  readonly context: { readonly priceListId?: Uuidv7; readonly creditPartyId?: Uuidv7; readonly referrerId?: Uuidv7; readonly centreId?: Uuidv7 };
  readonly priority: Priority;
  readonly at: IsoUtc;
}
export interface PriceQuote {
  readonly orderableId: Uuidv7; readonly priceListId: Uuidv7; readonly priceListVersion: number;
  readonly source: 'explicit' | 'credit_party' | 'referrer' | 'centre' | 'tenant_default';
  readonly unitPrice: Money; readonly urgentSurcharge?: Money;
  readonly tax: { readonly vat: 'exempt' | 'taxable'; readonly otherTaxCode?: Code;   // 04 L15/L25 BLOCKED B7 → configurable
                  readonly vatRateBp?: number; readonly otherTaxRateBp?: number; readonly hsCode?: string };  // added by 08: rates owned by C3 (R18)
}
export interface RangeQuery { readonly analyteId: Uuidv7; readonly sex: Sex; readonly ageDays?: number; readonly specimenTypeCode?: Code; readonly at: IsoUtc;
  readonly birthOn?: IsoDate }                                   // added by 08: exact calendar age when known; ageDays optional (08 A17.1): absent = age unknown
export interface ReferenceRangeMatch {
  readonly referenceRangeId: Uuidv7; readonly version: number;   // result rows snapshot this (04 D14)
  readonly low?: DecimalString; readonly high?: DecimalString; readonly text?: string; // "Biological Ref Range" column (00 §4)
  readonly unitCode?: Code;
  readonly kind?: 'numeric' | 'text' | 'ordinal'; readonly normalCodes?: readonly Code[];   // added by 08 (CR-C3-001)
}
export interface CriticalLimitsMatch { readonly criticalLimitId: Uuidv7; readonly version: number; readonly low?: DecimalString; readonly high?: DecimalString; readonly abnormalCodes?: readonly Code[] }
export interface InstrumentCodeQuery {
  readonly instrumentId: Uuidv7;
  readonly direction: 'inbound' | 'outbound';                    // inbound: instrument code → analyte; outbound: test/analyte → instrument code (host query)
  readonly instrumentCode?: string; readonly analyteId?: Uuidv7; readonly testId?: Uuidv7;
}
export interface InstrumentCodeMapping {
  readonly mappingId: Uuidv7; readonly instrumentId: Uuidv7; readonly instrumentCode: string;
  readonly analyteId: Uuidv7; readonly testId: Uuidv7;
  readonly unitConversion?: { readonly fromUnitRaw: string; readonly toUnitCode: Code; readonly factor: DecimalString };
  readonly flagMap?: Readonly<Record<string, Code>>;
}
// ---- added by 08 (CR-C3-001 + C4-002 + C5-001 + C13-007)
export type CatalogPartyPurpose = 'display' | 'notification' | 'billing';
export interface ReferrerProfile {
  readonly referrerId: Uuidv7; readonly canonicalReferrerId: Uuidv7; readonly code: Code; readonly displayName: string;
  readonly qualification?: string; readonly registrationNo?: string; readonly isVerified: boolean; readonly isActive: boolean;
  readonly contact?: { readonly phoneE164?: string; readonly email?: string } }      // purpose 'notification' + actor user|system only
export interface CreditPartyProfile {
  readonly creditPartyId: Uuidv7; readonly code: Code; readonly name: string;
  readonly kind: 'hospital' | 'company' | 'clinic' | 'partner_lab' | 'insurer' | 'other';
  readonly allowsCredit: boolean; readonly isActive: boolean; readonly priceListId?: Uuidv7;
  readonly pan?: string; readonly billingAddressText?: string;                     // purpose 'billing' only (C4 receipts/periodic invoices)
  readonly contact?: { readonly phoneE164?: string; readonly email?: string } }      // purpose 'notification' only
export interface CommentCodeResolution {
  readonly resolved: readonly { readonly code: Code; readonly commentCodeId: Uuidv7; readonly version: number; readonly departmentId?: Uuidv7; readonly text: string }[];
  readonly unknown: readonly Code[] }

export interface CatalogPortV1 {
  /** @throws common.not_found; catalog.test_inactive (only when opts require active) */
  getTest(ctx: RequestContext, input: { testId: Uuidv7; asOf?: IsoUtc; requireActive?: boolean }): Promise<TestDefinition>;
  /** @throws common.not_found */
  getPanel(ctx: RequestContext, input: { panelId: Uuidv7; asOf?: IsoUtc; requireActive?: boolean }): Promise<PanelDefinition>;
  /** Expands panels recursively to tests; @throws common.not_found, catalog.test_inactive, catalog.panel_cycle */
  resolveOrderables(ctx: RequestContext, input: { orderableIds: readonly Uuidv7[]; asOf?: IsoUtc }): Promise<ResolvedOrderables>;
  /** @throws common.not_found, catalog.no_price, catalog.tax_config_missing */
  priceFor(ctx: RequestContext, input: PriceQuery): Promise<PriceQuote>;
  /** `ageDays` absent (08 A17.1): only rows with no age restriction (age bounds NULL) match.
   *  @throws common.not_found, catalog.no_reference_range */
  referenceRangeFor(ctx: RequestContext, input: RangeQuery): Promise<ReferenceRangeMatch>;
  /** Returns undefined when the analyte has no critical limits configured. `ageDays` absent (08 A17.1): only rows with no age
   *  restriction match. @throws common.not_found */
  criticalLimitsFor(ctx: RequestContext, input: RangeQuery): Promise<CriticalLimitsMatch | undefined>;
  /** @throws catalog.instrument_code_unmapped */
  mapInstrumentCode(ctx: RequestContext, input: InstrumentCodeQuery): Promise<InstrumentCodeMapping>;
  // ---- added by 08
  /** @throws common.not_found; auth.forbidden (purpose 'notification' from device/portal/patient/partner actor) */
  getReferrer(ctx: RequestContext, input: { referrerId: Uuidv7; purpose: 'display' | 'notification' }): Promise<ReferrerProfile>;
  /** @throws common.not_found; auth.forbidden (purpose 'notification'|'billing' from a non user/system actor) */
  getCreditParty(ctx: RequestContext, input: { creditPartyId: Uuidv7; purpose: CatalogPartyPurpose }): Promise<CreditPartyProfile>;
  /** Department-specific active code wins over tenant-wide; unknown/inactive codes → `unknown`; ≤ 50 codes.
   *  `asOf` returns the text version effective then. @throws common.validation_failed */
  resolveCommentCodes(ctx: RequestContext, input: { codes: readonly Code[]; departmentId?: Uuidv7; asOf?: IsoUtc }): Promise<CommentCodeResolution>;
  // ---- added by 08 Addendum A2.2 (CR-C12-010, additive). Signature verbatim from 08 Addendum A4.1 (supersedes the A2.2 text).
  /** Rate of one tax code effective on date `on` (tenant-local ISO date), read from C3's tax-rule data (R18 single source of rates).
   *  No 'exempt' kind (08 A4.1): exemption is a treatment (C3 `tax_rules.vat_treatment`; C12 purchase lines with no tax code), not a
   *  rate — C12 never calls getTaxRate for an exempt line. `effectiveFrom` is null for a rate with no versioned history (the global VAT
   *  row in `g_tax_types`); never derived from `created_at`.
   *  @throws catalog.tax_config_missing (no rate for taxCode effective on `on`) */
  getTaxRate(ctx: RequestContext, input: { taxCode: string; on: string /* ISO date, tenant timezone */ }): Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat' | 'other'; effectiveFrom: string | null }>;
  // ---- added by 08 Addendum A24.1 (CR-C16-023, additive). Consumer C16 (staff validation of a price_list_id). If C3's price-list
  //      status set differs, C3's set wins and this signature follows it. Request handlers never read `v_pub_*` views (R25/P-21).
  /** @throws common.not_found */
  getPriceListStatus(ctx: RequestContext, input: { priceListId: Uuidv7 }): Promise<{ priceListId: Uuidv7; isActive: boolean; status: 'draft' | 'published' | 'superseded' | 'discarded' }>;   // C3 price_list_versions status set (A24.1: C3's set wins). Derived list-level value (C3 TRD §7.4a [CONV]): 'published' if any version is published, else 'draft' if an open draft exists, else 'discarded'; 'superseded' is never returned; usable list = isActive && status === 'published'
}
export type CatalogPort = CatalogPortV1;
```

| Aspect | Specification |
|---|---|
| Semantics | Read-only view of the tenant's catalog (global master + tenant overrides — REQ-ARCH-035). `asOf` returns the version effective at that instant (versioned ranges/units — 04 D14), default `ctx.now()`. |
| Price precedence [CONV default; C3 PRD may change by CR] | explicit `priceListId` > credit party > referrer (doctor) > centre > tenant default (00 E3 "different price lists for each doctor, hospital or collection centre"). `source` tells the caller which won. |
| Invariants | Same `(input, catalogRevision)` ⇒ same output. Deactivated entities remain readable (reports re-render). Money in integer paisa. No PHI. |
| Tax rates (08 R18, A2.2, A4.1) | C3 is the single owner of tax-rate values for sales **and** purchase sides. `priceFor` returns the rates for an orderable; `getTaxRate` returns the rate of one tax code on a date (consumer C12 purchase side: C12 stores tax code per item/supplier and `vat_in_cost`, never rate values). Exemption is a treatment, not a rate: C12 never calls `getTaxRate` for an exempt line (08 A4.1). |
| Ownership note | Binding (X4): instrument analyte-code maps are **catalog data owned by C3** (`catalog.instrument_code_maps`); C7's mapping UI writes them through C3's HTTP API (`/v1/catalog/instrument-code-maps`); the `instruments` schema holds only driver/channel configuration. |
| Performance | p95 ≤ 20 ms per call with warm cache; `resolveOrderables` ≤ 50 ms for 50 orderables. Caches invalidated by `catalog.changed.v1`. |
| Unknown patient age (08 A17.1, CR-C5-012) | `RangeQuery.ageDays` is optional. When absent, C3 matches only reference-range and critical-limit rows with **no age restriction** (age bounds NULL). If such rows exist, flags and critical-value checks run normally. If none exist, C5 marks the result `range_unavailable_age_unknown`, it is **never auto-verified**, and the verification screen shows "Age unknown — reference range and critical check not applied". C4 registration keeps requiring date of birth or age; this path is the exception. |
| Tenant context | required; global rows visible to all tenants, tenant rows only to their tenant. |
| Fake must support | seeded synthetic catalog (≥3 departments, CBC-style multi-analyte test, a clinical panel, a package with `sexRestriction`, a formula analyte, an ordinal analyte, an attachment test, a microbiology test); age/sex-banded ranges; two price lists with precedence; deterministic `catalogRevision`; `failNext`. |
| Contract tests | (1) getTest unknown id → not_found; (2) other tenant's tenant-specific test → not_found; (3) `asOf` before a new range version returns old version; (4) resolveOrderables de-duplicates a test present in two panels; (5) panel cycle → `catalog.panel_cycle`; (6) priceFor precedence order across all five sources; (7) priceFor urgent adds surcharge only when rule exists; (8) no price → `catalog.no_price`; (9) referenceRangeFor picks the age/sex band at boundaries (day 0, exact upper age); (10) criticalLimitsFor returns undefined when unset; (11) mapInstrumentCode inbound and outbound round-trip; (12) unmapped → `catalog.instrument_code_unmapped`; (13) deactivated test readable with `requireActive` unset, rejected with `requireActive: true`. **Added by 08:** (14) `getReferrer` display hides contact, notification shows it; (15) merged doctor → canonical id; (16) `resolveCommentCodes` department precedence + unknown list; (17) `priceFor` returns `vatRateBp = 1300` for taxable; (18) `catalog.tax_config_missing`; (19) text-kind range has no low/high; (20) `birthOn` exact-age boundary; (21) critical ordinal `abnormalCodes`; (22) unit/method mismatch → `catalog.no_reference_range`; (23) explicit inactive price list → not_found (C3 02-TRD §14); (24) purpose `billing` returns `pan`/`billingAddressText`, never `contact`; (25) `TestDefinition.departmentName` present; (26) `resolveCommentCodes` with `asOf` before a text change returns the old text. **Added by 08 A2.2:** (27) `getTaxRate` returns the rate effective on `on` (version boundary: day before / on `effectiveFrom`); (28) `getTaxRate` for an unknown code, or a code with no rate effective on `on` → `catalog.tax_config_missing`. **Added by 08 A4.1:** (29) `getTaxRate` for the global VAT code (no versioned history) → `kind: 'vat'`, `effectiveFrom: null`; (30) result `kind` is never `'exempt'`. **Added by 08 A13 D-9:** (31) analyte with `ordinalSetCode` → `ordinalSetValues` equals the active set (C3 fills it from `g_value_set_values` / `cs_value_set_values`; C5 validates entries against it and flags `A` via `ReferenceRangeMatch.normalCodes`). |

### 4.3 `FrontdeskPort` — owner C4; consumers C5, C6, C10, C11, C13, C14, C15, C16, C17 (C10/C11 from batch-2 C11 m#30; C14 with existing purpose `lab_display`, C15 `getOrderSummary` only, staff or system — 08 A19 D-110, CR-C14-009, CR-C15-014)

```ts
// contracts/ports/FrontdeskPort.ts
import type { RequestContext, Uuidv7, IsoUtc, IsoDate, Priority, Sex } from './common';
export const FRONTDESK_PORT_VERSION = 1 as const;

export type OrderStatus = 'pre_registered' | 'registered' | 'in_progress' | 'completed' | 'cancelled';
export interface OrderSummary {
  readonly orderId: Uuidv7; readonly registrationNo: string; readonly patientId: Uuidv7;
  readonly branchId: Uuidv7; readonly centreId: Uuidv7;
  readonly visitType: 'opd' | 'ipd'; readonly billingMode: 'cash' | 'credit';
  readonly creditPartyId?: Uuidv7; readonly referrerId?: Uuidv7;
  readonly priority: Priority; readonly status: OrderStatus;
  readonly source: 'front_desk' | 'engagement_booking' | 'home_collection' | 'partner_manifest';
  readonly sourceRefId?: Uuidv7;
  readonly items: readonly { readonly orderItemId: Uuidv7; readonly orderableId: Uuidv7; readonly orderableKind: 'test' | 'panel';
                             readonly testIds: readonly Uuidv7[]; readonly priority: Priority; readonly status: 'active' | 'removed' | 'cancelled';
                             readonly outsourced: boolean }[];
  readonly registeredAt?: IsoUtc; readonly version: number;
  readonly partnerId?: Uuidv7;                                   // added by 08 (R25, CR-C4-006)
}
export type DemographicsPurpose = 'report_render' | 'label_print' | 'notification' | 'instrument_host_query'
  | 'portal_display' | 'partner_display' | 'smart_report' | 'home_visit'
  | 'result_evaluation' | 'lab_display' | 'patient_app_link';   // added by 08 (CR-C5-003, C16-007)
export interface PatientDemographics {
  readonly patientId: Uuidv7; readonly patientCode: string;     // per-tenant patient code ("lab code", 00 A2)
  readonly fullName?: string; readonly sex: Sex;
  readonly birthOn?: IsoDate; readonly ageAtOrder?: { readonly years: number; readonly months: number; readonly days: number };
  readonly phoneE164?: string; readonly email?: string;
  readonly consents: { readonly sms: boolean; readonly whatsapp: boolean; readonly email: boolean; readonly shareWithReferrer: boolean; readonly consentTextVersion: string };
  readonly status: 'active' | 'merged' | 'anonymised';           // added by 08: all purposes (CR-C16-007)
  readonly contactPresence?: { readonly phone: boolean; readonly email: boolean };   // added by 08: purpose 'notification' for non-system actors (CR-C6-015)
}
export interface BookingOrderInput {
  readonly source: 'engagement_booking' | 'home_collection' | 'partner_manifest';
  readonly sourceRefId: Uuidv7;                                  // booking id / visit id / manifest line id
  readonly patient: { readonly patientId: Uuidv7 } | { readonly newPatient: { readonly fullName: string; readonly sex: Sex; readonly birthOn?: IsoDate; readonly ageYears?: number; readonly phoneE164?: string; readonly consents: PatientDemographics['consents'] } };
  readonly branchId: Uuidv7; readonly centreId: Uuidv7;
  readonly referrerId?: Uuidv7; readonly creditPartyId?: Uuidv7;
  readonly orderableIds: readonly Uuidv7[]; readonly priority: Priority;
  readonly scheduledAt?: IsoUtc;
  readonly confirmImmediately: boolean;                          // true → 'registered' (emits order.created); false → 'pre_registered'
  readonly idempotencyKey: string;
  readonly partnerId?: Uuidv7;                                   // added by 08: required iff source = 'partner_manifest'; immutable on the order
}

export interface FrontdeskPortV1 {
  getOrderSummary(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<OrderSummary>;
  /** Field set depends on purpose (REQ-SEC-081). @throws auth.forbidden if the actor's permissions do not cover the purpose */
  getPatientDemographics(ctx: RequestContext, input: { patientId: Uuidv7; purpose: DemographicsPurpose }): Promise<PatientDemographics>;
  /** @throws frontdesk.booking_already_converted (same sourceRefId, different idempotencyKey), frontdesk.consent_required,
   *          catalog.test_inactive, catalog.no_price, frontdesk.patient_duplicate_suspected */
  createOrderFromBooking(ctx: RequestContext, input: BookingOrderInput): Promise<{ orderId: Uuidv7; registrationNo: string; status: 'pre_registered' | 'registered'; replayed: boolean }>;
  // ---- added by 08
  /** Missing/invisible ids omitted. ≤ 200 ids. @throws auth.forbidden (purpose not covered) */
  getPatientDemographicsBatch(ctx: RequestContext, input: { patientIds: readonly Uuidv7[]; purpose: DemographicsPurpose }): Promise<readonly PatientDemographics[]>;
  /** Engagement system actor only. Always creates a NEW patient (source 'self_service'); never returns an existing id.
   *  @throws frontdesk.consent_required, auth.forbidden */
  createSelfRegisteredPatient(ctx: RequestContext, input: { fullName: string; sex: Sex; birthOn?: IsoDate; ageYears?: number; phoneE164: string;
    consents: PatientDemographics['consents']; idempotencyKey: string }): Promise<{ patientId: Uuidv7; patientCode: string; duplicateSuspected: boolean; replayed: boolean }>;
}
export type FrontdeskPort = FrontdeskPortV1;
```

| Aspect | Specification |
|---|---|
| Field allowlist by purpose | `report_render`: fullName, sex, ageAtOrder, birthOn, patientCode · `label_print`: fullName, sex, ageAtOrder, patientCode · `notification`: phoneE164, email, consents (no name unless template needs it — §4.8) · `instrument_host_query`: sex, ageAtOrder only · `portal_display`/`partner_display`: masked fullName per R3-like rules + sex + age · `smart_report`: sex, ageAtOrder · `home_visit`: fullName, phoneE164, consents, birthOn, sex (CR-C17-003). **Added by 08:** `result_evaluation`: sex, ageAtOrder, birthOn (system, `lab.result.enter`/`lab.result.verify` holders) · `lab_display`: fullName, sex, ageAtOrder, patientCode (`lab.worklist.read` or `lab.status_board.read` holders, system) · `patient_app_link`: fullName, sex, birthOn, phoneE164, status (`engagement.link.issue` holders, engagement system actor) · `notification` by a non-system actor: consents + `contactPresence` only (no phoneE164/email); system actors keep the full set · `status` is returned for every purpose. Fields outside the allowlist are omitted. |
| Semantics | `createOrderFromBooking` is the synchronous path for C13 (partner manifests) and C17 (home visits); C16 bookings go async via `engagement.booking.confirmed.v1` whose C4 consumer calls the same logic. Prices are computed server-side by C4 via CatalogPort (REQ-SEC-046). Order creation owner per booking type: 08 R7 table; authorisation per `source` as in 08 R7 (`engagement_booking` → system actor only; `home_collection` → `homecollection.visit.assign` or system; `partner_manifest` → system actor of `partners` or `partners.manifest.receive`). |
| Invariants | Idempotent on `idempotencyKey` (replay returns same orderId, `replayed: true`). `registrationNo` immutable once assigned. Never returns another tenant's patient. Access to demographics is audited by the *calling* user-facing action (`access_log`), not by the port. |
| Performance | getOrderSummary ≤ 15 ms; getPatientDemographics ≤ 10 ms; createOrderFromBooking ≤ 150 ms (includes numbering + catalog). |
| Tenant context | required; centre scope applies (RLS) — a centre-scoped actor cannot read another centre's order. |
| Fake must support | seeded patients/orders for both synthetic tenants; purpose-based field filtering; idempotent replay; `frontdesk.booking_already_converted`; deterministic registration numbers (`0001SY000001`…). |
| Contract tests | (1) summary of other tenant's order → not_found; (2) centre-scoped actor, other centre → not_found; (3) demographics purpose `instrument_host_query` returns no name/phone; (4) `notification` returns consents; (5) createOrderFromBooking replay with same key → same orderId + `replayed: true`; (6) same sourceRefId new key → `frontdesk.booking_already_converted`; (7) `confirmImmediately: true` emits `frontdesk.order.created.v1` once (event spy); (8) `false` emits nothing; (9) inactive orderable → `catalog.test_inactive`; (10) new patient without required consents → `frontdesk.consent_required`. **Added by 08:** (11) `home_collection` `booking.confirmed` → no order; (12) cancel with a linked registered home order → review item = `frontdesk.order_flags` row kind `booking_cancelled_after_registration` (08 A2.12); (13) batch omits other-tenant ids; (14) `lab_display` returns no phone; (15) `notification` by user actor returns `contactPresence` only; (16) self-registration replay; (17) duplicate-suspected still new id; (18) `patient_app_link` refused without `engagement.link.issue`. |

### 4.4 `BillingPort` — owner C4; consumers C6, C13, C15, C16, C17 (callers staff/system only — 08 R8)

```ts
// contracts/ports/BillingPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Money, Code } from './common';
export const BILLING_PORT_VERSION = 1 as const;

export type ReleaseBasis = 'paid_in_full' | 'zero_balance' | 'credit_party' | 'override' | 'policy_not_enforced'
  | 'due_outstanding' | 'no_invoice';
export interface ReleaseEligibility {
  readonly orderId: Uuidv7; readonly eligible: boolean; readonly basis: ReleaseBasis;
  readonly balanceDue: Money; readonly overrideId?: Uuidv7; readonly evaluatedAt: IsoUtc;
}
export interface OrderBalance {
  readonly orderId: Uuidv7; readonly invoiced: Money; readonly paid: Money; readonly credited: Money;
  readonly balanceDue: Money; readonly balanceVersion: number; readonly asOf: IsoUtc;
}
export interface GatewayPaymentInput {
  readonly intentId: Uuidv7; readonly orderId: Uuidv7; readonly invoiceId?: Uuidv7;
  readonly gateway: 'esewa' | 'khalti' | 'fonepay'; readonly gatewayTxnRef: string;
  readonly amount: Money; readonly verifiedAt: IsoUtc;
  readonly allowExceedsDue?: boolean;          // added by 08: true → record full amount + finance_review_items 'gateway_payment_exceeds_due'
}
// ---- added by 08 (CR-C15-002)
export interface GatewayRefundInput {
  readonly refundId: Uuidv7; readonly intentId: Uuidv7; readonly orderId: Uuidv7;
  readonly gateway: 'esewa' | 'khalti' | 'fonepay'; readonly gatewayTxnRef: string;
  readonly amount: Money;                      // positive; stored negative, entry_kind 'refund', capture_kind 'gateway'
  readonly reasonCode: Code; readonly approvedByMembershipId: Uuidv7; readonly refundedAt: IsoUtc }

export interface BillingPortV1 {
  /** Hold-till-paid gate (00 D1; 01 §1.4): tenant setting releaseRequiresPayment; credit-party orders eligible; authorised override recorded by C6 via HTTP to billing. */
  getReleaseEligibility(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<ReleaseEligibility>;
  /** Append-only ledger write (04 P1; REQ-SEC-057). Idempotent on (gateway, gatewayTxnRef) (04 P6).
   *  @throws billing.amount_mismatch (amount ≠ intent amount recorded by C15), billing.payment_exceeds_due */
  recordGatewayPayment(ctx: RequestContext, input: GatewayPaymentInput): Promise<{ ledgerEntryId: Uuidv7; duplicate: boolean; balance: OrderBalance }>;
  getOrderBalance(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<OrderBalance>;
  // ---- added by 08
  /** Idempotent on refundId (idempotency_key 'gw_refund:'+refundId). @throws billing.ledger_reversal_invalid */
  recordGatewayRefund(ctx: RequestContext, input: GatewayRefundInput): Promise<{ ledgerEntryId: Uuidv7; duplicate: boolean; balance: OrderBalance }>;
}
export type BillingPort = BillingPortV1;
```

| Aspect | Specification |
|---|---|
| Semantics | `getReleaseEligibility` is the authoritative gate; `billing.balance.changed.v1` is only a hint. `recordGatewayPayment` is called by C15 inside its settle transaction (canonical); C4's `payments.intent.settled.v1` consumer calls the same code path idempotently. |
| Invariants | Ledger rows never updated/deleted; corrections are reversing rows (04 P1). Duplicate call with same `(gateway, gatewayTxnRef)` returns the original `ledgerEntryId` and `duplicate: true`. Balance never negative unless an overpayment rule is defined by C4 PRD (default: reject with `billing.payment_exceeds_due`). Billing data isolatable per tenant (04 D16). `capture_kind = 'gateway'` entries have `collected_by_membership_id = NULL`. |
| Performance | getReleaseEligibility ≤ 15 ms (bulk release calls it per order); recordGatewayPayment ≤ 50 ms; getOrderBalance ≤ 10 ms. |
| Tenant context | required. Callers are staff (`user`) or `system` actors only; C15 calls it in the verifying job/callback context (system) or in a staff request. Patient/portal contexts never call BillingPort (08 R8). |
| Fake must support | per-order programmable balances; tenant setting toggle `releaseRequiresPayment`; credit-party orders; override records; idempotent gateway payment; balance version increments. |
| Contract tests | (1) zero balance → eligible `zero_balance`; (2) due outstanding + setting on → not eligible `due_outstanding`; (3) setting off → eligible `policy_not_enforced`; (4) credit party → eligible `credit_party`; (5) override present → eligible `override` with id; (6) recordGatewayPayment twice → one ledger row, second `duplicate: true`; (7) amount mismatch → `billing.amount_mismatch`; (8) overpayment → `billing.payment_exceeds_due`; (9) other tenant's order → not_found; (10) balanceVersion strictly increases after each recorded payment. **Added by 08:** (11) refund idempotent; (12) refund > refundable → `billing.ledger_reversal_invalid`; (13) `allowExceedsDue` records + review item; (14) patient/portal actor → `auth.forbidden`. |

### 4.5 `LabPort` — owner C5; consumers C4, C6, C7, C10, C11, C14, C17 (C10/C11 also via `submitModuleResult`, A1; C9 removed — C9 does not call LabPort, 08 A26.3)

```ts
// contracts/ports/LabPort.ts
import type { RequestContext, Uuidv7, IsoUtc, DecimalString, Code, Priority, Sex, ResultStatus, SpecimenStatus, Page } from './common';
export const LAB_PORT_VERSION = 1 as const;

export interface ResultView {
  readonly resultId: Uuidv7; readonly orderItemId: Uuidv7; readonly testId: Uuidv7; readonly analyteId: Uuidv7;
  readonly versionNo: number; readonly status: ResultStatus;
  readonly valueText?: string; readonly valueNumeric?: DecimalString; readonly ordinalCode?: Code; readonly unitCode?: Code;
  readonly flag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';          // HH/LL = critical; A = abnormal non-numeric [CONV]
  // (C5 result marker `range_unavailable_age_unknown` — 08 A17.1, §4.2 — is a C5 column/HTTP field, not a `flag` value and not a ResultView v1 field)
  readonly referenceRangeSnapshot?: { readonly referenceRangeId: Uuidv7; readonly version: number; readonly low?: DecimalString; readonly high?: DecimalString; readonly text?: string };
  readonly methodName?: string; readonly origin: 'instrument' | 'manual' | 'calculated' | 'module';
  readonly instrumentId?: Uuidv7;
  readonly commentCodes: readonly Code[]; readonly commentText?: string;
  readonly attachments: readonly { readonly bucket: string; readonly objectPath: string; readonly sha256: string; readonly mimeType: string }[];
  readonly onHold: boolean; readonly qcReviewRequired: boolean;
  readonly verifiedAt?: IsoUtc; readonly verifiedByMembershipId?: Uuidv7;
  readonly approvedAt?: IsoUtc; readonly approvedByMembershipId?: Uuidv7;
  readonly amendment?: { readonly previousVersionNo: number; readonly reasonCode: Code; readonly reasonText?: string; readonly amendedAt: IsoUtc };
  readonly moduleRef?: { readonly module: 'micro' | 'anatomic'; readonly entityId: Uuidv7; readonly versionNo: number };   // added by 08 (CR-C6-006)
}
export interface OrderResults {
  readonly orderId: Uuidv7;
  readonly specimens: readonly { readonly specimenId: Uuidv7; readonly specimenTypeCode: Code; readonly status: import('./common').SpecimenStatus;
                                 readonly collectedAt?: IsoUtc; readonly receivedAt?: IsoUtc;
                                 readonly barcode?: string /* added by 08 (CR-C6-006): P2, scope 'approved' only */ }[];
  readonly items: readonly { readonly orderItemId: Uuidv7; readonly testId: Uuidv7; readonly departmentId: Uuidv7; readonly results: readonly ResultView[] }[];
  readonly approvedSetHash: string;                              // same hash as lab.order.ready_for_report.v1
}
export interface InstrumentResultInput {                         // = instruments.result.received.v1 payload, camelCased field for field (08 A13 D-10)
  readonly instrumentMessageId: Uuidv7; readonly instrumentId: Uuidv7; readonly agentId: Uuidv7; readonly centreId: Uuidv7;
  readonly protocol: 'astm' | 'hl7v2' | 'file_drop';
  readonly sampleBarcode: string; readonly recordKind: 'quantitative' | 'qualitative' | 'ordinal' | 'text' | 'organism_id' | 'ast' | 'attachment';
  readonly instrumentAnalyteCode: string; readonly mappingStatus: 'mapped' | 'unmapped'; readonly analyteId?: Uuidv7; readonly testId?: Uuidv7;
  readonly valueRaw?: string; readonly valueNumeric?: DecimalString; readonly unitRaw?: string; readonly unitCode?: Code;
  readonly instrumentFlags?: readonly string[];                  // absent = []
  readonly instrumentResultTime?: IsoUtc; readonly instrumentClockOffsetSeconds?: number; readonly receivedAt: IsoUtc;
  readonly isRerun?: boolean;                                    // absent = false
  readonly capturedAt?: IsoUtc; readonly processingKind?: 'live' | 'reprocess' | 'rematch'; readonly sourceRecordId?: Uuidv7;
  readonly organism?: { readonly organismCodeRaw: string; readonly organismCode?: Code; readonly isolateSeq?: number };   // shape as §3.14 `organism`
  readonly ast?: { readonly antibioticCodeRaw: string; readonly antibioticCode?: Code; readonly isolateSeq?: number;
                   readonly method: 'mic' | 'zone_diameter' | 'other'; readonly rawValue: string; readonly interpretationRaw?: string;
                   readonly standard?: 'CLSI' | 'EUCAST' | 'ECOFF' | 'unknown'; readonly standardVersion?: string };    // shape as §3.14 `ast`
  readonly attachment?: { readonly bucket: string; readonly objectPath: string; readonly sha256: string; readonly mimeType: string };   // port only (unchanged)
}

export interface LabPortV1 {
  /** scope 'approved' = only approved (latest version) results — what reports/smart report may use.
   *  scope 'all_visible' = every status, for staff UIs of consumer modules with lab.result.read permission. */
  getOrderResults(ctx: RequestContext, input: { orderId: Uuidv7; scope: 'approved' | 'all_visible' }): Promise<OrderResults>;
  /** Host query (bi-directional instruments, 01 §3.1). @throws lab.specimen_not_found (unknown barcode in tenant),
   *  lab.specimen_not_receivable (rejected/discarded/not yet received per tenant rule) */
  getPendingTestsForBarcode(ctx: RequestContext, input: { instrumentId: Uuidv7; barcode: string }): Promise<{
    specimenId: Uuidv7; priority: Priority; patient: { sex: Sex; ageDays?: number };
    tests: readonly { orderItemId: Uuidv7; testId: Uuidv7; analyteIds: readonly Uuidv7[] }[] }>;
  /** Synchronous apply of one instrument result (manual re-match / replay from the C7 UI). The bulk path is the
   *  instruments.result.received.v1 consumer; both are idempotent on the 04 N10 result-level key.
   *  Never throws for an approved target: returns outcome `rejected_state` with `reasonCode: 'result_locked'` (CR-C5-008). A key stored as `unmatched`/`rejected_state` with an open C5 exception is re-evaluated on replay (CR-C7-011). */
  ingestInstrumentResult(ctx: RequestContext, input: InstrumentResultInput): Promise<{
    outcome: 'applied' | 'duplicate' | 'unmatched' | 'rejected_state' | 'held'; resultId?: Uuidv7; specimenId?: Uuidv7; reasonCode?: Code }>;
  /** QC failure hold (01 §2.5): marks matching non-approved results on_hold; approved ones get qcReviewRequired. Idempotent on qcRunId. */
  holdResultsSince(ctx: RequestContext, input: { instrumentId: Uuidv7; analyteIds: readonly Uuidv7[]; since: IsoUtc; qcRunId: Uuidv7; reasonCode: Code }): Promise<{ heldResultIds: readonly Uuidv7[]; reviewFlaggedResultIds: readonly Uuidv7[] }>;
  /** Accepted addition A1. Hands a finished micro (C10) or anatomic (C11) result into the common result chain so that
   *  verification → approval → lab.order.ready_for_report.v1 → report release work identically for every department.
   *  The module keeps its detailed data in its own schema; C5 stores a reference + a reportable summary.
   *  @throws lab.module_result_invalid, lab.result_locked, lab.result_invalid_transition, lab.module_result_stale */
  submitModuleResult(ctx: RequestContext, input: SubmitModuleResultInput): Promise<SubmitModuleResultOutput>;
  // ---- added by 08
  /** Callers holding frontdesk.order.read or frontdesk.order.edit, or system. No PHI. (08 A13 D-5) */
  getOrderItemProcessingState(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<readonly { orderItemId: Uuidv7; removable: boolean; reasonCode?: Code;
    processingStatus: 'not_started' | 'in_progress' | 'reported' | 'cancelled' }[]>;
  /** Worklist download (BLOCKED B2 per instrument). Received specimens of the device's centre with ≥ 1 pending result mapped outbound for instrumentId. */
  listPendingForInstrument(ctx: RequestContext, input: { instrumentId: Uuidv7; receivedSince?: IsoUtc; limit?: number /* ≤ 200 */; cursor?: string }):
    Promise<Page<{ specimenId: Uuidv7; barcode: string; priority: Priority; patient: { sex: Sex; ageDays?: number };
                   tests: readonly { orderItemId: Uuidv7; testId: Uuidv7; analyteIds: readonly Uuidv7[] }[] }>>;
  /** No side effects; caller RLS. Users: lab.specimen.read; the {orderId} form also with homecollection.visit.read (C17 checks assignment);
   *  system: tenant-wide; device: refused. Unknown/invisible → omitted. An old barcode of a recollected specimen resolves only to the old specimen. */
  lookupSpecimens(ctx: RequestContext, input: SpecimenSelector): Promise<readonly SpecimenRef[]>;
  /** Approved results only, latest version, approvedAt in [since, before), newest first, RLS-scoped; unknown patient → empty series. */
  getAnalyteHistory(ctx: RequestContext, input: { patientId: Uuidv7; analyteIds: readonly Uuidv7[] /* 1..100 */; before: IsoUtc; since?: IsoUtc;
    limitPerAnalyte: number /* 1..10 */; excludeOrderId?: Uuidv7; includeLegacy?: boolean /* default false */ }):
    Promise<{ series: readonly { analyteId: Uuidv7; points: readonly AnalyteHistoryPoint[] }[] }>;
}
export type LabPort = LabPortV1;

// ---- added by 08 (CR-C10-003 + C17-002, CR-C14-002)
export type SpecimenSelector =
  | { readonly barcode: string }
  | { readonly specimenIds: readonly Uuidv7[] }                                  // 1..200
  | { readonly orderId: Uuidv7; readonly statuses?: readonly SpecimenStatus[] };
export interface SpecimenRef {
  readonly specimenId: Uuidv7; readonly barcode: string; readonly orderId: Uuidv7; readonly patientId: Uuidv7; readonly centreId: Uuidv7;
  readonly processingCentreId?: Uuidv7; readonly specimenTypeCode: Code; readonly containerCode?: Code; readonly status: SpecimenStatus;
  readonly isActive: boolean; readonly replacesSpecimenId?: Uuidv7; readonly parentSpecimenId?: Uuidv7; readonly version: number }
export interface AnalyteHistoryPoint {
  readonly source: 'lis' | 'legacy';                 // 'legacy' only when includeLegacy and C18 data exist (DEFER B4)
  readonly resultId: Uuidv7;                         // lab.results id, or lab.legacy_results id when source = 'legacy'
  readonly orderId?: Uuidv7; readonly versionNo?: number; readonly approvedAt: IsoUtc;
  readonly valueNumeric?: DecimalString; readonly unitCode?: Code; readonly flag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A' }

/** A1 input. Exactly one submission per (payloadRef.module, payloadRef.entityId, payloadRef.versionNo). */
export interface SubmitModuleResultInput {
  readonly orderItemId: Uuidv7;
  readonly analyteId?: Uuidv7;                 // omitted → the test's single reportable "module result" analyte (C3 seeds one per micro/anatomic test)
  readonly kind: 'structured' | 'narrative' | 'ast_panel' | 'organism';
  readonly reportPhase: 'preliminary' | 'final';   // micro prelim/final (01 research §2.3); anatomic always 'final' at sign-out
  readonly payloadRef: { readonly module: 'micro' | 'anatomic'; readonly entityId: Uuidv7; readonly versionNo: number };
  readonly summaryText?: string;               // ≤ 4,000 chars, plain text, shown in worklists; full content rendered from the module (see below)
  readonly flag?: 'N' | 'A';                   // abnormal marker for the result list
  readonly isCritical?: boolean;               // module-determined critical finding → C5 emits lab.critical_value.detected.v1 (direction 'abnormal')
  readonly submittedAt: IsoUtc;
  readonly idempotencyKey: string;             // `${module}:${entityId}:${versionNo}`
  readonly amendment?: { readonly reasonCode: Code; readonly reasonText?: string /* ≤ 500 chars, P3 */ };   // added by 08 (R1)
}
export interface SubmitModuleResultOutput {
  readonly resultId: Uuidv7;
  readonly versionNo: number;                  // results.current_version_no after the call (1 until first approval; n+1 for an amendment) — 08 A13 D-7
  readonly status: ResultStatus;               // 'resulted' for a new prelim/final; 'approved' only when amendmentOf an approved final (see semantics)
  readonly replayed: boolean;
}
```

| Aspect | Specification |
|---|---|
| Semantics (submitModuleResult, A1) | Creates/updates the `lab.results` row for the order item with `origin: 'module'`; that row holds `payloadRef` and `summaryText`. `result_versions` rows are created only at approval (R6) and amendment (R7). A submission on a `verified` result performs a system R5 (`reason_code = module_resubmitted`) followed by R3, in one transaction (08 A13 D-7; C5 seeds `module_resubmitted` in `lab.g_cs_return_reasons`). Preliminary submissions can be followed by later preliminary/final submissions while the result is not approved (each a new `payloadRef.versionNo`, result stays/returns to `resulted`; the chain then goes through normal verify (R4) and approve (R6)). A submission for a result already `approved` is an **amendment** (R7): allowed only when the actor holds `lab.result.amend`, creates version n+1 and emits `lab.result.amended.v1`. **08 R1:** `amendment` is required when the target result is `approved` (missing → `lab.amendment_reason_required`), ignored otherwise; `reasonCode` must be an active code of C5's amendment-reason coded set (`lab.g_cs_amendment_reasons` + tenant `lab.cs_amendment_reasons`); seeds `module_phase_progression` (accepted only when `payloadRef.module = 'micro'`, `reportPhase = 'final'` and the approved version being replaced was a `preliminary` submission; otherwise `lab.module_result_invalid`) and `supplementary_report` (accepted only when `payloadRef.module = 'anatomic'`). A `payloadRef.versionNo` lower than the last applied → `lab.module_result_stale`. Report content: C6 renders micro/anatomic sections from the approved `payloadRef` by calling the module's published views `micro.v_pub_report_content` / `anatomic.v_pub_report_content` (§6.8), so C6 never reads module tables. |
| Semantics (getOrderItemProcessingState, 08 A13 D-5, refined by 08 A17.2) | `removable` = no non-rejected specimen linked to the item has `received_at`, and no result of the item is `resulted` or later; otherwise `false` with `reasonCode: specimen_received` (specimen received) or `reasonCode: 'result_entered'` (any result of the item is `resulted` or later — A17.2). `processingStatus`: `cancelled` = every `order_test` of the item is `cancelled`; `reported` = every non-cancelled `order_test` is reported (S10); `not_started` = no specimen of the item received **and** no result of the item is beyond `pending` (A17.2; covers existing-material items); otherwise `in_progress`. A specimen rejected without recollection sets its `order_tests.status = 'cancelled'` (cancel reason `specimen_rejected`); its pending results go to R8 `cancelled` and readiness excludes them (C5 rule). |
| Semantics (ingestInstrumentResult input, 08 A13 D-10) | `InstrumentResultInput` is the `instruments.result.received.v1` payload camelCased 1:1 (C7 TRD §6.7). `instrumentFlags` absent = `[]`; `isRerun` absent = `false`; `attachment` exists on the port only. C5's port path runs unit conversion from `unitRaw`. |
| Semantics | See §10.1/§10.2 state machines. `ingestInstrumentResult` never auto-verifies in Phase 1 (04 R2); it sets `resulted`, evaluates range flags/delta/critical and may emit `lab.critical_value.detected.v1`. `outcome: held` = applied but `on_hold` because the instrument/analyte is under a QC hold. `unmatched` = barcode or mapping not found → stored in C5's unmatched queue for the C7 re-match UI. |
| Invariants | Approved results are never changed by ingest (04 R1). Recollected specimens have new barcodes; an old barcode never resolves to the new specimen (01 §2.1). Duplicate ingest (same 04 N10 key) → `duplicate`, no new row. `getOrderResults('approved')` returns exactly the set hashed into `approvedSetHash`. |
| Performance | submitModuleResult ≤ 50 ms; getPendingTestsForBarcode p95 ≤ 300 ms end-to-end in-process (the analyser waits on the LIS reply "within ~seconds" — 01 §3.1); ingestInstrumentResult ≤ 50 ms; getOrderResults ≤ 80 ms for 100 results; holdResultsSince ≤ 500 ms for 1,000 results. |
| Tenant context | required. Device actors (C7 ingest) are restricted to their centre (02-CV §6). |
| Fake must support | seeded orders/specimens/results in every status (incl. a micro and an anatomic order item for A1); barcode lookup; rejected specimen; locked approved result; programmable QC hold; deterministic outcomes for each `outcome` value; `approvedSetHash` computed exactly as specified (SHA-256 of sorted `result_id:version_no` joined by `\n`). |
| Contract tests | (1) approved scope hides unverified results; (2) all_visible requires `lab.result.read` (else `auth.forbidden`); (3) host query on received specimen returns its pending tests only (excludes approved/cancelled); (4) unknown barcode → `lab.specimen_not_found`; (5) rejected barcode → `lab.specimen_not_receivable`; (6) ingest new → applied, status `resulted`; (7) same key → duplicate; (8) ingest on approved → `rejected_state`, value unchanged; (9) unmapped → unmatched; (10) critical value → event spy sees `lab.critical_value.detected.v1`; (11) holdResultsSince twice same qcRunId → same lists, no double flagging; (12) other tenant barcode → not_found; (13) approvedSetHash stable across calls and changes after amendment; **A1:** (14) submitModuleResult new → `resulted`, `origin: module`; (15) replay with same idempotencyKey → `replayed: true`, same resultId/versionNo; (16) lower `payloadRef.versionNo` → `lab.module_result_stale`; (17) submission on approved result without `lab.result.amend` → `lab.result_locked`; with it → version n+1 + `lab.result.amended.v1`; (18) orderItem whose test workflowType is not `microbiology`/`anatomic`/`molecular` → `lab.module_result_invalid`; (19) `isCritical: true` → `lab.critical_value.detected.v1` with direction `abnormal`; (20) other tenant's order item → not_found. **Added by 08:** (21) replay of an unmatched key after the fix → applied, exception closed (CR-C7-011); (22) approved + `amendment` → event carries the code; approved without `amendment` → `lab.amendment_reason_required`; (23) `module_phase_progression` from anatomic → `lab.module_result_invalid`; (24) approved scope returns barcode; (25) module result returns `moduleRef`; (26) `lookupSpecimens` other tenant omitted / old barcode resolves to old specimen; (27) `{orderId}` form with `homecollection.visit.read`; (28) `getAnalyteHistory` never returns another patient's results; (29) `listPendingForInstrument` excludes approved/cancelled; (30) `getOrderItemProcessingState`: received specimen → `removable: false`. **Added by 08 A13:** (31) item whose only specimen is rejected without recollection → `removable: true`, `processingStatus: 'cancelled'` (D-5); (32) all items reported → `reported` (D-5); (33) `submitModuleResult` resubmission on `verified` → `resulted`, verification cleared (D-7); (34) `versionNo` = 1 before approval, n+1 after amendment (D-7). **Added by 08 A17 D-61:** (35) micro preliminary over an approved preliminary with `amendment.reasonCode = 'module_preliminary_update'` → version n+1 and `lab.result.amended.v1` carries the code; (36) the same code with `reportPhase = 'final'` or from anatomic → `lab.module_result_invalid`. Behaviour (CR-C9-004): with `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true`, C5 calls `QualityPort.canAutoVerify` for every instrument-origin save (not on hold, no unit mismatch) and auto-verifies only on `allow`. |

### 4.6 `IdentityPort` — owner C2; consumers: all

```ts
// contracts/ports/IdentityPort.ts
import type { RequestContext, Uuidv7, Uuid, Actor, IsoUtc, Code } from './common';
export const IDENTITY_PORT_VERSION = 1 as const;

export type RoleCode = string;          // tenant-configurable; defaults in contracts/permissions.yaml (§11)
export type PermissionCode = string;    // '<module>.<resource>.<action>' — must exist in contracts/permissions.yaml (§11; A6)

export interface ActorProfile {
  readonly actor: Actor; readonly displayName: string;
  readonly roles: readonly RoleCode[]; readonly permissions: readonly PermissionCode[];
  readonly centreScope: { readonly all: boolean; readonly centreIds: readonly Uuidv7[] };
  readonly branchIds: readonly Uuidv7[];
  readonly mfa: { readonly enrolled: boolean; readonly level: 'aal1' | 'aal2' };
  readonly isLocked: boolean;
  readonly signature?: { readonly displayTitle: string; readonly registrationNo?: string; readonly signatureImageRef?: string }; // signatory block (00 §4)
}
export interface TenantSettings {                                // final shape per 08 §4.12 (CR-C2-008 primary; C0-009, C4-009, C5-009, C11-005)
  readonly calendarDisplay: 'AD' | 'BS' | 'AD_BS' | 'BS_AD';    // 04 D12; default AD
  readonly timezone: string;                                     // default 'Asia/Kathmandu'; v1 accepts only 'Asia/Kathmandu' (C2 → identity.setting_out_of_range; 08 A13 P-15, §6)
  readonly idleTimeoutMinutes: number;                           // 15–30 (04 A8)
  readonly absoluteSessionHours: number;                         // ≤12 (04 A8)
  readonly reportLinkTtlDays: number;                            // 30–90 (04 A10)
  readonly releaseRequiresPayment: boolean;                      // hold-till-paid (01 §1.4)
  readonly partialReleaseAllowed: boolean;
  readonly letterheadDefault: 'with' | 'without';
  readonly numbering: {                                          // §9.3
    readonly registrationNoPattern: string; readonly barcodePattern: string; readonly patientCodePattern: string;
    readonly invoiceNoPattern: string; readonly creditNoteNoPattern: string;
    readonly receiptNoPattern: string;                       // default 'RC-{fy}-{seq:6}'            (CR-C2-008)
    readonly barcodePrefix?: string;                         // [A-Z0-9]{0,4}                        (CR-C5-009)
    readonly accessionNoPattern?: string;                    // default '{prefix}{yy}-{seq:4}'       (CR-C11-005)
    readonly accessionPrefixes?: { readonly histology?: string; readonly cytology?: string;
                                   readonly ihc?: string; readonly molecular?: string };   // [A-Z0-9]{0,4}; defaults S/C/I/M
  };
  readonly channels: { readonly whatsappEnabled: boolean; readonly smsEnabled: boolean; readonly emailEnabled: boolean; readonly smsSenderId?: string };
  readonly branding: {                                       // replaces CR-C4-009 'letterhead' and CR-C0-009 'branding' (R21)
    readonly legalName: string; readonly displayName: string;
    readonly addressLines: readonly string[];                // ≤ 4 lines, each ≤ 120
    readonly phones: readonly string[];                      // ≤ 3 display strings, each ≤ 40
    readonly contactEmail?: string; readonly website?: string;
    readonly logoAssetId?: Uuidv7; readonly letterheadHeaderAssetId?: Uuidv7; readonly letterheadFooterAssetId?: Uuidv7;
    readonly receiptFooterNote?: string;                     // ≤ 200
    readonly accentColor?: string;                           // '#RRGGBB'; kit derives accessible variants (C0 04-UI-UX §1.6)
  };
  readonly retentionYears: number;                           // default 5 (04 I8, BLOCKED B15); kept = retention.clinicalYears (back-compat)
  readonly retention: { readonly clinicalYears: number; readonly auditYears: number; readonly rawInstrumentYears: number }; // floors 5/5/1 (04 I8, B15)
  readonly featureFlags: Readonly<Record<string, boolean>>;  // codes from identity.g_feature_flags (+ 'smart_report', CR-C14-005)
  readonly referralIncentiveReportEnabled: boolean;              // 04 L19 / B13 — reporting only, never "commission"
  readonly autoVerificationEnabled: boolean;                     // Phase 2 (04 R2); default false
  readonly westgardMode: 'classic' | 'modern';                   // 04 L23 per-lab flag; default set in C9 PRD
  readonly ird: { readonly pan?: string; readonly cbmsRealtimeRequired: boolean; readonly abbreviatedInvoiceLimitPaisa?: number;
                  readonly annexReadiness: 'complete' | 'incomplete' };   // 04 L6/L9/L26; values BLOCKED B6; annexReadiness tracking-derived, not a legal determination
}
export type TenantSettingKey = keyof TenantSettings;

export interface IdentityPortV1 {
  /** @throws auth.unauthenticated, auth.account_locked */
  getActor(ctx: RequestContext): Promise<ActorProfile>;
  /** Throws unless the actor holds `permission` (and covers `centreId` when given). Privileged permissions re-validate membership
   *  against core.memberships and require aal2 (04 A4; REQ-SEC-067).
   *  @throws auth.forbidden, auth.mfa_required, auth.account_locked, auth.session_expired */
  assertRole(ctx: RequestContext, requirement: { permission: PermissionCode; centreId?: Uuidv7; branchId?: Uuidv7 }): Promise<void>;
  getTenantSettings<K extends TenantSettingKey>(ctx: RequestContext, input?: { keys?: readonly K[] }): Promise<Pick<TenantSettings, K>>;
  // ---- added by 08 (CR-C6-007, C13-003, C16-004)
  /** System actor holding identity.signatory.read only. ≤ 20 ids; unknown/other tenant omitted. */
  getSignatories(ctx: RequestContext, input: { membershipIds: readonly Uuidv7[] }): Promise<readonly Signatory[]>;
  /** Callers: any `user` or `system` actor of the tenant. Returns only branding assets (kinds `logo`, `letterhead_header`, `letterhead_footer`);
   *  signature images are never returned here and stay behind `getSignatories` (system actor holding `identity.signatory.read`). (08 A13 D-26)
   *  Assets referenced by a released report stay readable (never deleted). @throws common.not_found */
  readBrandingAsset(ctx: RequestContext, input: { assetId: Uuidv7 }): Promise<BrandingAssetContent>;
  /** Caller: C13 service with partners.partner.manage (staff) or partners.partner_user.manage (partner admin of the same partner).
   *  @throws identity.user_exists, identity.tenant_suspended */
  provisionPartnerMembership(ctx: RequestContext, input: { email: string; displayName: string; partnerRole: PartnerRole }):
    Promise<{ membershipId: Uuidv7; userId: Uuid; invitationId: Uuidv7; status: 'invited' }>;
  /** Revokes sessions on deactivate/role change. Non-partner membership → common.not_found.
   *  `expectedVersion` (08 A19 D-100): omitted → C2 applies the action to the current row under `SELECT … FOR UPDATE`;
   *  present → `common.version_conflict` on mismatch. C13 controls concurrency on its own `partner_users` row and calls without it.
   *  @throws common.version_conflict, identity.membership_inactive */
  updatePartnerMembership(ctx: RequestContext, input: { membershipId: Uuidv7; action: 'deactivate' | 'reactivate' | 'set_role' | 'resend_invitation';
    partnerRole?: PartnerRole; reasonCode?: Code; expectedVersion?: number }): Promise<{ membershipId: Uuidv7; status: 'invited' | 'active' | 'deactivated'; version: number }>;
  /** Caller: patient pre_auth context only; idempotent per accountId; no phone/e-mail stored in GoTrue; GoTrue never messages these users. */
  provisionPatientMembership(ctx: RequestContext, input: { accountId: Uuidv7 }): Promise<{ membershipId: Uuidv7; userId: Uuid }>;
  /** Same caller restriction; membership must be actor_type 'patient' and active. Returns the opaque session token (08 R10). */
  openPatientSession(ctx: RequestContext, input: { membershipId: Uuidv7; appInstanceId: Uuidv7; appPlatform: 'android' | 'ios' }):
    Promise<{ sessionToken: string; accessToken: string; accessExpiresAt: IsoUtc; sessionExpiresAt: IsoUtc }>;
  /** Caller: the patient whose claims membership_id = membershipId, or the engagement system actor. */
  revokePatientSessions(ctx: RequestContext, input: { membershipId: Uuidv7; reason: Code; deactivateMembership: boolean }): Promise<{ revokedSessions: number }>;
  // ---- added by 08 Addendum A4.2 (CR-C6-018, additive)
  /** Caller: system actors only (reporting worker). `eligible` = membership status = 'active', actor_type = 'user', not locked
   *  (locked_at IS NULL — 08 A3.4), holds `requiredPermission`. `email` = core.users.email_normalized (08 A3.4). */
  getStaffNotificationContact(ctx: RequestContext, input: { membershipId: Uuidv7; requiredPermission: PermissionCode }): Promise<{ membershipId: Uuidv7; email: string | null; eligible: boolean }>;
  // ---- added by 08 Addendum A21.2 (CR-C6-020, additive). C6 render worker uses it; C2 implements.
  /** Caller: system actor holding `identity.signatory.read` only. Signature image of the membership's signatory record.
   *  @throws common.not_found */
  readSignatureImage(ctx: RequestContext, input: { membershipId: Uuidv7 }): Promise<SignatureImageContent>;   // return type per 08 A26.1
}
export type IdentityPort = IdentityPortV1;

// ---- added by 08
export interface Signatory { readonly membershipId: Uuidv7; readonly displayName: string; readonly displayTitle?: string; readonly registrationNo?: string;
  readonly signatureAssetId?: Uuidv7; readonly signatureSha256?: string; readonly isActive: boolean }      // inactive still returned
export interface BrandingAssetContent { readonly assetId: Uuidv7; readonly kind: 'logo' | 'letterhead_header' | 'letterhead_footer';
  readonly mimeType: 'image/png' | 'image/jpeg'; readonly sha256: string; readonly base64: string }        // ≤ 2 MB
export interface SignatureImageContent { readonly membershipId: Uuidv7; readonly contentBase64: string;      // 08 A26.1 (readSignatureImage; not BrandingAssetContent)
  readonly mimeType: 'image/png' | 'image/jpeg'; readonly sha256: string }
export type PartnerRole = 'partner_admin' | 'partner_member';
// Migration system actor (CR-C18-007): DEFER (B4).
```

| Aspect | Specification |
|---|---|
| Semantics | Single authority for "may this actor do X here". `assertRole` name is fixed by 01; it checks a **permission** (roles map to permissions per tenant). System actors (worker) hold the permissions declared by the module's worker manifest; device actors hold only `instruments.ingest.*` (REQ-SEC-072); portal actors only `reporting.portal.*`. `branchIds` = explicit `core.membership_branches` grants; `centreScope.all` implies all branches; branch scope is application-level only (08 R3). Partner/patient/queue-display actors per 08 §4.14: partner → permissions = `fixed_actor_permissions.partner[role]`, centreScope `{all:false, centreIds:[]}`, roles `[role]`; patient → fixed patient set (pre_auth stage → `patient_pre_auth` set); device with `device_kind = 'queue_display'` → `[engagement.queue.board_read]`, centreScope `{all:false, centreIds:[claims.centre_id]}`. `assertRole` refuses every `platform.*` code; platform permissions are checked by C2 `PlatformAuthz` (08 R23). |
| Invariants | Never trusts claims for privileged checks (re-reads membership). Locked user → `auth.account_locked` on every call. Settings values always within the 04 ranges (C2 validates on write: `identity.setting_out_of_range`). |
| Performance | assertRole ≤ 2 ms (per-request memo of ActorProfile), ≤ 10 ms for privileged re-validation; getTenantSettings ≤ 2 ms cached (invalidated on settings change). |
| Tenant context | required (platform console calls use a support session in the target tenant — 02-CV §6). |
| Fake must support | actors per default role for both tenants; centre-scoped and all-centre actors; locked actor; aal1 vs aal2; privileged permission list; settings overrides per test. |
| Contract tests | (1) permission held → resolves; (2) missing → `auth.forbidden`; (3) centre outside scope → `auth.forbidden`; (4) privileged at aal1 → `auth.mfa_required`; (5) locked → `auth.account_locked`; (6) membership revoked after token issued → privileged check fails; (7) device actor cannot get `lab.result.read`; (8) settings defaults: calendarDisplay `AD`, idle within 15–30, link TTL within 30–90; (9) keys filter returns only requested keys; (10) unknown permission code → `common.validation_failed` (programming error surfaced in tests). **Added by 08 A4.2:** (11) `getStaffNotificationContact` for an active, unlocked `user` membership holding `requiredPermission` → `eligible: true`, `email` = `core.users.email_normalized`; (12) same membership without `requiredPermission`, or `status` ≠ `active`, or locked, or `actor_type` ≠ `user` → `eligible: false`. **Added by 08 A19 D-100:** (13) `updatePartnerMembership` without `expectedVersion` succeeds; with a stale version → `common.version_conflict`. C2 validates every `TenantSettings` field on write (`identity.setting_out_of_range`; pattern grammar errors at JSON pointer); the fake returns defaults (08 §4.12). |

### 4.7 `ReportingPort` — owner C6; consumers C13, C16

```ts
// contracts/ports/ReportingPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Page } from './common';
import type { SmartSummary } from './SmartReportPort';            // added by 08 A2.3 (snapshot type only; no SmartReportPort call)
export const REPORTING_PORT_VERSION = 1 as const;

export interface ReleasedReportSummary {
  readonly reportId: Uuidv7; readonly versionNo: number; readonly orderId: Uuidv7; readonly patientId: Uuidv7;
  readonly kind: 'final' | 'partial' | 'preliminary' | 'amended' | 'addendum';   // 'addendum' added by 08 (R1)
  readonly status: 'valid' | 'superseded';
  readonly releasedAt: IsoUtc; readonly panelNames: readonly string[];   // P3 — only for authorised consumers
  readonly smartSummaryAvailable: boolean;   // 08 A4.4: true iff smart_summary_json / smart_summary_id / smart_summary_version are non-null on the version being read
}
export interface ReportsFilter {
  readonly orderId?: Uuidv7; readonly patientId?: Uuidv7; readonly partnerId?: Uuidv7; readonly centreId?: Uuidv7;
  readonly releasedFrom?: IsoUtc; readonly releasedTo?: IsoUtc; readonly includeSuperseded?: boolean;
}

export interface ReportingPortV1 {
  /** Exactly one of orderId | patientId | partnerId | centreId must be set. @throws common.validation_failed */
  getReleasedReports(ctx: RequestContext, input: { filter: ReportsFilter; cursor?: string; limit?: number }): Promise<Page<ReleasedReportSummary>>;
  /** Creates a ≥128-bit random link token (04 A10) bound to report+channel, TTL from tenant settings (30–90 d), OTP-gated (04 A9).
   *  The returned URL is a secret: pass it only to NotificationPort (or, for C13 access slips, render it once into the slip PDF in the
   *  C13 worker — 08 A2.1); never log/store it elsewhere. Write: callers are staff (`user`) or `system` actors only (08 R8, A2.1).
   *  @throws reporting.report_not_released, reporting.report_superseded */
  issuePortalLink(ctx: RequestContext, input: { reportId: Uuidv7; versionNo?: number;
    channel: 'whatsapp' | 'sms' | 'email' | 'print_qr' | 'patient_app'; recipientKind: 'patient' | 'referrer' | 'centre' | 'partner' }): Promise<{ linkId: Uuidv7; url: string; expiresAt: IsoUtc }>;
  // ---- added by 08 (CR-C13-005, C16-008)
  /** Released or superseded versions only. Partner actors: reports.partner_id = app.current_partner_id(); patient actors:
   *  patient_id ∈ app.engagement_patient_ids() (C16 also checks visible_from). @throws common.not_found (indistinguishable) */
  openReleasedReportFile(ctx: RequestContext, input: { reportId: Uuidv7; versionNo: number }): Promise<ReleasedReportFile>;
  /** Patient actor. Valid unexpired unrevoked link, recipient 'patient', channel sms|whatsapp, destination = phoneE164.
   *  Never consumes/extends/reveals the link; 5 failures per token. @throws reporting.link_invalid (identical for every failure) */
  redeemPortalLinkForApp(ctx: RequestContext, input: { linkToken: string; phoneE164: string }): Promise<{ patientId: Uuidv7; reportId: Uuidv7; versionNo: number; releasedAt: IsoUtc }>;
}
export type ReportingPort = ReportingPortV1;

// ---- added by 08
export interface ReleasedReportFile { readonly reportVersionId: Uuidv7; readonly reportId: Uuidv7; readonly versionNo: number;
  readonly status: 'valid' | 'superseded'; readonly contentType: 'application/pdf'; readonly byteSize: number; readonly sha256: string;
  readonly signedUrl: string /* internal Storage URL, TTL ≤ 300 s, never logged or returned to browsers */; readonly expiresAt: IsoUtc;
  /** 08 A2.3/A2.8/A4.4: approved SmartSummary JSON snapshot stored by C6 on this report version — at first assembly and at Regenerate
   *  (reason `smart_summary_added`) alike; absent when none attached. Placement on this result type is [CONV]. */
  readonly smartSummary?: SmartSummary }
```

| Aspect | Specification |
|---|---|
| Semantics | Only `released` versions are visible. Superseded versions are listed only with `includeSuperseded` and flagged. Partner filter returns reports of orders submitted by that partner only. |
| Smart summary for non-staff (08 A2.3) | Patient (C16), portal (C6) and partner (C13) readers receive smart-summary content **only** from the snapshot C6 stores on the report version (`report_versions.smart_summary_json` + `smart_summary_id` + `smart_summary_version`, written on every version assembled with an approved smart summary — at first assembly and at Regenerate with reason `smart_summary_added` alike, 08 A4.4; `smartSummaryAvailable` = those columns are non-null on the version being read), via `ReportingPort` / portal reads under their existing actor policies (CR-C13-005, CR-C16-008). Non-staff actors never call `SmartReportPort`; `smartreport.*` has no non-staff RLS policies. |
| Invariants | Links revocable; revoked/unknown tokens indistinguishable at the portal (04 R3 pattern). OTP rules 04 A9 apply at the portal, not here. |
| Performance | getReleasedReports ≤ 50 ms per page of 50; issuePortalLink ≤ 20 ms. |
| Tenant context | required; patient actors limited to their own patient ids (C16), partner actors to their partner id (C13). `issuePortalLink` is a write, not one of the R8 non-staff reads: callers are staff or system actors only. C13 patient access slips (08 A2.1): the partner request `POST …/access-slips` only records a slip request in `partners.*`; the C13 worker, running as the partners system actor, calls `issuePortalLink`, renders the slip PDF once into the partners bucket and stores the slip's reference in `partners.*`; the partner UI polls slip status (typically < 5 s [CONV]). No partner HTTP response ever contains the link token or URL — only the printable slip is downloadable; the plaintext token is never stored. `openReleasedReportFile`: partner actors only where `reports.partner_id = app.current_partner_id()`; patient actors only where `patient_id ∈ app.engagement_patient_ids()` (C16 also checks `visible_from`); every other case → `common.not_found` (08 §4.14). |
| Fake must support | released/superseded versions; deterministic link ids and fake URLs (`https://portal.invalid/r/<token>`); expiry computation from settings. |
| Contract tests | (1) unreleased report not listed; (2) superseded hidden by default; (3) two filters → validation_failed; (4) partner sees only its orders; (5) issuePortalLink on unreleased → `reporting.report_not_released`; (6) expiresAt = now + tenant TTL; (7) other tenant report → not_found; (8) pagination stable with cursor. |

### 4.8 `NotificationPort` — owner C6; consumers C4, C5, C8, C16, C17

```ts
// contracts/ports/NotificationPort.ts
import type { RequestContext, Uuidv7, Code } from './common';
import type { PermissionCode } from './IdentityPort';               // added by 08 A4.2 (staff recipient)
export const NOTIFICATION_PORT_VERSION = 1 as const;

export type Recipient =
  | { kind: 'patient'; patientId: Uuidv7 } | { kind: 'referrer'; referrerId: Uuidv7 }
  | { kind: 'centre'; centreId: Uuidv7 } | { kind: 'partner'; partnerId: Uuidv7 }
  | { kind: 'staff'; membershipId: Uuidv7; requiredPermission?: PermissionCode }   // 08 A4.2: C8 sets it for purpose 'scheduled_report_ready'; optional (other purposes keep Phase-1 suppression) [CONV]
  | { kind: 'phone_otp'; phoneE164: string };                    // OTP flows only, before a patient id is known
export type NotificationPurpose = 'registration_confirmation' | 'report_ready' | 'otp' | 'dues_reminder'
  | 'recollection_request' | 'critical_value_alert' | 'booking_confirmation' | 'visit_assignment' | 'follow_up_reminder'
  | 'scheduled_report_ready' | 'booking_cancelled' | 'booking_reminder';          // added by 08 (CR-C8-007, C16-009)
export interface SendBase {
  readonly recipient: Recipient; readonly templateCode: Code; readonly purpose: NotificationPurpose;
  readonly params: Readonly<Record<string, string>>;             // validated against the template's declared non-PHI params
  readonly idempotencyKey: string;
  readonly related?: { readonly entityType: 'order' | 'report' | 'specimen' | 'booking' | 'visit' | 'critical_event'
                                           | 'report_run' /* added by 08 */; readonly entityId: Uuidv7 };
}
export interface SendResult { readonly deliveryId: Uuidv7; readonly status: 'queued' | 'suppressed_no_consent' | 'suppressed_no_contact' | 'suppressed_channel_disabled'; readonly replayed: boolean }

export interface NotificationPortV1 {
  /** @throws reporting.notification_template_unknown, reporting.notification_params_invalid */
  sendSms(ctx: RequestContext, input: SendBase): Promise<SendResult>;
  /** Utility template carrying a link only, no PHI (04 R4). @throws as sendSms */
  sendWhatsAppTemplate(ctx: RequestContext, input: SendBase & { linkUrl?: string }): Promise<SendResult>;
  /** Link-only email via relay (04 R5, S20). @throws as sendSms */
  sendEmailLink(ctx: RequestContext, input: SendBase & { linkUrl: string }): Promise<SendResult>;
}
export type NotificationPort = NotificationPortV1;
```

| Aspect | Specification |
|---|---|
| Semantics | The **only** outbound messaging gateway (01 §5.1). Never calls a provider synchronously: it writes a delivery row and enqueues a worker task in `ctx.tx` (outbox — REQ-ARCH-038). Resolves contact details itself from the recipient id (via FrontdeskPort `notification` purpose / catalog doctors / core centres) so callers never handle phone numbers. Staff recipients for purpose `scheduled_report_ready` (08 A2.6 as corrected by A4.2): C8's request carries `recipient: { kind: 'staff'; membershipId; requiredPermission }`, where C8 always sends `requiredPermission = analytics.dashboard.read` (08 A7.6); per-report permissions only filter pack content. The C6 reporting worker (system actor) calls `IdentityPort.getStaffNotificationContact({ membershipId, requiredPermission })` (§4.6, CR-C6-018) — never FrontdeskPort; `eligible: false` or `email: null` → `suppressed_no_contact` (C8 already validates at schedule time with `analytics.recipient_ineligible`). Link-only, no PHI in the body. C6's Phase-1 suppression of staff recipients is lifted for this purpose only (every other purpose keeps it). Checks consent per channel (REQ-SEC-005) and tenant channel switches. SMS fallback when WhatsApp not delivered in time or no WhatsApp (REQ-ARCH-085; N minutes = C6 TRD value). Param kind `staff_url` (08 A13 D-29): an absolute URL with origin `LIMS_ORIGIN_STAFF_WEB` whose path matches a `staff_web` route of `contracts/routes.yaml`. Allowed only for purpose `scheduled_report_ready` to a `staff` recipient. `analytics.report_ready` validates `linkUrl` as `staff_url`. C8 builds the URL with `@lims/shared-ts/routes` for `staff.analytics.report_run`. |
| Templates seeded by C6 (08 §4.10) | `reporting.g_message_templates`: `frontdesk.registration_confirmation` (registration_confirmation), `frontdesk.recollection_request` (recollection_request), `analytics.report_ready` (scheduled_report_ready, email, staff only; renamed from `analytics_report_ready` by 08 A2.6; param `schedule_name` kind `label_text` — 08 A4.3; `label_text` = ≤ 80 characters, plain text, no URLs (`://` or `www.` rejected), HTML-escaped; C6's existing `short_text` kind (≤ 40, charset regex, used by `ref`/`booking_no`) is unchanged — C6 02-TRD defines both), `engagement.login_otp` (otp), `engagement.booking_confirmation` (booking_confirmation), `engagement.booking_cancelled` (booking_cancelled), `engagement.booking_reminder` (booking_reminder), `engagement.follow_up_reminder` (follow_up_reminder), `homecollection.visit_assigned` (visit_assignment, channel `sms`, params `route_date` and `visit_count`, both kind `short_text` — 08 A13 D-34; staff recipients stay `suppressed_no_contact` in Phase 1, contract case 11), `reporting.dues_due` (dues_reminder, channels `sms`/`whatsapp`, recipient patient; params `lab_name` and `amount_text`, both kind `short_text`, and `url` (kind `url`: the portal dues link `/r/{token}/dues`) — 08 A21.1, C6 second-pass hand-off), `homecollection.visit_scheduled` (booking_confirmation, channel `sms`, recipient patient; params `window_start_local` and `window_end_local`, both kind `short_text` (08 A4.3), no lab-name parameter — 08 A19 D-129, CR-C17-014). Params non-PHI only (04 R6). |
| PHI rule | Template params are declared per template as non-PHI (e.g. lab name, link, OTP code, time window). Params containing test names, results, names of tests, diagnoses → rejected `reporting.notification_params_invalid` (04 R4/R6, REQ-SEC-070). `critical_value_alert` to clinicians: message says "critical result — call the lab"; no value, no link [CONV] (08 A13 D-35: no released report may exist yet). |
| Invariants | Idempotent on `idempotencyKey` (replay → same deliveryId). OTP purpose limited by 04 A9 (≤3 sends/number/hour → `common.rate_limited`). No send from non-prod to real providers (REQ-SEC-136). |
| Performance | ≤ 15 ms (DB writes only). |
| Tenant context | required; per-tenant sender ID and credentials (01 §4.4). |
| Fake must support | template registry with declared params; consent matrix; recorded outbox; suppression statuses; idempotent replay; failure injection of provider (affects later delivery status, not the call). |
| Contract tests | (1) no consent → `suppressed_no_consent`; (2) unknown template → error; (3) PHI-like param key not declared → `reporting.notification_params_invalid`; (4) replay same key → same deliveryId, `replayed: true`; (5) channel disabled → `suppressed_channel_disabled`; (6) 4th OTP send in an hour to same phone → `common.rate_limited`; (7) call inside a rolled-back tx leaves no delivery row; (8) recipient in other tenant → not_found. **Added by 08 A2.6:** (9) staff recipient + purpose `scheduled_report_ready` + template `analytics.report_ready` → e-mail resolved via `IdentityPort.getStaffNotificationContact`, `queued`; (10) staff recipient for which `getStaffNotificationContact` returns `eligible: false` (membership lacks the request's `requiredPermission`, inactive, not `actor_type 'user'`, or locked) or `email: null` → `suppressed_no_contact` (08 A4.2); (11) staff recipient for any other purpose → `suppressed_no_contact` (Phase-1 rule unchanged); (12) `schedule_name` (kind `label_text`, 08 A4.3) of 81 characters, or containing `://` or `www.` → `reporting.notification_params_invalid`. |

### 4.9 `PaymentProviderPort` — owner C15; consumers C4, C6, C16 (callers staff/system only — 08 R8; C6 = portal dues-payment worker as system actor, 08 A11.1 / CR-C15-010 ACCEPT-MODIFIED) — Phase 1.5–2

```ts
// contracts/ports/PaymentProviderPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Money, Code } from './common';
export const PAYMENT_PROVIDER_PORT_VERSION = 1 as const;

export type Gateway = 'esewa' | 'khalti' | 'fonepay';
export type IntentAction =
  | { kind: 'form_post'; url: string; fields: Readonly<Record<string, string>>; launchUrl?: string }   // eSewa ePay v2 form POST (04 P3); launchUrl added by 08 (CR-C15-001)
  | { kind: 'redirect'; url: string }                                               // Khalti payment_url (04 P4)
  | { kind: 'qr'; qrPayload: string };                                              // Fonepay dynamic QR — BLOCKED B8
export type IntentStatus = 'created' | 'initiated' | 'pending' | 'settled' | 'failed' | 'expired' | 'held_for_review'
  | 'refunded' | 'partially_refunded';

export interface PaymentProviderPortV1 {
  /** Amount is computed server-side from BillingPort.getOrderBalance — the caller never supplies it (REQ-SEC-046).
   *  @throws payments.intent_open_exists (one open intent per order — 04 P6), payments.nothing_due, payments.gateway_not_available,
   *          payments.amount_not_supported, payments.return_url_not_allowed (added by 08) */
  createIntent(ctx: RequestContext, input: { orderId: Uuidv7; gateway: Gateway; idempotencyKey: string; returnUrl: string; cancelUrl: string }):
    Promise<{ intentId: Uuidv7; gateway: Gateway; amount: Money; action: IntentAction; expiresAt?: IsoUtc; replayed: boolean }>;
  /** Server-to-server verification (04 P7). Settles only on eSewa COMPLETE / Khalti Completed with exact amount match;
   *  on settle calls BillingPort.recordGatewayPayment in ctx.tx and emits payments.intent.settled.v1.
   *  Khalti Pending/Refunded/Partially Refunded/unknown and eSewa AMBIGUOUS(AMBIGIOUS)/FULL_REFUND/PARTIAL_REFUND/unknown → held_for_review (04 P3/P4).
   *  eSewa PENDING/NOT_FOUND and Khalti Initiated are non-terminal (keep polling) until `expires_at` + grace; after it → held_for_review
   *  (PENDING, Initiated) or expired (NOT_FOUND) (08 A19 D-114, pending 04 P4 amendment F-08; contract case 5). */
  verify(ctx: RequestContext, input: { intentId: Uuidv7 }): Promise<{ intentId: Uuidv7; status: IntentStatus; gatewayStatusRaw?: string; verifiedAmount?: Money }>;
  /** Privileged (REQ-SEC-055). @throws payments.refund_exceeds_captured, payments.refund_requires_approval, payments.gateway_not_available */
  refund(ctx: RequestContext, input: { intentId: Uuidv7; amount: Money; reasonCode: Code; idempotencyKey: string; approvalId: Uuidv7 }):
    Promise<{ refundId: Uuidv7; status: 'requested' | 'completed' | 'failed' | 'held_for_review'; replayed: boolean }>;
  // ---- added by 08 (CR-C15-001)
  /** Read-only, no gateway call. `action` only while initiated/pending. */
  getIntent(ctx: RequestContext, input: { intentId: Uuidv7 }): Promise<{ intentId: Uuidv7; orderId: Uuidv7; gateway: Gateway; status: IntentStatus;
    amount: Money; refundedAmount: Money; expiresAt?: IsoUtc; settledAt?: IsoUtc; action?: IntentAction }>;
  /** Verifies first; settles instead if paid. @throws payments.intent_invalid_transition */
  cancelIntent(ctx: RequestContext, input: { intentId: Uuidv7; reasonCode: Code }): Promise<{ intentId: Uuidv7; status: IntentStatus }>;
}
export type PaymentProviderPort = PaymentProviderPortV1;
```

| Aspect | Specification |
|---|---|
| Semantics | One interface over eSewa ePay v2, Khalti KPG-2, Fonepay (04 P2). Fonepay: BLOCKED B8 → until the spec arrives the real implementation throws `payments.gateway_not_available` for `fonepay`, and static-QR payments are recorded manually as ledger entries by C4 (04 P5). eSewa `code: 0` / service unavailable → retry, not failure (04 P3). HTTP status is never the success signal for Khalti (04 P4). Refund API details per gateway are not in 04 → UNVERIFIED; C15 TRD must cite the gateway docs. |
| Invariants | Unique `(gateway, gateway_txn_ref)`; one open intent per order (partial unique index — REQ-SEC-053); idempotency key per checkout (REQ-SEC-050); effects only on state transition (REQ-SEC-051); amount mismatch → hold + alert (REQ-SEC-048); daily reconciliation job (REQ-SEC-054). No card/wallet credentials stored (REQ-SEC-056). |
| Performance | createIntent ≤ 1.5 s including gateway initiate call (Khalti initiate is server-side — 04 P4; eSewa needs only local signing); verify ≤ 3 s (network-bound). These are the only ports allowed to make outbound network calls in-request, and only to Nepali gateways (04 §11). |
| Tenant context | required; per-tenant gateway credentials in the secret store (REQ-SEC-058). Callers: staff holding `payments.intent.create` (C4), the engagement system actor (C16), or the reporting system actor in the C6 portal dues-payment worker (`createIntent` / `getIntent` only — 08 A11.1, CR-C15-010 ACCEPT-MODIFIED); patient/portal actors never call this port (08 R8). C6 portal dues payment (08 A11.1): the portal actor creates a `reporting.portal_payment_requests` row (spec by C6) and enqueues a job; the worker as system actor reads the amount with `BillingPort.getOrderBalance` at request time (the patient never supplies it) and calls `createIntent` with return/cancel URL `<PORTAL>/r/payments/{portal_payment_request_id}/done` (route `portal.payment_done`, §7) [CONV]; ledger entry as for every gateway payment: C15 calls `BillingPort.recordGatewayPayment` inside its settle transaction (03-IC X3, canonical); C4's `payments.intent.settled.v1` consumer is the idempotent safety net (08 A19 D-115, replaces A11.1 bullet 4). Ships with C15; before C15 is live the portal shows the balance and "pay at the counter or in the app" with no payment button (the phase stub reports gateways unavailable). Production uses the phase stub until C15 ships (every method throws `payments.gateway_not_available` — 08 R9). |
| Fake must support | sandbox-mode fixtures for each gateway status string (eSewa: PENDING/COMPLETE/FULL_REFUND/PARTIAL_REFUND/AMBIGUOUS/AMBIGIOUS/NOT_FOUND/CANCELED/`code:0`; Khalti: Completed/Pending/Initiated/Refunded/Partially Refunded/User canceled/Expired/unknown), amount-mismatch scenario, deterministic intent ids, B8 behaviour for Fonepay. |
| Contract tests | (1) second open intent → `payments.intent_open_exists`; (2) replay same key → same intent; (3) nothing due → `payments.nothing_due`; (4) each settled status string → settled + ledger spy; (5) each hold status (eSewa `AMBIGUOUS`/`AMBIGIOUS`/`FULL_REFUND`/`PARTIAL_REFUND`/unknown; Khalti `Pending`/`Refunded`/`Partially Refunded`/unknown) → `held_for_review`, no ledger write; eSewa `PENDING`/`NOT_FOUND` and Khalti `Initiated` before `expires_at + grace` → unchanged non-terminal; after it → `held_for_review` (`PENDING`, `Initiated`) or `expired` (`NOT_FOUND`) (CR-C15-001); (6) amount mismatch → held_for_review + alert spy; (7) eSewa `code: 0` → status unchanged (retry); (8) refund > captured → error; (9) refund without approval → `payments.refund_requires_approval`; (10) fonepay → `payments.gateway_not_available` while B8 open; (11) verify twice after settle → one ledger entry. **Added by 08 (C15 02-TRD §5.3):** (12) `getIntent` returns `action` only while open; (13) `cancelIntent` on an intent the gateway reports paid → `settled`; (14) eSewa `NOT_FOUND` after deadline → `expired`; (15) return URL off-allowlist → `payments.return_url_not_allowed`; (16) Khalti due 999 paisa → `payments.amount_not_supported`; (17) late success on `expired` → `held_for_review`; (18) refund replay same key → same refund, `replayed: true`. |

### 4.10 `SmartReportPort` — owner C14; consumers C6 (staff/system actors only — 08 A2.3; C16 removed as consumer by 08 A5.7) — Phase 2–3

```ts
// contracts/ports/SmartReportPort.ts
import type { RequestContext, Uuidv7, Code, IsoUtc, DecimalString } from './common';
export const SMART_REPORT_PORT_VERSION = 1 as const;

export type BandStatus = 'in_range' | 'borderline' | 'out_of_range' | 'critical';
export interface SmartSummary {
  readonly summaryId: Uuidv7; readonly orderId: Uuidv7; readonly reportVersionNo: number;
  readonly templateLibraryVersion: string; readonly status: 'draft' | 'approved';
  readonly approvedByMembershipId?: Uuidv7; readonly approvedAt?: IsoUtc;
  readonly healthScore?: { readonly value: number /* 0–100 */; readonly band: 'good' | 'fair' | 'needs_attention'; readonly formulaVersion: string; readonly panelsScored: number;
                           readonly explanationText?: string /* added by 08 */ };
  readonly panels: readonly { readonly panelCode: Code; readonly status: BandStatus; readonly resultIds: readonly Uuidv7[]; readonly displayName?: string /* added by 08 */ }[];
  readonly deranged: readonly { readonly resultId: Uuidv7; readonly analyteId: Uuidv7; readonly direction: 'low' | 'high' | 'abnormal'; readonly severity: BandStatus; readonly templateBlockId: Uuidv7; readonly text: string;
                                readonly analyteName?: string /* added by 08 */ }[];
  readonly advice: readonly { readonly templateBlockId: Uuidv7; readonly text: string }[];
  readonly followUps: readonly { readonly ruleId: Uuidv7; readonly suggestedTestCode: Code; readonly intervalDays: number; readonly text: string;
                                 readonly suggestedTestName?: string /* added by 08 */ }[];
  readonly trends: readonly { readonly analyteId: Uuidv7; readonly direction: 'improved' | 'worsened' | 'stable'; readonly pointResultIds: readonly Uuidv7[];
                              readonly analyteName?: string; readonly unitCode?: Code;                       // added by 08
                              readonly points?: readonly { readonly resultId: Uuidv7; readonly approvedAt: IsoUtc; readonly valueNumeric: DecimalString }[] }[];
  readonly disclaimerBlockId: Uuidv7;
  // added by 08 (CR-C14-001 + C16-015): display fields
  readonly language?: 'en' | 'ne'; readonly builtAt?: IsoUtc; readonly disclaimerText?: string;
  // also optional: healthScore.explanationText?; panels[].displayName?; deranged[].analyteName?; followUps[].suggestedTestName?;
  // trends[].analyteName?, trends[].unitCode?, trends[].points?: { resultId; approvedAt; valueNumeric }[] — added to the element types above
}
export interface SmartReportPortV1 {
  /** Builds (or returns the cached) rules-based summary from approved results only (01 §5.2; 04 R8).
   *  @throws smartreport.no_eligible_results, smartreport.template_not_approved, smartreport.feature_disabled
   *  Never throws `smartreport.summary_not_ready` (08 A19 D-111): a summary not yet approved is returned with `status: 'draft'`
   *  (contract case 10); the code stays registered but unused by the port.
   *  Callers: staff (`user`) and `system` actors only (08 A2.3); patient/portal/partner actors read the C6 snapshot via ReportingPort. */
  buildSummary(ctx: RequestContext, input: { orderId: Uuidv7; version: number }): Promise<SmartSummary>;  // `version` = report version number
}
export type SmartReportPort = SmartReportPortV1;
```

Note (binding X11): method name `buildSummary` and its two inputs (`orderId`, `version`) are as fixed by 01 §5.1; the signature uses the single-input-object style of 02-CV §8.1.

| Aspect | Specification |
|---|---|
| Semantics | Every text fragment comes from the pathologist-approved template library; no free generation; supplement upsell excluded (04 R8; 01 §5.2). Optional LLM fluency layer only self-hosted in Nepal behind a flag (B11). Uses `LabPort.getOrderResults(scope: 'approved')` and history. Named pathologist owner BLOCKED B14. |
| Actor rules (CR-C14-006 as amended by 08 A2.3) | `smartreport.*` is staff/system-only: the read-only `buildSummary` entry for patient/portal/partner actors is removed from the 08 R8 / 02-CV §8.5 non-staff allowlist (08 A2.3). Patient/portal/partner actors get smart-summary content only through the C6 report-version snapshot via `ReportingPort` / portal reads (§4.7). Internal `rejected` maps to status `draft`. Production uses the phase stub until C14 ships (throws `smartreport.feature_disabled` — 08 R9). |
| Invariants | Deterministic: same approved set + library version ⇒ same summary. Never includes an analyte or number not present in input. `status: approved` only after a pathologist approves the summary (C14 workflow). |
| Performance | ≤ 300 ms build; cached per (orderId, version, libraryVersion). |
| Tenant context | required. |
| Fake must support | fixed summaries for seeded orders; `draft` vs `approved`; feature-disabled tenant. |
| Contract tests | (1) no approved results → `smartreport.no_eligible_results`; (2) determinism across calls; (3) every deranged entry references a resultId present in LabPort approved set; (4) disabled tenant → `smartreport.feature_disabled`; (5) other tenant order → not_found; (6) library not approved → `smartreport.template_not_approved`. **Added by 08 (C14 02-TRD §7.1):** (7) amendment changes `approvedSetHash` → new `summaryId`, old one never returned; (8)–(9) withdrawn by 08 A2.3 (non-staff actors no longer call this port); (10) rejected → `status: 'draft'`; (11) `healthScore` omitted when `panelsScored < min_groups_scored`; (12) property test: no `text` contains a digit except digits from `value`, `ref_range` or `interval_days` placeholders; (13) `followUps[].intervalDays` equal the rule data; (14) every `trends[].pointResultIds` element belongs to the same patient. |

### 4.11 `QualityPort` — owner C9; consumer C5 — Phase 2

```ts
// contracts/ports/QualityPort.ts
import type { RequestContext, Uuidv7, IsoUtc, DecimalString, Code } from './common';
export const QUALITY_PORT_VERSION = 1 as const;

export interface ResultContext {
  readonly resultId: Uuidv7; readonly analyteId: Uuidv7; readonly instrumentId?: Uuidv7;
  readonly valueNumeric?: DecimalString; readonly instrumentFlags: readonly string[];
  readonly rangeFlag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A'; readonly deltaCheckFailed: boolean; readonly isCritical: boolean;
  readonly resultedAt: IsoUtc;
}
export type AutoVerifyReason = 'feature_disabled' | 'instrument_flag' | 'outside_autoverify_limits' | 'critical' | 'delta_failure'
  | 'qc_out_of_control' | 'qc_no_data' | 'manual_origin' | 'rule_missing'
  | 'qc_warning';                                                 // added by 08 (CR-C9-003)

export interface QualityPortV1 {
  /** Phase 2 (04 R2). Criteria per 01 §2.2 (no instrument error flag, within auto-verify limits, not critical, no delta failure, QC in control). */
  canAutoVerify(ctx: RequestContext, resultContext: ResultContext): Promise<{ decision: 'allow' | 'deny'; reasons: readonly AutoVerifyReason[]; ruleSetVersion?: string }>;
  /** Returns out_of_control while a rejected run is not closed; no_qc_data when the last in-control run is older than the
   *  plan's validity; violatedRules may contain 'incomplete_run' (CR-C9-003). */
  qcStatusFor(ctx: RequestContext, input: { instrumentId: Uuidv7; analyteId: Uuidv7; at: IsoUtc }): Promise<{
    status: 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data'; lastInControlRunAt?: IsoUtc; currentRunId?: Uuidv7; violatedRules?: readonly Code[] }>;
}
export type QualityPort = QualityPortV1;
```

Note (binding X11): method name `qcStatusFor` and its inputs (instrument, analyte, time — named `instrumentId`, `analyteId`, `at`) follow 01 §5.1; the signature uses the single-input-object style of 02-CV §8.1. `canAutoVerify(ctx, resultContext)` already takes one object.

| Aspect | Specification |
|---|---|
| Semantics | Phase 1 has no C9: the registered fake returns `deny` with `feature_disabled` for every result (every result manually first-verified — 04 R2) and `no_qc_data` for qcStatusFor. Production uses the phase stub (02-CV §8.2, 08 R9). Phase 2: real engine; `warning` = 1-2s fired, not a rejection (04 L23). CR-C9-004: with `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true` C5 calls `canAutoVerify` for every instrument-origin save that is not on hold and has no unit mismatch, independent of the tenant switch (shadow simulation), and auto-verifies only on `allow`; C9 still returns `deny`/`feature_disabled` while the tenant is disabled. |
| Invariants | `allow` never returned when any reason applies; `allow` never returned if tenant `autoVerificationEnabled = false`. |
| Performance | canAutoVerify ≤ 10 ms; qcStatusFor ≤ 10 ms (called per result at ingest). |
| Tenant context | required. |
| Fake must support | Phase-1 default (always deny/feature_disabled); programmable per analyte/instrument QC states; programmable allow for C5 Phase-2 tests. |
| Contract tests | (1) feature disabled → deny; (2) critical → deny with `critical`; (3) delta failure → deny; (4) QC out of control → deny `qc_out_of_control`; (5) all criteria pass + enabled → allow; (6) qcStatusFor with only 1-2s → `warning`; (7) time before any QC → `no_qc_data`. **Added by 08 (C9 02-TRD §11.1):** (8) open rejected run masks a newer accepted run; (9) staleness → `no_qc_data`; (10) shadow version never changes the returned decision; (11) `allow` never returned when any reason applies (property test); (12) other tenant's plan invisible → `no_qc_data`. |

### 4.15 `BillingCommandPort` — owner C4 (`billing`); consumer C4 (`frontdesk` only) — added by 08 (CR-C4-001)

Normative text = C4 02-TRD §6.3, with `catalog.tax_config_missing` in place of `billing.tax_config_missing` (08 R18). Lives in `contracts/ports/` because 02-CV lint forbids cross-module imports. No phase stub (08 R9).

```ts
// contracts/ports/BillingCommandPort.ts  (owner C4/billing; consumer allowlist: frontdesk only — CI manifest consumer check)
import type { RequestContext, Uuidv7, IsoUtc, Money, Code, Priority } from './common';
import type { OrderBalance } from './BillingPort';
export const BILLING_COMMAND_PORT_VERSION = 1 as const;

export interface PricedLineInput {
  readonly lineRef: string;                    // stable within one draft (orderable id + priority)
  readonly orderItemId?: Uuidv7;               // absent in quotes before items exist
  readonly orderableId: Uuidv7; readonly orderableKind: 'test' | 'panel';
  readonly code: Code; readonly name: string;  // snapshot for the fiscal line
  readonly departmentId?: Uuidv7;              // single department of all member tests, else absent
  readonly priority: Priority;
  readonly unitPrice: Money; readonly urgentSurcharge?: Money;   // from CatalogPort.priceFor
  readonly tax: { readonly vat: 'exempt' | 'taxable'; readonly otherTaxCode?: Code;      // from CatalogPort.priceFor().tax —
                  readonly vatRateBp?: number; readonly otherTaxRateBp?: number; readonly hsCode?: string };  // rates owned by C3 (08 R18)
  readonly priceListId: Uuidv7; readonly priceListVersion: number;
  readonly priceSource: 'explicit' | 'credit_party' | 'referrer' | 'centre' | 'tenant_default';
}
export interface DiscountInput {
  readonly scope: 'line' | 'bill'; readonly lineRef?: string;
  readonly kind: 'amount' | 'percent'; readonly amountPaisa?: number; readonly percentBp?: number;
}
export interface ComputedLine extends PricedLineInput {
  readonly lineKind: 'orderable' | 'urgent_surcharge';
  readonly gross: Money; readonly discount: Money; readonly exempt: Money; readonly taxable: Money;
  readonly vat: Money; readonly otherTax: Money; readonly otherTaxCode?: Code; readonly net: Money;
}
export interface Totals { readonly gross: Money; readonly discount: Money; readonly exempt: Money; readonly taxable: Money;
                          readonly vat: Money; readonly otherTax: Money; readonly net: Money }
export interface QuoteResult {
  readonly lines: readonly ComputedLine[]; readonly totals: Totals;
  readonly fingerprint: string;                // sha256 hex of canonical JSON {lines (incl. tax rates), discounts, totals}
  readonly baseFingerprint: string;            // the same fingerprint computed for the same lines with discounts: [] (discount-approval binding)
}
export interface IssuedInvoiceRef { readonly invoiceId: Uuidv7; readonly invoiceNo: string; readonly fiscalYearBs: string;
                                    readonly issuedAt: IsoUtc; readonly totals: Totals }

export interface BillingCommandPortV1 {
  /** Pure computation, no writes; uses the rates on each line (no C4 tax table — 08 R18).
   *  @throws catalog.tax_config_missing (line taxable without vatRateBp, or otherTaxCode without otherTaxRateBp) */
  computeQuote(ctx: RequestContext, input: { lines: readonly PricedLineInput[]; discounts: readonly DiscountInput[] }): Promise<QuoteResult>;
  /** Locked account, CatalogPort.getCreditParty({purpose:'billing'}) with allowsCredit = false or isActive = false → credit_party_locked.
   *  @throws billing.credit_party_locked, billing.credit_limit_exceeded */
  assertCreditAllowed(ctx: RequestContext, input: { creditPartyId: Uuidv7; additional: Money }): Promise<void>;
  /** Gapless allocation + invoice + lines + events (issued, balance.changed) in ctx.tx.
   *  Recomputes the quote and rejects if fingerprint differs (common.version_conflict).
   *  billing.counter_busy also carries detail "fiscal_year_rollover" when the FY changed during allocation (08 A13 D-25);
   *  the caller (frontdesk) retries its whole transaction once on billing.counter_busy and on SQLSTATE 40P01.
   *  @throws billing.counter_busy, billing.fiscal_year_closed, billing.numbering_pattern_invalid, catalog.tax_config_missing, common.version_conflict */
  issueOrderInvoice(ctx: RequestContext, input: {
    orderId: Uuidv7; patientId: Uuidv7; branchId: Uuidv7; centreId: Uuidv7; referrerId?: Uuidv7;
    buyer: { name: string; pan?: string; address?: string };
    lines: readonly PricedLineInput[]; discounts: readonly DiscountInput[]; expectedFingerprint: string;
    purpose: 'registration' | 'supplementary';
  }): Promise<IssuedInvoiceRef>;
  /** Upserts billing.credit_accounts from CatalogPort.getCreditParty({purpose:'billing'}) (code, name, PAN, address snapshot)
   *  before inserting charges; runs assertCreditAllowed. @throws billing.credit_party_locked, billing.credit_limit_exceeded, common.version_conflict */
  recordCreditCharges(ctx: RequestContext, input: { orderId: Uuidv7; creditPartyId: Uuidv7; branchId: Uuidv7; centreId: Uuidv7;
    referrerId?: Uuidv7; patientDisplayName: string; lines: readonly PricedLineInput[]; discounts: readonly DiscountInput[];
    expectedFingerprint: string }): Promise<{ chargeIds: readonly Uuidv7[]; totals: Totals }>;
  voidCreditCharges(ctx: RequestContext, input: { orderId: Uuidv7; orderItemIds?: readonly Uuidv7[]; reasonCode: Code }):
    Promise<{ voided: number; alreadyInvoiced: readonly Uuidv7[] }>;
  /** Manual or home-collection payment. Receipt numbers use TenantSettings.numbering.receiptNoPattern.
   *  @throws billing.payment_exceeds_due (manual only), billing.order_not_invoiced, billing.counter_busy (incl. detail "fiscal_year_rollover") */
  recordPayment(ctx: RequestContext, input: { orderId: Uuidv7; invoiceId?: Uuidv7; methodCode: Code; amount: Money;
    reference?: string; captureKind: 'manual' | 'home_collection'; idempotencyKey: string; collectedByMembershipId?: Uuidv7;
    capturedAt?: IsoUtc;
    issueReceiptNo: boolean;                     // false for payments taken in the registration transaction (the invoice is the receipt, PRD D-RECEIPT)
  }): Promise<{ ledgerEntryId: Uuidv7; receiptNo?: string; duplicate: boolean; exceedsDue: boolean; balance: OrderBalance }>;
  /** Records that issued invoice lines must be credited (order cancelled / items removed). No fiscal document is created.
   *  Covers the order's own invoices AND credit charges already on a periodic credit bill (voidCreditCharges.alreadyInvoiced):
   *  for those, one task per periodic invoice with invoice_id = charge.invoice_id, invoice_line_ids = the charges' invoice_line_id,
   *  and required = true. */
  raiseCreditNoteRequirement(ctx: RequestContext, input: { orderId: Uuidv7; orderItemIds?: readonly Uuidv7[];
    cause: 'order_cancelled' | 'item_removed'; reasonCode: Code }): Promise<{ required: boolean; taskIds: readonly Uuidv7[] }>;
  getOrderBillingSummary(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<{
    invoiceIds: readonly Uuidv7[]; hasIssuedInvoice: boolean; creditChargeIds: readonly Uuidv7[]; balance: OrderBalance }>;
}
export type BillingCommandPort = BillingCommandPortV1;
```

| Aspect | Specification |
|---|---|
| Semantics | C4-internal command port between the `frontdesk` and `billing` modules (01 §8 risk 4). Tax rates come from `CatalogPort.priceFor` on each line; C4 has no tax table (08 R18). |
| Performance | [CONV] computeQuote ≤ 10 ms for 20 lines; issueOrderInvoice ≤ 60 ms incl. counter; recordPayment ≤ 30 ms (≤ 50 ms when a receipt number is allocated). |
| Tenant context | required; frontdesk handlers and the C4 worker only. |
| Contract tests | (1) quote determinism (same input ⇒ same fingerprint); (2) fingerprint mismatch → `common.version_conflict`; (3) other-tenant order → `common.not_found`; (4) locked party → `billing.credit_party_locked`; (5) limit → `billing.credit_limit_exceeded`; (6) issue twice in one tx with same order+purpose `registration` → second throws `common.validation_failed` (one registration invoice per order); (7) payment over due manual → `billing.payment_exceeds_due`, home_collection → recorded with `exceedsDue: true`; (8) same idempotencyKey → `duplicate: true`; (9) raise requirement on order without invoice → `required: false`; (10) void charges after periodic invoicing → listed in `alreadyInvoiced`; (11) missing tax rate on a line → `catalog.tax_config_missing`; (12) `baseFingerprint` equals the `fingerprint` of the same lines quoted with `discounts: []`; (13) `raiseCreditNoteRequirement` after (10) → `required: true`, task on the periodic invoice; (14) credit party with `allowsCredit = false` → `billing.credit_party_locked`; (15) allocation across the FY boundary (injected clock) → `billing.counter_busy` with detail `fiscal_year_rollover`, no counter change. (Cases 12–15 and the `baseFingerprint`, `fiscal_year_rollover`, `billing.numbering_pattern_invalid`, credit-account upsert, `allowsCredit`/`isActive` and periodic credit-note texts copied from C4 02-TRD §6.3, 2026-11-06 final sweep.) |

### 4.16 `RenderPort` — owner C6 (`reporting`); consumers C4, C8, C13 (worker, partners system actor — 08 A5.1) — added by 08 (CR-C4-004 + CR-C8-009, R12c)

```ts
// contracts/ports/RenderPort.ts
import type { RequestContext } from './common';
export const RENDER_PORT_VERSION = 1 as const;
export type RenderTemplateKey = 'billing.invoice' | 'billing.credit_note' | 'billing.register' | 'analytics.report'
  | 'partners.access_slip';                                   // added by 08 Addendum A5.1 (CR-C13-014, additive)
export interface RenderPortV1 {
  /** System actors in worker tasks only. Data validated against contracts/render/<templateKey>.schema.json; bundled assets only (REQ-SEC-086);
   *  60 s timeout; the caller stores the bytes in its own bucket. analytics.report: ≤ 5,000 rows.
   *  @throws reporting.render_unavailable, reporting.template_invalid, common.payload_too_large (> 10 MB output), auth.forbidden (non-system actor) */
  renderPdf(ctx: RequestContext, input: { templateKey: RenderTemplateKey; data: Readonly<Record<string, unknown>>; idempotencyKey: string }):
    Promise<{ contentBase64: string; sha256: string; byteSize: number; pageCount: number }>;
}
export type RenderPort = RenderPortV1;
```

| Aspect | Specification |
|---|---|
| Semantics | Implemented in the `reporting` module, calling the renderer service; synchronous in the worker task; no row locks held across the call. Template directories: `services/renderer/templates/billing/**` → C4, `templates/analytics/**` → C8, `templates/smart/**` → C14; everything else under `services/renderer/**` → C6. Output ≤ 10 MB (base64). No cross-module bucket writes. |
| `partners.access_slip` (08 Addendum A5.1, CR-C13-014) | Caller: C13 worker as the partners system actor. Data schema `contracts/render/partners.access_slip.schema.json`: `{ tenantDisplayName, partnerName, patientDisplayName, orderRef, portalUrl, expiresAtLocal, issuedAtLocal }` — no results, no PHI beyond name and order ref. The QR code is drawn inside C6's render pipeline from `portalUrl` (C6 already renders report QR codes), so C13 adds no QR library. The portal URL exists only in worker memory and inside the PDF; it is never logged or stored as text. C13 stores the PDF in `partners-slips` (§13.4). |
| Tenant context | required; system actor only. No phase stub (owner ships in the consumers' phase — 08 R9). |
| Contract tests | (1) unknown key → `common.validation_failed`; (2) data violating schema → `reporting.template_invalid`; (3) user actor → `auth.forbidden`; (4) same idempotencyKey + data → identical sha256; (5) renderer down → `reporting.render_unavailable`. |

### 4.17 `EngagementPort` — owner C16 (`engagement`); consumers C4, C17 — added by 08 (CR-C17-005 + R25)

```ts
// contracts/ports/EngagementPort.ts
import type { RequestContext, Uuidv7, IsoUtc, Code, DecimalString } from './common';
export const ENGAGEMENT_PORT_VERSION = 1 as const;
export interface EngagementPortV1 {
  /** System actors, or staff holding homecollection.visit.assign / homecollection.visit.read (C17 checks the assignment). P2.
   *  Callers write access_log 'home_visit.view'. @throws common.not_found */
  getHomeAddress(ctx: RequestContext, input: { homeAddressId: Uuidv7; purpose: 'home_visit' }):
    Promise<{ addressText: string; landmark?: string; latitude?: DecimalString; longitude?: DecimalString }>;
  /** Registration (C4, frontdesk.registration.create holders). Returns undefined when no active membership. */
  getActiveMembership(ctx: RequestContext, input: { patientId: Uuidv7; at?: IsoUtc }):
    Promise<{ membershipId: Uuidv7; planCode: Code; planName: string; priceListId?: Uuidv7; validTo: IsoUtc } | undefined>;
}
export type EngagementPort = EngagementPortV1;
```

| Aspect | Specification |
|---|---|
| Semantics | Replaces the booking-address and patient-membership views proposed by CR-C16-012, which are not created (08 R25): operational reads use ports. Implemented in `services/api/src/modules/engagement/ports/EngagementPort.impl.ts`. |
| Tenant context | required. Production uses the phase stub until C16 ships: `getActiveMembership` → `undefined`; `getHomeAddress` → `common.not_found` (08 R9). |
| Contract tests | (1) other tenant → not_found / undefined; (2) device/patient actor → `auth.forbidden`; (3) expired membership → undefined. |

---
## 5. Change log — accepted additions and resolved ambiguities (lead decision, 2026-11-05)

### 5.1 Accepted additions log

All eight additions drafted as "P1–P8" in rev. 1 were **accepted**. They are now part of the contract and live in the sections below; this table is only an index.

| # | Addition | Needed by | Now lives in |
|---|---|---|---|
| A1 | `LabPort.submitModuleResult` (C10/C11 → C5): hands micro/anatomic results into the common verify → approve → release chain | C6, C10, C11 | §4.5 (signature, semantics, tests); §10.2 R2/R7; §6.8 module report-content views; §8 codes `lab.module_result_invalid`, `lab.module_result_stale` |
| A2 | C12 consumes `lab.result.verified.v1` and `instruments.qc.received.v1` | C12 | §3.9, §3.15, §3.25 |
| A3 | C9 consumes `lab.specimen.status_changed.v1` and `reporting.report.released.v1` | C9 | §3.7, §3.17, §3.25 |
| A4 | C10, C11 consume `lab.specimen.status_changed.v1` (act on `to_status = received`) | C10, C11 | §3.7, §3.25 |
| A5 | New event `engagement.booking.cancelled.v1` (C16 → C4, C17) | C4, C16, C17 | §3.24 (schema + validated example), §3.25 |
| A6 | `contracts/permissions.yaml` permission registry (C0) | all | §11 |
| A7 | C0 platform tables `core.event_log`, `<m>.event_inbox`, `core.dead_letters`, `core.idempotency_keys`, wrapper `app.enqueue_job` | all | §12 |
| A8 | C5 consumes `reporting.report.released.v1` (specimen `reported`, status board "printed") | C5 | §3.17, §3.25, §10.1 S10 |
| A9 | CR register 08 (2026-11-06) | all | `08-CR-REGISTER.md` §4 transcribed into §3, §4, §6–§11 |

Note for the 01 consumer lists: `01-CHUNK-MAP.md` §5.1 now includes A2–A5 and A8 (applied 2026-11-06 with 08).

### 5.2 Resolved ambiguities log (binding)

Every resolution below was accepted by the lead and is **binding** on all chunks. Chunk documents may not reopen them except by CR.

| # | Ambiguity | Binding resolution |
|---|---|---|
| X1 | 04 S12 / research 03 named `packages/db`, `packages/contract`; 01 §3 names `db/`, `contracts/` | Paths are `db/` and `contracts/` per 01 §3 (lead aligning 04 wording). |
| X2 | Instrument results arrive both by `instruments.result.received.v1` and `LabPort.ingestInstrumentResult` | The event is the canonical bulk path; the port is only for synchronous re-match/replay from C7's UI. Both are idempotent on the 04 N10 result-level key. |
| X3 | Gateway payments recorded both by `payments.intent.settled.v1` and `BillingPort.recordGatewayPayment` | C15 calls `recordGatewayPayment` inside its settle transaction (canonical write). C4's event consumer is an idempotent safety net plus follow-ups (receipt, notification). |
| X4 | `CatalogPort.mapInstrumentCode` (C3) vs "mappings" in the `instruments` schema (C7) and C7's mapping UI | Analyte-code maps are catalog data in `catalog.instrument_code_maps`, owned by C3, which implements the port. C7's mapping UI writes them through C3's HTTP API (`/v1/catalog/instrument-code-maps`). The `instruments` schema holds driver/channel configuration only. |
| X5 | Orders from bookings via both `engagement.booking.confirmed.v1` and `FrontdeskPort.createOrderFromBooking` | C16 uses the event (async); C13 partner manifests and C17 home visits call the port (sync, `source` enum). Same C4 logic behind both. |
| X6 | C1 listed as consumer of `instruments.agent.health_changed.v1` but owns no job path | C1 consumes through C7-exported metrics (`lims_instruments_agent_state`) and C1 alert rules. |
| X7 | Ports described as "inside the API"; worker jobs also need them | The worker core builds the same port registry as the API (02-CV §8.2); port implementations live once, in the owning API module. |
| X8 | Research specimen machine mixes result states | `resulted/verified/approved/reported` are specimen **roll-up** states derived from its results (§10.1); results have their own machine (§10.2). |
| X9 | 04 D4 "`TO authenticated`" vs dedicated login roles (04 D5) | Module-table policies target the group role `lims_app` (members `lims_api`, `lims_worker`) — narrower than `authenticated`, as REQ-SEC-015 allows. `authenticated` is used only for Supabase-served objects (`storage.objects`, `realtime.messages`, `api.*`). |
| X10 | 04 S19 "OpenAPI 3.1" vs stable oasdiff/dart-dio/Prism 3.1 gaps (04 T7/T8) | Specs are authored to be **valid OpenAPI 3.0.3** using only constructs that are also valid 3.1 (02-CV §4.12); the `openapi:` field is `3.0.3`. |
| X11 | `buildSummary(orderId, version)` / `qcStatusFor(instrument, analyte, time)` were positional | **Changed by the lead:** both use the single-input-object style of 02-CV §8.1; method names unchanged (§4.10, §4.11). |
| X12 | C8 not a consumer of `lab.specimen.rejected.v1` but needs rejection rates | C8 reads `lab.v_pub_rejection_daily`; no event change. |

### 5.3 Resolutions from the CR register (binding)

Decided in `08-CR-REGISTER.md` §2 (2026-11-06); the text there is authoritative. Login rate limiting: R6 is superseded by 08 Addendum A1 (founder decision).

| # | Resolution | Reference |
|---|---|---|
| R1 | Amendment reason on `LabPort.submitModuleResult` (CR-C10-001 + CR-C11-004; CR-C10-002; C11 supplementary report) | see 08 R1 |
| R2 | Anatomic "sign-out" vs final approval (CR-C11-010) | see 08 R2 |
| R3 | Branch / centre scope model (CR-C2-003; C0 05-SCHEMA §3.3; C12 R6) | see 08 R3 |
| R4 | `billing.v_pub_payment_collection` column name (CR-C8-010) | see 08 R4 |
| R5 | Glossary `core.centres` and `TO authenticated` (CR-C0-008, CR-C2-015) | see 08 R5 |
| R6 | Login rate limit 5/min/IP vs labs behind one NAT (CR-C1-009; CR-C2-012; CR-C16-018) | see 08 R6 — superseded by 08 Addendum A1 |
| R7 | Duplicate orders for home-collection bookings (CR-C17-001; C4 booking consumer; C16 TRD §4.7 note / R-5) | see 08 R7 |
| R8 | Patient-context payments (C15 F-04; C16 TRD §4.7; C4 RLS; CR-C15-001/002/010) | see 08 R8 |
| R9 | Production phase stubs (CR-C0-010) | see 08 R9 |
| R10 | Claims architecture and session kinds (CR-C2-005, C2-009, C2-004, C0-003, C0-007, SP-1; CR-C13-003, C16-004, C17-004) | see 08 R10 |
| R11 | Overlapping port additions (CatalogPort, LabPort, FrontdeskPort, IdentityPort, ReportingPort) | see 08 R11 |
| R12 | Duplicate shared-library CRs | see 08 R12 |
| R13 | Event changes (CR-C5-006, C7-004, C12-004, C12-006, C17-006, C16-009, C10-007, C3-003, C8-007) | see 08 R13 |
| R14 | Path ownership (CR-C0-001, C0-002, C2-001, C13-001, C15-007, C16-001, C4-004, C8-009) | see 08 R14 |
| R15 | Doc-owner wording CRs (CR-C18-010, CR-C4-012/C15-012, CR-C1-007, CR-C8-003) | see 08 R15 |
| R16 | Founder actions buried in CRs | see 08 R16 |
| R17 | Smart-report per-summary pathologist approval volume (C14 06 R1) | see 08 R17 |
| R18 | Tax-rate ownership duplicated (found: C3 `catalog.tax_rules`/`cs_tax_types` + `PriceQuote.vatRateBp`; C4 `billing.tax_codes` + `billing.tax_config_missing`) | see 08 R18 |
| R19 | Permission codes with two segments (found) | see 08 R19 |
| R20 | Access-log action codes (found) | see 08 R20 |
| R21 | `TenantSettings` collisions (found: CR-C0-009 `branding.accentColor`, CR-C2-008 `branding{…}`, CR-C4-009 `letterhead{…}`; numbering CR-C2-008, C5-009, C11-005) | see 08 R21 |
| R22 | UI-kit duplicates and look-alikes (found; CR-C2-016, C3-006, C4-013, C6-010, C7-010, others) | see 08 R22 |
| R23 | Platform authorisation path (found: CR-C0-004 vs C2 TRD §7.2) | see 08 R23 |
| R24 | Token-hash representation (found: C6, C16 use `text`; C2, C7, C15 use `bytea`) | see 08 R24; scope per 08 Addendum A2.4: every stored token hash **or HMAC** compared for authentication or redemption is `bytea` with `octet_length = 32` (incl. C16 `link_codes.code_hmac`, `bound_phone_hmac`; `app.engagement_redeem_link_code` takes `bytea`); content/row digests (file checksums, payload digests) may stay hex `text` with a format CHECK |
| R25 | Published views used for operational reads (found: CR-C6-012, CR-C16-012/014; 01 §5 "views are for reporting reads only") | see 08 R25 |
| R26 | Storage bucket naming and ownership (found) | see 08 R26 |
| R27 | Global uniqueness of staff users (found: C0 05-SCHEMA §3.3 vs CR-C2-017) | see 08 R27 |
| A1 | Login rate limiting must not depend on static IPs (per-IP failure counter + edge flood guard; R6's registered-IP zone removed) | see 08 Addendum A1 |
| A2 | Lead decisions on apply-phase findings (A2.1 C13 access slip via worker; A2.2 `CatalogPort.getTaxRate`; A2.3/A2.8 smart summary via C6 report-version snapshot; A2.4 R24 scope; A2.5 C17 `map_handoff_enabled` default true; A2.6 `analytics.report_ready` / `short_text` (corrected to `label_text` by A4.3) / IdentityPort staff recipients (permission corrected by A4.2); A2.7 C8 not a consumer of engagement daily views; A2.9 C4 access-log codes; A2.10 C5 label-print conflict = `common.version_conflict`; A2.11 strict YAML routes; A2.12 R7 review via `frontdesk.order_flags`) | see 08 Addendum A2 |
| A3 | Lead decisions on the C0–C2 apply report (A3.1 `identity.sessions.previous_token_sha256` + partial unique index exception; A3.2 fail2ban jail; A3.3 C0 owns `core.*` DDL) | see 08 Addendum A3 |
| A4 | Lead decisions on the A2 fix-pass report (A4.1 `getTaxRate` signature: `RequestContext`, `kind 'vat' \| 'other'`, `effectiveFrom string \| null`; A4.2 `IdentityPort.getStaffNotificationContact` (CR-C6-018), staff recipient carries the report's `requiredPermission`, A2.6's non-existent permission name withdrawn; A4.3 C6 `short_text` restored, new `label_text` for `schedule_name`; A4.4 smart-summary snapshot at first assembly and at Regenerate, `smartSummaryAvailable` semantics; A4.5 C4 `receipt.print`; A4.6 `smartreport.summary_not_ready` narrowed to staff callers; A4.7 C6 portal "Health summary" section; A4.8 §13.1 strict YAML list) | see 08 Addendum A4 |
| A5 | Lead decisions on the C8/C12–C17 fix-pass report — applied in 03: A5.1 RenderPort `partners.access_slip` (C13 worker consumer, data schema); A5.2 bucket `partners-slips` (§13.4); A5.7 C16 removed from SmartReportPort consumers (§4.10). A5.3–A5.6 have no 03 text. | see 08 Addendum A5 |
| A11–A13 | Applied in 03: A11.1 portal dues payment (§4.9 consumers/callers, §7 `portal.payment_done`, CR-C15-010 ACCEPT-MODIFIED); A12 pre-tenant/maintenance GUCs (§13.3); A13 P-2/P-3/P-9/P-12/P-13/P-15 (§6, §13.1, §13.6), D-1/D-2/D-3/D-21 (§3.4, §3.9, §3.18, §3.19 — `if`/`then`/`else`, `x-extensible`), D-5/D-7/D-9/D-10/D-26/D-29/D-34/D-35 (§4.2, §4.5, §4.6, §4.8), D-6 (§3.7, §3.25), D-8/D-23 (§9.3), D-15/D-7/D-5 (§10.1, §10.2, §10.4), D-4/D-14/D-16/D-18/D-24/D-28 (§11), D-23/D-24/D-25 (§8), D-11 (§13.1), D-19 (§6.6), D-30/D-42/P-6 (§13.3). | see 08 Addenda A11–A13 |

---

## 6. Published read views (`<schema>.v_pub_*`)

All views: `WITH (security_invoker = true)` (REQ-SEC-031), `GRANT SELECT … TO lims_app`, columns are a contract (02-CV §5.13). `business_date` = date in the tenant timezone (default `Asia/Kathmandu`) of the anchoring timestamp. **Business-date timezone in v1 (08 A13 P-15):** in v1, `TenantSettings.timezone` accepts only `Asia/Kathmandu` (C2 rejects other values with `identity.setting_out_of_range`). Views use the literal `AT TIME ZONE 'Asia/Kathmandu'`, and app code reads `timezone`. A per-tenant timezone needs a CR that adds stored `business_date` columns (08 §4.9 fallback). Money columns are `bigint` paisa. Column types: `uuid`, `date`, `timestamptz`, `bigint`, `integer`, `text`, `boolean`.

### 6.1 `frontdesk` (owner C4)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `frontdesk.v_pub_order_daily` | tenant_id, branch_id, centre_id, business_date, orders_registered, patients_distinct, new_patients, urgent_orders, cancelled_orders, opd_orders, ipd_orders | dashboard "patients" tiles (00 F1) | C8 |
| `frontdesk.v_pub_referrer_volume` | tenant_id, business_date, branch_id, centre_id, referrer_id, orders, patients_distinct, order_items | "which doctor sends the most patients" (00 F3) | C8 |
| `frontdesk.v_pub_centre_volume` | tenant_id, business_date, branch_id, centre_id, collection_mode, orders, patients_distinct, order_items | "which collection centre sends the most" (00 F3) | C8 |
| `frontdesk.v_pub_order_status` | tenant_id, order_id, patient_id, centre_id, branch_id, source, source_ref_id, partner_id, status, registered_at, updated_at | read models for tracking | C13, C16, C17 |

### 6.2 `billing` (owner C4)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `billing.v_pub_invoice_daily` | tenant_id, branch_id, centre_id, business_date, invoices_issued, invoices_cancelled, gross_paisa, discount_paisa, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa, credit_notes_paisa | daily income (00 F1) | C8 |
| `billing.v_pub_department_income` | tenant_id, branch_id, centre_id, business_date, department_id, line_count, gross_paisa, discount_paisa, net_paisa | income by department (00 F2) — `department_id` snapshotted on invoice lines at issue | C8 |
| `billing.v_pub_payment_collection` | tenant_id, branch_id, centre_id, business_date, collected_by_membership_id, payment_method_code, entries, reversals, gross_collected_paisa, reversed_paisa, net_collected_paisa | daily cash collection by staff and method (00 E7). C0 DDL: `method_code AS payment_method_code` (08 R4) | C8, C15 |
| `billing.v_pub_referrer_billing` | tenant_id, business_date, referrer_id, centre_id, orders, net_billed_paisa | referral-incentive **report** input (never labelled "commission" — 04 L19, B13) | C8 |
| `billing.v_pub_credit_party_statement` | tenant_id, credit_party_id, period_month (date, first of A.D. month), fiscal_year_bs, invoiced_paisa, paid_paisa, credited_paisa, closing_balance_paisa | credit-party monthly bill/statement (00 E6) | C13 (C8 removed — 08 A17 D-51; a later additive C8 CR may add it once a credit-party label source exists) |
| `billing.v_pub_order_balance` | tenant_id, order_id, invoiced_paisa, paid_paisa, credited_paisa, balance_due_paisa, balance_version, release_basis | read models (portal/app/partner due display) | C13, C16, C17 |

### 6.3 `lab` (owner C5)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `lab.v_pub_specimen_timeline` | tenant_id, specimen_id, order_id, centre_id, processing_branch_id, specimen_type_code, priority, status, ordered_at, collected_at, in_transit_at, received_at, first_resulted_at, first_verified_at, all_approved_at, reported_at, rejected_at, rejection_reason_code, parent_specimen_id (added by 08, CR-C8-004), replaces_specimen_id, specimen_version (= `lab.specimens.version`, the event aggregate seq; added by 08 A19 D-106, CR-C16-022) | TAT segments: pre-analytical (collection→received), within-lab (received→first verified), total (registration→report) (01 research §2.7) | C8, C9, C13, C16 |
| `lab.v_pub_pending_items` | tenant_id, centre_id, processing_branch_id, department_id, test_id, order_id, order_item_id, specimen_id, priority, item_status, received_at, tat_target_seconds, age_seconds | pending test list (00 F4) | C8, C9 |
| `lab.v_pub_result_daily` | tenant_id, processing_branch_id, business_date, department_id, test_id, results_resulted, results_verified, results_approved, results_amended, auto_verified, critical_count, abnormal_count, centre_id (order's collection centre; grouping key), tests_approved bigint (added by 08, CR-C8-004) | tests done (00 F1) | C8, C9, C12 |
| `lab.v_pub_rejection_daily` | tenant_id, centre_id, business_date, specimen_type_code, reason_code, rejections, recollections_ordered | rejection rate MIS (01 research §2.1) | C8, C9 |
| `lab.v_pub_critical_value_daily` | tenant_id, business_date, analyte_id, detected, notified, median_notify_seconds, max_notify_seconds, centre_id (grouping key; added by 08, CR-C8-004) | critical-value log stats (04 L21) | C8, C9 |
| `lab.v_pub_qc_result` | tenant_id, qc_result_id, instrument_id, analyte_id, control_id_raw, control_lot_raw, control_level, value_numeric (text decimal), unit_code, instrument_result_time, received_at, source (instrument/manual), created_at (added by 08; index `qc_results__tenant_id_created_at__idx (tenant_id, created_at, id)`, CR-C9-005) | QC raw data captured in Phase 1 (04 §12) | C9 |

### 6.4 `reporting` (owner C6)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `reporting.v_pub_report_release` | tenant_id, report_id, version_no, order_id, centre_id, report_kind (may be `addendum` — 08 R1), released_at, release_basis, superseded_at | release counts, overrides | C8 |
| `reporting.v_pub_order_report_tat` | tenant_id, order_id, centre_id, registered_at, first_released_at, final_released_at, total_tat_seconds | total TAT | C8, C9 |
| `reporting.v_pub_delivery_daily` | tenant_id, business_date, channel, purpose, recipient_kind, queued, sent, delivered, read, failed, suppressed, centre_id (NULL for non-report deliveries; added by 08, CR-C8-005; grouped by it). `business_date` = delivery creation date for every count (cohort; 08 A17 D-48) | delivery stats | C8 |

### 6.5 `instruments` (owner C7)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `instruments.v_pub_agent_status` | tenant_id, agent_id, centre_id, state, last_heartbeat_at, agent_version, queue_depth, clock_offset_seconds | fleet status | C8 |
| `instruments.v_pub_message_daily` | tenant_id, instrument_id, centre_id, business_date, messages, patient_records, qc_records, unmatched, quarantined, duplicates | interface volume & health | C8, C12 |
| `instruments.v_pub_instrument_directory` (added by 08, CR-C9-006 + CR-C12-005, R12d) | tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active | instrument labels/filters; P0 | C8, C9, C12 |

### 6.6 `catalog` (owner C3)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `catalog.v_pub_department` | tenant_id, department_id, code, name, is_active | labels for MIS | C8 |
| `catalog.v_pub_test_directory` | tenant_id, test_id, code, name, department_id, workflow_type, is_active | labels/filters | C8, C12, C13 |
| `catalog.v_pub_price_list_items` | tenant_id, price_list_id, price_list_version, owner_kind (credit_party/referrer/centre/default), owner_id, orderable_id, unit_price_paisa, effective_from, effective_to, falls_through (`boolean`, appended — 08 A13 D-19) | partner price list view (C13 scope). C16 no longer reads this view: it validates a `price_list_id` with `CatalogPort.getPriceListStatus` (08 A24.1, CR-C16-023; replaces the CR-C16-013 read). Rows only for versions `status IN ('published','superseded')` of active lists (`WHERE v.status IN ('published','superseded') AND l.is_active`); inactive lists excluded; consumers apply fall-through to the tenant default list themselves (08 A13 D-19) | C13 |
| `catalog.v_pub_referrer_directory` | tenant_id, referrer_id, display_name, is_active, canonical_referrer_id (added by 08, CR-C3-004) | referrer labels | C8 |

### 6.7 `quality` (owner C9, Wave 2)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `quality.v_pub_qc_summary` | tenant_id, instrument_id, analyte_id, business_date, runs, accepted_runs, rejected_runs, warnings, last_in_control_run_at | QC summary for MIS | C8 |

### 6.8 `micro` and `anatomic` report content (owners C10, C11, Wave 2 — A1)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `micro.v_pub_report_content` | tenant_id, entity_id, version_no, order_item_id, report_phase (preliminary/final), culture_summary_text, isolates (jsonb: seq, organism_code, organism_display, growth_text), ast (jsonb: isolate_seq, antibiotic_code, antibiotic_display, method, raw_value, category_code, standard, standard_version), comments_text, signed_by_membership_id, signed_at | render micro sections from the `payloadRef` submitted via `LabPort.submitModuleResult` | C6, C14 |
| `anatomic.v_pub_report_content` | tenant_id, entity_id, version_no, order_item_id, accession_no, case_kind (histology/cytology/ihc/molecular), gross_text, microscopy_text, impression_text, synoptic (jsonb), images (jsonb: bucket, object_path, sha256, caption), signed_by_membership_id, signed_at, version_kind, scope, change_reason_code, clinical_history_text, comment_text, specimen_parts, slides, ancillary, molecular, addenda, diagnosis_codes (appended by 08, CR-C11-001; JSON Schemas in C11 05-SCHEMA §5) | render anatomic/molecular narrative sections | C6, C14 |

`jsonb` columns carry arrays of objects with exactly the keys listed; their JSON Schemas are specified in C10/C11 `05-SCHEMA.md` and transcribed by C0. Only `version_no`s that were submitted via A1 are guaranteed stable (immutable) in these views.

### 6.9 `engagement` (owner C16, Wave 3 — added by 08, CR-C16-012)

| View | Columns | Purpose | Consumers |
|---|---|---|---|
| `engagement.v_pub_booking_daily` | tenant_id, centre_id, business_date (slot start, Asia/Kathmandu), booking_kind, created_via, bookings, completed, no_shows, cancelled | booking MIS; P0 | none yet — C8 removed by 08 A2.7 (later additive C8 CR once C16 ships); C16 owns the view |
| `engagement.v_pub_queue_daily` | tenant_id, centre_id, queue_id, business_date, tokens_issued, tokens_completed, tokens_not_served, median_wait_seconds, p90_wait_seconds | queue MIS; P0 | none yet — C8 removed by 08 A2.7 (later additive C8 CR once C16 ships); C16 owns the view |

Not created (08 R25): the booking-address and patient-membership views proposed by CR-C16-012 — operational reads go through `EngagementPort` (§4.17). C6 is **not** a consumer of `catalog.v_pub_department` or `frontdesk.v_pub_order_status`: report rendering uses `TestDefinition.departmentName` and `OrderSummary.partnerId` (08 R25).

Expression indexes for date-bounded reads (CR-C8-011): C0 creates them in the owner schemas; whether `(ts AT TIME ZONE 'Asia/Kathmandu')::date` is indexable on PG 17 stays UNVERIFIED and is proven in the migration PR; fallback = a stored `business_date` column written by the owner.

Global note: core tables (tenants, branches, centres, users, memberships) are read by every module through C0's `ctx.core` repository (01 §5 R1), so no `core.v_pub_*` views are defined.

---

## 7. Cross-app route registry (`contracts/routes.yaml`)

Rules: route params are **only** UUIDs or opaque tokens — never names, phones, barcodes or registration numbers (REQ-SEC-098). Origins are configured per environment by C1 (`LIMS_ORIGIN_<NAME>`); no host names are fixed here. Token routes (`/r/…`, `/v/…`) MUST be excluded from access-log path logging at nginx (C1) and the portal (C6) — the token is a secret. `auth: display_token` routes (added by 08) render without the staff session and are never nav entries (`nav: false`). The block is strict YAML (08 A2.11): every `path` containing a `{param}` is a quoted string; CI parses the file with a YAML parser.

```yaml
# contracts/routes.yaml (C0) — version 1
version: 1
origins:
  staff_web:   { env: LIMS_ORIGIN_STAFF_WEB,  owner: C0 }   # apps/web (BFF)
  portal:      { env: LIMS_ORIGIN_PORTAL,     owner: C6 }   # apps/portal (separate origin — 01 §3)
  partner:     { env: LIMS_ORIGIN_PARTNER,    owner: C13 }  # apps/partner
  patient_app: { scheme: app_link, base_origin: portal, path_prefix: /app, owner: C16 }  # verified app links on the portal origin [CONV]
  phlebo_app:  { scheme: app_link, base_origin: portal, path_prefix: /phlebo, owner: C17 }
  api:         { env: LIMS_ORIGIN_API,        owner: C1 }   # added by 08 (CR-C1-004)
fallbacks:     [portal.report_link_required, portal.app_fallback]   # portal.app_fallback added by 08 (served by C6, CR-C16-010)
routes:
  # ---- staff web (owner = chunk owning the route segment) ----
  - { id: staff.frontdesk.registration_new, origin: staff_web, path: /frontdesk/registrations/new,              owner: C4,  permission: frontdesk.registration.create }
  - { id: staff.frontdesk.order,            origin: staff_web, path: "/frontdesk/orders/{order_id}",              owner: C4,  permission: frontdesk.order.read }
  - { id: staff.frontdesk.patient,          origin: staff_web, path: "/frontdesk/patients/{patient_id}",          owner: C4,  permission: frontdesk.patient.read }
  - { id: staff.billing.invoice,            origin: staff_web, path: "/billing/invoices/{invoice_id}",            owner: C4,  permission: billing.invoice.read }
  - { id: staff.billing.credit_party,       origin: staff_web, path: "/billing/credit-parties/{credit_party_id}", owner: C4,  permission: billing.credit_party.read }
  - { id: staff.billing.daily_cash,         origin: staff_web, path: /billing/daily-cash,                       owner: C4,  permission: billing.cash_report.read }
  - { id: staff.lab.status_board,           origin: staff_web, path: /lab/status-board,                         owner: C5,  permission: lab.status_board.read }
  - { id: staff.lab.specimen,               origin: staff_web, path: "/lab/specimens/{specimen_id}",              owner: C5,  permission: lab.specimen.read }
  - { id: staff.lab.order_results,          origin: staff_web, path: "/lab/orders/{order_id}/results",            owner: C5,  permission: lab.result.read }
  - { id: staff.lab.critical_value,         origin: staff_web, path: "/lab/critical-values/{critical_event_id}",  owner: C5,  permission: lab.critical_value.read }
  - { id: staff.lab.worklist,               origin: staff_web, path: "/lab/worklists/{department_id}",            owner: C5,  permission: lab.worklist.read }
  - { id: staff.reporting.report,           origin: staff_web, path: "/reporting/reports/{report_id}",            owner: C6,  permission: reporting.report.read }
  - { id: staff.reporting.delivery,         origin: staff_web, path: "/reporting/deliveries/{delivery_id}",       owner: C6,  permission: reporting.delivery.read }
  - { id: staff.catalog.test,               origin: staff_web, path: "/catalog/tests/{test_id}",                  owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.price_list,         origin: staff_web, path: "/catalog/price-lists/{price_list_id}",      owner: C3,  permission: catalog.price_list.read }
  # LD-71 / CR-C3-031-a: SCR-01..05 (C3 04-UI-UX section 1)
  - { id: staff.catalog.home,               origin: staff_web, path: /catalog,                                  owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.departments,        origin: staff_web, path: /catalog/departments,                      owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.specimens,          origin: staff_web, path: /catalog/specimens,                        owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.methods,            origin: staff_web, path: /catalog/methods,                          owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.units,              origin: staff_web, path: /catalog/units,                            owner: C3,  permission: catalog.test.read }
  # LD-76 / CR-C3-033-a: SCR-09..12 (C3 04-UI-UX section 1)
  - { id: staff.catalog.panels,             origin: staff_web, path: /catalog/panels,                           owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.panel,              origin: staff_web, path: "/catalog/panels/{panel_id}",                owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.comment_codes,      origin: staff_web, path: /catalog/comment-codes,                    owner: C3,  permission: catalog.test.read }
  - { id: staff.catalog.doctors,            origin: staff_web, path: /catalog/doctors,                          owner: C3,  permission: catalog.referrer.read }
  - { id: staff.catalog.doctor_verify,      origin: staff_web, path: /catalog/doctors/verify,                   owner: C3,  permission: catalog.referrer.read }
  - { id: staff.catalog.doctor,             origin: staff_web, path: "/catalog/doctors/{doctor_id}",              owner: C3,  permission: catalog.referrer.read }
  - { id: staff.catalog.credit_parties,     origin: staff_web, path: /catalog/credit-parties,                   owner: C3,  permission: catalog.price_list.read }
  - { id: staff.catalog.credit_party,       origin: staff_web, path: "/catalog/credit-parties/{credit_party_id}", owner: C3,  permission: catalog.price_list.read }
  # LD-84 / CR-C3-034-a: SCR-13…17 (04-UI-UX §1)
  - { id: staff.catalog.price_lists,         origin: staff_web, path: /catalog/price-lists,                       owner: C3,  permission: catalog.price_list.read }
  - { id: staff.catalog.price_list_version,  origin: staff_web, path: "/catalog/price-lists/{price_list_id}/versions/{version_id}", owner: C3, permission: catalog.price_list.read }
  - { id: staff.catalog.price_simulator,     origin: staff_web, path: /catalog/price-simulator,                   owner: C3,  permission: catalog.price_list.read }
  - { id: staff.catalog.surcharges,          origin: staff_web, path: /catalog/surcharges,                        owner: C3,  permission: catalog.price_list.read }
  - { id: staff.catalog.tax,                 origin: staff_web, path: /catalog/tax,                               owner: C3,  permission: catalog.price_list.read }
  - { id: staff.instruments.agent,          origin: staff_web, path: "/instruments/agents/{agent_id}",            owner: C7,  permission: instruments.agent.read }
  - { id: staff.instruments.message,        origin: staff_web, path: "/instruments/messages/{instrument_message_id}", owner: C7, permission: instruments.message.read }
  - { id: staff.analytics.dashboard,        origin: staff_web, path: /analytics,                                owner: C8,  permission: analytics.dashboard.read }
  - { id: staff.admin.user,                 origin: staff_web, path: "/admin/users/{membership_id}",              owner: C2,  permission: identity.user.read }
  - { id: staff.admin.audit_entry,          origin: staff_web, path: "/admin/audit/{audit_id}",                   owner: C2,  permission: audit.log.read }
  - { id: staff.platform.tenant,            origin: staff_web, path: "/platform/tenants/{tenant_id}",             owner: C2,  permission: platform.tenant.read }
  - { id: staff.platform.dead_letter,       origin: staff_web, path: "/platform/dead-letters/{dead_letter_id}",   owner: C2,  permission: platform.dead_letter.manage }
  # LD-112 / CR-C2-T20, CR-C2-T26: nav routes for AD-1..AD-15 and ME-1, PL-1..PL-8 (C2 04-UI-UX section 1); no parameterised row, no role editor row
  - { id: staff.admin.me,                origin: staff_web, path: /admin/me,                     owner: C2,  permission: identity.self.manage }
  - { id: staff.admin.users,             origin: staff_web, path: /admin/users,                  owner: C2,  permission: identity.user.read }
  - { id: staff.admin.user_new,          origin: staff_web, path: /admin/users/new,              owner: C2,  permission: identity.user.manage }
  - { id: staff.admin.roles,             origin: staff_web, path: /admin/roles,                  owner: C2,  permission: identity.user.read }
  - { id: staff.admin.branches,          origin: staff_web, path: /admin/branches,               owner: C2,  permission: identity.user.read }
  - { id: staff.admin.centres,           origin: staff_web, path: /admin/centres,                owner: C2,  permission: identity.centre.read }
  - { id: staff.admin.settings,          origin: staff_web, path: /admin/settings,               owner: C2,  permission: identity.settings.manage }
  - { id: staff.admin.sessions,          origin: staff_web, path: /admin/sessions,               owner: C2,  permission: identity.session.revoke }
  - { id: staff.admin.audit,             origin: staff_web, path: /admin/audit,                  owner: C2,  permission: audit.log.read }
  - { id: staff.admin.access_log,        origin: staff_web, path: /admin/access-log,             owner: C2,  permission: audit.log.read }
  - { id: staff.admin.exports,           origin: staff_web, path: /admin/exports,                owner: C2,  permission: audit.log.export }
  - { id: staff.admin.support_access,    origin: staff_web, path: /admin/support-access,         owner: C2,  permission: audit.log.read }
  - { id: staff.admin.access_review,     origin: staff_web, path: /admin/access-review,          owner: C2,  permission: identity.user.read }
  - { id: staff.platform.home,           origin: staff_web, path: /platform,                     owner: C2,  permission: platform.tenant.read }
  - { id: staff.platform.tenants,        origin: staff_web, path: /platform/tenants,             owner: C2,  permission: platform.tenant.read }
  - { id: staff.platform.ird,            origin: staff_web, path: /platform/ird,                 owner: C2,  permission: platform.tenant.read }
  - { id: staff.platform.support_sessions, origin: staff_web, path: /platform/support-sessions,    owner: C2,  permission: platform.tenant.read }
  - { id: staff.platform.dead_letters,   origin: staff_web, path: /platform/dead-letters,        owner: C2,  permission: platform.dead_letter.manage }
  - { id: staff.platform.staff,          origin: staff_web, path: /platform/staff,               owner: C2,  permission: platform.staff.manage }
  - { id: staff.platform.auth_events,    origin: staff_web, path: /platform/auth-events,         owner: C2,  permission: platform.tenant.read }
  - { id: staff.quality.qc_run,             origin: staff_web, path: "/quality/qc-runs/{qc_run_id}",              owner: C9,  permission: quality.qc_run.read }
  # LD-130 / CR-C9-T01: nav routes for the quality nav manifest (C9 04-UI-UX section 1.1); qc_run stays the only parameterised row
  - { id: staff.quality.status,               origin: staff_web, path: "/quality",                        owner: C9, permission: quality.qc_run.read }
  - { id: staff.quality.runs,                 origin: staff_web, path: "/quality/runs",                   owner: C9, permission: quality.qc_run.read }
  - { id: staff.quality.lj_chart,             origin: staff_web, path: "/quality/lj",                     owner: C9, permission: quality.qc_run.read }
  - { id: staff.quality.observations,         origin: staff_web, path: "/quality/observations",           owner: C9, permission: quality.qc_run.read }
  - { id: staff.quality.setup,                origin: staff_web, path: "/quality/setup/materials",        owner: C9, permission: quality.qc_run.read }
  - { id: staff.quality.autoverify,           origin: staff_web, path: "/quality/autoverify",             owner: C9, permission: quality.autoverify.read }
  - { id: staff.quality.tat_alerts,           origin: staff_web, path: "/quality/tat-alerts",             owner: C9, permission: quality.tat_alert.read }
  - { id: staff.quality.settings,             origin: staff_web, path: "/quality/settings",               owner: C9, permission: quality.qc_run.read }
  - { id: staff.micro.culture,              origin: staff_web, path: "/micro/cultures/{culture_id}",              owner: C10, permission: micro.culture.read }
  - { id: staff.anatomic.case,              origin: staff_web, path: "/anatomic/cases/{case_id}",                 owner: C11, permission: anatomic.case.read }
  - { id: staff.inventory.item,             origin: staff_web, path: "/inventory/items/{item_id}",                owner: C12, permission: inventory.item.read }
  - { id: staff.smartreport.summary,        origin: staff_web, path: "/smartreport/summaries/{summary_id}",       owner: C14, permission: smartreport.summary.read }
  # LD-130 / CR-C14-T18a: nav routes for the smartreport nav manifest (C14 04-UI-UX section 1); summary stays the only parameterised row
  - { id: staff.smartreport.summaries,        origin: staff_web, path: "/smartreport/summaries",          owner: C14, permission: smartreport.summary.read }
  - { id: staff.smartreport.library,          origin: staff_web, path: "/smartreport/library",            owner: C14, permission: smartreport.template.manage }
  - { id: staff.smartreport.wording,          origin: staff_web, path: "/smartreport/wording",            owner: C14, permission: smartreport.template.manage }
  - { id: staff.engagement.booking,         origin: staff_web, path: "/engagement/bookings/{booking_id}",         owner: C16, permission: engagement.booking.read }
  - { id: staff.homecollection.visit,       origin: staff_web, path: "/homecollection/visits/{visit_id}",         owner: C17, permission: homecollection.visit.read }
  # ---- portal (public + OTP-gated) ----
  - { id: portal.report_link, origin: portal, path: "/r/{link_token}", owner: C6, auth: link_token+otp, rate_limit_tier: report_download }   # 04 A9/A10
  - { id: portal.qr_verify,   origin: portal, path: "/v/{qr_token}",   owner: C6, auth: public,         rate_limit_tier: qr_verify }        # 04 A11, R3
  - { id: portal.dues_link, origin: portal, path: "/r/{link_token}/dues", owner: C6, auth: link_token+otp }   # 08 A21.1 dues link under hold-till-paid; path from the C6 second-pass hand-off (accepted); id [CONV]
  - { id: portal.payment_done, origin: portal, path: "/r/payments/{portal_payment_request_id}/done", owner: C6, auth: link_token+otp }   # 08 A11.1 (CR-C15-010 ACCEPT-MODIFIED): gateway return/cancel URL of the portal dues payment; path fixed by A11.1 [CONV]; id and auth [CONV]; ships with C15
  # ---- partner portal ----
  - { id: partner.order,    origin: partner, path: "/orders/{order_id}",       owner: C13, auth: partner_user }
  - { id: partner.report,   origin: partner, path: "/reports/{report_id}",     owner: C13, auth: partner_user }
  - { id: partner.manifest, origin: partner, path: "/manifests/{manifest_id}", owner: C13, auth: partner_user }
  - { id: partner.statement,origin: partner, path: "/statements/{period_month}", owner: C13, auth: partner_user, params: { period_month: "YYYY-MM" } }
  # ---- patient app (app links; fallback = same path rendered by portal) ----
  - { id: patient_app.report,  origin: patient_app, path: "/reports/{report_id}",   owner: C16, auth: patient, fallback: portal.report_link_required }
  - { id: patient_app.booking, origin: patient_app, path: "/bookings/{booking_id}", owner: C16, auth: patient }
  - { id: patient_app.order,   origin: patient_app, path: "/orders/{order_id}",     owner: C16, auth: patient }
  # ---- phlebotomy app ----
  - { id: phlebo_app.visit,    origin: phlebo_app,  path: "/visits/{visit_id}",     owner: C17, auth: phlebotomist }
  - { id: phlebo_app.route,    origin: phlebo_app,  path: "/routes/{route_date}",   owner: C17, auth: phlebotomist, params: { route_date: "YYYY-MM-DD" } }
  # ---- added by 08 §4.3 (CR register 2026-11-06), grouped by raising chunk ----
  # --- CR-C5-007
  - { id: staff.lab.order_labels, origin: staff_web, path: "/lab/orders/{order_id}/labels", owner: C5, permission: lab.specimen.label_print }
  - { id: staff.lab.ingest_exception, origin: staff_web, path: "/lab/ingest-exceptions/{exception_id}", owner: C5, permission: lab.result.read }
  # --- CR-C7-014 (08 A16.2)
  - { id: staff.lab.ingest_exceptions, origin: staff_web, path: /lab/ingest-exceptions, owner: C5, permission: lab.result.read }
  # --- CR-C6-011
  - { id: staff.reporting.worklist, origin: staff_web, path: /reporting, owner: C6, permission: reporting.report.read }
  - { id: staff.reporting.narrative, origin: staff_web, path: "/reporting/narratives/{narrative_id}", owner: C6, permission: reporting.narrative.write }
  - { id: staff.reporting.outsourced, origin: staff_web, path: /reporting/outsourced, owner: C6, permission: reporting.outsourced.attach }
  - { id: staff.reporting.template, origin: staff_web, path: "/reporting/templates/{template_id}", owner: C6, permission: reporting.template.manage }
  - { id: staff.reporting.settings, origin: staff_web, path: /reporting/settings, owner: C6, permission: reporting.settings.manage }
  - { id: staff.reporting.messages, origin: staff_web, path: /reporting/messages, owner: C6, permission: reporting.message_template.manage }
  # --- CR-C7-003
  - { id: staff.instruments.agents, origin: staff_web, path: /instruments/agents, owner: C7, permission: instruments.agent.read }
  - { id: staff.instruments.instruments, origin: staff_web, path: /instruments/instruments, owner: C7, permission: instruments.instrument.read }
  - { id: staff.instruments.instrument, origin: staff_web, path: "/instruments/instruments/{instrument_id}", owner: C7, permission: instruments.instrument.read }
  - { id: staff.instruments.instrument_mappings, origin: staff_web, path: "/instruments/instruments/{instrument_id}/mappings", owner: C7, permission: instruments.instrument.read }
  - { id: staff.instruments.messages, origin: staff_web, path: /instruments/messages, owner: C7, permission: instruments.message.read }
  - { id: staff.instruments.settings, origin: staff_web, path: /instruments/settings, owner: C7, permission: instruments.instrument.read }
  # --- CR-C8-008
  - { id: staff.analytics.reports, origin: staff_web, path: /analytics/reports, permission: analytics.dashboard.read, owner: C8 }
  - { id: staff.analytics.referral_incentive, origin: staff_web, path: /analytics/referral-incentive, permission: analytics.referral_report.read, owner: C8 }
  - { id: staff.analytics.exports, origin: staff_web, path: /analytics/exports, permission: analytics.data.export, owner: C8 }
  - { id: staff.analytics.schedules, origin: staff_web, path: /analytics/schedules, permission: analytics.schedule.manage, owner: C8 }
  - { id: staff.analytics.report_run, origin: staff_web, path: "/analytics/report-runs/{report_run_id}", permission: analytics.dashboard.read, owner: C8 }
  # --- 08 A17 D-46
  - { id: staff.analytics.collections, origin: staff_web, path: /analytics/collections, permission: analytics.collections.read, owner: C8 }
  # --- CR-C10-006
  - { id: staff.micro.worklist, origin: staff_web, path: /micro/worklist, owner: C10, permission: micro.culture.read }
  - { id: staff.micro.instrument_records, origin: staff_web, path: /micro/instrument-records, owner: C10, permission: micro.culture.read }
  - { id: staff.micro.settings, origin: staff_web, path: /micro/settings, owner: C10, permission: micro.config.manage }
  - { id: staff.micro.breakpoint_sets, origin: staff_web, path: /micro/breakpoint-sets, owner: C10, permission: micro.breakpoint.manage }
  - { id: staff.micro.breakpoint_set, origin: staff_web, path: "/micro/breakpoint-sets/{breakpoint_set_id}", owner: C10, permission: micro.breakpoint.manage }
  # --- CR-C11-006
  - { id: staff.anatomic.worklist, origin: staff_web, path: /anatomic, owner: C11, permission: anatomic.case.read }
  - { id: staff.anatomic.labels, origin: staff_web, path: "/anatomic/cases/{case_id}/labels", owner: C11, permission: anatomic.case.work }
  - { id: staff.anatomic.tracking, origin: staff_web, path: /anatomic/tracking, owner: C11, permission: anatomic.case.read }
  - { id: staff.anatomic.batches, origin: staff_web, path: /anatomic/batches, owner: C11, permission: anatomic.case.read }
  - { id: staff.anatomic.batch, origin: staff_web, path: "/anatomic/batches/{batch_id}", owner: C11, permission: anatomic.case.read }
  - { id: staff.anatomic.config, origin: staff_web, path: /anatomic/config, owner: C11, permission: anatomic.config.manage }
  - { id: staff.anatomic.template, origin: staff_web, path: "/anatomic/config/templates/{template_id}", owner: C11, permission: anatomic.config.manage }
  # --- CR-C12-002
  - { id: staff.inventory.home, origin: staff_web, path: /inventory, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.items, origin: staff_web, path: /inventory/items, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.stock, origin: staff_web, path: /inventory/stock, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.purchase_orders, origin: staff_web, path: /inventory/purchase-orders, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.purchase_order, origin: staff_web, path: "/inventory/purchase-orders/{po_id}", owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.receipts, origin: staff_web, path: /inventory/receipts, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.receipt, origin: staff_web, path: "/inventory/receipts/{grn_id}", owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.transfers, origin: staff_web, path: /inventory/transfers, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.transfer, origin: staff_web, path: "/inventory/transfers/{transfer_id}", owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.counts, origin: staff_web, path: /inventory/counts, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.count, origin: staff_web, path: "/inventory/counts/{count_id}", owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.bench, origin: staff_web, path: /inventory/bench, owner: C12, permission: inventory.bench.record }
  - { id: staff.inventory.rules, origin: staff_web, path: /inventory/rules, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.unresolved, origin: staff_web, path: /inventory/unresolved, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.alerts, origin: staff_web, path: /inventory/alerts, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.reports, origin: staff_web, path: /inventory/reports, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.suppliers, origin: staff_web, path: /inventory/suppliers, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.stores, origin: staff_web, path: /inventory/stores, owner: C12, permission: inventory.item.read }
  - { id: staff.inventory.settings, origin: staff_web, path: /inventory/settings, owner: C12, permission: inventory.master.manage }
  # --- CR-C13-008
  - { id: staff.partners.list, origin: staff_web, path: /partners, owner: C13, permission: partners.partner.read }
  - { id: staff.partners.partner, origin: staff_web, path: "/partners/{partner_id}", owner: C13, permission: partners.partner.read }
  - { id: staff.partners.inbox, origin: staff_web, path: /partners/manifests, owner: C13, permission: partners.manifest.receive }
  - { id: staff.partners.manifest, origin: staff_web, path: "/partners/manifests/{manifest_id}", owner: C13, permission: partners.manifest.receive }
  - { id: staff.partners.pickups, origin: staff_web, path: /partners/pickups, owner: C13, permission: partners.pickup.manage }
  - { id: staff.partners.referrers, origin: staff_web, path: /partners/referrers, owner: C13, permission: partners.referrer.map }
  - { id: staff.partners.settings, origin: staff_web, path: /partners/settings, owner: C13, permission: partners.partner.manage }
  # --- CR-C15-007
  - { id: staff.payments.review, origin: staff_web, path: /payments/review, owner: C15, permission: payments.reconciliation.read }
  - { id: staff.payments.intent, origin: staff_web, path: "/payments/intents/{intent_id}", owner: C15, permission: payments.reconciliation.read }
  - { id: staff.payments.refunds, origin: staff_web, path: /payments/refunds, owner: C15, permission: payments.reconciliation.read }
  - { id: staff.payments.reconciliation, origin: staff_web, path: /payments/reconciliation, owner: C15, permission: payments.reconciliation.read }
  - { id: staff.payments.static_qr, origin: staff_web, path: /payments/static-qr, owner: C15, permission: payments.reconciliation.read }
  - { id: staff.payments.settings, origin: staff_web, path: /payments/settings, owner: C15, permission: payments.merchant_config.read }
  # --- CR-C16-011
  - { id: staff.engagement.bookings, origin: staff_web, path: /engagement/bookings, owner: C16, permission: engagement.booking.read }
  - { id: staff.engagement.slots, origin: staff_web, path: /engagement/slots, owner: C16, permission: engagement.slot.manage }
  - { id: staff.engagement.bookable, origin: staff_web, path: /engagement/bookable-items, owner: C16, permission: engagement.bookable_item.manage }
  - { id: staff.engagement.queue, origin: staff_web, path: /engagement/queue, owner: C16, permission: engagement.queue.operate }
  - { id: staff.engagement.queue_setup, origin: staff_web, path: /engagement/queue/setup, owner: C16, permission: engagement.queue.manage }
  - { id: staff.engagement.app_access, origin: staff_web, path: "/engagement/app-access/{patient_id}", owner: C16, permission: engagement.link.read }
  - { id: staff.engagement.reminders, origin: staff_web, path: /engagement/reminders, owner: C16, permission: engagement.reminder.read }
  - { id: staff.engagement.memberships, origin: staff_web, path: /engagement/memberships, owner: C16, permission: engagement.membership.read }
  - { id: staff.engagement.enquiries, origin: staff_web, path: /engagement/enquiries, owner: C16, permission: engagement.enquiry.read }
  - { id: staff.engagement.settings, origin: staff_web, path: /engagement/settings, owner: C16, permission: engagement.settings.manage }
  - { id: staff.engagement.queue_display, origin: staff_web, path: /queue-display, owner: C16, auth: display_token, nav: false }
  - { id: patient_app.payment_done, origin: patient_app, path: "/payments/{payment_request_id}/done", owner: C16, auth: patient, fallback: portal.app_fallback }
  # --- CR-C17-009
  - { id: staff.homecollection.dispatch, origin: staff_web, path: /homecollection/dispatch, owner: C17, permission: homecollection.visit.read }
  - { id: staff.homecollection.handovers, origin: staff_web, path: /homecollection/handovers, owner: C17, permission: homecollection.handover.receive }
  - { id: staff.homecollection.devices, origin: staff_web, path: /homecollection/devices, owner: C17, permission: homecollection.device.manage }
  - { id: staff.homecollection.settings, origin: staff_web, path: /homecollection/settings, owner: C17, permission: homecollection.settings.manage }
  - { id: staff.catalog.imports, origin: staff_web, path: /catalog/imports, owner: C3, permission: catalog.test.read }
  - { id: staff.catalog.import, origin: staff_web, path: "/catalog/imports/{import_id}", owner: C3, permission: catalog.test.read }
```

API operations recorded in the final sweep (2026-11-06). They are HTTP operations, not app routes, so they have no entry above; C0-0C transcribes them into `contracts/openapi/<domain>.yaml` from the owner TRD:
- reporting (C6 02-TRD §6.6) P7 `getPortalDues` — GET `/v1/reporting/portal/dues` (security `portalSession`, stage `session` with link purpose `dues` or `report`; tier `general`) (08 A21.1).
- payments (C15 02-TRD §5): P7b `recheckPaymentRefund` — POST `/v1/payments/refunds/{refund_id}/recheck` (`payments.intent.resolve`); P11b `failManualPaymentRefund` — POST `/v1/payments/refunds/{refund_id}/fail` (`payments.refund.approve`; `reason_code` `x-coded-set: payments.refund_fail_reasons`); P24b `listPaymentCancelReasons` — GET `/v1/payments/cancel-reasons` (`payments.intent.create`; set `cancel_reasons` only — 08 A19 P-43). Coded set `payments.refund_fail_reasons` (C15) is also readable through P24 `listPaymentCodes`.

Cross-app link rules: a module builds links only through `@lims/shared-ts/routes` (`buildRoute('staff.lab.specimen', { specimen_id })`), generated from this file. Push notifications and messages use only routes whose params carry no PHI (REQ-SEC-106). Whether app links are served from the portal origin depends on C16/C17 app-store setup (domain association files on the portal) — [CONV], confirm in C16 TRD.

---

## 8. Global error-code registry (`contracts/errors.yaml`)

Format per entry: `code`, `http`, `title` (stable, no PHI), `owner`, `meaning`. `type` in problem+json = `urn:lims:error:<code>` (02-CV §4.6). Codes are never reused for a different meaning; retired codes stay listed with `retired: true`.

```yaml
# contracts/errors.yaml (C0) — version 1
- { code: common.validation_failed,        http: 400, owner: C0, title: "Request validation failed", meaning: "Body/params/query violate the spec; details in errors[]" }
- { code: common.field_required,           http: 400, owner: C0, title: "Field required", meaning: "Sub-code used inside errors[] only" }
- { code: common.field_invalid,            http: 400, owner: C0, title: "Field invalid", meaning: "Sub-code used inside errors[] only" }
- { code: common.unknown_field,            http: 400, owner: C0, title: "Unknown field", meaning: "Sub-code: field not declared in the spec (REQ-SEC-080)" }
- { code: common.invalid_cursor,           http: 400, owner: C0, title: "Invalid cursor", meaning: "Malformed or foreign pagination cursor" }
- { code: common.id_mismatch,              http: 400, owner: C0, title: "Identifier mismatch", meaning: "Id in body differs from id in path (REQ-SEC-044)" }
- { code: common.idempotency_key_required, http: 400, owner: C0, title: "Idempotency-Key required", meaning: "Operation marked x-idempotency: required" }
- { code: common.idempotency_key_reused,   http: 422, owner: C0, title: "Idempotency-Key reused", meaning: "Same key sent with a different request body" }
- { code: common.idempotency_in_progress,  http: 409, owner: C0, title: "Request in progress", meaning: "First request with this key still running; retry" }
- { code: common.not_found,                http: 404, owner: C0, title: "Not found", meaning: "Missing or not visible to this tenant/centre/actor (indistinguishable)" }
- { code: common.method_not_allowed,       http: 405, owner: C0, title: "Method not allowed", meaning: "" }
- { code: common.version_conflict,         http: 409, owner: C0, title: "Version conflict", meaning: "If-Match does not equal current version" }
- { code: common.precondition_required,    http: 428, owner: C0, title: "If-Match required", meaning: "Update/action requires If-Match" }
- { code: common.immutable_record,         http: 409, owner: C0, title: "Record is immutable", meaning: "Attempt to change a frozen column (02-CV §5.7)" }
- { code: common.payload_too_large,        http: 413, owner: C0, title: "Payload too large", meaning: "Body or upload above limit (uploads 15 MB)" }
- { code: common.unsupported_media_type,   http: 415, owner: C0, title: "Unsupported media type", meaning: "Content-Type/magic bytes not allowed (REQ-SEC-083)" }
- { code: common.upload_quarantined,       http: 422, owner: C0, title: "Upload rejected", meaning: "Malware scan hit or sanitisation failure (REQ-SEC-084)" }
- { code: common.date_out_of_range,        http: 422, owner: C0, title: "Date out of supported range", meaning: "B.S. conversion outside 1975–2099 B.S. (04 D13)" }
- { code: common.feature_disabled,         http: 403, owner: C0, title: "Feature disabled", meaning: "Tenant feature flag off" }
- { code: common.rate_limited,             http: 429, owner: C0, title: "Too many requests", meaning: "Rate-limit tier exceeded (04 §4); Retry-After set" }
- { code: common.internal,                 http: 500, owner: C0, title: "Internal error", meaning: "Unexpected failure; see request_id" }
- { code: common.dependency_unavailable,   http: 503, owner: C0, title: "Dependency unavailable", meaning: "Internal dependency (DB, storage, renderer) unavailable" }
- { code: common.service_unavailable,      http: 503, owner: C0, title: "Service unavailable", meaning: "Maintenance or overload" }
# auth (C0 core verifies tokens; C2 owns identity flows)
- { code: auth.unauthenticated,            http: 401, owner: C0, title: "Authentication required", meaning: "No/invalid credentials" }
- { code: auth.token_invalid,              http: 401, owner: C0, title: "Invalid token", meaning: "Signature/alg/aud/iss check failed (04 A7)" }
- { code: auth.token_expired,              http: 401, owner: C0, title: "Token expired", meaning: "exp passed; no grace (04 A7)" }
- { code: auth.session_expired,            http: 401, owner: C2, title: "Session expired", meaning: "BFF idle/absolute timeout (04 A8)" }
- { code: auth.forbidden,                  http: 403, owner: C2, title: "Forbidden", meaning: "Permission or centre scope missing" }
- { code: auth.mfa_required,               http: 403, owner: C2, title: "MFA required", meaning: "Privileged permission needs aal2 (04 A4)" }
- { code: auth.account_locked,             http: 403, owner: C2, title: "Account locked", meaning: "User locked by admin or lockout policy" }
- { code: auth.login_failed,               http: 401, owner: C2, title: "Login failed", meaning: "Generic; no account-existence oracle" }
- { code: auth.step_up_required,           http: 401, owner: C2, title: "Additional verification required", meaning: "≥5 failures → backoff + step-up (04 §4)" }
- { code: auth.password_policy_violation,  http: 422, owner: C2, title: "Password does not meet policy", meaning: "<12 chars etc. (04 A3)" }
- { code: auth.password_breached,          http: 422, owner: C2, title: "Password found in breach list", meaning: "Local breached-password list (04 A3)" }
- { code: auth.reset_token_invalid,        http: 400, owner: C2, title: "Reset link invalid", meaning: "Unknown/used/expired; identical response (04 A12)" }
- { code: auth.invite_invalid,             http: 400, owner: C2, title: "Invitation invalid", meaning: "Expired or used invite (REQ-SEC-076)" }
- { code: auth.mfa_invalid,                http: 401, owner: C2, title: "Invalid MFA code", meaning: "" }
- { code: auth.otp_invalid,                http: 401, owner: C6, title: "Invalid or expired code", meaning: "Wrong/expired OTP (04 A9)" }
- { code: auth.otp_attempts_exhausted,     http: 401, owner: C6, title: "Code no longer valid", meaning: "5 attempts used; OTP invalidated (04 A9)" }
- { code: auth.device_token_invalid,       http: 401, owner: C7, title: "Device not authorised", meaning: "Unknown/revoked device token (04 A13)" }
- { code: auth.csrf_failed,                http: 403, owner: C0, title: "Request origin rejected", meaning: "Origin/Sec-Fetch-Site check failed (REQ-SEC-091)" }
# identity / admin (C2)
- { code: identity.user_exists,            http: 409, owner: C2, title: "User already exists", meaning: "" }
- { code: identity.membership_inactive,    http: 403, owner: C2, title: "Membership inactive", meaning: "" }
- { code: identity.role_unknown,           http: 422, owner: C2, title: "Unknown role", meaning: "" }
- { code: identity.last_admin_protected,   http: 409, owner: C2, title: "Cannot remove last tenant admin", meaning: "" }
- { code: identity.mfa_enrolment_required, http: 403, owner: C2, title: "MFA enrolment required", meaning: "Privileged role before first PHI access (REQ-SEC-076)" }
- { code: identity.tenant_suspended,       http: 403, owner: C2, title: "Tenant suspended", meaning: "" }
- { code: identity.centre_inactive,        http: 409, owner: C2, title: "Centre inactive", meaning: "" }
- { code: identity.setting_out_of_range,   http: 422, owner: C2, title: "Setting out of allowed range", meaning: "e.g. idle 15–30 min (04 A8), link TTL 30–90 d (04 A10)" }
- { code: identity.support_session_required, http: 403, owner: C2, title: "Support session required", meaning: "Platform staff acting in a tenant (REQ-SEC-063)" }
# added by 08 §4.2
- { code: identity.code_duplicate, http: 409, owner: C2, title: "Code already used", meaning: "Tenant/branch/centre/role code not unique in scope" }   # CR-C2-007
- { code: identity.self_action_forbidden, http: 409, owner: C2, title: "Not allowed on your own account", meaning: "Lock/deactivate/revoke-current/MFA-reset of self" }   # CR-C2-007
- { code: identity.tenant_not_ready, http: 409, owner: C2, title: "Tenant not ready", meaning: "Activation needs an accepted admin, a branch and a centre" }   # CR-C2-007
- { code: identity.annex_invalid_transition, http: 409, owner: C2, title: "IRD annex status change not allowed", meaning: "03-APP-FLOW §2.5" }   # CR-C2-007
- { code: identity.export_too_large, http: 422, owner: C2, title: "Export range too large", meaning: "Range > 31 days or > 500,000 rows" }   # CR-C2-007
- { code: identity.platform_ip_denied, http: 403, owner: C2, title: "Access not allowed from this network", meaning: "Platform staff IP allowlist (REQ-SEC-063)" }   # CR-C2-007
# catalog (C3)
- { code: catalog.test_inactive,           http: 409, owner: C3, title: "Test inactive", meaning: "" }
- { code: catalog.panel_cycle,             http: 422, owner: C3, title: "Panel contains itself", meaning: "" }
- { code: catalog.no_price,                http: 422, owner: C3, title: "No price configured", meaning: "No applicable price list entry" }
- { code: catalog.no_reference_range,      http: 422, owner: C3, title: "No reference range", meaning: "No range for analyte/sex/age" }
- { code: catalog.formula_invalid,         http: 422, owner: C3, title: "Formula invalid", meaning: "" }
- { code: catalog.code_duplicate,          http: 409, owner: C3, title: "Code already used", meaning: "" }
- { code: catalog.import_invalid,          http: 422, owner: C3, title: "Import file invalid", meaning: "Excel price-list import errors (00 E4); details in errors[]", retired: true }   # C3 never returns it (C3 hand-off, 2026-11-06)
- { code: catalog.instrument_code_unmapped,http: 422, owner: C3, title: "Instrument code not mapped", meaning: "" }
- { code: catalog.version_in_use,          http: 409, owner: C3, title: "Version in use", meaning: "Referenced by results; create a new version instead" }
# added by 08 §4.2
- { code: catalog.tax_config_missing, http: 422, owner: C3, title: "Tax configuration missing", meaning: "No tenant-default tax rule (04 L15/L25, B7)" }   # CR-C3-003
- { code: catalog.import_not_committable, http: 409, owner: C3, title: "Import cannot be committed", meaning: "Not in validated state, expired, or already committed" }   # CR-C3-003
- { code: catalog.import_stale_base, http: 409, owner: C3, title: "Price list changed since export", meaning: "Base version superseded; resend with accept_stale_base" }   # CR-C3-003
# frontdesk (C4)
- { code: frontdesk.patient_duplicate_suspected, http: 409, owner: C4, title: "Possible duplicate patient", meaning: "Dedupe match; confirm or merge (01 §1.1)" }
- { code: frontdesk.consent_required,      http: 422, owner: C4, title: "Consent required", meaning: "REQ-SEC-005" }
- { code: frontdesk.order_not_editable,    http: 409, owner: C4, title: "Order can no longer be edited", meaning: "Items in processing" }
- { code: frontdesk.order_cancel_not_allowed, http: 409, owner: C4, title: "Order cannot be cancelled", meaning: "Results already approved" }
- { code: frontdesk.order_already_cancelled,  http: 409, owner: C4, title: "Order already cancelled", meaning: "" }
- { code: frontdesk.discount_approval_required, http: 403, owner: C4, title: "Discount needs approval", meaning: "Reason + approver required (00 A8)" }
- { code: frontdesk.discount_exceeds_limit, http: 422, owner: C4, title: "Discount exceeds limit", meaning: "" }
- { code: frontdesk.booking_already_converted, http: 409, owner: C4, title: "Booking already converted", meaning: "" }
- { code: frontdesk.referrer_required,     http: 422, owner: C4, title: "Referrer required", meaning: "Tenant rule" }
# added by 08 §4.2
- { code: frontdesk.discount_self_approval_forbidden, http: 403, owner: C4, title: "Requester cannot approve own discount", meaning: "Segregation of duties (00 A8)" }   # CR-C4-007
- { code: frontdesk.retention_not_elapsed, http: 409, owner: C4, title: "Retention period not elapsed", meaning: "Anonymisation before tenant retentionYears (B15)" }   # CR-C4-007
# billing (C4)
- { code: billing.invoice_immutable,       http: 409, owner: C4, title: "Invoice cannot be changed", meaning: "No edit/delete (04 L5, L26)" }
- { code: billing.invoice_already_cancelled, http: 409, owner: C4, title: "Invoice already cancelled", meaning: "" }
- { code: billing.cancel_reason_required,  http: 422, owner: C4, title: "Cancellation reason required", meaning: "04 L26 ज" }
- { code: billing.fiscal_year_closed,      http: 409, owner: C4, title: "Fiscal year closed", meaning: "" }
- { code: billing.counter_busy,            http: 503, owner: C4, title: "Invoice numbering busy", meaning: "Counter row lock timeout or FY rollover during allocation; retry (REQ-ARCH-032; FY rollover carries detail \"fiscal_year_rollover\" — 08 A13 D-25)" }
- { code: billing.payment_exceeds_due,     http: 422, owner: C4, title: "Payment exceeds amount due", meaning: "" }
- { code: billing.ledger_reversal_invalid, http: 409, owner: C4, title: "Reversal not allowed", meaning: "Already reversed / wrong amount" }
- { code: billing.credit_limit_exceeded,   http: 409, owner: C4, title: "Credit limit exceeded", meaning: "" }
- { code: billing.credit_party_locked,     http: 409, owner: C4, title: "Credit party locked", meaning: "Credit days exceeded (01 §1.5)" }
- { code: billing.amount_mismatch,         http: 409, owner: C4, title: "Amount mismatch", meaning: "Gateway amount ≠ expected (REQ-SEC-048)" }
- { code: billing.order_not_invoiced,      http: 409, owner: C4, title: "Order not invoiced", meaning: "" }
- { code: billing.export_too_large,        http: 422, owner: C4, title: "Export range too large", meaning: "Narrow the date range" }
# added by 08 §4.2
- { code: billing.credit_period_already_billed, http: 409, owner: C4, title: "Credit period already billed", meaning: "No uninvoiced charges for the credit party and month" }   # CR-C4-007
- { code: billing.numbering_pattern_invalid, http: 409, owner: C4, title: "Invoice pattern lacks {branch} for branch series", meaning: "invoice_series_scope = branch but invoiceNoPattern has no {branch} at allocation; no invoice issued; alert" }   # 08 A13 D-23
- { code: billing.refund_self_approval_forbidden, http: 403, owner: C4, title: "Refund approver must differ from requester", meaning: "Approver of a refund request is its requester (08 R15)" }   # 08 A13 D-24; title [CONV]
# lab (C5)
- { code: lab.specimen_not_found,          http: 404, owner: C5, title: "Specimen not found", meaning: "Barcode unknown in tenant (host query)" }
- { code: lab.specimen_invalid_transition, http: 409, owner: C5, title: "Specimen cannot move to the requested state", meaning: "§10.1" }
- { code: lab.specimen_not_receivable,     http: 409, owner: C5, title: "Specimen not receivable", meaning: "Rejected/discarded/wrong state" }
- { code: lab.rejection_reason_required,   http: 422, owner: C5, title: "Rejection reason required", meaning: "Coded reason mandatory (01 §2.1)" }
- { code: lab.barcode_duplicate,           http: 409, owner: C5, title: "Barcode already used", meaning: "Barcodes never reused (01 §2.1)" }
- { code: lab.result_invalid_transition,   http: 409, owner: C5, title: "Result cannot move to the requested state", meaning: "§10.2" }
- { code: lab.result_locked,               http: 409, owner: C5, title: "Result is approved and locked", meaning: "Amend instead (04 R1)" }
- { code: lab.result_value_invalid,        http: 422, owner: C5, title: "Result value invalid", meaning: "Type/range/decimals" }
- { code: lab.result_on_hold,              http: 409, owner: C5, title: "Result on QC hold", meaning: "01 §2.5" }
- { code: lab.formula_inputs_missing,      http: 422, owner: C5, title: "Formula inputs missing", meaning: "" }
- { code: lab.self_approval_forbidden,     http: 403, owner: C5, title: "Approver must differ from verifier", meaning: "Two-step approval (00 C5) — rule confirmed in C5 PRD" }
- { code: lab.amend_requires_pathologist,  http: 403, owner: C5, title: "Only a pathologist can amend", meaning: "00 C6" }
- { code: lab.amendment_reason_required,   http: 422, owner: C5, title: "Amendment reason required", meaning: "" }
- { code: lab.module_result_invalid,       http: 422, owner: C5, title: "Module result not accepted", meaning: "submitModuleResult on a test whose workflow is not micro/anatomic/molecular, or malformed payloadRef (A1)" }
- { code: lab.module_result_stale,         http: 409, owner: C5, title: "Older module result version", meaning: "payloadRef.versionNo lower than last applied (A1)" }
- { code: lab.critical_ack_required,       http: 409, owner: C5, title: "Critical notification not recorded", meaning: "C5 PRD decides if approval is blocked" }
# added by 08 §4.2
- { code: lab.barcode_pattern_invalid, http: 500, owner: C5, title: "Barcode numbering configuration invalid", meaning: "Rendered barcode violates [A-Z0-9]{1,20} or counter overflow" }   # CR-C5-005
- { code: lab.specimen_inactive, http: 409, owner: C5, title: "Specimen inactive", meaning: "Order cancelled or test removed; specimen not usable" }   # CR-C5-005
- { code: lab.flag_ack_required, http: 409, owner: C5, title: "Flag acknowledgement required", meaning: "Delta/critical/unit/instrument flag must be acknowledged before verification" }   # CR-C5-005
# reporting + notifications + portal (C6)
- { code: reporting.release_blocked_due,   http: 409, owner: C6, title: "Report held until payment", meaning: "Hold-till-paid (00 D1)" }
- { code: reporting.release_not_ready,     http: 409, owner: C6, title: "Report not ready", meaning: "Approved set incomplete" }
- { code: reporting.override_reason_required, http: 422, owner: C6, title: "Override reason required", meaning: "" }
- { code: reporting.report_not_released,   http: 409, owner: C6, title: "Report not released", meaning: "" }
- { code: reporting.report_superseded,     http: 409, owner: C6, title: "Report version superseded", meaning: "" }
- { code: reporting.render_unavailable,    http: 503, owner: C6, title: "Rendering unavailable", meaning: "Renderer pool busy/failed; async retry" }
- { code: reporting.outsourced_pdf_rejected, http: 422, owner: C6, title: "Outsourced PDF rejected", meaning: "Scan/sanitise failure (04 R7)" }
- { code: reporting.bulk_release_too_large, http: 422, owner: C6, title: "Too many reports in one bulk release", meaning: "" }
- { code: reporting.link_invalid,          http: 404, owner: C6, title: "Link not valid", meaning: "Unknown/expired/revoked — identical response (REQ-SEC-094)" }
- { code: reporting.verify_not_found,      http: 404, owner: C6, title: "Report could not be verified", meaning: "Unknown or revoked QR token — identical response (04 R3)" }
- { code: reporting.otp_required,          http: 401, owner: C6, title: "Verification code required", meaning: "" }
- { code: reporting.notification_template_unknown, http: 422, owner: C6, title: "Unknown message template", meaning: "" }
- { code: reporting.notification_params_invalid,   http: 422, owner: C6, title: "Message parameters not allowed", meaning: "Undeclared/PHI-like params (04 R4/R6)" }
- { code: reporting.template_invalid,      http: 422, owner: C6, title: "Report template invalid", meaning: "" }
# added by 08 §4.2
- { code: reporting.version_not_latest, http: 409, owner: C6, title: "A newer report version exists", meaning: "Only the latest non-discarded version can be released/printed as current" }   # CR-C6-004
- { code: reporting.report_cancelled, http: 409, owner: C6, title: "Report cancelled", meaning: "Order cancelled; no new versions or releases" }   # CR-C6-004
- { code: reporting.narrative_locked, http: 409, owner: C6, title: "Narrative report is signed", meaning: "Start an amendment instead" }   # CR-C6-004
- { code: reporting.narrative_incomplete, http: 422, owner: C6, title: "Required sections are empty", meaning: "Fill required sections before signing" }   # CR-C6-004
- { code: reporting.input_file_not_ready, http: 409, owner: C6, title: "File not ready", meaning: "Scan/sanitise still running or file rejected" }   # CR-C6-004
- { code: reporting.print_not_ready, http: 409, owner: C6, title: "Print file not ready", meaning: "Plain/bulk print still rendering" }   # CR-C6-004
- { code: reporting.channel_not_configured, http: 422, owner: C6, title: "Channel not configured", meaning: "No active channel account for this channel" }   # CR-C6-004
- { code: reporting.callback_rejected, http: 400, owner: C6, title: "Callback rejected", meaning: "Unknown callback token or bad signature; identical response" }   # CR-C6-004
# instruments (C7)
- { code: instruments.batch_too_large,     http: 413, owner: C7, title: "Batch too large", meaning: ">100 messages/request (04 §4)" }
- { code: instruments.message_malformed,   http: 422, owner: C7, title: "Message malformed", meaning: "Quarantined, not dropped (REQ-SEC-121)" }
- { code: instruments.device_mismatch,     http: 403, owner: C7, title: "Device not bound to instrument", meaning: "REQ-SEC-121" }
- { code: instruments.instrument_unknown,  http: 404, owner: C7, title: "Instrument unknown", meaning: "" }
- { code: instruments.driver_not_available,http: 422, owner: C7, title: "No driver for instrument model", meaning: "Manual pending (B2)" }
- { code: instruments.config_signature_invalid, http: 422, owner: C7, title: "Configuration signature invalid", meaning: "04 N11" }
# added by 08 §4.2
- { code: instruments.agent_not_active, http: 409, owner: C7, title: "Agent not active", meaning: "Agent retired (or revoked where the action needs an active agent)" }   # CR-C7-002
- { code: instruments.agent_has_active_instruments, http: 409, owner: C7, title: "Agent still has instruments", meaning: "Retire or move instruments first" }   # CR-C7-002
- { code: instruments.invalid_transition, http: 409, owner: C7, title: "State change not allowed", meaning: "Agent/instrument/command state machine (03-APP-FLOW §2)" }   # CR-C7-002
- { code: instruments.go_live_checklist_incomplete, http: 422, owner: C7, title: "Go-live checklist incomplete", meaning: "All checklist items and an evidence note are required" }   # CR-C7-002
- { code: instruments.capability_not_supported, http: 422, owner: C7, title: "Capability not supported", meaning: "Driver/instrument does not support host query, worklist or file drop" }   # CR-C7-002
- { code: instruments.message_too_large, http: 413, owner: C7, title: "Message too large", meaning: "Single message above the per-message limit" }   # CR-C7-002
- { code: instruments.reprocess_not_allowed, http: 409, owner: C7, title: "Message cannot be reprocessed", meaning: "Host query, retired instrument, or record not eligible" }   # CR-C7-002
- { code: instruments.code_duplicate, http: 409, owner: C7, title: "Code already used", meaning: "agent_code or instrument_code exists in the tenant" }   # CR-C7-002
# analytics (C8)
- { code: analytics.range_too_large,       http: 422, owner: C8, title: "Date range too large", meaning: "" }
- { code: analytics.report_unknown,        http: 404, owner: C8, title: "Report unknown", meaning: "" }
# added by 08 §4.2
- { code: analytics.export_not_ready, http: 409, owner: C8, title: "Export not ready", meaning: "Queued or building" }   # CR-C8-002
- { code: analytics.export_unavailable, http: 410, owner: C8, title: "Export no longer available", meaning: "Expired, failed or download limit reached" }   # CR-C8-002
- { code: analytics.export_too_large, http: 422, owner: C8, title: "Export too large", meaning: "Row or size cap exceeded; narrow the period" }   # CR-C8-002
- { code: analytics.recipient_ineligible, http: 422, owner: C8, title: "Recipient not eligible", meaning: "Membership inactive or lacks the report permission" }   # CR-C8-002
# quality (C9)
- { code: quality.qc_target_missing,       http: 422, owner: C9, title: "QC target not set", meaning: "Mean/SD missing for material/lot/analyte" }
- { code: quality.qc_run_already_evaluated, http: 409, owner: C9, title: "QC run already evaluated", meaning: "" }
- { code: quality.corrective_action_required, http: 409, owner: C9, title: "Corrective action required", meaning: "01 §2.5" }
- { code: quality.lot_expired,             http: 422, owner: C9, title: "Control lot expired", meaning: "" }
# added by 08 §4.2
- { code: quality.code_duplicate, http: 409, owner: C9, title: "Already exists", meaning: "Material/level/lot code, control-ID map or QC plan for the pair already exists" }   # CR-C9-002
- { code: quality.rerun_required, http: 409, owner: C9, title: "Accepted QC rerun required", meaning: "Rejected run can be closed only after a later accepted run (01 §2.5)" }   # CR-C9-002
- { code: quality.rule_set_invalid, http: 422, owner: C9, title: "Auto-verification rules invalid", meaning: "DSL validation errors in errors[]" }   # CR-C9-002
- { code: quality.rule_set_invalid_transition, http: 409, owner: C9, title: "Rule set version cannot change state", meaning: "03-APP-FLOW §2.3" }   # CR-C9-002
- { code: quality.simulation_incomplete, http: 409, owner: C9, title: "Simulation not long enough", meaning: "sim_min_days / sim_min_decisions not met" }   # CR-C9-002
- { code: quality.self_activation_forbidden, http: 403, owner: C9, title: "Another person must activate", meaning: "Four-eyes activation of auto-verification rules" }   # CR-C9-002
- { code: quality.insufficient_qc_data, http: 422, owner: C9, title: "Not enough QC data", meaning: "Fewer observations than target_min_points" }   # CR-C9-002
# micro (C10)
- { code: micro.organism_code_unknown,     http: 422, owner: C10, title: "Organism code unknown", meaning: "" }
- { code: micro.ast_standard_required,     http: 422, owner: C10, title: "Breakpoint standard required", meaning: "Category + standard + version (04 D14)" }
- { code: micro.antibiotic_not_in_panel,   http: 422, owner: C10, title: "Antibiotic not in panel", meaning: "" }
- { code: micro.report_final_locked,       http: 409, owner: C10, title: "Final micro report locked", meaning: "Amend instead" }
# added by 08 §4.2
- { code: micro.culture_invalid_transition, http: 409, owner: C10, title: "Culture cannot move to the requested state", meaning: "03-APP-FLOW §2.1" }   # CR-C10-005
- { code: micro.isolate_invalid_transition, http: 409, owner: C10, title: "Isolate cannot move to the requested state", meaning: "03-APP-FLOW §2.2" }   # CR-C10-005
- { code: micro.ast_value_invalid, http: 422, owner: C10, title: "AST value invalid", meaning: "MIC/zone syntax or range" }   # CR-C10-005
- { code: micro.ast_category_not_allowed, http: 422, owner: C10, title: "Interpretive category not allowed", meaning: "Not a code of the standard, or restricted for this antibiotic (04 D14)" }   # CR-C10-005
- { code: micro.report_incomplete, http: 422, owner: C10, title: "Report is incomplete", meaning: "Preliminary/final completeness guards" }   # CR-C10-005
- { code: micro.amendment_reason_required, http: 422, owner: C10, title: "Amendment reason required", meaning: "Reopen/amend needs a coded reason" }   # CR-C10-005
- { code: micro.instrument_record_conflict, http: 409, owner: C10, title: "Instrument record conflicts with existing data", meaning: "Choose use_instrument or keep_existing" }   # CR-C10-005
- { code: micro.breakpoint_import_invalid, http: 422, owner: C10, title: "Breakpoint file rejected", meaning: "Not UTF-8 text, NUL bytes, or duplicate file" }   # CR-C10-005
- { code: micro.breakpoint_set_invalid_transition, http: 409, owner: C10, title: "Breakpoint set cannot change state", meaning: "03-APP-FLOW §2.5" }   # CR-C10-005
- { code: micro.breakpoint_four_eyes_required, http: 403, owner: C10, title: "Another user must activate this set", meaning: "Importer cannot activate own import" }   # CR-C10-005
- { code: micro.code_duplicate, http: 409, owner: C10, title: "Code already used", meaning: "Protocol/panel code or active vocabulary map key exists" }   # CR-C10-005
# anatomic (C11)
- { code: anatomic.accession_duplicate,    http: 409, owner: C11, title: "Accession number already used", meaning: "" }
- { code: anatomic.signout_locked,         http: 409, owner: C11, title: "Case signed out", meaning: "Addendum/amend instead" }
- { code: anatomic.ihc_requires_block,     http: 422, owner: C11, title: "IHC must be ordered on a block", meaning: "01 research §2.4" }
# added by 08 §4.2
- { code: anatomic.case_invalid_transition, http: 409, owner: C11, title: "Case cannot move to the requested state", meaning: "C11 TRD §7" }   # CR-C11-003
- { code: anatomic.accession_pattern_invalid, http: 500, owner: C11, title: "Accession numbering configuration invalid", meaning: "Pattern tokens/charset invalid or counter overflow" }   # CR-C11-003
- { code: anatomic.report_incomplete, http: 422, owner: C11, title: "Report incomplete", meaning: "Required report content missing at sign-out; details in errors[]" }   # CR-C11-003
- { code: anatomic.template_invalid, http: 422, owner: C11, title: "Template definition invalid", meaning: "Synoptic definition violates schema; details in errors[]" }   # CR-C11-003
- { code: anatomic.template_not_published, http: 409, owner: C11, title: "Template not published", meaning: "Draft or retired template used/retired" }   # CR-C11-003
- { code: anatomic.block_not_available, http: 409, owner: C11, title: "Block not available", meaning: "Block sent out or discarded" }   # CR-C11-003
- { code: anatomic.image_limit_reached, http: 422, owner: C11, title: "Image limit reached", meaning: "Per-case or per-report image limit" }   # CR-C11-003
- { code: anatomic.image_not_ready, http: 409, owner: C11, title: "Image not ready", meaning: "Still processing or quarantined", retired: true }   # CR-C11-003
- { code: anatomic.order_item_inactive, http: 409, owner: C11, title: "Order item no longer active", meaning: "Item removed/cancelled at front desk" }   # CR-C11-003
- { code: anatomic.batch_closed, http: 409, owner: C11, title: "Batch closed", meaning: "" }   # CR-C11-003
- { code: anatomic.batch_position_taken, http: 409, owner: C11, title: "Batch position already used", meaning: "" }   # CR-C11-003
# inventory (C12)
- { code: inventory.insufficient_stock,    http: 409, owner: C12, title: "Insufficient stock", meaning: "" }
- { code: inventory.lot_expired,           http: 409, owner: C12, title: "Lot expired", meaning: "FEFO issue rule" }
- { code: inventory.po_invalid_transition, http: 409, owner: C12, title: "Purchase order state change not allowed", meaning: "" }
- { code: inventory.uom_mismatch,          http: 422, owner: C12, title: "Unit of measure mismatch", meaning: "" }
# added by 08 §4.2
- { code: inventory.code_duplicate, http: 409, owner: C12, title: "Code already used", meaning: "item/pack/store/supplier/barcode code exists in the tenant" }   # CR-C12-003
- { code: inventory.item_inactive, http: 409, owner: C12, title: "Item inactive", meaning: "" }   # CR-C12-003
- { code: inventory.item_in_use, http: 409, owner: C12, title: "Item in use", meaning: "Deactivation blocked: stock or open PO lines" }   # CR-C12-003
- { code: inventory.store_not_empty, http: 409, owner: C12, title: "Store not empty", meaning: "Deactivation blocked: non-zero balance" }   # CR-C12-003
- { code: inventory.po_self_approval_forbidden,http: 403, owner: C12, title: "Approver must differ from creator", meaning: "Tenant setting" }   # CR-C12-003
- { code: inventory.over_receipt, http: 422, owner: C12, title: "Received quantity exceeds order", meaning: "Beyond tolerance" }   # CR-C12-003
- { code: inventory.document_invalid_transition,http: 409, owner: C12, title: "Document state change not allowed", meaning: "GRN/transfer/count/container/fact/alert" }   # CR-C12-003
- { code: inventory.lot_unavailable, http: 409, owner: C12, title: "Lot not available", meaning: "Quarantined or blocked" }   # CR-C12-003
- { code: inventory.reason_required, http: 422, owner: C12, title: "Reason required", meaning: "" }   # CR-C12-003
- { code: inventory.fact_not_reversible, http: 409, owner: C12, title: "Consumption cannot be reversed", meaning: "Only manual facts are reversible" }   # CR-C12-003
- { code: inventory.store_locked_for_count, http: 409, owner: C12, title: "Store is being counted", meaning: "Tenant setting count_locks_store" }   # CR-C12-003
- { code: inventory.count_already_open, http: 409, owner: C12, title: "A count is already open for this store", meaning: "" }   # CR-C12-003
- { code: inventory.rule_conflict, http: 409, owner: C12, title: "A current rule exists", meaning: "Supersede the existing rule instead" }   # CR-C12-003
- { code: inventory.export_too_large, http: 422, owner: C12, title: "Export too large", meaning: "Row cap exceeded; narrow the range" }   # CR-C12-003
- { code: inventory.range_too_large, http: 422, owner: C12, title: "Date range too large", meaning: "" }   # CR-C12-003
# partners (C13)
- { code: partners.manifest_invalid,       http: 422, owner: C13, title: "Manifest invalid", meaning: "" }
- { code: partners.partner_inactive,       http: 403, owner: C13, title: "Partner account inactive", meaning: "" }
# added by 08 §4.2
- { code: partners.manifest_not_editable, http: 409, owner: C13, title: "Manifest can no longer be edited", meaning: "Lines are read-only after submit" }   # CR-C13-009
- { code: partners.manifest_invalid_transition, http: 409, owner: C13, title: "Manifest cannot move to the requested state", meaning: "03-APP-FLOW §2.1" }   # CR-C13-009
- { code: partners.manifest_line_invalid_transition, http: 409, owner: C13, title: "Manifest line cannot move to the requested state", meaning: "03-APP-FLOW §2.2" }   # CR-C13-009
- { code: partners.orderable_not_offered, http: 422, owner: C13, title: "Test not offered to this partner", meaning: "Not in the partner price-list projection" }   # CR-C13-009
- { code: partners.pickup_invalid, http: 422, owner: C13, title: "Pickup request invalid", meaning: "Window or manifest rules" }   # CR-C13-009
- { code: partners.pickup_invalid_transition, http: 409, owner: C13, title: "Pickup cannot move to the requested state", meaning: "03-APP-FLOW §2.3" }   # CR-C13-009
- { code: partners.partner_invalid_transition, http: 409, owner: C13, title: "Partner cannot move to the requested state", meaning: "" }   # CR-C13-009
- { code: partners.partner_user_invalid_transition, http: 409, owner: C13, title: "Partner user cannot move to the requested state", meaning: "" }   # CR-C13-009
- { code: partners.last_partner_admin, http: 409, owner: C13, title: "Cannot remove the last partner admin", meaning: "" }   # CR-C13-009
- { code: partners.self_action_forbidden, http: 409, owner: C13, title: "You cannot change your own access", meaning: "" }   # CR-C13-009
- { code: partners.code_duplicate, http: 409, owner: C13, title: "Partner code already used", meaning: "" }   # CR-C13-009
- { code: partners.credit_party_in_use, http: 409, owner: C13, title: "Credit party already linked to a partner", meaning: "" }   # CR-C13-009
- { code: partners.credit_party_inactive, http: 422, owner: C13, title: "Credit party inactive", meaning: "" }   # CR-C13-009
- { code: partners.referrer_duplicate, http: 409, owner: C13, title: "Referrer already exists", meaning: "" }   # CR-C13-009
- { code: partners.referrer_not_mapped, http: 422, owner: C13, title: "Referrer not yet linked by the lab", meaning: "require_mapped_referrer" }   # CR-C13-009
- { code: partners.referrer_doctor_inactive, http: 422, owner: C13, title: "Doctor record inactive", meaning: "" }   # CR-C13-009
- { code: partners.referrer_invalid_transition, http: 409, owner: C13, title: "Referrer mapping cannot change", meaning: "" }   # CR-C13-009
- { code: partners.setting_out_of_range, http: 422, owner: C13, title: "Setting out of allowed range", meaning: "02-TRD §10.2" }   # CR-C13-009
# smartreport (C14)
- { code: smartreport.no_eligible_results, http: 422, owner: C14, title: "No approved results for summary", meaning: "" }
- { code: smartreport.template_not_approved, http: 409, owner: C14, title: "Template library not approved", meaning: "Pathologist approval pending (B14)" }
- { code: smartreport.validator_failed,    http: 422, owner: C14, title: "Generated text failed validation", meaning: "Optional LLM layer (01 §5.3)" }
- { code: smartreport.feature_disabled,    http: 403, owner: C14, title: "Smart report disabled", meaning: "" }
# added by 08 §4.2
- { code: smartreport.library_invalid, http: 422, owner: C14, title: "Template library invalid", meaning: "Validation rules V1–V14 failed; details in errors[]" }   # CR-C14-004
- { code: smartreport.library_invalid_transition, http: 409, owner: C14, title: "Template library cannot change state", meaning: "Edit outside draft, second open draft, or illegal transition" }   # CR-C14-004
- { code: smartreport.summary_invalid_transition, http: 409, owner: C14, title: "Summary cannot change state", meaning: "Approve/reject outside draft" }   # CR-C14-004
- { code: smartreport.summary_superseded, http: 409, owner: C14, title: "Summary built on superseded results", meaning: "Approved results changed after the summary was built" }   # CR-C14-004
- { code: smartreport.summary_not_ready, http: 409, owner: C14, title: "Smart summary not available yet", meaning: "Staff callers: summary requested before it is approved" }   # CR-C14-004; meaning narrowed by 08 A4.6
# payments (C15)
- { code: payments.gateway_not_available,  http: 503, owner: C15, title: "Payment method unavailable", meaning: "Gateway down or not configured (Fonepay BLOCKED B8)" }
- { code: payments.intent_open_exists,     http: 409, owner: C15, title: "Payment already in progress", meaning: "One open intent per order (04 P6)" }
- { code: payments.nothing_due,            http: 409, owner: C15, title: "Nothing to pay", meaning: "" }
- { code: payments.signature_invalid,      http: 400, owner: C15, title: "Callback signature invalid", meaning: "REQ-SEC-049/052" }
- { code: payments.callback_stale,         http: 400, owner: C15, title: "Callback too old", meaning: "REQ-SEC-052" }
- { code: payments.refund_exceeds_captured,http: 422, owner: C15, title: "Refund exceeds captured amount", meaning: "REQ-SEC-055" }
- { code: payments.refund_requires_approval, http: 403, owner: C15, title: "Refund requires approval", meaning: "REQ-SEC-055" }
# added by 08 §4.2
- { code: payments.amount_not_supported, http: 422, owner: C15, title: "Amount not supported by this payment method", meaning: "Khalti < 1000 paisa (04 P4); eSewa fractional rupees while unverified" }   # CR-C15-006
- { code: payments.return_url_not_allowed, http: 422, owner: C15, title: "Return address not allowed", meaning: "returnUrl/cancelUrl outside the allowlist" }   # CR-C15-006
- { code: payments.intent_invalid_transition, http: 409, owner: C15, title: "Payment cannot move to the requested state", meaning: "02-TRD §4.1" }   # CR-C15-006
- { code: payments.intent_not_verifiable, http: 409, owner: C15, title: "Payment not confirmed by the provider", meaning: "Resolve requires gateway success + exact amount" }   # CR-C15-006
- { code: payments.refund_not_allowed, http: 409, owner: C15, title: "Refund not allowed", meaning: "Intent not settled, refund in progress, or wrong refund state" }   # CR-C15-006
- { code: payments.refund_self_approval_forbidden, http: 403, owner: C15, title: "Refund needs a second approver", meaning: "REQ-SEC-055 two-person rule" }   # CR-C15-006
- { code: payments.credential_invalid, http: 422, owner: C15, title: "Merchant credentials rejected", meaning: "Gateway rejected the key during test" }   # CR-C15-006
- { code: payments.reconciliation_in_progress, http: 409, owner: C15, title: "Reconciliation already running", meaning: "" }   # CR-C15-006
- { code: payments.callback_mismatch, http: 400, owner: C15, title: "Callback does not match payment", meaning: "Recorded outcome only; callbacks never change state" }   # CR-C15-006
- { code: payments.static_qr_already_reconciled, http: 409, owner: C15, title: "Already reconciled", meaning: "One worksheet per date and centre" }   # CR-C15-006
# engagement (C16)
- { code: engagement.slot_unavailable,     http: 409, owner: C16, title: "Slot unavailable", meaning: "" }
- { code: engagement.booking_limit_reached,http: 429, owner: C16, title: "Booking limit reached", meaning: "Per-patient daily cap (REQ-SEC-100)" }
- { code: engagement.booking_not_cancellable, http: 409, owner: C16, title: "Booking cannot be cancelled", meaning: "" }
- { code: engagement.app_version_unsupported, http: 426, owner: C16, title: "App update required", meaning: "Minimum supported version (REQ-SEC-113)" }
# added by 08 §4.2
- { code: engagement.link_code_invalid, http: 422, owner: C16, title: "Code not valid", meaning: "Unknown, expired, used, wrong phone, or report link not valid — identical response" }   # CR-C16-003
- { code: engagement.link_limit_reached, http: 409, owner: C16, title: "Profile limit reached", meaning: "Per-account or per-patient link limit; self profile exists; address limit" }   # CR-C16-003
- { code: engagement.booking_invalid_transition, http: 409, owner: C16, title: "Booking cannot move to the requested state", meaning: "03-APP-FLOW §4.1" }   # CR-C16-003
- { code: engagement.slot_outside_window, http: 422, owner: C16, title: "Slot not bookable", meaning: "Past, inside lead time, beyond horizon, or not a generated slot" }   # CR-C16-003
- { code: engagement.orderable_not_bookable, http: 422, owner: C16, title: "Test not available for booking", meaning: "Not in the bookable catalogue for this kind, or sex restriction" }   # CR-C16-003
- { code: engagement.address_required, http: 422, owner: C16, title: "Address required", meaning: "Home collection needs an address" }   # CR-C16-003
- { code: engagement.queue_closed, http: 409, owner: C16, title: "Queue not open", meaning: "Queue inactive or queue feature off" }   # CR-C16-003
- { code: engagement.queue_token_invalid_transition, http: 409, owner: C16, title: "Token cannot move to the requested state", meaning: "03-APP-FLOW §4.3" }   # CR-C16-003
- { code: engagement.membership_overlap, http: 409, owner: C16, title: "Membership already active", meaning: "One active membership per patient" }   # CR-C16-003
- { code: engagement.plan_inactive, http: 409, owner: C16, title: "Membership plan inactive", meaning: "" }   # CR-C16-003
- { code: engagement.reminder_invalid_transition, http: 409, owner: C16, title: "Reminder cannot change", meaning: "Already sent/cancelled" }   # CR-C16-003
- { code: engagement.enquiry_invalid_transition, http: 409, owner: C16, title: "Enquiry cannot change", meaning: "Closed, or open-enquiry limit" }   # CR-C16-003
- { code: engagement.setting_out_of_range, http: 422, owner: C16, title: "Setting out of allowed range", meaning: "05-SCHEMA §2.1" }   # CR-C16-003
# homecollection (C17)
- { code: homecollection.visit_not_assigned, http: 403, owner: C17, title: "Visit not assigned to you", meaning: "" }
- { code: homecollection.barcode_mismatch, http: 422, owner: C17, title: "Scanned barcode does not match", meaning: "Patient/specimen ID check" }
- { code: homecollection.visit_closed,     http: 409, owner: C17, title: "Visit already closed", meaning: "" }
- { code: homecollection.mutation_superseded, http: 409, owner: C17, title: "Change superseded by server", meaning: "Server-wins conflict, per-mutation outcome (04 S17)" }
- { code: homecollection.unsynced_changes, http: 409, owner: C17, title: "Unsynced changes pending", meaning: "Logout blocked while unsynced (04 A15)" }
# added by 08 §4.2
- { code: homecollection.app_version_unsupported, http: 426, owner: C17, title: "App update required", meaning: "Below tenant min_app_version (REQ-SEC-113)" }   # CR-C17-007
- { code: homecollection.device_not_registered, http: 409, owner: C17, title: "Device not registered", meaning: "Unknown device id or bound to another user" }   # CR-C17-007
- { code: homecollection.visit_incomplete, http: 422, owner: C17, title: "Visit is not ready to assign", meaning: "Address and time window required" }   # CR-C17-007
- { code: homecollection.phlebotomist_not_eligible, http: 422, owner: C17, title: "Phlebotomist cannot take this visit", meaning: "Inactive, other centre, or no phlebotomist role" }   # CR-C17-007
- { code: homecollection.collection_not_held, http: 409, owner: C17, title: "Collection is not awaiting review", meaning: "" }   # CR-C17-007
```

Codes are emitted only by their owner module (CI greps `LimsError('<code>'` against `owner`), except `common.*`/`auth.*` emitted by the C0 core and IdentityPort. Emission exceptions (08 §4.2): `auth.session_expired` may also be emitted by `apps/web/src/core/session/policy.ts` (CR-C0-005); module `engagement` may emit `auth.otp_invalid` and `auth.otp_attempts_exhausted` with the C6 meaning (CR-C16-003); A code thrown by a port propagates unchanged through the calling module (R18): the handler rethrows the original `LimsError` and never constructs it, and the caller may list the code in its `x-error-codes`. Current users: C4 and C12 (`catalog.*`), C10 and C11 (`lab.*`) (08 A17 P-23). `billing.tax_config_missing` is not registered (R18). Reserved (DEFER, B4): `frontdesk.legacy_batch_conflict`, `frontdesk.legacy_void_window_closed`, `lab.legacy_batch_conflict`, `lab.legacy_void_window_closed`, `reporting.legacy_batch_conflict`, `reporting.legacy_void_window_closed`.

---

## 9. Domain vocabulary and identifiers

### 9.1 Core entities (names are fixed for every interface)

| Entity | Owner (schema.table) | Internal id | Human-readable id | Meaning |
|---|---|---|---|---|
| Tenant | core.tenants (C0/C2) | UUIDv7 | `tenant_code` (slug) | One customer lab company (a taxpayer for IRD — 04 L3/L4) |
| Branch | core.branches | UUIDv7 | `branch_code` | Physical lab/processing site of a tenant |
| CollectionCentre | core.collection_centres | UUIDv7 | `centre_code` (example shape from 00 §4: `C000000002`) | Where samples are collected; includes the tenant's home-collection pseudo-centre (00 §4 "C000000002-HOME COLLECTION") |
| User | auth.users (GoTrue credentials) + core.users (profile) | GoTrue `sub` (UUID, any version) | — | A human login |
| Membership | core.memberships (+ core.membership_centres) | UUIDv7 | — | User ↔ tenant link with roles, `all_centres` flag, centre list, signatory profile |
| Role | core.roles | UUIDv7 | `role_code` | Named permission bundle per tenant (defaults from permissions.yaml) |
| Patient | frontdesk.patients | UUIDv7 | `patient_code` (searchable "lab code", 00 A2) | Person tested |
| Referrer (Doctor) | catalog.doctors | UUIDv7 | `doctor_code` | Referring doctor ("Referred By", 00 §4; `SELF` = no referrer) |
| CreditParty | catalog.credit_parties | UUIDv7 | `party_code` | Hospital/company billed on credit (00 E2/E6) |
| Department | catalog.departments | UUIDv7 | `code` | Hematology, Biochemistry, … (00 §4, F2) |
| Orderable | catalog (Test ∪ Panel) | UUIDv7 | `code` | Anything a front desk can order |
| Test | catalog.tests | UUIDv7 | `code` (short name e.g. `CBC`) | Orderable unit with ≥1 analyte |
| Analyte | catalog.analytes | UUIDv7 | `code` | One measured/reported parameter (e.g. haemoglobin) |
| Panel | catalog.panels | UUIDv7 | `code` | Clinical panel or commercial package |
| ReferenceRange / CriticalLimit | catalog.reference_ranges / catalog.critical_limits | UUIDv7 + `version` | — | Versioned; results snapshot the version used (04 D14) |
| PriceList | catalog.price_lists | UUIDv7 + `version` | `code` | Per doctor/hospital/centre/default (00 E3) |
| Order | frontdesk.orders | UUIDv7 | `registration_no` (example shape 00 §4: `0001EE000996`) | One visit/registration |
| OrderItem | frontdesk.order_items | UUIDv7 | — | One orderable on an order |
| Specimen | lab.specimens | UUIDv7 | `barcode` (example shape 00 §4: `E1100001677`) | Physical container; aliquot = specimen with `parent_specimen_id` |
| Result | lab.results | UUIDv7 | — | One analyte value for one order item (current state pointer) |
| ResultVersion | lab.result_versions | UUIDv7 + `version_no` | — | Immutable value snapshot; v1 original, v≥2 amendments |
| Verification | lab.verifications | UUIDv7 | — | Technologist first-level verification record |
| Approval | lab.approvals | UUIDv7 | — | Pathologist approval record (locks) |
| CriticalValueEvent | lab.critical_value_log | UUIDv7 | — | Detection + notification log (who/when/read-back — 01 §2.2) |
| QcResult | lab.qc_results | UUIDv7 | — | Captured QC observation (Phase 1) |
| QcRun | quality.qc_runs | UUIDv7 | — | Evaluated QC run (Phase 2) |
| Report | reporting.reports | UUIDv7 | — | Report for an order (one per order × kind) |
| ReportVersion | reporting.report_versions | UUIDv7 + `version_no` | — | Rendered immutable PDF (`{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf`, sha256 — 04 D15) |
| Delivery | reporting.deliveries | UUIDv7 | — | One outbound message attempt chain |
| PortalLink / QrToken | reporting.portal_links / reporting.qr_tokens | UUIDv7 | token (≥128-bit random, stored as lookup — 04 A10/A11) | Patient link; report authenticity QR |
| Invoice | billing.invoices | UUIDv7 | `invoice_no` | Fiscal document; immutable |
| InvoiceLine | billing.invoice_lines | UUIDv7 | — | Snapshot of orderable, department, price, discount, tax |
| CreditNote | billing.credit_notes | UUIDv7 | `credit_note_no` | Cancellation/credit document |
| LedgerEntry | billing.ledger_entries | UUIDv7 | `receipt_no` [CONV, optional] | Append-only payment-method entry (04 P1) |
| FiscalCounter | billing.fiscal_counters | (tenant_id, series, fiscal_year_bs) | — | Gapless counter row (04 L7) |
| PaymentIntent | payments.intents | UUIDv7 | — | Gateway checkout (04 P6) |
| Agent | instruments.agents | UUIDv7 | `agent_code` | Bridge agent install = the "device" holding a device token (04 A13) |
| Instrument | instruments.instruments | UUIDv7 | `instrument_code` | One analyser connection |
| InstrumentMessage | instruments.messages | UUIDv7 | — | Raw archived message (≥1 y — 04 I8) |
| InstrumentCodeMap | catalog.instrument_code_maps | UUIDv7 | — | Instrument code ↔ analyte; owned by C3, edited from C7's UI via C3 HTTP (X4) |
| Booking | engagement.bookings | UUIDv7 | `booking_no` [CONV] | Patient appointment / home-collection request |
| HomeVisit | homecollection.visits | UUIDv7 | — | Assigned phlebotomy visit |
| Partner / PartnerUser / Manifest | partners.* | UUIDv7 | `partner_code`, `manifest_no` | B2B partner entities |

### 9.2 Identifier formats

| Identifier | Format | Generator | Uniqueness |
|---|---|---|---|
| Internal id | UUIDv7, RFC 9562, lowercase canonical text | app code: `@lims/shared-ts/uuidv7`, `lims_shared` Dart (04 D9) | global |
| GoTrue user id | UUID (version per GoTrue) | GoTrue | global |
| Tokens | ≥128-bit (link, QR, reset) / ≥256-bit (device) CSPRNG, base64url | `@lims/shared-ts/crypto` | global; stored as lookup (QR, link) or SHA-256 hash (device) — 04 A10–A13 |
| Human numbers | per-tenant patterns (§9.3) | per-tenant counter rows (never Postgres sequences shared across tenants — 04 D16) | per tenant (+ series/FY for fiscal numbers) |

### 9.3 Human-readable numbering (configurable per tenant; examples are synthetic)

Pattern tokens [CONV]: `{prefix}` literal per tenant/branch, `{branch}` branch code, `{centre}` centre code, `{yy}` A.D. 2-digit year, `{fy}` B.S. fiscal year short form `082/83`, `{fyl}` long `2082/83`, `{seq:N}` zero-padded counter of width N. Patterns of fiscal numbers and of numbers used across modules live in `TenantSettings.numbering` (set by C2, validated with the owning module's grammar). Module-internal, non-fiscal document numbers may live in the owning module's settings table. Every number is unique-indexed with `tenant_id` leading, never a foreign key, never in a URL, never logged except `invoice_no`/`credit_note_no` (08 §4.5).

| Number | Owner | Default pattern [CONV] | Example (synthetic) | Counter scope | Rules |
|---|---|---|---|---|---|
| `patient_code` | C4 | `{prefix}{seq:8}` | `MP00004211` | tenant | never reused; merges keep the survivor's code |
| `registration_no` | C4 | `{branch}{prefix}{seq:6}` (shape of 00 §4 `0001EE000996`) | `0001SY000001` | tenant + branch | gaps allowed (not fiscal); never reused; C4 grammar (applied by C2): `registrationNoPattern` must contain `{branch}` (08 A13 D-23) |
| `barcode` | C5 | `{prefix}{yy}{seq:8}` (00 §4 `E1100001677` = prefix + yy + 8 digits; client format wins — 08 A13 D-8) | `E2600000042` | tenant | never reused; recollection = new barcode (01 §2.1); characters `[A-Z0-9]`, ≤20; label symbology chosen in C5 TRD (not fixed here); pattern key `numbering.barcodePattern` + `numbering.barcodePrefix` (`[A-Z0-9]{0,4}`, CR-C5-009) |
| `invoice_no` | C4 | `{fy}-{seq:6}` (convention example `081/82-000123` — 01 research §4.8) | `082/83-000123` | **tenant + B.S. fiscal year** (series granularity BLOCKED B6/L8 — default per (tenant, FY)) | **gapless** counter row `UPDATE … RETURNING`, allocated last in the invoice transaction (04 L7; REQ-ARCH-032); resets Shrawan 1 (04 L16); printed once, reprints marked "Copy of Original"/"प्रतिलिपि" + print count (04 L26 च); `invoice_series_scope = branch` is rejected by C4 (B32) unless `invoiceNoPattern` contains `{branch}` (`400 common.validation_failed`, path `/invoice_series_scope`); a pattern that loses `{branch}` while scope = branch → `409 billing.numbering_pattern_invalid` at allocation, no invoice issued, alert (08 A13 D-23; B6 stays BLOCKED, default tenant scope unchanged) |
| `credit_note_no` | C4 | `CN-{fy}-{seq:6}` | `CN-082/83-000007` | tenant + FY | gapless, same mechanism |
| `receipt_no` | C4 | `RC-{fy}-{seq:6}` | `RC-082/83-000310` | tenant + FY | optional receipt reference for ledger entries; pattern key `numbering.receiptNoPattern` (CR-C2-008) |
| `accession_no` (histo) | C11 | `{prefix}{yy}-{seq:4}` (01 research §2.4 example `S26-1234`) | `S26-0042` | tenant + year + case kind | separate from lab number series (01 research §2.4); blocks `S26-0042-A1`; pattern keys `numbering.accessionNoPattern` + `numbering.accessionPrefixes{histology,cytology,ihc,molecular}` (`[A-Z0-9]{0,4}`; defaults S/C/I/M); C2 validates with C11's grammar (CR-C11-005) |
| `booking_no` | C16 | `BK{yy}{seq:6}` | `BK26000015` | tenant | — |
| `manifest_no` | C13 | `MF{yy}{seq:6}` | `MF26000003` | tenant + partner | — (partners settings) |
| `po_no`, `grn_no`, `transfer_no`, `count_no`, `doc_no` | C12 | `PO{yy}{seq:6}`, `GR{yy}{seq:6}`, `TR{yy}{seq:6}`, `SC{yy}{seq:5}`, `SD{yy}{seq:6}` | `PO26000012` | tenant + period | gaps allowed; patterns in `inventory.settings` (CR-C12-007) |

Numbers are display/lookup attributes: they are unique-indexed with `tenant_id` leading, never used as foreign keys, never placed in URLs (02-CV §4.1) and never logged (02-CV §9.2) except `invoice_no`/`credit_note_no`.

---

## 10. State machines (interface level)

C5/C4/C6 internal designs MUST realise exactly these states and emit exactly these events; guards beyond those shown are internal and documented in the owner's `03-APP-FLOW.md`.

### 10.1 Specimen (`lab.specimens.status`) — owner C5

Physical states follow 01 research §2.1; `resulted → verified → approved → reported` are **roll-up** states (all non-cancelled results on the specimen have reached at least that state) — see §5.2 X8.

| # | From | To | Trigger / guard | Actor | Events |
|---|---|---|---|---|---|
| S1 | (none) | `ordered` | specimen requirement created from `frontdesk.order.created.v1` / `items_changed.v1`; barcode assigned | system | status_changed (from absent) |
| S2 | `ordered` | `collected` | collection recorded (front desk, centre, or `homecollection.collection.synced.v1`) | user/system | status_changed |
| S3 | `collected` | `in_transit` | scan-out at centre for transfer to processing branch (01 research §2.1) | user | status_changed |
| S4 | `collected` or `in_transit` | `received` | accession scan at processing lab | user | status_changed |
| S5 | `received` | `aliquoted` | ≥1 aliquot specimen created (each aliquot starts at `received` with `parent_specimen_id`) | user | status_changed (parent) + status_changed for each aliquot (absent → received) |
| S6 | `received` / `aliquoted` | `in_process` | first result value saved or worklist/host query pick-up | user/system | status_changed |
| S7 | `in_process` | `resulted` | roll-up: all results ≥ `resulted` | system | status_changed |
| S8 | `resulted` | `verified` | roll-up: all results ≥ `verified` | system | status_changed |
| S9 | `verified` | `approved` | roll-up: all results `approved` | system | status_changed |
| S10 | `approved` | `reported` | C5's consumer of `reporting.report.released.v1` (A8) sees a released version whose order items cover all this specimen's results | system | status_changed |
| S11 | any of `ordered…verified` (any pre-`approved`) | `rejected` | coded reason (01 §2.1) + optional free text | user | status_changed **+** specimen.rejected |
| S12 | `rejected` | `recollection_ordered` | recollection requested; **new** specimen row (new barcode) created with `replaces_specimen_id`, tests re-pointed | user/system | status_changed (old) + status_changed (new: absent → ordered) |
| S13 | `received`…`reported` | `stored` | retention location recorded | user | status_changed |
| S14 | `stored` / `reported` / `rejected` / `recollection_ordered` | `discarded` | disposal with retention-policy date | user | status_changed |
| S15 | (rollback) `resulted`/`verified` roll-ups | lower roll-up | a result returns to an earlier state (§10.2 R5) | system | status_changed |

Forbidden examples (must return `lab.specimen_invalid_transition`): `received → collected`, `approved → rejected`, any transition out of `discarded`, `rejected → received`.

### 10.2 Result (`lab.results.status`, versions in `lab.result_versions`) — owner C5

| # | From | To | Trigger / guard | Actor / permission | Events |
|---|---|---|---|---|---|
| R1 | (none) | `pending` | created with order item (one per reportable analyte) | system | — |
| R2 | `pending` | `resulted` | value saved: instrument ingest, manual entry, formula, or module submission (`LabPort.submitModuleResult`, A1). Range flag + delta check + critical check run here | system / `lab.result.enter` | `lab.critical_value.detected.v1` if critical |
| R3 | `resulted` | `resulted` | re-entry/rerun before verification (value replaced; audit trigger keeps old/new — 04 D11) | `lab.result.enter` | critical event again only if newly critical |
| R4 | `resulted` | `verified` | first-level verification; not `on_hold`; Phase 2 auto path when `QualityPort.canAutoVerify` = allow and tenant enabled (04 R2) | `lab.result.verify` / system | `lab.result.verified.v1` |
| R5 | `verified` | `resulted` | returned for correction by verifier or pathologist (reason required); or A1 resubmission on a `verified` result (`reason_code = module_resubmitted`, followed by R3 in the same transaction — 08 A13 D-7) | `lab.result.verify` or `lab.result.approve`; system (A1 resubmission) | — |
| R6 | `verified` | `approved` | pathologist approval; approver ≠ verifier (`lab.self_approval_forbidden`, rule confirmed in C5 PRD); not `on_hold` | `lab.result.approve` (privileged) | `lab.result.approved.v1`; then readiness evaluation → maybe `lab.order.ready_for_report.v1` |
| R7 | `approved` | `approved` (version_no + 1) | amendment by pathologist only (00 C6) with reason; new immutable `result_versions` row; previous version kept and marked superseded (04 R1) | `lab.result.amend` (privileged) | `lab.result.amended.v1`; readiness re-evaluated → `lab.order.ready_for_report.v1` (contains_amendment = true) |
| R8 | `pending`/`resulted`/`verified` | `cancelled` | order item removed/order cancelled (`items_changed`/`cancelled` events) | system | — |

Flags (not states): `on_hold` (set by `LabPort.holdResultsSince` / `quality.qc_run.rejected.v1`; blocks R4/R6 with `lab.result_on_hold`); `qc_review_required` (approved results inside a QC-failure window; review only, never auto-changed). Forbidden: any change of value on `approved` except R7 (`lab.result_locked`); `pending → verified`; `cancelled → *`.

### 10.3 Report version (`reporting.report_versions.status`) — owner C6

| From | To | Trigger | Events |
|---|---|---|---|
| (none) | `rendering` | `lab.order.ready_for_report.v1` consumed (or manual re-render); PDF render enqueued (async — REQ-ARCH-050) | — |
| `rendering` | `rendered` | renderer stored PDF + sha256 (04 D15) | — |
| `rendering` | `render_failed` | render error after retries | — |
| `render_failed` | `rendering` | retry | — |
| `rendered` | `released` | release rules pass (BillingPort eligibility or override; partial/bulk rules) | `reporting.report.released.v1` |
| `released` | `superseded` | a newer version of the same report is released | `reporting.report.released.v1` (for the new version, `supersedes_version_no` set) |
| `rendering` | `discarded` | newer version assembled or order cancelled (CR-C6-005) | — |
| `rendered` | `discarded` | newer version assembled or order cancelled (CR-C6-005) | — |
| `render_failed` | `discarded` | newer version assembled or order cancelled (CR-C6-005) | — |

QR verify shows `valid` for `released`, `superseded` for `superseded` (04 R3); unreleased versions are not verifiable. QR of a discarded version → `reporting.verify_not_found`; release of a discarded version → `reporting.release_not_ready` (CR-C6-005).

### 10.4 Order (`frontdesk.orders.status`) — owner C4

| From | To | Trigger | Events |
|---|---|---|---|
| (none) | `pre_registered` | `createOrderFromBooking` with `confirmImmediately = false` | — |
| (none) / `pre_registered` | `registered` | front-desk registration or confirmation | `frontdesk.order.created.v1` |
| `registered` | `in_progress` | derived on read from `LabPort.getOrderItemProcessingState`: `in_progress` iff any active item is `in_progress`/`reported` (08 A13 D-5) | — |
| `registered`/`in_progress` | `completed` | derived on read from `LabPort.getOrderItemProcessingState`: `completed` iff every active item is `reported` or `cancelled` and ≥ 1 is `reported` (08 A13 D-5) | — |
| `pre_registered`/`registered`/`in_progress` | `cancelled` | cancel with reason; no approved results | `frontdesk.order.cancelled.v1` |

Item changes in `registered`/`in_progress` → `frontdesk.order.items_changed.v1`.

### 10.5 Invoice (`billing.invoices.status`) — owner C4

| From | To | Trigger | Events |
|---|---|---|---|
| (none) | `issued` | invoice transaction allocates gapless number (04 L7) | `billing.invoice.issued.v1`, `billing.balance.changed.v1` |
| `issued` | `cancelled` | cancel with reason + credit note in same transaction (04 L26 ज) | `billing.invoice.cancelled.v1`, `billing.balance.changed.v1` |

No other transitions; no draft state in `billing` (drafts live in the registration screen state); no delete (04 L5). Print count and CBMS sync state are lifecycle columns, not states (02-CV §5.7). CBMS API spec UNVERIFIED (04 L13, BLOCKED B6).

### 10.6 Payment intent (`payments.intents.status`) — owner C15

Transition table (normative = C15 02-TRD §4.1, CR-C15-003):

| # | From | To | Trigger / guard | Side effects |
|---|---|---|---|---|
| I1 | (none) | `created` | `createIntent` passes all guards (§6.1) | insert intent + transition row |
| I2 | `created` | `initiated` | eSewa form signed (same transaction) / Khalti initiate returned `pidx` + `payment_url` | store refs, `expires_at`; enqueue first poll |
| I3 | `initiated` | `pending` | callback received, or gateway reports in-progress (eSewa `PENDING`) | transition row |
| I4 | `initiated`/`pending` | `settled` | gateway success (eSewa `COMPLETE` / Khalti `Completed`) **and** verified amount = `amount_paisa` **and** `amount_paisa ≤ balanceDue` | `BillingPort.recordGatewayPayment` + event `payments.intent.settled.v1` in the same transaction; metric |
| I5 | `initiated`/`pending` | `failed` | gateway failure status (eSewa `CANCELED`; Khalti `User canceled`/`Canceled`/`Failed`) or `cancelIntent` (`abandoned`) | transition row; if `abandoned` and Khalti: final check stays scheduled |
| I6 | `initiated`/`pending` | `expired` | after deadline: eSewa `NOT_FOUND`; Khalti `Expired` (any time) | transition row |
| I7 | `initiated`/`pending` | `held_for_review` | hold outcome (§7.2.4, §7.3.4): amount mismatch, ambiguous, Khalti `Pending`, refunded-before-settle, unknown status, not found after retries, exceeds due, non-final after deadline | `hold_reason`; metric + alert (REQ-SEC-048) |
| I8 | `held_for_review` | `settled` | finance re-check/resolve with success + exact amount (and due, or `record_exceeding_due`), or reconciliation | as I4 |
| I9 | `held_for_review` | `failed` | finance resolve `fail` with reason | transition row |
| I10 | `settled` | `partially_refunded` | completed refund < remaining captured | via refund completion |
| I11 | `settled`/`partially_refunded` | `refunded` | completed refunds = captured | via refund completion |
| I12 [CR-C15-003] | `partially_refunded` | `partially_refunded` | another partial refund completed | version + 1 |
| I13 [CR-C15-003] | `failed`/`expired` | `held_for_review` | reconciliation or a final check finds gateway success (`late_payment_found`) | critical alert |
| I14 [CR-C15-003] | `created` | `failed` | (only reachable inside `createIntent`'s own transaction if initiate fails after insert — the transaction is rolled back, so in practice never persisted; listed for completeness of the guard) | — |

Forbidden (→ `409 payments.intent_invalid_transition` [CR-C15-006] from handlers; trigger guard raises in SQL): any transition out of `refunded`; `settled → failed|expired|held_for_review`; `held_for_review → expired`; any `→ created`; `failed|expired → settled` directly (must pass `held_for_review`).

Only `→ settled` (I4, I8) emits `payments.intent.settled.v1`. One open intent per order = statuses `created`, `initiated`, `pending` (REQ-SEC-053).

---

## 11. Permission registry (`contracts/permissions.yaml`) — accepted addition A6

Rules: every OpenAPI operation's `x-permission`, every `IdentityPort.assertRole` call and every `routes.yaml` `permission` MUST name a code listed here (CI check). `privileged: true` ⇒ membership re-validated against `core.memberships` and session at `aal2` (TOTP) required — 04 A4 (tenant-admin, platform-admin, finance/refund, data-export roles) and REQ-SEC-067. Roles are **defaults** seeded per tenant; tenant admins (C2) may create roles and re-assign non-platform permissions, but cannot grant `platform.*` and cannot remove the last holder of `identity.role.manage` (`identity.last_admin_protected`). Platform permissions are checked only by C2's `PlatformAuthz` in platform context; `IdentityPort.assertRole` refuses every `platform.*` code (08 R23). Chunks add codes by CR to C0 (the owning chunk's TRD lists them first). Role codes and grants are [CONV] defaults; the client's real role model is confirmed in C2's PRD. CI rules (08 §4.1): every code passes `^[a-z_]+\.[a-z_]+\.[a-z_]+$`; a code with `roles: []` is actor-only or system-only and may never be granted to a tenant role; partner-only and patient-only codes may never be granted to tenant roles; staff codes never to partner/patient sets (CR-C13-002, C16-002); the one listed exception is `identity.self.manage` in `fixed_actor_permissions.partner.partner_member` (08 A19 D-101). Reserved (DEFER, B4): `frontdesk.patient.import_legacy`, `lab.legacy_result.import`, `reporting.legacy_document.import`, `reporting.legacy_document.read`.

```yaml
# contracts/permissions.yaml (C0) — version 1
version: 1
roles:   # default tenant roles [CONV]; actor types device/portal/patient/partner/system get fixed permission sets (below)
  - { code: tenant_admin,      mfa_required: true,  description: "Lab owner / IT admin of the tenant" }
  - { code: front_desk,        mfa_required: false, description: "Registration + cashier at a centre/branch" }
  - { code: finance,           mfa_required: true,  description: "Accounts: invoices, cancellations, refunds, credit parties" }
  - { code: lab_technologist,  mfa_required: false, description: "Sample handling, result entry, first verification" }
  - { code: pathologist,       mfa_required: true,  description: "Approval, amendment, critical-value sign-off" }
  - { code: lab_manager,       mfa_required: true,  description: "Catalog, instruments, QC, worklists, MIS" }
  - { code: centre_staff,      mfa_required: false, description: "Collection-centre staff (collect, dispatch, view status)" }
  - { code: phlebotomist,      mfa_required: false, description: "Home-collection app user" }
  - { code: owner_viewer,      mfa_required: true,  description: "Owner dashboard + exports (data export → MFA, 04 A4)" }
  - { code: radiologist,       mfa_required: true,  description: "Writes and signs imaging/endoscopy narrative reports" }   # added by 08 (CR-C6-003)
partner_roles:   # added by 08 (CR-C13-002); partner actors only, never tenant roles
  - { code: partner_member, mfa_required: false }
  - { code: partner_admin,  mfa_required: true }
platform_roles:   # The LIMS provider staff, separate identity (REQ-SEC-063); act in a tenant only via support session
  - { code: platform_superadmin, mfa_required: true }
  - { code: platform_support,    mfa_required: true }
fixed_actor_permissions:        # replaced by 08 §4.1
  device:                       # by claims device_kind; absent = bridge_agent (CR-C16-002)
    bridge_agent:  [instruments.ingest.submit, instruments.ingest.heartbeat, instruments.ingest.host_query,
                    instruments.ingest.config_read, instruments.ingest.enrol]                     # REQ-SEC-072; + CR-C7-001
    queue_display: [engagement.queue.board_read]
  portal:  [reporting.portal.view, reporting.portal.download, reporting.portal.challenge]          # + CR-C6-003
  patient: [engagement.self.read, engagement.booking.create, engagement.booking.cancel, reporting.portal.view,
            reporting.portal.download, engagement.self.manage, engagement.link.redeem, engagement.payment.create,
            engagement.enquiry.create]                                                            # + CR-C16-002
  patient_pre_auth: [engagement.auth.challenge]                                                   # new key
  partner:                      # by partner role (CR-C13-002)
    partner_member: [partners.order.read, partners.manifest.submit, partners.report.read, partners.statement.read,
                     partners.price_list.read, partners.pickup.request, partners.referrer.read,
                     identity.self.manage]   # 08 A19 D-101 (partner self-service; partner_admin inherits)
    partner_admin:  [<partner_member set>, partners.referrer.manage, partners.partner_user.manage]
  system:  declared per worker manifest (02-CV §2.3), subset of tenant permissions, never platform.*
permissions:
  # identity / admin / audit / platform (C2)
  - { code: identity.user.read,          privileged: false, roles: [tenant_admin] }
  - { code: identity.user.manage,        privileged: true,  roles: [tenant_admin] }          # create, lock/unlock (00 E1)
  - { code: identity.role.manage,        privileged: true,  roles: [tenant_admin] }
  - { code: identity.centre.manage,      privileged: true,  roles: [tenant_admin] }          # branches/centres (00 E2)
  - { code: identity.centre.read, privileged: false, roles: [tenant_admin, front_desk, finance, lab_technologist, pathologist, lab_manager, centre_staff, owner_viewer] }   # [CONV] centre directory (P0); C2 listCentres — 08 A13 D-16
  - { code: identity.settings.manage,    privileged: true,  roles: [tenant_admin] }
  - { code: identity.session.revoke,     privileged: true,  roles: [tenant_admin] }          # REQ-SEC-073
  - { code: audit.log.read,              privileged: true,  roles: [tenant_admin] }
  - { code: platform.tenant.read,        privileged: true,  roles: [platform_superadmin, platform_support] }
  - { code: platform.tenant.manage,      privileged: true,  roles: [platform_superadmin] }
  - { code: platform.support_session.open, privileged: true, roles: [platform_superadmin, platform_support] }
  - { code: platform.dead_letter.manage, privileged: true,  roles: [platform_superadmin] }
  # added by 08 §4.1
  - { code: audit.log.export, privileged: true, roles: [tenant_admin] }   # insider-export control (02 failure mode #10)   # CR-C2-006
  - { code: identity.self.manage, privileged: false, roles: [tenant_admin, front_desk, finance, lab_technologist, pathologist, lab_manager, centre_staff, phlebotomist, owner_viewer, radiologist] }   # CR-C2-006
  - { code: platform.staff.manage, privileged: true, roles: [platform_superadmin] }   # CR-C2-006
  - { code: identity.signatory.read, privileged: false, roles: [] }   # system actor of reporting only   # CR-C6-007
  # catalog (C3)
  - { code: catalog.test.read,           privileged: false, roles: [tenant_admin, lab_manager, front_desk, lab_technologist, pathologist, finance] }
  - { code: catalog.test.manage,         privileged: false, roles: [lab_manager] }
  - { code: catalog.price_list.read,     privileged: false, roles: [tenant_admin, lab_manager, finance, front_desk] }
  - { code: catalog.price_list.manage,   privileged: true,  roles: [tenant_admin, finance] }  # incl. Excel import/export (00 E4)
  - { code: catalog.referrer.manage,     privileged: false, roles: [tenant_admin, lab_manager, front_desk] }  # quick-add doctor (00 A5)
  - { code: catalog.instrument_code_map.manage, privileged: true, roles: [lab_manager] }    # used by C7 UI (X4); privileged by 08 A13 D-18 (aal2 on map edits)
  # added by 08 §4.1
  - { code: catalog.referrer.read, privileged: false, roles: [tenant_admin, lab_manager, front_desk, finance, centre_staff] }   # CR-C3-003
  - { code: catalog.reference_range.publish, privileged: true, roles: [pathologist, lab_manager] }   # clinical sign-off: analyte versions, ranges, critical limits (08 A13 D-18)   # CR-C3-003
  - { code: catalog.referrer.export, privileged: true, roles: [tenant_admin, lab_manager] }   # doctors' contacts (04 A4 data export)   # CR-C3-003
  # frontdesk (C4)
  - { code: frontdesk.registration.create, privileged: false, roles: [front_desk, centre_staff] }
  - { code: frontdesk.patient.read,      privileged: false, roles: [front_desk, centre_staff, lab_technologist, pathologist, tenant_admin] }   # tenant_admin: 08 A13 D-28
  - { code: frontdesk.patient.merge,     privileged: true,  roles: [tenant_admin] }
  - { code: frontdesk.order.read,        privileged: false, roles: [front_desk, centre_staff, lab_technologist, pathologist, finance, tenant_admin] }   # tenant_admin: 08 A13 D-28
  - { code: frontdesk.order.edit,        privileged: false, roles: [front_desk] }
  - { code: frontdesk.order.cancel,      privileged: false, roles: [front_desk, tenant_admin] }
  - { code: frontdesk.discount.apply,    privileged: false, roles: [front_desk] }
  - { code: frontdesk.discount.approve,  privileged: true,  roles: [tenant_admin, finance] }  # approver captured (00 A8)
  - { code: frontdesk.trf.upload,        privileged: false, roles: [front_desk, centre_staff] }
  # added by 08 §4.1
  - { code: frontdesk.settings.manage, privileged: true, roles: [tenant_admin] }   # CR-C4-008
  - { code: frontdesk.patient.anonymise, privileged: true, roles: [tenant_admin] }   # 02-CV §5.6, REQ-SEC-139   # CR-C4-008
  # billing (C4)
  - { code: billing.invoice.read,        privileged: false, roles: [front_desk, finance, tenant_admin] }
  - { code: billing.invoice.issue,       privileged: false, roles: [front_desk, finance] }
  - { code: billing.invoice.reprint,     privileged: false, roles: [front_desk, finance] }    # "Copy of Original" (04 L26 च)
  - { code: billing.invoice.cancel,      privileged: true,  roles: [finance] }
  - { code: billing.payment.record,      privileged: false, roles: [front_desk, finance, phlebotomist] }
  - { code: billing.payment.reverse,     privileged: true,  roles: [finance] }
  - { code: billing.refund.approve,      privileged: true,  roles: [finance] }                # REQ-SEC-055
  - { code: billing.refund.request, privileged: true, roles: [finance] }   # two-person refund (08 R15) — 08 A13 D-24; approver ≠ requester → billing.refund_self_approval_forbidden
  - { code: billing.credit_party.read,   privileged: false, roles: [finance, tenant_admin] }
  - { code: billing.credit_party.manage, privileged: true,  roles: [finance] }
  - { code: billing.cash_report.read,    privileged: false, roles: [finance, tenant_admin, owner_viewer] }
  - { code: billing.data.export,         privileged: true,  roles: [finance] }                # Excel/XML/PDF (04 L26 ठ), sales register
  - { code: billing.release.override,   privileged: true,  roles: [finance, tenant_admin] }  # hold-till-paid override (01 §1.4)
  # added by 08 §4.1
  - { code: billing.settings.manage, privileged: true, roles: [tenant_admin, finance] }   # "Billing settings: invoice series scope, CBMS retry, payment methods (tax rules live in C3)" (R18)   # CR-C4-008
  # lab (C5)
  - { code: lab.status_board.read,       privileged: false, roles: [front_desk, centre_staff, lab_technologist, pathologist, lab_manager] }
  - { code: lab.specimen.read,           privileged: false, roles: [centre_staff, lab_technologist, pathologist, lab_manager, front_desk, phlebotomist] }   # front_desk, phlebotomist: 08 A13 D-4 (RLS keeps centre scope)
  - { code: lab.specimen.collect,        privileged: false, roles: [front_desk, centre_staff, phlebotomist, lab_technologist] }
  - { code: lab.specimen.receive,        privileged: false, roles: [lab_technologist] }
  - { code: lab.specimen.reject,         privileged: false, roles: [lab_technologist] }
  - { code: lab.specimen.label_print,    privileged: false, roles: [front_desk, centre_staff, lab_technologist] }
  - { code: lab.worklist.read,           privileged: false, roles: [lab_technologist, pathologist, lab_manager] }
  - { code: lab.result.read,             privileged: false, roles: [lab_technologist, pathologist, lab_manager] }
  - { code: lab.result.enter,            privileged: false, roles: [lab_technologist] }
  - { code: lab.result.verify,           privileged: false, roles: [lab_technologist, pathologist] }
  - { code: lab.result.approve,          privileged: true,  roles: [pathologist] }            # 00 C5
  - { code: lab.result.amend,            privileged: true,  roles: [pathologist] }            # 00 C6
  - { code: lab.critical_value.read,     privileged: false, roles: [lab_technologist, pathologist] }
  - { code: lab.critical_value.log_notification, privileged: false, roles: [lab_technologist, pathologist] }
  - { code: lab.qc.capture,              privileged: false, roles: [lab_technologist] }
  # added by 08 §4.1
  - { code: lab.worksheet.manage, privileged: false, roles: [lab_technologist, lab_manager] }   # CR-C5-004
  - { code: lab.config.manage, privileged: true, roles: [lab_manager, pathologist] }   # CR-C5-004
  - { code: lab.qc_hold.release, privileged: true, roles: [lab_manager, pathologist] }   # CR-C5-004
  # reporting (C6)
  - { code: reporting.report.read,       privileged: false, roles: [front_desk, centre_staff, lab_technologist, pathologist, lab_manager, tenant_admin, radiologist] }   # roles += CR-C6-003; radiologist 08 A21.3
  - { code: reporting.report.release,    privileged: false, roles: [pathologist, front_desk] }
  - { code: reporting.report.bulk_release, privileged: true, roles: [pathologist, lab_manager] }   # REQ-SEC-100
  - { code: reporting.report.print,      privileged: false, roles: [front_desk, centre_staff] }
  - { code: reporting.delivery.read,     privileged: false, roles: [front_desk, tenant_admin] }
  - { code: reporting.delivery.resend,   privileged: false, roles: [front_desk] }
  - { code: reporting.template.manage,   privileged: true,  roles: [tenant_admin, lab_manager] }  # letterhead, signatures (00 D7)
  - { code: reporting.outsourced.attach, privileged: false, roles: [lab_technologist, front_desk] }
  - { code: reporting.portal.view,       privileged: false, roles: [] }                       # portal/patient actors only
  - { code: reporting.portal.download,   privileged: false, roles: [] }
  # added by 08 §4.1
  - { code: reporting.report.render, privileged: false, roles: [pathologist, lab_manager] }   # CR-C6-003
  - { code: reporting.report.regenerate, privileged: true, roles: [pathologist, lab_manager] }   # CR-C6-003
  - { code: reporting.report.bulk_download, privileged: true, roles: [lab_manager, tenant_admin] }   # REQ-SEC-100   # CR-C6-003
  - { code: reporting.token.revoke, privileged: true, roles: [tenant_admin] }   # CR-C6-003
  - { code: reporting.narrative.write, privileged: false, roles: [pathologist, radiologist, lab_technologist] }   # CR-C6-003
  - { code: reporting.narrative.sign, privileged: true, roles: [pathologist, radiologist] }   # CR-C6-003
  - { code: reporting.message_template.manage, privileged: true, roles: [tenant_admin] }   # CR-C6-003
  - { code: reporting.channel.manage, privileged: true, roles: [tenant_admin] }   # CR-C6-003
  - { code: reporting.settings.manage, privileged: true, roles: [tenant_admin, lab_manager] }   # CR-C6-003
  - { code: reporting.portal.challenge, privileged: false, roles: [] }   # added to fixed_actor_permissions.portal   # CR-C6-003
  # instruments (C7)
  - { code: instruments.agent.read,      privileged: false, roles: [lab_manager] }
  - { code: instruments.agent.manage,    privileged: true,  roles: [lab_manager, tenant_admin] }  # device token issue/revoke (04 A13)
  - { code: instruments.message.read,    privileged: false, roles: [lab_manager, lab_technologist] }
  - { code: instruments.message.rematch, privileged: false, roles: [lab_technologist] }       # X2 replay path
  - { code: instruments.ingest.submit,   privileged: false, roles: [] }                       # device actors only
  - { code: instruments.ingest.heartbeat,privileged: false, roles: [] }
  - { code: instruments.ingest.host_query, privileged: false, roles: [] }
  - { code: instruments.ingest.config_read, privileged: false, roles: [] }
  # added by 08 §4.1
  - { code: instruments.instrument.read, privileged: false, roles: [lab_manager, lab_technologist, pathologist] }   # CR-C7-001; pathologist: 08 A13 D-14
  - { code: instruments.instrument.manage, privileged: true, roles: [lab_manager] }   # CR-C7-001
  - { code: instruments.ingest.enrol, privileged: false, roles: [] }   # CR-C7-001
  # analytics (C8)
  - { code: analytics.dashboard.read,    privileged: false, roles: [owner_viewer, tenant_admin, lab_manager] }
  - { code: analytics.referral_report.read, privileged: true, roles: [owner_viewer] }         # 04 L19/B13; gated by tenant flag
  - { code: analytics.data.export,      privileged: true,  roles: [owner_viewer, tenant_admin] }   # renamed by 08 R19
  # added by 08 §4.1
  - { code: analytics.collections.read, privileged: false, roles: [owner_viewer, tenant_admin, finance] }   # CR-C8-001
  - { code: analytics.schedule.manage, privileged: false, roles: [owner_viewer, tenant_admin] }   # CR-C8-001
  # wave 2/3 modules
  - { code: quality.qc_run.read,         privileged: false, roles: [lab_technologist, lab_manager, pathologist], phase: 2 }
  - { code: quality.qc.manage,           privileged: false, roles: [lab_manager], phase: 2 }
  - { code: quality.autoverify.manage,   privileged: true,  roles: [pathologist, lab_manager], phase: 2 }
  - { code: micro.culture.read,          privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }   # lab_manager 08 A17 D-64 (one x-permission for micro config reads)
  - { code: micro.culture.work,          privileged: false, roles: [lab_technologist, pathologist], phase: 2 }   # roles = CR-C10-004
  - { code: anatomic.case.read,          privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }   # roles += CR-C11-002
  - { code: anatomic.case.signout,       privileged: true,  roles: [pathologist], phase: 2 }
  - { code: inventory.item.read,         privileged: false, roles: [lab_manager, lab_technologist, finance, owner_viewer], phase: 2 }   # roles = CR-C12-001
  - { code: inventory.stock.manage,      privileged: false, roles: [lab_manager], phase: 2 }
  - { code: partners.partner.manage,     privileged: true,  roles: [tenant_admin], phase: 2 }
  - { code: partners.order.read,         privileged: false, roles: [], phase: 2 }             # partner actors
  - { code: partners.manifest.submit,    privileged: false, roles: [], phase: 2 }
  - { code: partners.report.read,        privileged: false, roles: [], phase: 2 }
  - { code: partners.statement.read,     privileged: false, roles: [], phase: 2 }
  - { code: partners.price_list.read,    privileged: false, roles: [], phase: 2 }
  - { code: smartreport.summary.read,    privileged: false, roles: [pathologist, front_desk], phase: 2 }
  - { code: smartreport.template.approve,privileged: true,  roles: [pathologist], phase: 2 }  # B14
  - { code: payments.intent.create,      privileged: false, roles: [front_desk, finance], phase: 1.5 }   # roles += CR-C15-005
  - { code: payments.reconciliation.read,privileged: true,  roles: [finance], phase: 1.5 }
  - { code: engagement.booking.read,     privileged: false, roles: [front_desk, centre_staff, tenant_admin, lab_manager], phase: 3 }   # roles += CR-C16-002
  - { code: engagement.booking.manage,   privileged: false, roles: [front_desk, centre_staff], phase: 3 }   # roles += CR-C16-002
  - { code: engagement.self.read,        privileged: false, roles: [], phase: 3 }             # patient actors
  - { code: engagement.booking.create,   privileged: false, roles: [], phase: 3 }
  - { code: engagement.booking.cancel,   privileged: false, roles: [front_desk], phase: 3 }
  - { code: homecollection.visit.read,   privileged: false, roles: [phlebotomist, front_desk, lab_manager], phase: 3 }   # roles += CR-C17-008
  - { code: homecollection.visit.assign, privileged: false, roles: [front_desk, lab_manager], phase: 3 }
  - { code: homecollection.sync.upload,  privileged: false, roles: [phlebotomist], phase: 3 }
  # added by 08 §4.1
  - { code: quality.qc_run.review, privileged: false, roles: [lab_technologist, lab_manager, pathologist], phase: 2 }   # CR-C9-001
  - { code: quality.autoverify.read, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }   # CR-C9-001
  - { code: quality.tat_alert.read, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }   # CR-C9-001
  - { code: quality.tat_alert.ack, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }   # CR-C9-001
  - { code: quality.config.manage, privileged: false, roles: [lab_manager], phase: 2 }   # CR-C9-001
  - { code: micro.config.manage, privileged: false, roles: [lab_manager], phase: 2 }   # CR-C10-004
  - { code: micro.breakpoint.manage, privileged: true, roles: [lab_manager, pathologist], phase: 2 }   # CR-C10-004
  - { code: anatomic.case.work, privileged: false, roles: [lab_technologist, pathologist], phase: 2 }   # CR-C11-002
  - { code: anatomic.config.manage, privileged: true, roles: [pathologist, lab_manager], phase: 2 }   # CR-C11-002
  - { code: inventory.master.manage, privileged: false, roles: [lab_manager] }   # CR-C12-001
  - { code: inventory.stock.adjust, privileged: true, roles: [lab_manager] }   # CR-C12-001
  - { code: inventory.po.manage, privileged: false, roles: [lab_manager, finance] }   # CR-C12-001
  - { code: inventory.po.approve, privileged: true, roles: [lab_manager, finance] }   # CR-C12-001
  - { code: inventory.cost.read, privileged: false, roles: [lab_manager, finance, owner_viewer] }   # CR-C12-001
  - { code: inventory.report.export, privileged: true, roles: [lab_manager, finance, owner_viewer] }   # CR-C12-001
  - { code: inventory.bench.record, privileged: false, roles: [lab_technologist, lab_manager] }   # CR-C12-001
  - { code: partners.partner.read, privileged: false, roles: [tenant_admin, front_desk, centre_staff, finance, lab_manager], phase: 2 }   # CR-C13-002
  - { code: partners.manifest.receive, privileged: false, roles: [front_desk, centre_staff, lab_technologist], phase: 2 }   # CR-C13-002
  - { code: partners.pickup.manage, privileged: false, roles: [front_desk, centre_staff], phase: 2 }   # CR-C13-002
  - { code: partners.referrer.map, privileged: false, roles: [tenant_admin, lab_manager], phase: 2 }   # CR-C13-002
  - { code: partners.pickup.request, privileged: false, roles: [], phase: 2 }   # partner actors   # CR-C13-002
  - { code: partners.referrer.read, privileged: false, roles: [], phase: 2 }   # partner actors   # CR-C13-002
  - { code: partners.referrer.manage, privileged: false, roles: [], phase: 2 }   # partner_admin only   # CR-C13-002
  - { code: partners.partner_user.manage, privileged: true, roles: [], phase: 2 }   # partner_admin only   # CR-C13-002
  - { code: smartreport.template.manage, privileged: false, roles: [pathologist, lab_manager], phase: 2 }   # CR-C14-003
  - { code: smartreport.summary.approve, privileged: true, roles: [pathologist], phase: 2 }   # per-summary approval (03-IC §4.10 invariant)   # CR-C14-003
  - { code: payments.intent.resolve, privileged: true, roles: [finance], phase: 1.5 }   # CR-C15-005
  - { code: payments.refund.request, privileged: true, roles: [finance], phase: 1.5 }   # CR-C15-005
  - { code: payments.refund.approve, privileged: true, roles: [finance], phase: 1.5 }   # CR-C15-005
  - { code: payments.merchant_config.read, privileged: false, roles: [tenant_admin, finance], phase: 1.5 }   # CR-C15-005
  - { code: payments.merchant_config.manage, privileged: true, roles: [tenant_admin], phase: 1.5 }   # CR-C15-005
  - { code: engagement.auth.challenge, privileged: false, roles: [], phase: 3 }   # patient pre_auth stage only   # CR-C16-002
  - { code: engagement.self.manage, privileged: false, roles: [], phase: 3 }   # patient   # CR-C16-002
  - { code: engagement.link.redeem, privileged: false, roles: [], phase: 3 }   # patient   # CR-C16-002
  - { code: engagement.payment.create, privileged: false, roles: [], phase: 3 }   # patient   # CR-C16-002
  - { code: engagement.enquiry.create, privileged: false, roles: [], phase: 3 }   # patient   # CR-C16-002
  - { code: engagement.queue.board_read, privileged: false, roles: [], phase: 2 }   # device kind queue_display   # CR-C16-002
  - { code: engagement.slot.manage, privileged: false, roles: [tenant_admin, lab_manager], phase: 3 }   # CR-C16-002
  - { code: engagement.bookable_item.manage, privileged: false, roles: [tenant_admin, lab_manager], phase: 3 }   # CR-C16-002
  - { code: engagement.queue.operate, privileged: false, roles: [front_desk, centre_staff], phase: 2 }   # CR-C16-002
  - { code: engagement.queue.manage, privileged: false, roles: [tenant_admin, lab_manager], phase: 2 }   # CR-C16-002
  - { code: engagement.link.issue, privileged: false, roles: [front_desk, centre_staff], phase: 3 }   # CR-C16-002
  - { code: engagement.link.read, privileged: false, roles: [front_desk, centre_staff, tenant_admin], phase: 3 }   # CR-C16-002
  - { code: engagement.link.revoke, privileged: false, roles: [front_desk, tenant_admin], phase: 3 }   # CR-C16-002
  - { code: engagement.reminder.read, privileged: false, roles: [front_desk, tenant_admin], phase: 2 }   # CR-C16-002
  - { code: engagement.reminder.manage, privileged: false, roles: [front_desk], phase: 2 }   # CR-C16-002
  - { code: engagement.membership.read, privileged: false, roles: [front_desk, finance, tenant_admin], phase: 3 }   # CR-C16-002
  - { code: engagement.membership.enrol, privileged: false, roles: [front_desk], phase: 3 }   # CR-C16-002
  - { code: engagement.membership_plan.manage, privileged: true, roles: [tenant_admin, finance], phase: 3 }   # CR-C16-002
  - { code: engagement.enquiry.read, privileged: false, roles: [front_desk], phase: 3 }   # CR-C16-002
  - { code: engagement.enquiry.respond, privileged: false, roles: [front_desk], phase: 3 }   # CR-C16-002
  - { code: engagement.settings.manage, privileged: true, roles: [tenant_admin], phase: 2 }   # CR-C16-002
  - { code: homecollection.handover.receive, privileged: false, roles: [centre_staff, front_desk, lab_technologist], phase: 3 }   # CR-C17-008
  - { code: homecollection.device.manage, privileged: true, roles: [tenant_admin, lab_manager], phase: 3 }   # CR-C17-008
  - { code: homecollection.settings.manage, privileged: true, roles: [tenant_admin, lab_manager], phase: 3 }   # CR-C17-008
```

---

## 12. Platform tables behind the channels (C0 DDL) — accepted addition A7

These are C0-owned mechanics of the event and idempotency channels (02-CV §4.5, §7). They are not cross-chunk interfaces: modules use them only through `events.publish`, the worker dispatcher, the idempotency hook and the dead-letter console. All are tenant tables (RLS `__tenant` policies to `lims_app`, FORCE RLS, owner `lims_owner`) unless stated. `core.event_log`, `core.idempotency_keys` and `audit.access_log` are `shared_with: [partner, portal, patient]` with actor-specific INSERT policies (and SELECT/UPDATE of own rows on `core.idempotency_keys`); no non-staff SELECT on `event_log` or `access_log` (08 A23.3). Class per 02-CV §5.2.

| Table | Class | Columns (type) | Keys / indexes | Written by | Retention |
|---|---|---|---|---|---|
| `core.event_log` | A | tenant_id uuid, event_id uuid, event_type text, producer text, idempotency_key text, aggregate_type text, aggregate_id uuid, aggregate_seq int, occurred_at timestamptz, envelope jsonb, created_at timestamptz, created_by uuid | PK (tenant_id, event_id); UNIQUE (tenant_id, event_type, idempotency_key); index (tenant_id, aggregate_type, aggregate_id, aggregate_seq) | `events.publish` (API/worker core) | 90 days [CONV] |
| `<m>.event_inbox` (one per consuming module schema) | A | tenant_id uuid, event_id uuid, event_type text, received_at timestamptz, created_by uuid | PK (tenant_id, event_id) | worker core consumer wrapper | 90 days [CONV] |
| `core.dead_letters` | E (state column updated) | id uuid, tenant_id uuid (NULL only for `tenantScope: platform` tasks — then the row is in the RLS-exempt list and visible to platform roles only), task_identifier text, job_key text NULL CHECK (char_length(job_key) BETWEEN 1 AND 400) [CONV] (copied at dead-lettering — 08 A23.2; length accepted by 08 A29.2; returned by `app.dl_resolve`, passed to `app.dl_insert_platform` as `p_job_key` — §13.3), job_payload jsonb, last_error_code text, last_error_message_redacted text, attempts int, first_failed_at timestamptz, dead_at timestamptz, state text CHECK (open/replayed/discarded), resolved_by uuid, resolved_at timestamptz, created_at, created_by | PK (id); index (state, dead_at) | worker core on final failure; C2 platform console (replay/discard) | until resolved + 90 days [CONV] |
| `core.idempotency_keys` | E | tenant_id uuid (NULL for platform-context rows — 08 A25 D-213), actor_id uuid, key text, method text, route text, request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32) (32-byte SHA-256, not hex text — C0 review #40, 08 R24), state text CHECK (in_progress/completed), response_status int, response_body jsonb, created_at timestamptz, expires_at timestamptz | `CONSTRAINT idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key)` (replaces the PK; PostgreSQL ≥ 15 — D-213); index (expires_at); platform rows via `idempotency_keys__{select,insert,update}__platform` policies (`tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor())`); responses stored only for status < 400 (D-202) | API core idempotency hook; a non-staff/platform actor may DELETE its own `in_progress` key (08 A29.2 [CONV]) | 7 days [CONV] (the `expires_at` purge covers NULL-tenant rows) |

Other C0 columns that chunks read or rely on (C0 05-SCHEMA §10 is the DDL):

| Table | Column / constraint | Rule | Source |
|---|---|---|---|
| `core.memberships` | `partner_role text NULL` | `CHECK ((actor_type = 'partner') = (partner_role IS NOT NULL))`; `CHECK (partner_role IN ('partner_admin','partner_member'))` (NULL passes); C2 reads it for `PartnerRole` (§4.6) | 08 A28.3 |
| `audit.audit_log` | `detail jsonb NULL`; `actor_id uuid NULL`; `created_by uuid NULL` | `actor_id`/`created_by` NULL only for rows written by `app.tg_row_audit` inside a maintenance DEFINER: `actor_type = 'system'`, `detail = {"maintenance": "<function name>"}`, tenant from the row (the row's own id for `core.tenants`); CHECK `(actor_id IS NOT NULL AND created_by IS NOT NULL) OR (actor_id IS NULL AND created_by IS NULL AND actor_type = 'system' AND detail ? 'maintenance')`; `audit_context_missing` only when neither claims nor `app.maintenance` are present. Indexes `(tenant_id, request_id)` and partial `(tenant_id, support_session_id, occurred_at DESC) WHERE support_session_id IS NOT NULL` (08 A28.6) | 08 A28.5, A29.2 |
| `core.event_log` | `created_by uuid` | the actor column of the row (08 A29.2 [CONV]) | 08 A29.2 |

Function `app.enqueue_job(identifier text, payload jsonb, job_key text DEFAULT NULL, run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL) RETURNS void` — `SECURITY DEFINER`, `SET search_path = ''`, in the unexposed `app` schema, owned by `lims_queue` (NOLOGIN, NOBYPASSRLS; 02-CV §5.9), calls `graphile_worker.add_job` with schema-qualified names, rejects identifiers not present in the worker task registry table generated at deploy, inventoried per 04 D7 / REQ-SEC-020. Its exact `add_job` argument mapping is fixed by C0 against Graphile Worker 0.18.0 docs (04 D6 UNVERIFIED: least-privilege operation tested first).

---

## 13. Consolidated registries from the CR register (08 §4, 2026-11-06)

Transcribed from `08-CR-REGISTER.md` §4 (final text; 08 wins on any difference). R6's registered-egress-IP items (`platform.tenant_egress_ip.manage`, `setTenantEgressIps`, `identity.egress_ip_limit`, access action `tenant_egress_ip.change`) are **not** included: 08 Addendum A1 removed them.

### 13.1 Access-log action codes (`audit.g_cs_access_actions` seed; CHECK `^[a-z_]+\.[a-z_]+$`) — 08 §4.4

Existing C0 seed kept. Additions (code — display — requested by). Strict YAML list, one code per line (08 Addendum A4.8); the display text and provenance stay as trailing comments [CONV layout]:
```yaml
# Strict YAML list, one code per line (as 03-IC §13.1, A4.8; converted by the A13 apply); display text and provenance as trailing comments
# C2 (CR-C2-010, mapped from bare event types)
- audit_entry.view                  # "Audit entry viewed" — was 'view' (audit_entry)
- dead_letter.view                  # "Dead letter viewed" — was 'view' (dead_letter)
- audit_export.download             # "Audit export downloaded" — create uses existing data.export
- ird_document.download             # "IRD annex document downloaded"
- branding_asset.download           # "Branding asset downloaded"
- support_session.approve           # "Support session approved"
- support_session.deny              # "Support session denied"
- support_session.activate          # "Support session activated"
- support_session.revoke            # "Support session revoked" — 'open'/'close' exist; 'end' maps to close
- tenant.lifecycle_change           # "Tenant provisioned/activated/suspended/terminated"
- settings.change                   # "Tenant settings changed"
- feature_flag.change               # "Feature flag changed"
# tenant_egress_ip.change           # "Registered egress IPs changed" (R6) — removed by Addendum A1 (03-IC §13 preamble)
# role_change -> existing role.change; session_revoke -> existing session.revoke; export -> existing data.export
# C4
- patient.search                    # "Patient search performed" — was 'patient_search'
- patient.update                    # 08 Addendum A2.9
- patient.anonymise                 # 08 Addendum A2.9
- credit_note.print                 # 08 Addendum A2.9
- receipt.print                     # 08 Addendum A2.9
# C5 (triage batch 1) — 08 A13 D-11
- specimen_label.print              # per specimen, #14
- lab_result.view                   # order results grid
- lab_result_history.view           # history + trend (#26)
- critical_value.view
- worksheet.print
- ingest_exception.view             # exception detail (raw values)
# C6 (CR-C6-008)
- report.release
- report.portal_view
- report.portal_download
- report.outsourced_view
- report.narrative_sign
- report.token_revoke
- portal.session_start
- portal.link_reissue
# C7 (CR-C7-008)
- instrument_message.raw_view
- instrument_message.attachment_view
- instrument_message.reprocess
- instrument_message.rematch
- device_credential.issue
- device_credential.revoke
# C8 (CR-C8-006)
- referral_report.view              # "Referral business report viewed" — was analytics.referral_report.view
# C9 (used in C9 docs, not CR-registered)
- autoverify.activate
- autoverify.retire
# C9 (triage batch 2) — 08 A17 D-53
- autoverify_decision.view         # decision detail drawer (P3 inputs)
- autoverify_simulation.view       # simulation report
# C10 (CR-C10-010, renamed)
- culture.view                      # was micro.culture.view
- breakpoint_set.import             # were micro.breakpoint_set.*
- breakpoint_set.activate           # were micro.breakpoint_set.*
- breakpoint_set.retire             # were micro.breakpoint_set.*
- micro_instrument_record.assign    # was micro.instrument_record.assign
# C11 (triage batch 2; replaces the anatomic.* three-segment strings) — 08 A17 D-53
- anatomic_case.view
- anatomic_report.view             # report version view
- anatomic_image.view              # image content stream
- anatomic_label.print
- anatomic_object.lookup           # success only
- anatomic_report.sign_out
# C13 (CR-C13-012)
- manifest.print
- report.access_slip
- statement.view
# C14 / C16
- smart_summary.view
# C15 (used in C15 docs)
- payment_intent.resolve            # was 'payment_resolve'
# C16 (CR-C16-019, renamed)
- link_code.issue                   # was engagement.link_code.issue
- app_link.redeem                   # was engagement.link.redeem
- app_link.revoke                   # was engagement.link.revoke
- patient_membership.lookup         # was membership.lookup (collided in meaning with staff membership.lock/unlock)
- patient_account.delete            # was engagement.account.delete
# C17 (used in C17 docs)
- home_visit.view                   # was { type: 'view', entity: 'home_visit' }
# C3: catalog file / referrer exports use existing data.export (entityType 'catalog_file' / 'referrer_export')
# Reserved (DEFER, B4): legacy_document.download
```

Calls use C0's `ctx.audit.access({action, entityType, entityId?, centreId?, purpose?, outcome, detail?})` (C0 TRD §6.9; 08 R20). Every `action` used in `services/**` must be in this list / the C0 seed before use; CI (C0-0C) fails a string-literal `action:` not in `audit.g_cs_access_actions` (08 A13 P-3; 02-CV §10.2 "Audit").

### 13.2 UI-kit components — 08 §4.6

**Web (`@lims/ui`, C0-0D).** New components and prop changes (props as in the requesting chunk's 04-UI-UX unless stated):

| Component / change | Requested by | Note |
|---|---|---|
| `PermissionMatrix` | C2 | keyboard grid; non-assignable codes disabled |
| `DataUriImage` | C2 | `<img>` from PNG or SVG data URI only; never inline SVG markup |
| `EditableGrid` | C3 | cell editing, per-row status/error cell |
| `CodeField` | C3 | upper-casing, regex hint |
| `FormulaEditor` | C3 | diagnostics from `@lims/shared-ts/formula` |
| `StatusStepper` | C3 | import/publish progress |
| `DiffTable` | C3 + C2 (`JsonDiffView`) | rows `{label, before, after, changed}`; values as text nodes; "changed" text marker |
| `PrintFrame` | C4 | print-only iframe, `@media print` |
| `FileUpload` + `scanState?: Record<string,'pending'\|'clean'\|'infected'\|'unavailable'>`; `accept` union += `'text/csv'`, `'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'` | C4, C10, C3 | replaces FileDropzone/FileDrop |
| `RichTextEditor` | C6 | allowlisted marks; sanitised client + server |
| `OtpInput` | C6 + C2 (`OtpCodeInput`) | 6 numeric cells, `autocomplete="one-time-code"`, paste fills, Enter submits |
| `ImageThumbnailGrid`, `PdfFileCard` | C6 (C11 uses the grid) | |
| `CodeBlock`, `KeyValueListEditor` | C7 | |
| `SecretRevealOnce` (+ `requireAcknowledgement?: boolean` default true) | C7 + C2 (`SecretRevealField`) | secret never re-rendered after close |
| `PeriodPicker`, `DurationText`, `FreshnessBadge` | C8 | C4 may reuse PeriodPicker |
| `ControlChart` | C9 | Levey-Jennings; shapes + text, hidden table |
| `BarcodeSymbol` (Code 128 SVG) | C11 (C5 uses it) | value `^[A-Z0-9-]{1,32}$`, never logged |
| `DecimalField.suffix?: string` | C12 | |
| `QrCode` | C4 (front-desk gateway dialog: QR of `action.launchUrl` / `qrPayload`, 08 A19 D-113; C4 04-UI-UX §3.6). CR-C13-013 withdrawn by C13 (QR drawn by C6 inside the slip PDF, A5.1) | local SVG, no network |
| `TextDiff` | C14 (Phase 3) | grapheme-aware |
| `SecretField` | C15 | masked, never pre-filled |
| `QueueBoard`, `TokenSlip`, `WeekdayTimeRangeEditor` | C16 | |
| message key `ui.status.report_version.discarded` "Discarded" | C6 | CR-C6-005 |
| shell slot: support-session banner | C2 (CR-C2-009) | part of C0 shell, not a feature component |

Mapped to existing components (no new component): `MoneyInput`→`MoneyField`; `MoneyText` (exists); `DualDate`→`DateText mode="AD_BS"`; `AsyncCombobox`→`Combobox`; `DataTable` (exists); `StatusBadge`→`StatusChip`; `ShortcutHint`→`Button.shortcut` / `KeyboardShortcutsDialog`; `ConfirmDialog` with reason (exists); `StatusTimeline`→`Timeline`; `AppPage`→`PageShell`+`PageHeader`; `NumberField`→`DecimalField`; `Textarea`→`TextArea`; `DateTimeField`→`DateTimePicker`; `Skeleton`→`LoadingSkeleton`; `Toast`→`useToast`; `KeyboardShortcutsHelp`→`KeyboardShortcutsDialog`; `Badge` (exists).

**Flutter (`lims_ui`, C0-0D).** New (CR-C16-016): `LimsPhoneField`, `LimsOtpField`, `LimsCodeField` (grouped `XXXXX-XXXXX`), `LimsStageTimeline`, `LimsSlotPicker`, `LimsSegmentedControl`, `LimsBottomNav`, `LimsCard`, `LimsQrCode`, `LimsPdfViewer`, `LimsProfileSwitcher`, `LimsAppLockGate`. Dependency pins (licence + no runtime egress) for router/app links, external browser, local auth, PDF render, QR render (CR-C16-017), and `local_auth`-class biometric prompt, `url_launcher`-class hand-off, on-device location capture, on-device `LimsBarcodeScanner` confirmation (CR-C17-010).

### 13.3 SECURITY DEFINER inventory, DB roles, index exceptions — 08 §4.7

**DB roles** (02-CV §5.9 additions; all NOSUPERUSER, NOBYPASSRLS):

| Role | LOGIN | Special | Purpose | CR |
|---|---|---|---|---|
| `lims_queue` | no | — | owns `graphile_worker` schema, `app.enqueue_job`, `app.queue_depth`; `lims_worker` is a member | C0-007 |
| `lims_monitor` | yes | `pg_monitor` | metrics exporter | C1-002 |
| `lims_replicator` | yes | REPLICATION | standby streaming | C1-002 |
| `lims_audit_ship` | yes | REPLICATION | logical decoding of publication `lims_audit_ship` (INSERT only) | C1-002 |
| `lims_reporting_lookup` | no | — | owns C6 pre-tenant token lookup DEFINERs | C6-002 |
| `lims_migration` | reserved | — | DEFER (B4) | C18-001 |

CI assertion: `rolreplication` true only for `lims_replicator`, `lims_audit_ship`; `rolbypassrls`/`rolsuper` false for every `lims_%` role.

**DEFINER inventory additions** (`db/meta/definer-inventory.yaml`; all `SET search_path = ''`, schema-qualified, no caller-supplied tenant; pre-tenant lookups bind their policies to a transaction-local GUC set inside the function from the presented hash):

| Function | Owner | EXECUTE to | Source |
|---|---|---|---|
| `app.enqueue_job(...)`, `app.queue_depth() RETURNS TABLE (task_identifier text, ready bigint, locked bigint, failed bigint)` (counts only, never payloads or keys) | `lims_queue` | `lims_app` (`queue_depth`: `lims_worker`) | C0-007, 03-IC §12; C0 05-SCHEMA §4.3 |
| `app.has_all_centres()` (rewritten CASE: `system` → tenant set; `user` → membership; every other actor type → false), `app.current_centre_ids()` (02-CV §5.8; policies cast it `::uuid[]`, 08 A16.1) | `lims_owner` | `lims_app` | R3; `memberships__select__owner_only`, `membership_centres__select__owner_only` |
| `app.tg_row_audit()` (+ per-table excluded-column trigger argument; `coalesce(TG_ARGV::text[], '{}')`, A15.5; no `audit_log` row for a NULL-tenant row of a table other than `core.tenants`, A25 D-215) | `lims_owner` | trigger | C15-013 |
| `app.ratelimit_hit(text, int, int)` | `lims_owner` | `lims_api`, `lims_worker` | C0 05-SCHEMA §4.3 (RLS-exempt counter table, 02-CV §5.9; A20.4) |
| `app.purge_idempotency_keys()`, `app.purge_event_log()`, `app.purge_event_inboxes()`, `app.purge_dead_letters()`, `app.purge_ratelimit_counters()` (no input arguments, A12.4/A15.4; each returns `(OUT deleted bigint, OUT capped boolean)` [CONV, accepted 08 A29.2; `capped` feeds `lims_core_retention_purge_capped_total{table}`, D-200]; loop cap `clock_timestamp() - now() > interval '4 minutes'`, own transaction each, task `core.retention_purge` with `taskOptions: { statementTimeoutMs: 300000 }` — A25 D-200; SQL in C0 05-SCHEMA §10) | `lims_owner` | `lims_worker` | A15.3 (`app.maintenance = '<function name>'`); D-200 |
| `app.dl_insert_platform(uuid, text, jsonb, text, text, integer, timestamptz, text)` (8 arguments; last `p_job_key text DEFAULT NULL`, A23.2), `app.dl_list_platform(text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid)`, `app.dl_resolve(uuid, integer, text, text)` (RETURNS TABLE = the `DeadLetterRow` columns plus core-only `job_payload` (A10.1) and `job_key` (replay source, A23.2), neither ever in `DeadLetterRow`), `app.platform_list_tenants(text, text, text, timestamptz, uuid, integer)` (SQL in C0 05-SCHEMA §10) | `lims_owner` | `lims_worker` (insert); `lims_api` (list, resolve, tenants — platform context only) | C0-004; `platform_list_tenants`: maintenance GUC `app.maintenance = 'platform_list_tenants'`, platform claims check, non-PHI tenant columns, keyset paging (08 A12.3) |
| `app.cron_tenant_ids() RETURNS SETOF uuid` | `lims_owner` | `lims_worker` | 08 A13 P-6, A23.1 (tenant list for `tenantScope: 'per_tenant'` cron ticks; `core.tenants.status IN ('active','suspended')` [CONV]; `core.tenants__select__owner_only` per A10.5, gated by `app.maintenance = 'cron_tenant_ids'` per A12.2). EXECUTE += `lims_migration` only when CR-C18-001 is accepted after B4 (D-134, deferred) |
| `app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)` (plpgsql; replaces `app.engagement_resolve_tenant_code`) | `lims_owner` | `lims_api` | 08 A19 D-121: body `set_config('app.pre_tenant_code', p_code, true)` → select → reset to `''`; `core.tenants__select__owner_only` ORed with `tenant_code = nullif(current_setting('app.pre_tenant_code', true), '')`; the caller filters `status = 'active'`. EXECUTE += `lims_migration` only when CR-C18-001 is accepted after B4 (D-134, deferred) |
| `app.is_platform_actor()` (C0-owned DDL, A15.6) | `lims_owner` | `lims_app` | C2-004; `platform_staff__select__owner_only` |
| `app.identity_resolve_session(uuid, uuid)`, `app.identity_login_context(uuid)`, `app.identity_session_by_token(bytea)`, `app.identity_record_auth_event(jsonb)`, `app.identity_user_exists(uuid)`, `app.identity_bootstrap_platform_admin(uuid, uuid, text, text, uuid)` | `lims_owner` | `lims_api` | C2-005 (SQL in C2 05-SCHEMA §10); pre-tenant GUCs per 08 A12.1 (below), incl. `app.pre_support_session_id` (A15.1) and `app.pre_tenant_id` = the support session's `support_tenant_id` for a platform support session (A20.1); `identity_user_exists` takes the GoTrue `sub` |
| `app.identity_purge_sessions()`, `app.identity_expire_support_sessions()`, `app.identity_expire_invitations()` (each `RETURNS integer`), `app.identity_expire_audit_exports() RETURNS TABLE (object_path text)`, `app.identity_purge_auth_events() RETURNS integer` | `lims_owner` | `lims_worker` | 08 A12.2, A15.3 (each sets `app.maintenance = '<function name>'`; owner policies gated on it; `identity_purge_auth_events` reads `identity.tenant_settings` retention for all tenants); SQL in C2 05-SCHEMA §10.3 |
| `app.identity_load_breached_batch(p_hashes bytea[], p_version text) RETURNS integer`, `app.identity_finish_breached_import(p_version text) RETURNS integer` | `lims_owner` | `lims_worker` | C2 05-SCHEMA §10.3 (breached-password list import into class G `identity.g_breached_passwords`; no RLS, no owner policy) |
| `app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid` (≤ 100 values) | `lims_owner` | `lims_worker` only | 08 A25 D-217 (task `identity.notify_ip_throttle`); owner policy `users__select__owner_only` ORed with `current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL` (A12.2); A12.7 tests; SQL in C0 05-SCHEMA §10 / C2 05-SCHEMA §10.3 |
| `app.identity_platform_auth_write_session_insert(p_user_id uuid, p_row jsonb) RETURNS void`, `app.identity_platform_auth_write_session_update(p_user_id uuid, p_session_id uuid, p_set jsonb) RETURNS integer`, `app.identity_platform_auth_write_mfa_factor(p_user_id uuid, p_factor_id uuid, p_row jsonb) RETURNS integer`, `app.identity_platform_auth_write_invitation_accept(p_user_id uuid, p_invitation_id uuid) RETURNS integer`, `app.identity_platform_auth_write_staff_login(p_user_id uuid) RETURNS integer` [CONV names, C2] | `lims_owner` | `lims_api` only | 08 A28.1 (platform-staff session / MFA-factor / invitation / last-login writes during authentication, before a platform session exists; whitelisted columns only): each sets `app.pre_user_id = p_user_id` and resets it before return; owner policies `sessions__insert/update/select__owner_only` (`tenant_id IS NULL AND kind = 'platform' AND user_id = app.pre_user_id`), `mfa_factors__insert/update__owner_only` and `invitations__update/select__owner_only` (`tenant_id IS NULL AND user_id = app.pre_user_id`), `platform_staff__update__owner_only` (`user_id = app.pre_user_id`); SQL in C2 05-SCHEMA §10.3, policies §5.4 |
| `app.identity_notify_ip_throttle_hmacs(p_client_ip inet, p_since timestamptz) RETURNS SETOF bytea` (≤ 100 values) [CONV name, C2] | `lims_owner` | `lims_worker` only | 08 A28.4 (task `identity.notify_ip_throttle`; reads tenant-less `login_failed` `auth_events`): sets `app.maintenance = 'identity_notify_ip_throttle'` and resets it; `auth_events__select__owner_only` gains `app.maintenance = 'identity_notify_ip_throttle' AND tenant_id IS NULL AND event_type = 'login_failed' AND email_hmac IS NOT NULL`; SQL in C2 05-SCHEMA §10.3 |
| `app.reporting_verify_qr(bytea)`, `app.reporting_resolve_portal_credential(text, bytea)`, `app.reporting_ingest_provider_callback(text, bytea, jsonb)` | `lims_reporting_lookup` | `lims_api` | C6-002 (+R24 types); GUC names per 08 A21.4 (each set inside the body and reset to `''` before every return): `app.pre_qr_token_sha256` (`qr_tokens__select__lookup`, `report_versions__select__lookup`), `app.pre_portal_credential_sha256` (`portal_links__select__lookup`, `portal_sessions__select__lookup`), `app.pre_callback_token_sha256` + `app.pre_callback_tenant_id` + `app.pre_callback_channel_account_id` (`channel_accounts__select__lookup`, `provider_events__insert__lookup`, `provider_events__select__lookup` — the SELECT policy and `GRANT SELECT, INSERT ON reporting.provider_events` are needed by `INSERT … ON CONFLICT` under FORCE RLS; accepted from the C6 second pass) [CONV names, C6 05-SCHEMA §6.2] |
| `app.reporting_redeem_link_for_app(p_token_sha256 bytea, p_phone_sha256 bytea) RETURNS TABLE (tenant_id uuid, patient_id uuid, report_id uuid, version_no integer, released_at timestamptz)` | `lims_reporting_lookup` | `lims_api` | 08 A13 D-30 (`ReportingPort.redeemPortalLinkForApp`): returns a row only for a valid link with recipient `patient`, channel `sms`\|`whatsapp` and `coalesce(portal_links.destination_sha256, delivery destination) = p_phone_sha256`; a mismatch increments `portal_links.redeem_failures smallint NOT NULL DEFAULT 0 CHECK (redeem_failures BETWEEN 0 AND 5)`, at ≥ 5 nothing is returned; GUC `app.pre_portal_token_sha256`; policies `TO lims_reporting_lookup`: `portal_links__select__owner_only` / `__update__owner_only` `USING (token_sha256 = <GUC>)`, and `reports__select__owner_only`, `report_versions__select__owner_only`, `deliveries__select__owner_only` (rows of the link's report, its versions and the link's delivery); column grant `GRANT UPDATE (redeem_failures, updated_at, version) ON reporting.portal_links TO lims_reporting_lookup`; the failure-counter increment persists through `ctx.commitOnError()` (A19 P-42); A12.7 tests; probe: 5 wrong phones → the 6th, correct phone fails |
| `app.instruments_resolve_device_credential(bytea)`, `app.instruments_agent_state_snapshot()`, `app.purge_instruments_archive(p_raw_retention_days integer)` (≥ 365; signature changed by 08 A13 D-42) | `lims_owner` | `lims_api` / `lims_worker` | C7-006; D-42: `instruments.purge_archive` runs `per_tenant` (P-6) and passes `TenantSettings.retention.rawInstrumentYears` read via IdentityPort; maintenance GUC `app.maintenance = 'purge_instruments_archive'` (A12.2, A13) |
| `app.current_partner_id()` | `lims_owner` | `lims_app` | C13-004 |
| `partners.redact_lines(p_tenant_id uuid, p_older_than timestamptz) RETURNS integer` | `lims_owner` | `lims_worker` | C13 hand-off (SQL in C13 05-SCHEMA): task `partners.redact_expired_lines` (`per_tenant`, partners system actor); refuses unless `p_tenant_id = app.current_tenant_id()` and actor type `system`; sets `app.maintenance = 'partners_redact_lines'`; owner policies `manifest_lines__select/update__owner_only`, `order_reports__select/update__owner_only`, `order_tracking__select__owner_only` gated by that value **and** `tenant_id = (SELECT app.current_tenant_id())` |
| `app.payments_resolve_callback_token(p_token_sha256 bytea) RETURNS TABLE (tenant_id uuid, intent_id uuid)` | `lims_owner` | `lims_api` | C15-004; A19 P-41 / A12.1: GUC `app.pre_payments_callback_token_sha256` (hex), policy `intents__select__owner_only ON payments.intents TO lims_owner USING (callback_token_sha256 = decode(current_setting('app.pre_payments_callback_token_sha256', true), 'hex'))`; reset before return; 30-day acceptance window [CONV] (SQL in C15 05-SCHEMA) |
| `app.engagement_resolve_preauth(text, bytea)`, `app.engagement_resolve_display(bytea)` (plpgsql) | `lims_owner` | `lims_api` | C16-005 (+R24 types); 08 A19 D-121: GUCs `app.pre_engagement_otp_token_sha256` / `app.pre_engagement_display_token_sha256` (hex); `otp_challenges__select__owner_only` / `queue_displays__select__owner_only TO lims_owner USING (token_sha256 = decode(current_setting('<GUC>', true), 'hex'))`; `app.pre_tenant_id` set after the row is found (A12.1) for C0 `tenants__select__owner_only`; all reset before return. `app.engagement_resolve_tenant_code(text)` is **removed** (→ `app.core_resolve_tenant_code`, D-121) |
| `app.engagement_account_id()`, `app.engagement_patient_ids()`, `app.engagement_patient_visible(uuid, timestamptz)`, `app.engagement_redeem_link_code(bytea)` (08 A2.4: takes the 32-byte HMAC), `app.engagement_apply_report_link(uuid, timestamptz)`, `app.engagement_code_redeemed_by_me(uuid, uuid)` | `lims_owner` | `lims_app` | C16-006; 08 A19 D-121 tenant-claim owner policies (C16 05-SCHEMA §6.5–§6.6): `accounts__select__owner_only` (`tenant_id = (SELECT app.current_tenant_id()) AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid`), `account_patient_links__select/update__owner_only` (`account_id = app.engagement_account_id()`), `link_codes__select__owner_only` (`status = 'issued' OR redeemed_account_id = app.engagement_account_id()`), `link_codes__update__owner_only` (`status = 'issued'` / WITH CHECK `redeemed_account_id = app.engagement_account_id()`); C0 `memberships__select__owner_only` |
| `engagement.purge_payment_requests()`, `engagement.purge_queue()` (each `RETURNS integer`) | `lims_owner` | `lims_worker` | 08 A19 D-121 last bullet (purges that touch non-E rows; C16 05-SCHEMA §6.4/§6.6): `payment_requests__select/delete__owner_only` (`app.maintenance = 'engagement_purge_payment_requests'`); `queue_tokens__…`, `queue_day_counters__select/delete__owner_only` (`app.maintenance = 'engagement_purge_queue'`); each also bound to the job's tenant claims |
| `frontdesk.purge_trf_drafts(p_older_than interval, p_ids uuid[]) RETURNS integer` | `lims_owner` | `lims_worker` | C4 hand-off (SQL in C4 05-SCHEMA): task `frontdesk.trf_draft_purge` (`per_tenant`, tenant claims) after deleting the draft objects (P-12 a); sets `app.maintenance = 'frontdesk_purge_trf_drafts'`; `trf_attachments__select/delete__owner_only` gated by that value, `order_id IS NULL` and `tenant_id = (SELECT app.current_tenant_id())` |
| `app.homecollection_anonymise_retired_visits(p_before timestamptz) RETURNS TABLE (visits_anonymised integer, handover_items_anonymised integer)` | `lims_owner` | `lims_worker` | C17 hand-off (SQL in C17 05-SCHEMA): one tenant per call (system claims); sets `app.maintenance = 'homecollection_anonymise_retired_visits'`; `visits__select/update__owner_only`, `handover_items__select/update__owner_only` gated by that value plus `app.current_tenant_id()` |
| **Removed:** `app.custom_access_token_hook`, `app.resolve_membership_for_subject` (R10); `app.engagement_resolve_tenant_code` (D-121) | — | — | — |

Not DEFINER (INVOKER, listed for completeness): `app.is_staff_or_system()` (CR-C13-011), `app.current_lims_session_id()` (C0 DDL, 08 A20.2; `GRANT EXECUTE … TO lims_app, lims_api, lims_worker`), `app.engagement_preauth_stage()` (no table read; C16 05-SCHEMA §6.6), `app.purge_inventory_alerts()` (CR-C12-008; per-tenant class-E delete, A17 D-72). Class-E retention deletes of other modules are not DEFINERs (02-CV §5.11, P-18(c)).

**Pre-tenant and maintenance DEFINERs under FORCE RLS (08 A10.5, A12, A13).** Rule text: 02-CV §5.8. Names fixed by 08 A12.1 (all `app.pre_*`, text values, set inside the function body with `set_config(name, value, true)` before each read; owner policies `TO <function owner>` match on them; reset to `''` before returning):

| GUC | Policies (owner role) | Used by |
|---|---|---|
| `app.pre_session_token_sha256` (hex of the presented 32-byte hash) | `identity.sessions` owner SELECT `USING (token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex') OR previous_token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex'))` | `app.identity_session_by_token` |
| `app.pre_gotrue_session_id` | `identity.sessions` owner SELECT on `gotrue_session_id` | `app.identity_resolve_session` |
| `app.pre_user_id` (GoTrue `sub`) | `core.memberships` / `core.users` owner SELECT `USING (user_id = / id = nullif(current_setting('app.pre_user_id', true), '')::uuid)` | `app.identity_login_context`, `app.identity_resolve_session`, `app.identity_user_exists`; the five `app.identity_platform_auth_write_*` (08 A28.1: `identity.sessions` / `identity.mfa_factors` / `identity.invitations` owner INSERT/UPDATE/SELECT branch `tenant_id IS NULL AND user_id = app.pre_user_id`; `identity.platform_staff` owner UPDATE) |
| `app.pre_tenant_id` (set **after** the membership is chosen, A8.1) | owner SELECT on `core.tenants` (`id = …`), `core.membership_roles`, `core.roles`, `identity.mfa_factors`, `identity.tenant_settings`, `identity.support_sessions`: `tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid` (plus `user_id`/`membership_id` = the chosen ones where the table has them) | same identity functions |
| `app.pre_support_session_id` (the session row's `support_session_id`, `''` when NULL) | `identity.support_sessions` owner SELECT branch `id = nullif(current_setting('app.pre_support_session_id', true), '')::uuid` (08 A15.1) | `app.identity_resolve_session` |
| `app.pre_tenant_code` | `core.tenants__select__owner_only` ORed with `tenant_code = nullif(current_setting('app.pre_tenant_code', true), '')` (08 A19 D-121) | `app.core_resolve_tenant_code` |
| `app.pre_portal_token_sha256` | `reporting.portal_links` SELECT/UPDATE and `reports` / `report_versions` / `deliveries` SELECT `__owner_only` `TO lims_reporting_lookup` (08 A13 D-30) | `app.reporting_redeem_link_for_app` |
| `app.pre_qr_token_sha256`; `app.pre_portal_credential_sha256`; `app.pre_callback_token_sha256`, `app.pre_callback_tenant_id`, `app.pre_callback_channel_account_id` (08 A21.4 [CONV names], C6 05-SCHEMA §6.2) | `__lookup` policies `TO lims_reporting_lookup` on `qr_tokens`, `report_versions`; `portal_links`, `portal_sessions`; `channel_accounts`, `provider_events` (INSERT and SELECT) | `app.reporting_verify_qr`; `app.reporting_resolve_portal_credential`; `app.reporting_ingest_provider_callback` |
| `app.pre_payments_callback_token_sha256` (hex) | `payments.intents` owner SELECT (`intents__select__owner_only`) | `app.payments_resolve_callback_token` |
| `app.pre_engagement_otp_token_sha256`, `app.pre_engagement_display_token_sha256` (hex) | `engagement.otp_challenges` / `engagement.queue_displays` owner SELECT (08 A19 D-121) | `app.engagement_resolve_preauth`, `app.engagement_resolve_display` |
| `app.maintenance = '<function name>'` | owner policies `USING (current_setting('app.maintenance', true) = '<function name>' AND <narrow predicate>)` (08 A12.2; replaces ad-hoc names; A15.3: all cross-tenant maintenance DEFINERs) | C0 `app.purge_*`, `app.identity_purge_sessions`, `app.identity_expire_{support_sessions,invitations,audit_exports}`, `app.identity_purge_auth_events`, `app.identity_tenants_for_email_hmacs`, `app.identity_notify_ip_throttle_hmacs` (value `'identity_notify_ip_throttle'`, 08 A28.4), `app.platform_list_tenants`, `app.cron_tenant_ids`, `app.purge_instruments_archive`, `partners.redact_lines`, `engagement.purge_payment_requests`, `engagement.purge_queue`, `frontdesk.purge_trf_drafts`, `app.homecollection_anonymise_retired_visits` (tenant-bound ones also match `app.current_tenant_id()`) |

`lims_app` callers cannot benefit from setting these GUCs (policies are `TO` the owner role only). Tests (08 A12.7): for every such function a FORCE-RLS contract test proves (a) it returns the expected row, (b) a `lims_app` session that sets the same GUC directly sees nothing, (c) GUCs are empty after return. `app.purge_event_log` takes no argument (08 A12.4). `app.tg_row_audit` is not attached to `identity.platform_staff` or other platform-only tables; for `core.tenants` it uses the row's own `id` as `tenant_id` when no tenant claim is present (08 A12.5).

**Index-rule exceptions** (`db/meta/index-exceptions.yaml`; global unique on a hash or a one-tenant invariant, used only by inventoried DEFINERs; a tenant-leading secondary index also exists): `identity.sessions(token_sha256)`, partial `identity.sessions(previous_token_sha256) WHERE previous_token_sha256 IS NOT NULL` (08 Addendum A3.1, CR-C2-018; used only by the inventoried session-resolve DEFINER), `identity.sessions(gotrue_session_id)`, partial `core.memberships(user_id) WHERE actor_type = 'user'` (R27), `reporting.qr_tokens(token_sha256)`, `reporting.portal_links(token_sha256)`, `reporting.portal_sessions(token_sha256)`, `reporting.channel_accounts(callback_token_sha256)`, `instruments.agent_credentials(secret_sha256)`, `payments.intents(callback_token_sha256)`, `engagement.queue_displays(token_sha256)`, `identity.auth_events(occurred_at DESC, id DESC)` (`auth_events__occurred_at__idx`, platform-wide sign-in list PL-8; 08 A28.6). Tables with platform rows may use `UNIQUE NULLS NOT DISTINCT (tenant_id, …)` (CR-C2-017).

No GoTrue access-token hook role or hook/fallback functions are created (08 R10).

### 13.4 Storage buckets (all private; first path segment `{tenant_id}`; server-side `ctx.storage` only; `storage.objects` end-user policies only after SP-4) — 08 §4.8

| Bucket | Owner module | Paths | Writes | Source |
|---|---|---|---|---|
| `reports` | reporting (C6) | `{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf` | worker, write-once | 04 D15 |
| `reporting-inputs` | reporting | `{tenant_id}/quarantine/…`, `{tenant_id}/outsourced/…`, `{tenant_id}/narrative-images/…`, `{tenant_id}/instrument-sanitized/{yyyy}/{mm}/{sha256}.pdf` (08 A21.3) | API/worker | C6-009 (renamed) |
| `reporting-prints` | reporting | `{tenant_id}/prints/{yyyy}/{mm}/{print_id}.pdf` (24 h) | worker | C6-009 (renamed) |
| `identity-assets` | identity (C2) | logos, letterhead images, signature images; superseded objects kept | API | C2-012 (renamed) |
| `identity-exports` | identity | audit CSV exports (expire) | worker | C2-012 (renamed) |
| `frontdesk-trf` | frontdesk (C4) | TRF uploads | API | C4-005 (renamed) |
| `billing-exports` | billing (C4) | Excel/XML/PDF exports incl. RenderPort output | worker | C4-005 |
| `instruments-attachments` | instruments (C7) | `{tenant_id}/q/{yyyy}/{mm}/{id}.{ext}`, `{tenant_id}/{yyyy}/{mm}/{id}.{ext}` | API/worker | C7-007 (renamed) |
| `micro-imports` | micro (C10) | breakpoint CSV files | API | C10-008 |
| `anatomic-images` | anatomic (C11) | `{tenant_id}/{yyyy}/{mm}/{image_id}.{png\|jpg}` | API/worker | C11-008 |
| `partners-slips` | partners (C13) | `{tenant_id}/access-slips/{yyyy}/{mm}/{slip_id}.pdf` (deleted at link expiry) | worker, write-once per successful issue; a retry before the row is `issued` may replace (upsert) (C13 hand-off) | 08 Addendum A5.2 |
| `reporting-legacy` | reporting | reserved (DEFER, B4) | — | C18-004 |

C8 analytics exports and C3 catalog files are stored as their TRDs specify (no bucket requested); if they move to Storage they use `analytics-exports` / `catalog-files` under the same rules.

### 13.5 Core runtime and manifest additions (C0-0D) — 08 §4.11

```ts
// services/api/src/core/module.ts
interface ModuleManifest {
  /* existing */
  claimsResolver?: ClaimsResolver;                      // accepted only from module 'identity' (R10)
  authResolvers?: {                                     // module → allowed resolvers (CI-checked)
    deviceToken?: AuthResolver;          // 'instruments'
    portalSession?: AuthResolver;        // 'reporting'   (may return { error: 'reporting.link_invalid' } → 404, CR-C6-001)
    paymentCallback?: AuthResolver;      // 'payments'    (actor: system of payments; extraClaims { payment_intent_id })
    patientPreAuth?: AuthResolver;       // 'engagement'  (actor: patient, extraClaims { patient_stage, otp_token_sha256 })
    queueDisplayToken?: AuthResolver;    // 'engagement'  (actor: device, extraClaims { device_kind: 'queue_display' })
  };
}
// AuthResolver result: { actor: Actor; tenantId: Uuidv7; centreId?: Uuidv7; extraClaims?: Readonly<Record<string, string>> } | { error: ErrorCode }
// Allowed extraClaims keys per module: reporting {portal_stage, portal_report_id, portal_session_id}; instruments {credential_kind, credential_id};
// payments {payment_intent_id}; engagement {patient_stage, otp_token_sha256, device_kind}. Core copies them into request.jwt.claims.
interface WorkerManifest { /* existing */ taskOptions?: Readonly<Record<string, { statementTimeoutMs?: number /* ≤ 300000 */ }>> }   // CR-C8-012
// OpenAPI extensions: x-context: tenant|platform (CR-C2-004); x-edge-exposure: public|internal (CR-C1-004);
// x-anonymous-tx: true (module reporting only, with x-public; CR-C6-001); x-raw-body: true (reporting provider callbacks only, ≤ 256 KB);
// text/html responses only for payments operations with x-public or paymentCallbackToken (CR-C15-004).
ctx.db.anonymousTx(): DbTx                               // reporting only, x-public + x-anonymous-tx
ctx.db.withTenantScope(tx, tenantId, fn)                 // identity, platform context, operationId allowlist (R10 item 4 as amended by 08 A25 D-214);
                                                         // core-internal uses: worker-core cron fan-out (A23.1), deadLetters.replay of a tenant row (A23.2)
                                                         // + IdentityPort patient-context writes (provisionPatientMembership, openPatientSession,
                                                         //   revokePatientSessions) under <identity system actor> (08 A28.2)
ctx.db.identityAuthTx(fn)                                // 08 A25 D-212: module identity only, operations tagged x-context: identity_auth and listed in
  // core config (loginStaff, loginPartner, openMobileSession, refreshMobileSession, logoutMobileSession, confirmEmailToken,
  // requestPasswordRecovery, verifyMfaChallenge, startMfaEnrolment, completeMfaEnrolment, resolveSession, logoutSession,
  // setPasswordFromSetup, resolvePatientSession, logoutPatientSession); claims {sub: <identity system actor>, actor_type: 'system'}, no tenant_id;
  // tx.bindTenant(tenantId) at most once, after identity_login_context / identity_session_by_token / identity_resolve_session chose the membership;
  // authz guard (stage 9) exempts x-context: identity_auth; every listed operation carries x-public with a justification (02-CV §6)
ctx.core.systemActorPermissions(actorId): readonly PermissionCode[]                         // CR-C2-013
// 08 A17 D-47 (P-17): MembershipRow defined; memberships.list widened (all new inputs optional, so the C17 call stays valid)
export interface MembershipRow { readonly membershipId: Uuidv7; readonly userId: Uuid; readonly actorType: 'user'|'system'|'device'|'portal'|'patient'|'partner';
  readonly displayName: string; readonly status: 'invited'|'active'|'deactivated'; readonly isActive: boolean; readonly lockedAt?: IsoUtc;
  readonly allCentres: boolean; readonly centreIds: readonly Uuidv7[]; readonly roleCodes: readonly string[] }
memberships: { list(tx: RequestContext, input: { centreId?: Uuidv7; roleCode?: string; permission?: PermissionCode;
    membershipIds?: readonly Uuidv7[] /* ≤ 200 */; activeOnly?: boolean /* default true */; limit?: number /* 1–500, default 200 */ }):
  Promise<readonly { membershipId: Uuidv7; displayName: string; roleCodes: readonly string[]; allCentres: boolean; isActive: boolean }[]> }   // CR-C17-013, D-47
// list semantics (D-47): tenant from ctx only; actor_type = 'user' memberships only; centreId → all_centres or member of that centre;
// permission → a role of the membership grants it (core.role_permissions); unknown/other-tenant membershipIds omitted; displayName from core.users;
// callers staff or system only — portal, patient and partner actors get auth.forbidden. Users: C8 #16, C10 *_display, C11 A12 (08 A17 D-47).
ctx.core.centres.list(tx, { kinds?: readonly ('own' | 'franchise' | 'home_collection')[] })                            // CR-C17-013
  // rows include the centre's phone_display (core.collection_centres.phone_display, ≤ 40; C4 hand-off)
// Config keys: LIMS_CORE_SCANNER_URL (default tcp://clamd:3310, INSTREAM), LIMS_CORE_SCANNER_TIMEOUT_MS (default 30000) [CONV] — 08 A25 D-209, set by C1;
// LIMS_CORE_BFF_KEY_FILES lists kinds staff_web, partner, portal (08 A19 P-45); LIMS_CORE_TRUSTED_PROXY_CIDRS [CONV] (08 A25 P-61; C1 sets it to
// the nginx container address on edge_net) — app.client_ip from X-Forwarded-For only with a valid BFF key or a trusted peer; modules read ctx.clientIp.
// Idempotency (08 A25 D-202, D-213): responses stored only for status < 400 (a ctx.commitOnError() path deletes the key row before commit);
// core.idempotency_keys.tenant_id NULL for platform-context operations (provisionTenant, openSupportSession, invitePlatformStaff), UNIQUE NULLS NOT DISTINCT
// (tenant_id, actor_id, key) and __platform policies (03-IC §12).
// Runtime hooks (CR-C1-008): GET /health/live on LIMS_CORE_METRICS_PORT (API + worker); outbound HTTP honours LIMS_CORE_EGRESS_PROXY_URL;
// SIGTERM: worker drains up to LIMS_CORE_SHUTDOWN_GRACE_S (default 55); API stops accepting, drains, exits.
// Health exception: /v1/core/health/{live,ready} (CR-C0-006).
```
Note (found during arbitration): C0 05-SCHEMA `core.collection_centres.centre_kind` uses `own` and codes `^[A-Za-z0-9-]{1,16}$`; C2 TRD §5.5 uses `owned` and `{1,20}`. **Final: `own` and `{1,16}`** (DDL wins; C2's tighter text limits for address ≤ 300 and phone ≤ 30 are fine inside the DDL limits). C2 TRD/OpenAPI aligned in the apply plan.

### 13.6 Shared libraries and storage API (C0-0A / C0-0D) — 08 §4.13

```ts
// @lims/shared-ts/formula  (C0-0A; grammar text C3 TRD §7.1 + log10 — R12a)
export type FormulaAst = { readonly __brand: 'FormulaAst' };
export type FormulaContextVar = '@age_days' | '@age_years' | '@is_female' | '@is_male';
export interface FormulaParseError { readonly offset: number; readonly code: 'syntax' | 'too_long' | 'too_deep' | 'too_many_refs' | 'unknown_function'; readonly message: string }
export function parseFormula(text: string): { readonly ast?: FormulaAst; readonly refs: readonly Code[]; readonly contextVars: readonly FormulaContextVar[]; readonly errors: readonly FormulaParseError[] };
export function formulaRefs(ast: FormulaAst): readonly Code[];
export function evaluateFormula(ast: FormulaAst, inputs: Readonly<Record<Code, DecimalString | undefined>>,
  ctx: { readonly ageDays?: number; readonly ageYears?: number; readonly sex: Sex }):
  { readonly ok: true; readonly value: DecimalString; readonly inexact: boolean } | { readonly ok: false; readonly reason: string }; // reasons: missing_input:<CODE> | division_by_zero | domain_error | <invalid() code>
// @lims/shared-ts/decimal — exact decimal, ≥ 28 significant digits, half-up rounding; implementation pinned by C0-0A.
// @lims/shared-ts/spreadsheet (C0-0A; R12e as amended by 08 A13 P-9) — the one CSV/XLSX injection guard; writer write-excel-file 4.1.1; module-local copies banned
export function neutraliseFormula(cell: string): string;   // prefixes "'" when cell starts with = + - @ \t \r or "'"
export function restoreNeutralised(cell: string): string;  // strips exactly one leading "'"; restoreNeutralised(neutraliseFormula(s)) === s for all s

// services/{api,worker}/src/core/uploads + core/storage  (C0-0D; R12b)
export type UploadMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'text/csv'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type BucketName = 'reports' | 'reporting-inputs' | 'reporting-prints' | 'identity-assets' | 'identity-exports'
  | 'frontdesk-trf' | 'billing-exports' | 'instruments-attachments' | 'micro-imports' | 'anatomic-images'
  | 'partners-slips';                                  // 08 A26.3 (§13.4 / 08 §4.8 bucket of C13)
export interface UploadAcceptOptions {
  readonly allow: readonly UploadMime[];              // ⊆ the operation's declared x-upload allowlist
  readonly maxBytes: number;                          // ≤ 15 MB file (02-CV §10.2)
  readonly bucket: BucketName; readonly objectPath: string;   // first segment must equal ctx.tenantId; bucket prefix must match the module
  readonly images?: { readonly reencode: true; readonly stripMetadata: true; readonly maxMegapixels?: number /* default 40 */ };
  readonly scan: 'required' | 'not_applicable';       // not_applicable only for text/csv (UTF-8, no NUL)
}
export interface AcceptedUpload {
  readonly objectId: Uuidv7; readonly bucket: BucketName; readonly objectPath: string; readonly sha256: string; readonly byteSize: number;
  readonly mime: UploadMime; readonly image?: { readonly width: number; readonly height: number };
  readonly scanState: 'pending' | 'clean' | 'infected' | 'unavailable';   // pending/unavailable/infected ⇒ stays in quarantine (fail closed)
}
ctx.uploads.accept(file: IncomingFile, opts: UploadAcceptOptions): Promise<AcceptedUpload>;   // magic bytes + extension; xlsx = ZIP magic + .xlsx (C3 adds its ZIP inspection)
ctx.files.scan(bytes: Uint8Array): Promise<'clean' | 'infected' | 'unavailable'>;              // ClamAV-class service (C1); mandatory in staging/prod
ctx.storage.put(bucket: BucketName, objectPath: string, bytes: Uint8Array, opts: { contentType: string; ifAbsent?: boolean }): Promise<{ sha256: string; byteSize: number }>;
ctx.storage.read(bucket: BucketName, objectPath: string): Promise<Uint8Array>;
ctx.storage.move(bucket: BucketName, fromPath: string, toPath: string): Promise<void>;
ctx.storage.signedUrl(bucket: BucketName, objectPath: string, ttlSeconds: number /* ≤ 300 */): Promise<string>;   // internal only; never logged or sent to browsers
ctx.storage.delete(bucket: BucketName, objectPath: string): Promise<void>;
// delete (08 A13 P-12): owner bucket only. Allowed for (a) E-class objects (prints, expired exports, quarantine rejects); (b) objects whose
// retention period has elapsed, deleted by the owning module's purge task; (c) a patient's objects deleted by that module's anonymisation
// handler once retention has elapsed. Each delete increments lims_core_storage_deletes_total{bucket,reason} [CONV].
// read (08 A13 P-13): another module's bucket only for a (bucket, objectPath) pair received in the same flow (port output, event payload,
// published view); paths are never constructed; writes stay owner-only (R26). signedUrl (08 A13 P-2): never in a response, header or log.
// HTTP: multipart parser with per-route cap; streaming download helper (Content-Disposition: attachment, nosniff, no-store) (CR-C3-005);
// inline variant only for objects accepted with images.reencode: true and stored mime image/png|image/jpeg (CSP default-src 'none'; sandbox) — 08 A17 D-67, 02-CV §10.2 (I1).
```
