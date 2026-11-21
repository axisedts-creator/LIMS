APPROVE

SEC-ERR-1 review (diff 5ad7066c..HEAD, LD-236, audit 5.6).

- errors.ts:63 drops `detail` from every Problem built by toProblem when status >= 500. contracts/openapi/_common.yaml Problem lists `detail` as optional (required = type, title, status, code, request_id), so leaving it out is the option LD-236 chose. code, status, title, type, instance and request_id are unchanged. 4xx is unchanged, and errors[] still follows ERRORS_CODES.
- errors.ts:149-152: the request_failed log line now carries LimsError.detail, clamped to 2000 characters. It goes through the @lims/shared-ts/logger scrubbers (CV §9.2 denylist and value scrubbers). The message and stack are still not logged, so nothing new can leak PHI or SQL.
- Tests (errors-5xx-detail.test.ts): unit and real-bootstrap checks across every 5xx registry code (no detail key, internal text missing from the body, real detail present in the request_failed line), and every 4xx code keeping its detail. This covers done_when and the brief's tests.
- Scope: 4 code files (errors.ts, the new test, fixture module, fixture yaml), all inside services/api/src/core. No spec, contracts, db or migration change. No new names invented, no secrets.
- Ran: vitest errors-5xx-detail + errors + pending-operations: 3 files, 500 passed, 1 skipped. The first run reported 1 failure that did not reproduce on rerun; it looks like a load or timeout flake, not caused by this diff.
- Not a defect, but noted: pendingProblem (errors.ts:126-133, 501 operation_pending) still has a detail. That detail is a fixed template holding the public operationId, LD-325 requires it, and pending-operations.test.ts:149 asserts it. It is not an internal string, so it is outside the audit 5.6 concern. If the lead wants a strict "every 5xx" reading, that needs an LD change to LD-325.
- Not run by reviewer: full `pnpm -s verify`.
