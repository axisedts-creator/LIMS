CHANGES

Scope re-reviewed: `git diff 7996834..HEAD` after fix round 1.
Prior item 1 resolved: `migrations_meta.revision` query removed from pgTAP; node test "migration order: nothing sorts before
schemas; every helper user sorts after helpers" added. Migrations unchanged and still match 05-SCHEMA §2 / §10 verbatim
(uuidv7 body re-checked against 05-SCHEMA.md:593-601; set_bit 52/53 on v4 byte 6 gives nibble 7, variant 10 kept).
Names, grants (is_platform_actor REVOKE PUBLIC / GRANT lims_app; current_lims_session_id lims_app/api/worker), owned
paths, no secrets/PHI: OK. `node --test tests/db/T0B-01.bootstrap.test.mjs tests/db/T0B-02.schemas-helpers.test.mjs`
-> 23 pass, 0 fail. pgTAP not run (no live DB).

1. db/tests/app/T0B-02_helpers.test.sql:109-110 — "non-decreasing" assertion is flaky: 200 calls land in the same ms, so
   many rows tie on `substr(u::text, 1, 13)`; PostgreSQL's sort is not stable, so `array_agg(u ORDER BY substr(...))` can
   permute tied (distinct) uuids and the arrays differ even when the code is correct; the unordered `array_agg(u)` also has
   no guaranteed order. Fix: replace lines 109-110 with
   ```
   SELECT ok((SELECT bool_and(t >= p) FROM (SELECT t, lag(t) OVER (ORDER BY n) p
                FROM (SELECT n, substr(app.uuidv7()::text, 1, 13) t FROM generate_series(1, 200) n) s) w WHERE p IS NOT NULL),
     'uuidv7 timestamp prefix is non-decreasing across successive calls');
   ```
