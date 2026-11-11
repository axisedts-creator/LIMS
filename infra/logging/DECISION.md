# Logging decisions (T-17)

Stack: Fluent Bit 5.1.5 on every host -> VictoriaLogs 1.53.0 on `groups['ops'][0]` of the active profile (LD-45). Pins are in `infra/ansible/roles/logging/defaults/main.yml`.

## Ingest endpoint

Fluent Bit's `http` output posts `json_lines` to VictoriaLogs `/insert/jsonline` (VictoriaLogs 1.53.0) over wg0 on port 9428, with `_stream_fields=service,env,host`, `_msg_field=log,MESSAGE,msg,what` and `_time_field=date` (ISO-8601 via `json_date_format iso8601`). The listener is the ops host's own wg IP plus loopback; never 0.0.0.0. `Flush 1`, so a line is searchable well inside 60 s (AC-18.1); the disk buffer is capped at 1 GiB per shipper (TRD s10.1). UNVERIFIED here (no Fluent Bit / VictoriaLogs in this environment): the parameter names above follow the VictoriaLogs Fluent Bit integration docs from memory; `infra/tests/integration/test_t17_live.py` (LIMS_T17_LIVE=1) proves them on the dev VM.

## Compression ratio

Not measured yet. This environment has no Docker daemon or VictoriaLogs, so no number is recorded and none is invented. The measurement is `test_compression_ratio_measured` in `infra/tests/integration/test_t17_live.py`: it ingests 50,000 synthetic nginx-style lines (about 20 MB raw), waits for the flush, and prints `t17 compression ratio: <n>x`. The pass bar is a ratio of at least 2.5 (TRD s14; below that a CR must shorten retention). The figure is recorded here after the first dev-VM run; until then the open item is tracked in `.orchestra/cr/T-17.nonblocking.md`.

## Log-to-metrics

Verdict: UNAVAILABLE (not verified). The `log_to_metrics` filter was not checked against Fluent Bit 5.1.5, so the conf does not use it. Fallback for the log-derived security counters of TRD s11 (`SshLoginOutsideOps`, `SudoByUnknown`, `SecretDecryptUnexpected`): Prometheus alerts on LogsQL `stats` queries against VictoriaLogs through the ops nginx `/victorialogs/` proxy, plus Fluent Bit's own metrics on :2020. The verdict and the fallback are raised in `.orchestra/cr/T-17.nonblocking.md`; if a dev-VM check shows the filter works, flip this verdict to AVAILABLE and add the filter to `fluent-bit.conf.j2` (the static test then requires it).

## Retention

`-retentionPeriod=90d` in `infra/logging/victorialogs/flags.env` (AC-18.1); the only retention flag. `/flags` on the running store shows it (live test).

## Scrubbing

`infra/logging/fluent-bit/scrub.lua` runs on every record before shipping: key denylist (case-insensitive substrings, any depth, 02-CONVENTIONS s9.2), phone / Bearer / JWT value scrubbers, and `?...` cut under URL-ish keys (AC-18.4 defence in depth on top of nginx logging route templates only).
