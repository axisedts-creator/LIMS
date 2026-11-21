APPROVE

Scope reviewed: `git diff e98ca0ace..HEAD` (4d4c55e44 tester, 6a53524f0 writer, d72534e1c reviewer, a30abf1ca writer). App changes are limited to test files and the quality-t22.harness helper under features/{instruments,inventory,partners,quality}/**/__tests__. No product file, no money/order code, no SQL, RLS, routes, permissions, error codes, PHI or secrets touched.

- Types and specifiers only: `onUnhandledRequest` -> `onUnhandledFrame` (msw 3.0.3, LD-268); `as never` -> `as unknown as ComponentProps<...>` with LD-424 comment; json()/HttpResponse.json casts; `as object` on the conditional spread; `!`, `as const`, `[] as Record<string, unknown>[]`; page-arg cast in t23.counts/t24.unresolved (the arg is still passed). None of these changes a runtime value.
- Money/order statement: no emitted value, rounding, status or SQL changed (no billing, payments, invoice or order code is in the diff).
- No @ts-ignore, @ts-expect-error, `as any` or skipLibCheck added (one `m: any` removed). grep finds no `onUnhandledRequest` left in the four dirs.
- Prior review item 1 is resolved: per-package turbo counts are in `.orchestra/notes/VERIFY-GREEN-7.md`. AFTER is measured (web 287, in-scope 0, the other 10 packages 0). BEFORE is derived and labelled as derived. That is acceptable because the diff touches only in-scope test files.
- Prior review item 2 is resolved: nonblocking CR `.orchestra/cr/VERIFY-GREEN-7.md` lists the 4 pre-existing red drift tests with a question for each, and those tests were not edited.
- vg7 gate re-run by reviewer 2026-11-19: 7/7 pass.
- Non-defect note: VERIFY-GREEN-7-impl.md says t23.counts calls `mod.default()` with 0 args, but the code keeps the arg behind a cast. Notes wording only, runtime unchanged.
