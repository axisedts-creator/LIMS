APPROVE
# T-13 review round 2 (reviewer). Diff 654ccd9..HEAD (0dfbe99) on top of the earlier T-13 commits c44b92f..754cf2a
Ran: `python -B -m unittest discover -s infra/tests/static -p "test_t13_*.py"` → 78/78 OK. `bash infra/ci/gen-routes.sh | diff - infra/edge/public-routes.yaml` → identical (edge-routes-drift holds). Not run: nginx -t, ansible-lint, shellcheck, live tls/headers/routes/ratelimit (no docker/nginx here).

Round-1 CHANGES all resolved:
1. perip safety net: `limit_req zone=perip burst=200 nodelay;` repeated in staff_web.conf.j2:16, portal.conf.j2:14, api.conf.j2:38 (02-TRD:382). The arbiter ruling (T-13-ruling.md) is applied as written in test_t13_edge.py `zone_limits()` at :581/:588/:747/:805; the assertions for :583 and :590 are unchanged.
2. SEED: gen-routes.sh now cites CR-C1-T13 as its interim basis. The CR is queued non-blocking (.orchestra/cr/T-13.nonblocking.md).
3. ratelimit.py:62/132: AC-04.10 prints SKIP when public-routes.yaml has no otp-challenges route. It does not fail.

Rechecked: zone rates and bursts match 02-TRD s6.5. No secrets or PHI in logs. Only owned paths changed. The "Public edge" play targets the `app` group, which also exists in prod-lean (prod-1), so it fits LD-45. RLS/permissions/idempotency do not apply (edge only).

Notes (non-blocking, not defects):
- gen-routes.sh SEED comment points to `.orchestra/cr/T-13.md`. Orchestra renamed that file to `T-13.nonblocking.md`, so the path is stale. Update it when SEED is deleted.
- Still open for the lead (from impl note OPEN 1/2): `origins` and `acme_email` are missing from the inventories; no one owns compose.edge.yml, which decides the `listen <wg_ip>:8090` binding. Live done_when ("all origins serve", tests green on dev) has not been verified.
