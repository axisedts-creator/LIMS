CHANGES

Scope reviewed: `git diff e98ca0ace..HEAD` (4d4c55e44 tester, 6a53524f0 writer). 55 test files + quality-t22.harness, plus 2 notes files. No product file, no money/order code, no SQL, RLS, routes, permissions, error codes, PHI or secrets touched. All paths are under the four owned `__tests__` dirs.

Code verdict: the edits are correct and change types only.
- `onUnhandledRequest` -> `onUnhandledFrame`: confirmed as the option name in msw 3.0.3 typings (node_modules/msw/lib/_chunks/handlers-controller.d.ts). No `onUnhandledRequest` is left in the four dirs.
- `as never` -> `as unknown as ComponentProps<...>` (rs-c7.behaviour, web-t03.components), json() result casts (web-t04/t06, t23.transfers, t16.receive), `as object` on the conditional spread (web-t04), `!` / `as const` / `lots: [] as Record<string, unknown>[]` (quality-t22, uiconsole1), and the page-arg cast (t23.counts, t24.unresolved) are all compile-time only. None of them changes a runtime value.
- No @ts-ignore, @ts-expect-error or skipLibCheck added. One `m: any` was removed (web-t04 bulk-upsert handler).
- vg7 config: 7/7 pass (re-run by reviewer, 2026-11-19).

I re-ran the 18 feature configs: 14 fully green, quality-t21 green with 1 skipped, and 3 configs with 4 failing tests between them: rs-c7 2 (rs-c7.static permission literals, rs-c7.screens messages snapshot), web-t03 1 ('renders one link card'), t20 1 (t20.alerts 'API 500 -> page throws'). These failures are not caused by this diff. rs-c7.static.test.ts is not touched, the other three files only got the msw rename or a type cast, and product components last changed before the baseline (b530b36ff). The tester note shows the same tests red with the old msw key. They are still unresolved done_when items:

1. `.orchestra/notes/VERIFY-GREEN-7-impl.md:8`: done_when requires "The notes record the error count per package before and after (`turbo run typecheck --continue`)". The note says this was not run; only the apps/web count was measured (78 -> 0). Fix: writer runs `turbo run typecheck --continue` and records before (at e98ca0ace) and after (at HEAD) error counts per package in `.orchestra/notes/VERIFY-GREEN-7.md`. Notes only, no code change.

2. `.orchestra/notes/VERIFY-GREEN-7-tests.md:5`: 4 existing tests are red (rs-c7.static permission literals, rs-c7.screens messages snapshot, web-t03.components 'renders one link card', t20.alerts 'API 500 -> page throws'). The note says "needs lead ruling", but `.orchestra/cr/` has no VERIFY-GREEN-7 CR. Fix: write `.orchestra/cr/VERIFY-GREEN-7.md` (nonblocking, CR template in spec/program/04-CHANGE-REQUESTS.md) listing the 4 tests with file and the product/contract drift question for each, so the lead can rule. Do not edit those tests or the snapshot inside this task.
