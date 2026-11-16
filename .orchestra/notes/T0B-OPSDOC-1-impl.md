# T0B-OPSDOC-1 impl (writer) — LD-288 applied; unblocked
- contracts/openapi/core.yaml: Readiness gains optional `missing_env` (array, items pattern ^LIMS_[A-Z0-9_]*[A-Z0-9]$, not required, names-only description citing LD-288). Nothing else in contracts/.
- docs/runbooks/environment.md: new "Clean checkout" section (LD-284: `pnpm --filter "@lims/worker^..." run build --if-present` before worker start / registry-sync). Names and commands only.
- Earlier: core/health.ts REQUIRED_ENV + degraded/missing_env; bootstrap option `env` ([CONV] default = no env check); 173 doc rows, 22 required.
- Regenerated with `pnpm --dir tools/codegen run codegen`: api-client-ts/src/core.ts gains `missing_env?: string[]`. codegen:check was ALREADY failing before this change (identity, quality, server/operations, msw handlers, routes TS/Dart drift from other merged contracts); the regen also rewrote those files and could not be reverted in this session (git restore needs approval). Lead: keep (codegen:check now green) or restore all but core.ts.
- Ran: env-doc + health-env + health = 34/34 pass; codegen:check passes. Not run: full api suite, lint, typecheck.
- Open: LD-288 founder veto option (count instead of names) not applied.
