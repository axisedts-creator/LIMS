CHANGES
Round 2. Reviewed 471ae3a..HEAD (review r1 fixes). `node --test tools/lint/tests/ci-workflows.test.mjs`: 88 tests, 87 pass, 0 fail, 1 skip.
Items 2, 3, 4, 5 from round 1 are fixed and checked: oasdiff MDR with D fails and R100 falls through to the new path; migrations policy-dump diff, upgrade apply, and PR_BODY read via env with the verbatim 02-TRD §4.3 heading "Gate-9 migration checklist"; supabase-pin keyed by repoOf, with 3 tests; c17 emulator-runner and KVM step.

1. `tools/lint/check-deps.ts` (whole file; added for round-1 item 1): this new gate-12/13 script has no test. Round 1 asked for "a tools/lint script ... with a test", and the writer's note says it was "checked by hand". The only new test (`tools/lint/tests/ci-workflows.test.mjs:424-431`) greps pr.yml text. It never runs check-deps.ts. Fix: in `tools/lint/tests/` add fixture-root tests (a temp dir with `node_modules/.pnpm/<name>@<ver>/node_modules/<name>/package.json`, a root `package.json`/`apps/web/package.json`, `pubspec.lock`, triage and audit JSON) that run `node tools/lint/check-deps.ts --triage … --audit … --root <tmp>` and assert these:
   (a) allowed licence, SPDX `(MIT OR GPL-3.0)`, clean audit: exit 0;
   (b) `GPL-3.0` and `MPL-2.0` without a licenceReviews entry: exit 1; MPL-2.0 with `{name, approval}`: exit 0;
   (c) installed `pdf-lib`, `bullmq`, `@powersync/x`, pubspec.lock `sqlcipher_flutter_libs`: each exit 1;
   (d) `bikram-sambat` in `dependencies`: exit 1; in `devDependencies`: exit 0;
   (e) `@supabase/supabase-js` in `apps/web/package.json` dependencies: exit 1; in `services/api`: exit 0;
   (f) critical advisory untriaged, or triaged with a past `until`: exit 1; triaged with a future `until`: exit 0; a high-only advisory: exit 0;
   (g) audit JSON without `advisories`, missing `node_modules/.pnpm`, or an unknown argument: exit 2.

Note (not a defect, lead action): `deps` stays red until the lead/founder records licenceReviews for axe-core (MPL-2.0), caniuse-lite (CC-BY-4.0), @img/sharp-win32-x64 (LGPL-3.0) and argparse (Python-2.0). That is correct per CV §15.2. Python-2.0 is in no §15.2 row and needs a lead decision.
