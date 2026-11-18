Title: CR-C0-0D-OFFLINE2-1: a discard operation in the closed sync op catalogue (core.yaml SyncOperation)
From chunk: C0-0D (T0D-OFFLINE-2)            To owner: C0-0C (contracts) + C0-0B (sync service)
Type: api
Blocking? no. The web client queues the discard today as op_type `sync.discard`; until the server knows it, pushSyncBatch rejects it and the item reappears under Needs attention (sync.op_type_not_available or the validation code). T0D-OFFLINE-2 done_when 2 ("Discard ... is sent as an audited discard operation at the next sync") is only fully met once this lands.
Problem: the operator must be able to give up an operation the server refused (Needs attention) with a typed reason, and that decision must be audited on the server. SyncOperation (core.yaml, discriminator op_type) is closed and has no discard type.
Proposed change (exact): add to the SyncOperation discriminator mapping
  sync.discard: '#/components/schemas/SyncOpDiscard'
  SyncOpDiscard: { type: object, additionalProperties: false, required: [op_id, op_type, payload, device_created_at],
    properties: { op_id: Uuid, op_type: { type: string, maxLength: 40, enum: [sync.discard] }, device_created_at: IsoDateTime,
      payload: { type: object, additionalProperties: false, required: [discarded_op_id, original_op_type, reason],
        properties: { discarded_op_id: Uuid, original_op_type: { type: string, maxLength: 40 }, reason: { type: string, minLength: 1, maxLength: 1000 } } } } }
  Server: accept = write one audit entry (actor, device, discarded_op_id, original_op_type, reason); no domain change; idempotent on op_id.
  The name `sync.discard` is the writer's choice (the brief names none): rename freely, the web constant is DISCARD_OP_TYPE in apps/web/src/core/offline/controller.ts.
Backward compatible? yes (additive enum member).
Tenant/security impact: no RLS change; the payload carries no personal data (no copy of the discarded payload, by design and by test); permission sync.use like every batch.
IRD/regulatory impact: none (a discarded billing operation never reached the server, so no number was consumed).
Alternatives considered: deleting the item locally without telling the server (no audit trail: refused); a separate REST call (would not work offline).
Tests that will prove it: offline2.controller.test.ts (discard payload shape, no personal data, sent once in the next batch) plus a server test that the batch accepts sync.discard and audits it.
