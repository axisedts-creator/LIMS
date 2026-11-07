# API-T14 impl
- Files: `services/worker/src/jobs/instruments/{index,shared,health,configs,maintenance}.ts`, `alerts/instruments.rules.yml`. Reuses API-T02 `domain/health.ts` (evaluateHealth).
- Checks: verify cmd 8 files / 124 tests pass; whole worker suite 19 files / 262 pass; tsc (esnext/bundler, the 5 new files) clean. No eslint in repo. First cold run once hit vitest's 5 s timeout in manifest.test `setup()` (cold transform); warm runs all pass.
- [CONV] evaluator publishes first, then inserts transition + updates agent_status (guard `health_version = old`, `FOR UPDATE OF s`); duplicate publish skips the writes. clock_offset_seconds = round(ms/1000); event silent ids capped at 50 (schema maxItems), DB keeps all.
- [CONV] release configs: canonical JSON escapes control chars as lowercase `\u00xx`; agents.version bumped with latest_config_version (CV §5 "every UPDATE"); key read only when a version must be written.
- [CONV] purge: a failed Storage delete leaves the row unmarked and the run continues (DEFINER deletes only `#deleted` rows), warn log with count only; bucket fixed to `instruments-attachments`.
- [CONV] consumer: known entity types read from contracts/events/catalog.changed.v1.schema.json at load.
- Open: CR `.orchestra/cr/API-T14.md` (JobContext lacks `ports`/`metrics`). Not done: stale-gauge removal for retired agents, scan_attachment (not T14), DB-level purge/RLS run (no Postgres here), Go/TS canonical golden vector.
