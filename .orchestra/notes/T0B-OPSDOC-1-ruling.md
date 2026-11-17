TESTS_WRONG — `docRows()` strips `_` from every cell, so no LIMS_* name can ever match; change the cleaner, nothing else.

Reasons:
1. services/api/src/core/__tests__/health-env.test.ts:28 cleans cells with `x.replace(/[`*_]/g, '')`; `LIMS_CORE_ENV` becomes `LIMSCOREENV`, which fails the name check at :29 (`/^LIMS_[A-Z0-9_]*[A-Z0-9]$/`). `docRows()` therefore returns [] for every possible document, so :61, :72, :77, :83, :94, :102 fail whatever the implementation does.
2. Task brief done_when (1) (.orchestra/inbox/T0B-OPSDOC-1-arbiter.md:20) asks for the document to list each LIMS_* name with required/optional. The names contain `_` by definition. No spec line asks for underscores to be stripped, so the test checks something the spec cannot satisfy.
3. Fix: at :28 use `x.replace(/[`*]/g, '')` (strip backticks and asterisks only). Leave every assertion as it is.
4. Second note (LIMS_CORE_DATABASE_URL marked optional): done_when (1) and (3) leave the required/optional choice to the document and impose no rule on it, so this is not a defect. The test at :90 stays valid because req[0] is whichever name sorts first among the required names.
