# SEC-ERR-1 impl (writer)
- Changed: services/api/src/core/errors.ts only (toProblem + sendProblem).
- [CONV] Problem.detail is optional in _common.yaml, so detail is OMITTED when registry http >= 500 (not a generic string). LD-236.
- [CONV] request_failed log line gains `detail` (LimsError.detail, clamped 2000); name/code fields unchanged; no message/stack.
- 4xx unchanged; 501 pendingProblem (LD-325) untouched.
- Ran: vitest errors-5xx-detail.test.ts + errors.test.ts -> 2 files, 432 tests pass.
- Open: full `pnpm -s verify` not run in this note; log scrubber (T0D-10) is trusted to redact secrets in `detail`.
