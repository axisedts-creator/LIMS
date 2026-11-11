AG-T12 impl: apps/bridge-agent/internal/heartbeat/{types,client,service}.go (no test files touched).
[CONV] once-per-command_id: record `started` persisted before any side effect; re-delivery of a known id is never re-run, result is un-acked and re-reported; `started` on re-delivery = failed `interrupted`; restart_service persisted `completed` before RestartService.
[CONV] result_code: only a sanitized `Code()` ([a-z0-9._-], <=64) or fixed per-kind code (refresh_failed, restart_failed, upload_logs_failed, log_read_failed, reupload_failed, bad_params, unknown_kind, interrupted); error text never reported.
[CONV] upload_logs: window now-24h..now; Redact then cut to 1000 bytes, newest <=20000 lines, body <4 MiB; empty window sends one marker line (E07 needs >=1).
[CONV] reupload_since: since clamped to now-72h; missing/garbage/future = failed `bad_params`. Expired or unparseable expires_at = not run, not recorded.
[CONV] E07 sends Idempotency-Key = command_id (required, review #1); empty command_id = error, no send. E03 sends none.
[CONV] Client = same TLS rules as uploader.Client (duplicated: its http field is unexported and uploader/ is not owned).
Open: (1) Actions.RequeueUploadedSince needs a queue method (AG-T04) - CR if absent. (2) No SQLite CommandStore yet (AG-T04/T15 or CR). (3) `started` records never re-delivered stay unreported. (4) refresh via latest_config_version = AG-T15 wiring.
