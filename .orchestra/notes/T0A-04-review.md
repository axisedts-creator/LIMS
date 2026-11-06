CHANGES

1. `packages/shared-dart/test/uuidv7_test.dart:1` / `packages/shared-dart/lib/src/uuidv7.dart:1` — the Dart suite has still never run. The done_when "both pass vectors, ordering, seeding" and AC-0A-2.3 (01-PRD.md:99) are unproven on the Dart side. `.orchestra/notes/T0A-04-impl.md` says "Dart: STILL NOT RUN". This reviewer session was blocked as well (`dart --version` requires approval). Fix (human or an approved writer/debugger session): run `cd packages/shared-dart && dart pub get && dart test`, fix any failures, record the real pass count in `T0A-04-impl.md`, and commit the root `pubspec.lock` if pub creates one (`resolution: workspace`). No code defect was found in a static read. Approve once there is a recorded green run.

Checked OK (round 2):
- Previous item 1 is fixed. The test now lives at `packages/shared-ts/test/uuidv7.test.mjs`, the root `tests/uuidv7/` copy is gone, and `package.json:10` `verify` now runs `packages/shared-ts/test/*.test.mjs`.
- `node --test "packages/shared-ts/test/*.test.mjs"` gives 13/13 pass.
- `tools/lint/check-paths.ts --branch c00-0a/uuidv7` over the 7 product files reports no ownership errors. Its only output is the PR-body `Refs: CR-…` line, which is a PR-time requirement and not a code defect.
- The ruling (TESTS_WRONG at the old line 47) is honoured: the implementation was not bent to fit the test.
- TS and Dart agree on layout, on the counter/overflow logic, on xoshiro128** with splitmix32 using 32-bit masking, and on the CSPRNG source (REQ-SEC-028). The IC §2.1 regex is copied verbatim.
- Not in scope for this task: PHI, secrets, DB/RLS, routes, permissions, error codes.
