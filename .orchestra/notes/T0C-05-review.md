CHANGES

Scope reviewed: e8a5bb8..HEAD (debugger round 1: LD-01 PATIENT_EXCEPTION in tools/codegen/gen-permissions.ts) plus binding LD-03 items for T0C-05.
LD-01 fix is correct and narrow (exempts only actor `patient` + `engagement.booking.cancel`; LD cited in comments). `vitest run __tests__/codegen.test.ts` re-run by reviewer: 22/22 pass (double-run byte equality, CLI --check, real-yaml no violations). Off-chunk outputs (db/seeds/00{1,3}, shared-ts routes, shared-dart .g.dart) are sanctioned by 02-TRD §5.3 hand-off rows. ERROR_META emitted (error-codes.ts:291) per LD-03.

1. contracts/package.json:1-16 — LD-03 requires "exports" for "./ports/common" and "./ports/generated/error-codes"; none present, so T0A-08 (`@lims/contracts` consumer in shared-ts) cannot resolve these subpaths. Fix: add
   "exports": { "./ports/common": "./ports/common.ts", "./ports/generated/error-codes": "./ports/generated/error-codes.ts" }
   and a test asserting both subpaths resolve (e.g. `import("@lims/contracts/ports/common")` via the package self-reference, or read package.json and check the files exist).
2. contracts/ports/common.ts:53 — LimsError uses TS parameter properties (`constructor(readonly code ..., readonly safeDetail?, readonly fieldErrors?)`), which LD-03 forbids (breaks Node type stripping). Fix (cite LD-03 in a comment):
   readonly code: ErrorCode; readonly safeDetail?: string; readonly fieldErrors?: readonly FieldError[];
   constructor(code: ErrorCode, safeDetail?: string, fieldErrors?: readonly FieldError[]) { super(code); this.code = code; this.safeDetail = safeDetail; this.fieldErrors = fieldErrors; }
   Add a test that loads common.ts under `node --experimental-strip-types` (or checks `new LimsError('X').code`) so a regression fails.
