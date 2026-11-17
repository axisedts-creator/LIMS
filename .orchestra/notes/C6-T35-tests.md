# C6-T35 tests (tester)
File: tests/docs/C6-T35.manual.test.mjs (node:test, no deps). Run: `.orchestra\notes\C6-T35-verify.cmd` (= `node --test tests/docs/C6-T35.manual.test.mjs` from repo root).
Checks: docs/manual/reporting has README.md (links all pages), one <slug>.md per staff screen (worklist, report, narrative, outsourced, deliveries, delivery, templates, template, messages, settings; discovered from help/ files + helpKeys), portal.md, runbooks.md (7 scenarios of 04-UI-UX §6); hygiene (synthetic, no TODO, no URLs).
ASSUMED (dispute if wrong): page names = help slug names; each screen page has Purpose, Fields and a Steps/How to/Tasks/Common heading and names its route + routes.yaml permission; portal.md and runbooks.md names from 04-UI-UX §4/§6.
Red now: docs/manual/reporting does not exist.
Not covered: prose quality, screenshots (none required by spec), accuracy vs. the UI (doc review is human).
