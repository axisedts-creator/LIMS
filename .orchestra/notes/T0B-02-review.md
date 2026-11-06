CHANGES

Scope reviewed: `git diff 7996834..HEAD` (2 migrations, pgTAP file, node static test, notes).
Verified OK: both migrations match 05-SCHEMA §2 and §10 (helpers stage) verbatim (only comment wording differs); the
`current_lims_session_id` GRANT placed in the helpers stage per plan row review-fix note (08 A20.2); is_platform_actor
REVOKE PUBLIC / GRANT lims_app, DEFINER + `search_path = ''`, check_function_bodies off/on; 5 policy helpers per 08 A30.1;
uuidv7 bits 52/53 on a v4 base give version 7 / variant 10; lims_queue / lims_reporting_lookup default privileges set by
the roles themselves; no supabase_auth_admin grant, no standing CREATE, no secrets/PHI; owned paths only.
`node --test tests/db/T0B-01.bootstrap.test.mjs tests/db/T0B-02.schemas-helpers.test.mjs` -> 22 pass, 0 fail.
pgTAP file not run (no live DB in this review).

1. db/tests/app/T0B-02_helpers.test.sql:227-229 — the "creation order" assertion queries `migrations_meta.revision.name`,
   a column the spec never defines (05-SCHEMA §2 only says "runner revision table"); if the runner's table has a different
   column the whole pgTAP file errors, and even when it runs it only checks that `app__create_schemas` is the first
   `app__create_*` row — not schema test 21's requirement that the helpers migration precedes every migration creating a
   policy/function that references the helpers. Fix: delete lines 226-229, and in tests/db/T0B-02.schemas-helpers.test.mjs
   add a test: for every `db/migrations/*.sql` other than the schemas and helpers files whose comment-stripped text matches
   `/app\.(is_platform_actor|current_partner_id|engagement_(preauth_stage|account_id|patient_ids|patient_visible)|current_lims_session_id|uuidv7)\s*\(/`,
   assert `file > find('app__create_context_helpers')` (lexical sort = apply order); also assert no file sorts before
   `find('app__create_schemas')`.
