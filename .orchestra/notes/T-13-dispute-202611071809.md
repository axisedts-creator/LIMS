# T-13 dispute (writer)
Review item 1 applied: `limit_req zone=perip burst=200 nodelay;` added under the zone line in staff_web.conf.j2:15, portal.conf.j2:13, api.conf.j2:37.
New test `test_every_limited_location_keeps_the_perip_safety_net` now passes, but 4 older tests in infra/tests/static/test_t13_edge.py compare the location's FULL `limit_req` list for equality with a single zone, so they fail with the perip line:
- :577 test_staff_web_login_routes_use_the_login_zone, :585 test_portal_qr_zone_only_on_v, :740 test_zone_table_applied_to_any_route, :803 test_payments_zone_and_headers
  e.g. `[['zone=login','burst=20','nodelay'], ['zone=perip','burst=200','nodelay']] != [['zone=login','burst=20','nodelay']]`
The two test sets cannot both pass (review item 1 + 02-TRD s6.5 "every server" require perip). Fix (tester): in those 4 tests, filter out `zone=perip` entries before comparing (or assert the zone entry is present instead of list equality).
Run: `python -B -m unittest discover -s infra/tests/static -p "test_t13_*.py"` -> 78 run, 4 failures (above). gen-routes drift: identical.
Review item 2 done: .orchestra/cr/T-13.md (CR-C1-T13), cited in gen-routes.sh SEED comment. Item 3 was a test item (done by tester).
