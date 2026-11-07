Title: FD-T01: core ajv must accept the `x-coded-set` schema annotation so specs using it can mount
From chunk: C4-frontdesk-billing            To owner: C0-0D (services/api/src/core/openapi.ts)
Type: shared-lib
Blocking? yes — FD-T01 done_when "Core boots with module". 3 boot tests in services/api/src/modules/frontdesk/__tests__/unit/boot.test.ts fail; 27/30 vitest + 9/9 node:test pass.
Problem: 02-CONVENTIONS.md:573 requires coded-set fields as `type: string` + `x-coded-set: <name>`. contracts/openapi/frontdesk.yaml uses it (e.g. lines 3764, 3874, 4085). core/openapi.ts builds ajv via @fastify/ajv-compiler (AJV_OPTIONS / BODY_AJV_OPTIONS / RESPONSE_AJV_OPTIONS) with ajv strict mode on and no such keyword, so mounting throws `Error: strict mode: unknown keyword: "x-coded-set"` at boot. Same will hit billing, analytics, catalog, instruments, lab, reporting (all use x-coded-set). core/events/publish.ts already solves the same thing for `x-extensible` via addKeyword.
Proposed change (exact): in core/openapi.ts add `keywords: ['x-coded-set']` to AJV_OPTIONS (inherited by BODY_AJV_OPTIONS and RESPONSE_AJV_OPTIONS). Annotation only, no validation semantics; strict mode stays on for every other unknown keyword.
Backward compatible? yes — only makes currently-rejected specs mountable.
Tenant/security impact: none. removeAdditional:false, strict query (O2) and response validation (O4) unchanged; no new accepted input (keyword has no validator).
IRD/regulatory impact: n/a
Alternatives considered: strip `x-coded-set` in the frontdesk module before mount (rejected: module receives the spec from core bootstrap, and every module would duplicate it); strict:false (rejected: hides real schema typos).
Tests that will prove it: `.orchestra\notes\FD-T01-verify.cmd` 30/30 + 9/9; core test mounting a spec with an `x-coded-set` field boots and still rejects an unknown non-annotation keyword.
