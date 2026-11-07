## BL-T01 debug 2026-11-07
Cause: core request-validator ajv (services/api/src/core/openapi.ts:80-88, strict mode) registers no `x-coded-set` keyword; billing.yaml body schemas carry it (02-CONVENTIONS:573, TRD:341). Boot throws "unknown keyword: x-coded-set". Test fixture (JWT config) already fixed per ruling; not a test fault, no dispute.
Fix: none in billing code. Needed change is in C0-0D-owned openapi.ts (register `x-coded-set`/`x-extensible` as annotation keywords on the ajv option sets). Editing it violates CLAUDE.md ownership rule.
Status: BLOCKED on CR .orchestra/cr/BL-T01.md (no resolved-* file yet; openapi.ts unchanged on main since e6f622c). Re-run boot test once CR lands.
