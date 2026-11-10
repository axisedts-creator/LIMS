# API-T12 impl (writer)
Files: `service/messages.service.ts`, `repo/messages.repo.ts` (read-only SQL), `handlers/messages.handlers.ts`, `handlers/index.ts` (+messagesHandlers).
Result: 173/174 pass after arbiter ruling (TESTS_WRONG on :173; test revised, no impl change needed). Only fail: boot.test "boots and mounts" 30s timeout (34s; known T01 slow-boot flake, unrelated). tsc: no errors in messages files.
[CONV] E33/E42 range = `received_at >= from AND < to`, span <= 31 d; paging reuses agents.repo offset cursor (`paging`/`paged`).
[CONV] records_expired = received_at older than 90 d; E36 order: 404 -> assertRole(message centre) -> raw read -> access_log (ctx.audit.access, same tx) -> return; no audit sink = common.internal.
[CONV] raw_text_escaped: utf-8 decode, C0 -> U+2400 pictures, DEL -> U+2421, C1 -> `\xNN`; E36 handler adds `cache-control: no-store`.
[CONV] preview records: emit_status `not_applicable`, no event_id, no mapping_status, fresh uuidv7 ids (not persisted); unparseable/throwing driver -> records [].
Open: real SQL/RLS untested here (db tests); latest_run LATERAL + core.users display_name join unverified against a live DB.
