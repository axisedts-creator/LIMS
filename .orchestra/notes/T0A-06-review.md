CHANGES

Range bf6a347..HEAD only adds `.orchestra/notes/T0A-06-verify.cmd`; reviewed T0A-06 owned paths as they stand at HEAD (impl from 182e1bd/9faf083).

1. packages/test-fixtures/bsdate/review.json:1 — all 107 entries still `"status": "unresolved"`, none carry `verify_before_golive: true`. done_when ("zero unresolved entries") and LD-08 not met. Fix: per LD-08, resolve each entry to the `@remotemerge/nepali-date-converter@1.2.7` value (the source package recorded in db/meta/decisions/T0-03-dependencies.md:44): set `status: "resolved"`, `resolved_by: "LD-08"`, `resolution` = that package's `{days, ad_first_day}`, `verify_before_golive: true`.
2. packages/test-fixtures/bsdate/golden-2000-2099.json — file missing (not in git ls-files). done_when "golden committed" not met; `node --test packages/shared-ts/test/bsdate.test.mjs` fails ENOENT on it (golden, range, fiscal-year tests all fail). Fix: after item 1, re-run `node packages/test-fixtures/bsdate/generate.mjs`, commit the generated golden; keep the `verify_before_golive` flag through to golden rows for those 107 months (generate.mjs:76 must preserve the field when copying resolved entries — it does via `...old`, confirm in output).
3. packages/test-fixtures/bsdate/generate.mjs:76 — cite LD-08 in a code comment where resolved entries are kept (lead decision requires citation in code comments).
4. After items 1–2, both verify sides must pass: `node --test packages/shared-ts/test/bsdate.test.mjs` and `dart test test/bsdate_golden_test.dart` (Dart side not yet runnable without the golden).

Checked OK: deps recorded with name/version/licence (T0-03-dependencies.md:44-46,55); verify.cmd scoped to this task's tests only (LD-07); edits confined to owned paths; no secrets/PHI.
