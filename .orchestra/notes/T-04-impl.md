# T-04 impl (writer)
- Added `services/api/src/modules/lab/events/publish.ts`: `createLabEvents`, `approvedSetHash`, `valueSha256Prefix16` (test SEAM).
- Keys verbatim from 02-TRD §7.1; payload passed through as-is, core schema (additionalProperties false) rejects non-IC keys (S-12).
- [CONV] aggregate seq: specimenVersion / resultRowVersion / readinessSeq, as test header states (spec silent).
- [CONV] `ready_for_report` publisher computes `approved_set_hash`; critical value only feeds key hash, never payload.
- Tests: 56/57 pass. 1 fail is a test bug (nested fake transaction) — see T-04-dispute.md. tsc: no errors in lab/events.
