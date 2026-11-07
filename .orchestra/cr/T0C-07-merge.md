Title: CR-C0-0C-T0C-07-merge: main's versions kept for 2 files both lanes produced; lane C0-0C artefacts now disagree with them
From chunk: C0-0C            To owner: C0-0C (with C0-0A for the vectors file, C0-0B for the seed generator)
Type: shared-lib
Blocking? no
Problem: merging main into lane/C0-0C hit two add/add conflicts with incompatible decisions; main's version was kept per merger rule.
  1. `packages/fakes/contract-tests/formula.vectors.json` — main (T0A-12) uses schema `{ "//", vectors:[{id,expression,inputs,ctx?,expected}] }`, G8 `inputs.ALB: null`, extra X1–X6 (no log10 case). Lane (T0C-07) used `{ source, vectors:[{...,context?,expect}] }`, G8 without ALB, X1 = `log10(A)` inexact (C3 TRD §14 "incl. log10 and inexact cases"). Lost lane intent: the log10/inexact vector and the `source` provenance line. `packages/fakes/__tests__/contract-suites.test.ts` ("formula.vectors.json" describe) still reads `expect`/`context`, asserts inputs are all strings, G8 ALB undefined and a log10 vector — it will now fail against main's file.
  2. `db/seeds/003_audit__g_cs_access_actions.sql` — main writes it via `tools/codegen/gen-access-actions.ts` (display = §13.1 comment text, `SET LOCAL ROLE lims_owner`, T0B-04 equality test). Lane's `tools/codegen/codegen.ts` generateAll() also emits this path (display = code). Two generators own one file; `pnpm codegen` on this lane will overwrite main's seed.
Proposed change (exact): (1) update contract-suites.test.ts to main's schema (`expected`, `ctx`, allow `null` input for G8) and add a `log10` inexact vector to the shared file in agreement with C0-0A so formula.test.mjs still passes; (2) drop `db/seeds/003_audit__g_cs_access_actions.sql` (and access-actions.ts if duplicated) from codegen.ts generateAll() or have it call gen-access-actions.ts output, and adjust codegen.test.ts "access-actions" expectations.
Backward compatible? yes (test/generator alignment only)
Tenant/security impact: none (SYNTHETIC data, no PHI).
Alternatives considered: union file carrying both `expect` and `expected` keys — rejected, duplicate source of truth.
Tests that will prove it: packages/fakes contract-suites.test.ts, packages/shared-ts/test/formula.test.mjs, tools/codegen codegen.test.ts, T0B-04 seed equality test.
