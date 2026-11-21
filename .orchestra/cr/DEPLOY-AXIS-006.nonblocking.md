Title: CR-C1-DEPLOY-006: first real prod deploy, part 6: the public edge (nginx, TLS) could not start as shipped (night11)
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21)    To owner: C1 (edge_nginx, acme, `infra/edge/`), per item where noted
Type: bug
Blocking? yes for production go-live (no edge, no public access); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 001 to 005 covered the images, database, app stack and identity. This CR covers the first attempt to start the edge. Fixes exist in the deploy copy on the host and in `DEPLOY-AXIS-NIGHT11.patch` (held by the deployer, not in the repo). Evidence per item: (verified) = I checked it in the repo; (reported) = night11 report from the host, not re-checked by me.
Outcome on the host: a test edge container `lims-edge` runs healthy, published on 127.0.0.1:80/443 only, with leaves from the repo's internal CA (`acme_mode: internal_ca`), after the fixes below. The staff web login page answers through it (307 then 200), the portal answers 200, HTTP redirects to HTTPS, an unknown Host is refused. A real login through the edge, the public bind and Let's Encrypt are NOT proven.

## Items

### 1. No role task creates the edge container  (To: C1) (verified)
Problem: `edge_nginx` renders `/srv/lims/edge/nginx`, validates it in a throw-away container and reloads a running container named `lims-edge` (`defaults/main.yml:7`, `handlers/main.yml`), but no task anywhere in the role runs that container (verified: no `docker run` in the role). The "Public edge" play of `site.yml` (roles `edge_nginx`, `fail2ban`, `acme`) therefore fails or does nothing on a fresh host.
Night11 added `roles/edge_nginx/tasks/container.yml`: read-only root, tmpfs, `--cap-drop ALL` plus the four capabilities nginx needs, healthcheck on :80, `--restart unless-stopped`, fixed address 172.30.10.10 on `edge_net` (the address the nftables role expects as `nftables_nginx_edge_ip`), ports published on a new variable `edge_nginx_bind_addr` (no default; the task asserts one explicit IPv4 and refuses `0.0.0.0` and `::`), and a rw log directory (`edge_nginx_log_dir`, `/srv/lims/edge/log`; without it the container crash-looped on the read-only `/var/log/nginx`).
Proposed change: take the container task and the bind-address assertion into the role.
Backward compatible? yes.

### 2. Reload handlers fail before the container exists  (To: C1) (reported)
Problem: the `edge_nginx` and `acme` handlers `docker exec lims-edge nginx -s reload` even on the first run, before the container exists, and fail the play. Night11 guards them with `when: edge_nginx_container_running | default(true)`, set from `docker ps` in the playbook.
Proposed change: start the container before the handlers can fire (item 1) and keep the guard for first runs.
Backward compatible? yes.

### 3. `nginx -t` pre-check builds a broken `--add-host` list  (To: C1) (regex line verified, failure reported)
Problem: `tasks/main.yml:126` uses `regex_replace('^(.*)$', '--add-host=\\1:127.0.0.1')`. In the Jinja string this renders a literal `\\1` and the throw-away `docker run` exits with rc 125. Night11 replaced it with two plain `regex_replace` calls.
Proposed change: build the list with a plain loop or `map('regex_replace', '^', '--add-host=')` plus a join; add a render test for the command line.
Backward compatible? yes.

### 4. `certs` mountpoint inside a read-only mount  (To: C1) (reported)
Problem: the throw-away check container mounts the staged tree at `/etc/nginx` read-only and then the certs directory under it; Docker cannot create the `certs` mountpoint inside the read-only mount. Night11 added empty `certs` directories to the stage and install trees.
Proposed change: ship empty `certs` directories in the rendered tree (or mount over an existing directory).
Backward compatible? yes.

### 5. `api.conf.j2` renders a broken config  (To: C1) (trims verified, effect reported)
Problem: `infra/edge/nginx/sites/api.conf.j2` uses `{#-` at line 4 and `{%-` at lines 6, 27 onward. The trims glue `upstream` onto the preceding comment line, and `nginx -t` fails with "directive server has no opening {". Night11 removed the `-` trims.
Proposed change: drop the whitespace-trimming markers (or add `lstrip_blocks`/`trim_blocks` at the role level) and add a CI test that renders every edge template with sample variables and runs `nginx -t` on the result.
Backward compatible? yes.

### 6. Ops listener `listen <wg_ip>:8090` cannot bind inside a bridge container; the public api origin has no health route  (To: C1) (listen line verified, effect reported)
Problem: `api.conf.j2:60` binds `listen {{ wg_ip }}:8090;` for the ops-only health and `stub_status` server. Inside a container on a bridge network the wg address does not exist, so nginx cannot start. Night11 wrapped it in `{% if edge_nginx_ops_listener %}` (default true, false in its playbook); consequence: there is no :8090 listener and Prometheus cannot scrape the edge. Also, `https://<api origin>/v1/core/health/ready` returns 404 on the public edge by design (the origin exposes only the nine routes of `public-routes.yaml`), so there is no way to check api health through the edge.
Proposed change: publish the ops listener as a separate port on the wg address only (`-p <wg_ip>:8090:8090`, with an in-container address that exists), or run the ops listener in the host network namespace; decide where health checks of the edge-to-api path come from (a monitoring probe against the ops listener).
Backward compatible? yes (default unchanged).

### 7. Client address behind Docker: loopback arrives as the bridge gateway  (To: C1, C2 identity) (reported; related filters verified)
Problem: with the edge published on `127.0.0.1`, a loopback connection reaches nginx as `172.30.10.1` (the `edge_net` gateway) because Docker rewrites the source. The edge would forward `X-Forwarded-For: 172.30.10.1`, the api would take that as the client IP (one trusted hop), and a platform admin would be refused with `identity.platform_ip_denied` because 172.30.10.1 is outside `10.77.0.0/24,127.0.0.1/32,::1/128` (CR-005 item 4). Night11 added a role switch `edge_nginx_gateway_as_loopback` (default false, true only in its test playbook): `snippets/clientip.conf` maps 172.30.10.1 to 127.0.0.1 as `$lims_client_ip`; `proxy.conf` uses it for `X-Forwarded-For`; a log field `fwd_client_ip` was added. The edge log then shows `fwd_client_ip 127.0.0.1`, and a client-supplied `X-Forwarded-For` is ignored (edge overwrites it). It is safe only while the edge is published on 127.0.0.1 (the gateway address can then only be the host itself); it must be false for a public bind.
Open questions for a public bind (not tested): (a) does the source address survive Docker's DNAT from the office interface to 172.30.10.10, or does the userland proxy or masquerade rewrite it to the gateway? If it does, every client looks like 172.30.10.1; (b) the edge rate-limit zones use `$binary_remote_addr` (`infra/edge/nginx/snippets/limits.conf:5-15`) and the fail2ban filters parse `remote_addr` (`infra/edge/fail2ban/filter.d/lims-auth.conf`, `lims-ratelimit.conf`): both would see one address for all clients and limit globally, or ban the gateway, if the source is rewritten.
Proposed change: document the private-test mode (loopback bind + tunnel) as supported, keep the switch default off, and on a host with the real public bind test (a) and (b) from an outside address before go-live; if the source is rewritten, fix it (for example by avoiding the userland proxy or masquerade for the edge port) rather than by trusting the gateway.
Backward compatible? yes.
Tenant/security impact: the gateway mapping widens the platform-admin allow-list only for host-originated connections while the bind is loopback; a public bind with the switch on would let any client that appears as the gateway pass the CIDR check, hence the "must be false" rule. No PHI fields.

### 8. Duplicated security headers  (To: C1) (reported, cosmetic)
Problem: `x-content-type-options`, `referrer-policy`, `x-frame-options` and `permissions-policy` appear twice on `/auth/login` (once from the edge `headers.conf`, once from the web upstream).
Proposed change: `proxy_hide_header` the upstream copies or let only one layer set them.
Backward compatible? yes.

### 9. No documented private test path for the edge  (To: C1 docs) (reported)
Problem: nothing in the repo describes how to exercise the edge before DNS and the public bind exist. Night11 used `acme_mode: internal_ca` (allowed only where the edge host is also in group `ops`, true on a single host), a loopback-only bind, an SSH forward chain (axis to lims loopback; PC to axis), a hosts-file line, and importing the internal CA into the operator's trust store with a fingerprint check and a removal step. The guide is `OPERATOR-TEST-GUIDE.md` (held by the deployer).
Proposed change: add this as a "private test mode" section in `DAY-0.md` or the edge runbook, including the cutover steps: real origins, `acme_mode: letsencrypt` with an approved `acme_email`, `edge_nginx_bind_addr` set to the public address, `edge_nginx_gateway_as_loopback: false`, the nftables public-interface rule to 172.30.10.10, the router port forward, fail2ban, and the DNS records (DNS only, not proxied).
Backward compatible? yes.

Tenant/security impact: items 1 and 7 define what is reachable and from which source; the test edge was bound to 127.0.0.1 and asserted not to bind a wildcard. No PHI fields, no new public surface from the test. No secret value appears in this CR.
IRD/regulatory impact: none.
Alternatives considered: keeping each fix only in the deploy copy on the host (done for the test; not repeatable for the real cutover or a rebuild).
Tests that will prove it:
- CI: render every template under `infra/edge/nginx/` with sample variables and run `nginx -t` on the result in the pinned nginx image (items 3, 4, 5, 6);
- Ansible dry run on an empty single-host inventory: the edge play creates the container, `docker ps` shows it healthy and published only on the configured bind address, and the bind assertion refuses `0.0.0.0`;
- host test with a real outside client on the public bind: `fwd_client_ip` shows the client's address, `limit_req` zones count per client, fail2ban sees the client address (item 7);
- edge smoke: `/` redirects to `/auth/login`, `/auth/login` 200, an unknown Host is refused, HSTS present, HTTP redirects to HTTPS.
