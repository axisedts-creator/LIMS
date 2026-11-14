# Edge runbook (`edge`)

Owner C1. One section per alert in `monitoring/rules/edge.rules.yml` and `security.rules.yml` (`LimsAuthJailBan`), plus edge procedures.
Anchors = lower-case alert names (02-TRD s11.3); template 04-UI-UX s4.2. Edge = nginx on the public origins, fail2ban, nftables, Squid egress.
Commands run on the app host (`prod-1` in profile `lean`, `app-1` in `full`; LD-45). Logs: VictoriaLogs stream `access.json`.

## TLSCertExpiringSoon
Severity: warn   Owner: C1   Last tested: never
**Means:** a public certificate expires in under 21 days (blackbox probe, 10 min).  **Impact:** none yet; browsers reject the origin once it expires.
**Check first:** `echo | openssl s_client -connect <origin>:443 -servername <origin> 2>/dev/null | openssl x509 -noout -enddate` (expect a date under 21 days); `journalctl -u lims-certbot.service --since -2d` for the last renewal result.
**Fix:** 1. Read the renewal log; the usual cause is a failed ACME HTTP-01 challenge (port 80 closed, DNS changed). 2. Fix the cause and run the renewal unit (`systemctl start lims-certbot.service`). 3. Confirm the new expiry with the first command; nginx reloads on success.
**Escalate when:** still under 14 days after two failed renewals, or the CA rate-limits us -> secondary on-call.
**Close-out:** `infra/ci/ops-note.sh "TLSCertExpiringSoon <origin> renewed, new expiry <date>"`.

## TLSCertExpiryCritical
Severity: page   Owner: C1   Last tested: never
**Means:** a public certificate expires in under 7 days.  **Impact:** SEV2 (04-UI-UX s5.1); users get browser warnings or a hard failure when it expires.
**Check first:** same `openssl s_client` command as `TLSCertExpiringSoon` (expect under 7 days); `systemctl status lims-certbot.timer`.
**Fix:** 1. Follow `TLSCertExpiringSoon` steps 1-3 now. 2. If the ACME path is broken and cannot be fixed within 24 h, issue a certificate by the manual route in `secrets.md` and install it, then record why. 3. DESTRUCTIVE: never delete the live certificate directory before a new one is verified.
**Escalate when:** under 48 h left with no valid new certificate -> founder.
**Close-out:** ops log line with origin, new expiry, root cause; incident record if any origin served an expired certificate.

## Edge5xxRate
Severity: page   Owner: C1   Last tested: never
**Means:** more than 2 % of edge requests were answered 5xx over 5 min.  **Impact:** SEV2; users see errors on staff web, portal or API.
**Check first:** Grafana D2 (edge) by `route` and `status`; VictoriaLogs `access.json` filter `status:>=500` last 15 min grouped by `route`; `docker ps` on the app host for unhealthy containers.
**Fix:** 1. If one `route` dominates, find the upstream (api, web, portal) and follow `runtime.md#workerdown` or the owning module runbook. 2. If every route fails, check nginx (`nginx -t`, `systemctl status nginx`) and the upstream containers. 3. If a deploy just finished, run `infra/ci/rollback.sh` (see `deploy.md`). 4. For a traffic flood rather than an upstream fault, follow `ddos.md`.
**Escalate when:** not falling under 2 % within 15 min -> secondary on-call; total outage of registration or reporting -> SEV1 and `incident-response.md`.
**Close-out:** ops log line with route, upstream, cause and action; incident record for SEV1/SEV2.

## RateLimitSpike
Severity: warn   Owner: C1   Last tested: never
**Means:** nginx `limit_req` rejections are more than 10x the 7-day baseline for 10 min.  **Impact:** legitimate users behind a busy IP may see 429; may be the start of a flood.
**Check first:** Grafana D2 rate-limited panel; VictoriaLogs `access.json` with `limit_req_status:REJECTED`, last 15 min, counted by `remote_addr` and `route`.
**Fix:** 1. If one IP dominates, see `LimsAuthJailBan` and `ddos.md`. 2. If many IPs hit one route, follow `ddos.md` step 3 (tighten or temporarily close that route). 3. If a tenant lab behind one NAT is the source and the traffic is a misbehaving client, contact the lab; do not ban the NAT.
**Escalate when:** also `Edge5xxRate` firing -> page the secondary and follow `ddos.md`.
**Close-out:** ops log line with top IP class (tenant lab / unknown), route and action.

## ForbiddenPortOpen
Severity: page   Owner: C1   Last tested: never
**Means:** the external probe reached a port that must stay closed (for example PostgreSQL, PgBouncer, Valkey, metrics).  **Impact:** SEV1 (04-UI-UX s5.1): a data port is reachable from the internet.
**Check first:** the alert label `instance` names host:port; on the host `ss -ltnp | grep :<port>` and `nft list ruleset | grep -n <port>`.
**Fix:** 1. Close it first: confirm the nftables policy is loaded (`systemctl status nftables`), re-run the `nftables` role through `ansible-playbook playbooks/site.yml --limit <host>`. 2. Confirm from outside that the probe now fails (alert resolves after 2 min). 3. Treat as an incident: open `incident-response.md`, preserve evidence (nginx and auth logs for the exposure window) and assess whether the service was accessed.
**Escalate when:** always inform the founder; the secrets behind that service are rotated if access cannot be excluded (`secrets.md`).
**Close-out:** incident record with exposure start/end, port, and the assessment decision.

## Fail2banBanSpike
Severity: warn   Owner: C1   Last tested: never
**Means:** more than 50 fail2ban bans in the last hour.  **Impact:** possible distributed attack; some legitimate users may be banned.
**Check first:** `fail2ban-client status` then `fail2ban-client status lims-auth` on the app host; VictoriaLogs `access.json` top `remote_addr` for the hour.
**Fix:** 1. If bans come from many unrelated IPs, follow `ddos.md`. 2. If a tenant lab was caught, unban it (`manual-ban` below) and contact the lab. 3. Otherwise let bans expire (15 min).
**Escalate when:** spike continues for 2 h or `Edge5xxRate` fires -> secondary on-call.
**Close-out:** ops log line with number of bans, IP classes, action.

## EdgeNotFoundSpike
Severity: warn   Owner: C1   Last tested: never
**Means:** one client produced more than 30 edge 404s in 5 min, for 15 min (scanning or broken client).  **Impact:** SEV4 on its own (04-UI-UX s5.1); no user impact.
**Check first:** VictoriaLogs `access.json` `status:404`, last 30 min, counted by `remote_addr`; the label `lims_ops_edge_not_found_max_per_ip_5m` on Grafana D2.
**Fix:** 1. Find the IP in VictoriaLogs. 2. Decide if it is a tenant lab: a lab's NAT carries many users, so never ban a lab NAT for 404s (08 A25 D-211, 04-UI-UX s4.1). 3. Unknown IP: leave it; 404 scanning is rate limited by nginx already. Ban only if combined with other signals (auth failures, `LimsAuthJailBan`) and follow `manual-ban`.
**Escalate when:** together with `Fail2banBanSpike` or `RateLimitSpike` -> treat as `ddos.md`.
**Close-out:** ops log line with IP class and decision (no ban / ban and why).

## EgressDenied
Severity: warn   Owner: C1   Last tested: never
**Means:** Squid denied egress to a destination class not on the allow list.  **Impact:** a container tried to call out to a forbidden destination, or a legitimate integration lacks an allow-list entry.
**Check first:** VictoriaLogs Squid stream `TCP_DENIED`, last 15 min, by `dest_class` and source container; the Squid egress panel on Grafana D2.
**Fix:** 1. Identify the source service from the denied log line. 2. If the destination is a legitimate and approved integration, add it through the egress allow-list change process (a CR, then the `egress_proxy` role). 3. If not approved, treat it as suspicious: check the image digest and recent deploys, and see `incident-response.md`.
**Escalate when:** the source is a renderer, pdf-sandbox or scanner container (should never call out) -> page secondary and open an incident.
**Close-out:** ops log line with source, destination class and decision.

## LimsAuthJailBan
Severity: page   Owner: C1   Last tested: never
**Means:** one IP produced at least 300 nginx `limit_req` rejections in the `login` zone within 10 min and fail2ban `lims-auth` banned it for 15 min (08 Addendum A3.2). Failed passwords (401) never cause this ban; they are handled by C2's per-IP failure throttle.  **Impact:** every user behind that IP (possibly a whole lab on shared NAT) cannot reach the public origins for 15 min.
**Check first:** `fail2ban-client status lims-auth` on the app host (banned IP listed); VictoriaLogs query on `access.json` for that `remote_addr`, `limit_req_status=REJECTED`, last 15 min, grouped by `route`; D13 per-IP failure throttles active (C2).
**Fix:** 1. If the IP belongs to a known tenant lab (tenant ops contact, or the lab reports an outage) and the traffic is a misbehaving client, not an attack: `fail2ban-client set lims-auth unbanip <ip>` (`edge.md#manual-ban`), record it in `ops_audit`, contact the lab. 2. Otherwise let the ban expire; if the flood resumes, follow `ddos.md`.
**Escalate when:** repeated bans of the same IP within 1 h, or bans from many IPs at once -> secondary on-call (possible distributed attack, `ddos.md`).
**Close-out:** ops log line with IP class (tenant lab / unknown), ban duration, action taken.

## Manual ban
Procedure, not an alert. Use only after the decision rules in `LimsAuthJailBan` and `ddos.md`.
1. Ban for a bounded time: `fail2ban-client set lims-auth banip <ip>`; fail2ban applies the ban through nftables (`nft list ruleset | grep <ip>` shows it). A ban longer than the jail time is an edge change: raise it in the `fail2ban` role defaults and redeploy.
2. Unban: `fail2ban-client set lims-auth unbanip <ip>`.
3. Never ban a private, wg0 or ops-1 address. Check twice that the IP is not a tenant lab NAT (ask the tenant ops contact).
4. Record every ban/unban: `infra/ci/ops-note.sh "manual ban <ip> <duration> reason <short>"` (goes to `ops_audit`).

## Disabling one public route
Procedure. Use when one route is abused and the rest must stay up (`ddos.md` step 3).
1. Change the route's `location` in the `edge_nginx` role to return `503` with the standard error page; redeploy the app host: `ansible-playbook playbooks/site.yml --limit <host>`.
2. Confirm: `curl -sI https://<origin>/<route>` returns 503 and the other routes stay 200.
3. Add a status page notice (`infra/status/status.yaml`, state `degraded`) and record with `ops-note.sh`.
4. Revert the same way when the abuse stops.

## edge-routes-drift
Procedure for the CI failure `edge-routes-drift`: the generated route table no longer matches the committed route files (generator: `infra/ci/gen-routes.sh`).
1. Run `infra/ci/gen-routes.sh` locally and diff against the committed output.
2. If a module added or changed a route legitimately, commit the regenerated file through the owning task; do not hand-edit generated files.
3. If the diff shows a route nobody asked for, stop the deploy and ask the module owner.
