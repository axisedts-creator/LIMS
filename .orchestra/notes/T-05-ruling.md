TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/chunks/C1-infrastructure-ops/02-TRD.md:421 (§7.1): `upstream/` is a byte-for-byte copy of one upstream `docker/` commit; CI fails if a file differs from the lock. So the implementation may not edit out the tag.
- 02-TRD.md:110 (§2 "Docker Engine" row): the official PgBouncer override uses `!reset` (VERIFIED in file); infra/compose/supabase/upstream/docker-compose.pgbouncer.yml:14 `supavisor: !reset null` matches this.
- 02-TRD.md:433, 454-471: the spec's own override design relies on `!reset`, so a plain `yaml.safe_load` cannot parse spec-conformant compose files. The spec never requires them to be safe_load-parsable.
- LD-42 (binding, task brief): already rules this way. Use a pass-through loader; vendored files stay unchanged.
Change in test (infra/tests/static/test_t05_supabase_compose.py:370-371, and any other place that parses compose files): define `class _ComposeLoader(yaml.SafeLoader)`, then register
`_ComposeLoader.add_constructor("!reset", ...)` and `add_constructor("!override", ...)`. Each constructor returns the node's plain value (scalar/sequence/mapping via `construct_scalar`/`construct_sequence`/`construct_mapping`; `null` becomes None).
Then parse with `yaml.load(text, Loader=_ComposeLoader)`. Leave the assertions as they are. Keep `yaml.safe_load` for UPSTREAM.lock (lines 85, 182).
