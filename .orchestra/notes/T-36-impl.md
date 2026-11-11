# C3 T-36 impl (writer)
- Added `handlers/exports.handlers.ts` (#104–#107, wraps `exports.service.ts` like `imports.handlers.ts`); `handlers/index.ts` spreads it and drops the unused `notImplemented` stub.
- #106 headers: `content-disposition: attachment`, `cache-control: no-store`, `x-content-type-options: nosniff` (S-10). [CONV] stored file name has quotes/backslashes/control chars replaced with `_` before it enters the header.
- `__tests__/probes/pending.json` emptied to `[]` (LD-70, writer's edit).
- Created `ops/alerts.yaml`: 6 rules verbatim from 02-TRD §13, Prometheus `groups[].rules[]`, `labels.severity|route`, `annotations.summary` (no label interpolation). [CONV] summary wording is mine; the spec gives none.
- Ran probes + ci dirs: 6 files / 191 tests green; `exports.service.test.ts` 50 green. `tsc --noEmit` has pre-existing errors in contracts/ and shared-ts (none in the new files).
- Open: not verified through the real HTTP pipeline, promtool, or lint; `pr.yml` wiring is C0-0A's.
