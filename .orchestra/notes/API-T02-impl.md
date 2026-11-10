# API-T02 impl
- Files: `services/api/src/modules/instruments/domain/{agent,instrument,credential,command}.state.ts, health.ts, keys.ts, decimal.ts, instrumentTime.ts, transportSchemas.ts`. Tests: 5 files / 281 pass (vitest 5.1.0); `tsc` no errors in new files (pre-existing TS5097 in packages/shared-ts/src/bsdate).
- State machines: table-driven, throw `LimsError('instruments.invalid_transition')`; A6 guard throws `instruments.agent_has_active_instruments` (03-APP-FLOW §2.1). Command `delivered --deliver--> delivered` allowed (re-send, §2.5).
- [CONV] ajv loaded via `@fastify/ajv-compiler` (same trick as core/events/publish.ts; no new dep). Errors = `path keyword` only, never values.
- [CONV] health active hours: from > to wraps midnight; from == to = empty window. Unset from/to = all day.
- [CONV] decimal: `trim()` before matching DecimalString. localToUtc: two-pass offset; DST gap/overlap unspecified (ponytail note in code).
- Open: `filename_pattern`/`barcode_regex` not compiled as RE2 server-side (only length + named-group check); `protocol_options.astm.encoding` enum = ['latin1'] only (only value §5.2.4 names); `ack_message_type_format` (§5.4 profile option) not in schema.
