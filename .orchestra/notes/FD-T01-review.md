CHANGES

Reviewed `git diff c8d0b9c..HEAD` against C4 02-TRD §3.1/§3.3/§7/§11.1, 06 row FD-T01. Ran `.orchestra/notes/FD-T01-verify.cmd` parts: vitest 27/30 (3 failed), node:test 9/9.
Names (module name, openapi path, 3 produced events, 10 permission codes, 4 config defaults, 29 operationIds) match spec verbatim; stubs throw `common.service_unavailable` without echoing request data; no secrets/PHI; all paths C4-owned; nav entries empty (hidden). No DB/RLS in this task.

1. done_when "Core boots with module" not met. `services/api/src/modules/frontdesk/__tests__/unit/boot.test.ts:87,94,109` fail with `Error: strict mode: unknown keyword: "x-coded-set"` from core ajv (`services/api/src/core/openapi.ts`, owner C0-0D). Fix is outside C4: C0 must apply `.orchestra/cr/FD-T01.md` (add `keywords: ['x-coded-set']` to AJV_OPTIONS). Do not work around it in C4 and do not weaken the tests; re-run verify.cmd after the C0 change lands and expect 30/30 + 9/9.
2. `.orchestra/cr/FD-T01.md:1` titles the CR `CR-C4-001`, but that id is already taken (spec/program/08-CR-REGISTER.md:438, BillingCommandPort). Fix: drop the invented id and title it "FD-T01: core ajv must accept the `x-coded-set` schema annotation", so the register owner assigns the next free CR-C4-NNN.
