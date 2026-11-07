# T-05 dispute (debugger)
Test: infra/tests/static/test_t05_supabase_compose.py::UpstreamLockTest::test_lock_images_match_upstream_compose_tags (line 371).
Defect: `yaml.safe_load(upstream/docker-compose.pgbouncer.yml)` raises `ConstructorError: could not determine a constructor for the tag '!reset'`.
The file contains `supavisor: !reset null` (line 14) and must stay byte-for-byte (spec/chunks/C1-infrastructure-ops/02-TRD.md s7.1;
s2 row "Docker Engine": "upstream override uses `!reset` (VERIFIED in file)"), so the implementation cannot avoid the tag.
Fix belongs in the test: load with a SafeLoader subclass that registers a constructor for `!reset`/`!override` (return None/value).
The other 40 tests pass (python -B -m unittest discover -s infra/tests/static -p "test_t05_*.py").
