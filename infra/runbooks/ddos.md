# DDoS posture without a foreign CDN (`ddos`)

Owner C1. 04 I7, REQ-SEC-135, 04-UI-UX s4.3. Signals: `RateLimitSpike`, `Edge5xxRate`, the D2 req/s panel far above baseline, connection count near `worker_connections`. Related: `edge.md#ratelimitspike`, `edge.md#edge5xxrate`, `edge.md#limsauthjailban`.

## Steps
1. **Recognise.** `RateLimitSpike`, req/s on D2 well above baseline, `Edge5xxRate`, active connections close to `worker_connections`.
2. **Classify.** Application layer: HTTP requests are visible in `access.json`. Volumetric: packet drops or link saturation on the provider graph while nginx sees little traffic.
3. **Application layer.**
   - Find the top IPs and ASNs in VictoriaLogs (count by `remote_addr` and `route`).
   - Ban abusive IPs: `edge.md#manual-ban`. Never ban a tenant lab NAT without asking the tenant ops contact.
   - Tighten the per-IP zone temporarily (`edge_perip_rate` in `group_vars`) and redeploy the app host only.
   - If one route is targeted (for example `/v/`), lower its limit or return 503 for that route (the portal shows its error state): see "Disabling one public route" in `edge.md`.
4. **Volumetric.** Contact the datacentre or ISP using `isp_mitigation_contact` (empty until B12). Which Nepali ISP offers scrubbing is UNVERIFIED (04 I7). Accept downtime above upstream capacity and post a status page notice (`infra/status/status.yaml`, state `degraded` or `major_outage`). **No foreign CDN or scrubbing service may be enabled without founder approval (04 s11, B11).**
5. **After.** Open an incident record (`incident-response.md`), review the limits, and record what worked.

## Do not
- Do not route traffic through a foreign CDN, proxy or scrubber without founder approval (B11).
- Do not disable rate limits or fail2ban to "let users in".
- Do not publish the origin address or the mitigation contact in tickets or chat.
