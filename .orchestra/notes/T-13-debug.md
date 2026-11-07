# T-13 debug
- Cause: 4 tests (test_t13_edge.py:577,585,740,803) assert location `limit_req` list == single zone. Impl correctly adds `zone=perip burst=200 nodelay` per location (nginx location limit_req replaces server-level one) as required by 02-TRD.md:382 "every server | limit_req zone=perip burst=200 nodelay" + review item 1.
- Impl is spec-correct; removing perip would regress review item 1. No impl change made.
- Test contradicts spec -> dispute in .orchestra/notes/T-13-dispute.md (cites 02-TRD:366,382). Tester must filter zone=perip / assert zone presence in those 4 tests.
