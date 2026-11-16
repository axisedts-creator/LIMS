# T0B-OPSDOC-1 dispute (writer)

**Test:** `services/api/src/core/__tests__/health-env.test.ts`, helper `docRows()` (line ~29).

**Defect:** each cell is cleaned with `x.replace(/[`*_]/g, '')`, which also deletes the underscores inside the name, so
`LIMS_CORE_ENV` becomes `LIMSCOREENV` and never matches the next check `/^LIMS_[A-Z0-9_]*[A-Z0-9]$/`. `docRows()` therefore
returns `[]` for ANY document; `requiredNames()` is empty, and 7 of 10 tests fail whatever the implementation does
(`expect(req.length).toBeGreaterThan(0)`, `ok` with an empty env, etc.). No document format can satisfy it (a name
always contains `_`). Proof: `node -e "console.log('LIMS_CORE_ENV'.replace(/[\`*_]/g,''))"` prints `LIMSCOREENV`.

**Fix proposed (tester):** strip backticks and asterisks only: `x.replace(/[`*]/g, '')` (env-doc.test.ts already does
the name match on the raw cell, so it is unaffected).

**Evidence the implementation is right:** a temporary copy of the file with only that one change ran 10/10 green
(together with env-doc, health, health-checks and observability: 6 files, 93 tests passed); the copy was deleted.

**Second note (not a defect, shaped the doc):** the "names only" test unsets `req[0]` but then sets
`LIMS_CORE_DATABASE_URL` itself, so that name cannot be the first required name. The doc marks it `optional` with the
reason (readiness already reports it as checks.db down). If the lead wants it `required`, that test needs another name.
