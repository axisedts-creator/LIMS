CHANGES

Scope: e8a5bb8..HEAD (LD-01 patient exception, LD-03 exports + LimsError). Impl is correct: gen-permissions.ts exempts only patient+`engagement.booking.cancel` (LD-01 cited); contracts/package.json exports both LD-03 subpaths to existing files; common.ts LimsError has no parameter properties (LD-03 cited); new codegen tests cover both. Reviewer re-ran: tools/codegen `vitest run` 176 pass / 3 skipped; contracts `vitest run` 248/250 — 2 FAIL. Dispute (T0C-05-dispute.md) is right: LD-03 overrides the IC §4 text, so the T0C-02 tests are wrong, but the branch suite is red and must be fixed before approve (tester role, contracts/__tests__/ is C0-owned).

1. contracts/__tests__/ports.test.ts:112-116 — `common.ts equals IC §4 block > code ... is verbatim the IC block` fails because the IC block has the parameter-property LimsError. Fix: for name === "common", before comparing, replace in `want` the IC LimsError class with the LD-03 form, e.g.
   `want = want.replace(/export class LimsError extends Error \{[\s\S]*?\n\}/, LD03_LIMSERROR)` where LD03_LIMSERROR is the exact class now in contracts/ports/common.ts (fields `readonly code: ErrorCode; readonly safeDetail?: string; readonly fieldErrors?: readonly FieldError[];`, constructor `(code: ErrorCode, safeDetail?: string, fieldErrors?: readonly FieldError[])` assigning each). Add a comment citing LD-03. Assert the replace actually matched (want changed) so the test cannot go vacuous.
2. contracts/__tests__/ports.test.ts:129 — spot check expects `constructor(readonly code: ErrorCode, ...)`. Fix (cite LD-03): replace with
   `expect(c).toContain(norm("readonly code: ErrorCode; readonly safeDetail?: string; readonly fieldErrors?: readonly FieldError[];"));`
   `expect(c).toContain(norm("constructor(code: ErrorCode, safeDetail?: string, fieldErrors?: readonly FieldError[])"));`
   `expect(c).not.toMatch(/constructor\(readonly/);`
   and rename the `it` to "...LimsError has the 3-arg constructor (LD-03 explicit fields)".
