# T-38 dispute (writer)
Test: `web-t38.docs.test.ts` › "runbook entries: Import stuck / Import quarantined / No price spike" (line 226-237).
Defect: line 229 asserts `expect(t).toMatch(/catalog\.import_\*/)`, but `t = allManual()` is built with `norm()` (line 22), which strips every `*` (`replace(/[`*]/g, '')`). After norm the text can never contain `import_*`, so the assertion is unsatisfiable by any manual content (verified in node: `norm('queue `catalog.import_*`')` → `queue catalog.import_`; regex false for every spelling, escaped or not).
Needed fix (tester): match the normalised text, e.g. `/catalog\.import_/` (or test the raw manual text for this one check). Spec 04-UI-UX §7 names the queue `catalog.import_*`; the guide will write it that way.
Writer action: stopped per rules; no docs written yet. After the fix, writer implements docs/manual/catalog/ (README, integration, 19 screen pages) and help/ (19 pages).
