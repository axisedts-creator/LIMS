# T0-03 dispute — task requires editing read-only `spec/`

Blocker (not a test defect alone; task brief vs project rules):
- Plan row T0-03 (06-IMPLEMENTATION-PLAN.md:39) and 02-TRD.md §2.2 header say "fill `02-TRD.md` §2.3" at T0-03.
- Root CLAUDE.md: "Never edit `spec/`"; 01-CHUNK-MAP §3 gives C0-0A root package.json/pubspec/lockfiles, not `spec/chunks/**`.
- tests/monorepo/T0-03.pins.test.mjs:14 reads the table from `spec/chunks/C0-foundation-contracts/02-TRD.md` §2.3
  (tests at lines 158/167/175/199/207/239 depend on it). Writer cannot make them pass without editing spec/.
- Tester flagged same conflict (T0-03-tests.md line 5).

Ruling needed (planner/arbiter), one of:
1. Authorise writer to edit `spec/chunks/C0-foundation-contracts/02-TRD.md` §2.3 only (explicit exception), or
2. Move the table to an owned path (e.g. `db/meta/decisions/T0-03-deps.md` or root `DEPENDENCIES.md`) and retarget test line 14.
CR filed: `.orchestra/cr/T0-03.md`. No code changed. Stopped per writer rules.
Non-spec work ready once unblocked: exact Dart/Flutter sdk in root pubspec.yaml, commit pubspec.lock, add vitest/ajv/yaml to
pnpm-lock importers. Note local node is v25.8.0 vs .nvmrc 26.13.0 (installed-tree checks may need node 26).
