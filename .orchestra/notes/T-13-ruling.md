TESTS_WRONG — the 4 tests require the location's limit_req list to be exactly one zone; the spec also requires the perip safety net, so that equality is wrong.
Reasons:
1. spec/chunks/C1-infrastructure-ops/02-TRD.md:382 says "every server | `limit_req zone=perip burst=200 nodelay;` `limit_conn connip 200;`". The perip limit has to apply to every request, rate-limited locations included.
2. In nginx, a location that has its own `limit_req` stops inheriting the server-level `limit_req`. So each zoned location has to repeat `zone=perip` or it loses the 02-TRD.md:382 limit. Writer's fix (staff_web.conf.j2:15, portal.conf.j2:13, api.conf.j2:37) is correct, and test :858 checks it.
3. 02-TRD.md:374-381 only say which zone and burst a location ADDS. They do not say perip must be absent. 03-APP-FLOW.md:22 also applies perip to all requests.
Change in infra/tests/static/test_t13_edge.py (keep every other assertion as it is):
- :581, :588, :747, :805: before the equality check, drop entries whose args contain `zone=perip`. Example: `[x.args for x in lr if "zone=perip" not in x.args] == [[...single zone...]]`.
- Add to each of these tests: if the location has any limit_req, it must also contain `["zone=perip","burst=200","nodelay"]` exactly (02-TRD.md:382 values).
- :583 (`/auth/v1/user` has no limit_req) and :590 (no qrverify outside /v/) stay unchanged.
