APPROVE

# API-T02 review (diff a374287..HEAD)

Checked against 03-APP-FLOW §2.1–§2.5, 02-TRD §5.2.4, §5.4, §5.8, §5.9, §6.5, PRD AC-04.5, AC-13.2–13.5, contracts/errors.yaml.

- State machines: agent A1–A6, instrument I1–I6, credential §2.3, command §2.5 match spec and the DB transition triggers (migration 20261105002000 §4). Error codes `instruments.invalid_transition` / `instruments.agent_has_active_instruments` are verbatim (errors.yaml:159–160).
- Health evaluator matches the §2.4 pseudo-code: offline when heartbeat is > 180 s old, backlog/degraded/online precedence, [from, to) in tenant timezone, coalesce(last_message_at, live_at). No transition when the state is unchanged, and none for a never-heartbeated agent.
- Keys match the §6.5 formulas. `result_key_sha256` is SHA-256 hex. Decimal regex is verbatim from 03-IC §2.1.
- Transport, file_drop and protocol_options schemas match the §5.8 and §5.2.4 ranges and enums. Validation errors return path + keyword only, never values (no PHI). No secrets. No new dependency (ajv loaded the same way as core/events/publish.ts).
- Only owned paths are touched: `domain/*`, unit tests, notes.
- Checks run by the reviewer: `vitest run src/modules/instruments/__tests__/unit/` gave 5 files, 281/281 pass. `tsc --noEmit` reported no errors in the new files.
- RLS, permissions, idempotency and rate tier are not applicable: these are pure domain modules with no DB or routes.

Non-blocking follow-ups (not defects of this task):
1. `command.state.ts:10`: `delivered --deliver--> delivered` is allowed in the code but has no test (the test file excludes it on purpose). Add a one-line test when API-T04 or the heartbeat work lands.
2. `transportSchemas.ts:915-916`: `filename_pattern` / `barcode_regex` are not checked for Go RE2 validity on the server (only length and named group). Revisit in API-T05, or raise a CR if a server-side RE2 check is required.
3. `transportSchemas.ts`: `ack_message_type_format` (§5.4 profile option) is not in the hl7v2 options schema. Confirm whether it belongs in `protocol_options` or in the driver profile.
