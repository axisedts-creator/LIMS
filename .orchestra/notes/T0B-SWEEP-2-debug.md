# T0B-SWEEP-2 debugger
Cause: 1 failing test (<=10% SHALLOW; 508 vs 61). Root cause is core `openapi.ts:99-107` custom buildValidator skipping fastify header-schema lowercasing -> required If-Match/Idempotency-Key/X-Lims-* always 400. Not in owned sweep code.
Fix: none in implementation (core is C0-0D's; harness workaround would mask a BUG). No test edited.
Wrote `T0B-SWEEP-2-dispute.md`; CR `.orchestra/cr/T0B-SWEEP-2.md` already carries the exact change. Other 86 tests pass.
