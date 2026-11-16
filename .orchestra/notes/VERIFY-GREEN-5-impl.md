# VERIFY-GREEN-5 impl (writer, round 2)
- Review item 1: reverted apps/web/tsconfig.json `paths` to `{"@/*": ["./src/*"]}` (C0-0D owned; the fallback hid LD-250 TS2307). No implementation file changed in this task now.
- Wrote nonblocking CR `.orchestra/cr/VERIFY-GREEN-5.md` (to C0-0D/lead, options a/b/c) and listed the 9 errors as file:line in `notes/VERIFY-GREEN-5.md`. [CONV] relative-specifier fix stays blocked by the rs-c6 pins.
- `turbo run typecheck --continue`: 10/11 packages 0 errors; @lims/web 294, of which 9 are non-test (the 9 portal page errors in the CR) and 285 are in test files. Before = after (the tree matches the pre-task state). No money or order code touched: no emitted value, rounding, status or SQL changed.
- `pnpm --filter @lims/web build`: exit 0 (compiled, Next type-check passed, routes emitted).
- Suites: rs-c6 60/60 (CI=true), web-build-2 37/37. vg5 16/17: the gate is RED on purpose, because it never tolerates TS2307 for modules that exist in portal. It turns green after the lead picks a CR option.
- Whole web suite (bare `vitest run`, no `test` script in apps/web): 258/365 files fail. The tree equals the pre-task config, so this is baseline, not caused here; not triaged.
- Open: lead decision on CR (a/b/c).
