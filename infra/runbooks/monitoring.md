# Monitoring stack runbook (`monitoring`)

Owner C1. What to do when the monitoring stack itself is down (Grafana, Alertmanager and VictoriaLogs error states link here, 03-APP-FLOW s15). Prometheus, Alertmanager, Grafana and VictoriaLogs run on the ops role host (`prod-1` in profile `lean`, `ops-1` in `full`; LD-45) and are reached only through the ops nginx over wg0. An external uptime check and alert relay at site B still pages if the whole primary host is down (LD-45).

## Prometheus down
**Means:** Prometheus does not answer; dashboards show a datasource error and no alert evaluates.
**Check first:** `systemctl status prometheus` (or `docker ps --filter name=prometheus`); `curl -s http://127.0.0.1:9090/-/ready`.
**Fix:** 1. Restart it and read the log: `docker logs --tail 50 prometheus`. 2. Common causes: full disk (`host.md#diskfillforecast`), corrupt WAL after a crash (Prometheus repairs it on start; wait), invalid rule file after a deploy (`promtool check rules infra/monitoring/rules/*.rules.yml`; roll back the change). 3. While it is down, `Watchdog` stops (`ops.md#watchdog`): treat operations as blind and check hosts by hand.
**Escalate when:** down over 15 min -> secondary on-call.
**Record:** `infra/ci/ops-note.sh "prometheus down <start>-<end> cause <cause>"`.

## Alertmanager down
**Means:** Alertmanager does not answer; alerts are evaluated but not sent. The Alertmanager UI error state tells you to use `amtool` on ops-1.
**Check first:** `amtool --alertmanager.url=http://127.0.0.1:9093 alert query` (lists firing alerts even when the UI is unreachable); `docker logs --tail 50 alertmanager`.
**Fix:** 1. Restart it. 2. If the config is rejected (`amtool check-config`), roll back the last change. 3. If the mail relay is failing, test sending with a test alert after the restart: `amtool alert add test-alert --annotation=summary=test`. 4. Silences are lost only if the data directory is lost; re-create any needed ones and note them with `ops-note.sh`.
**Escalate when:** down over 15 min -> secondary on-call; the external check at site B should be paging for a total outage.
**Record:** ops log line with the window and cause.

## VictoriaLogs down
**Means:** log ingestion or the log UI is down (`TargetDown{service="victorialogs"}`). Evidence for incidents lives here, so fix it before it loses data.
**Check first:** `docker ps --filter name=victorialogs`; `curl -s http://127.0.0.1:9428/health`; free space on its volume.
**Fix:** 1. Restart the container. 2. If the disk is full, reduce retention in the `logging` role settings through a reviewed change; never delete log files by hand during an open incident. 3. The shippers (Fluent Bit) buffer on disk for a while; confirm they resume.
**Escalate when:** down over 30 min during an open incident -> secondary on-call; use host-local logs (`journalctl`, nginx files) as the evidence source until it returns.
**Record:** ops log line with the window and any log gap.

## Watchdog
The `Watchdog` alert is always firing; its entry is in `ops.md#watchdog`. If the heartbeat mail stops, check Prometheus, then Alertmanager, in this order, using the sections above.

## MetricCardinalityHigh
Too many series for one metric. Entry and steps are in `ops.md#metriccardinalityhigh`. Prometheus memory use is the symptom to watch while the owner fixes the label.
