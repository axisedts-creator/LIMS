-- T0C-CONTENT-1 pgTAP suite (LD-313, LD-325; founder 2026-11-17 04:57 NPT "do not leave any function", ElabAssist News and Updates, Slider / Banner, Special Offers, Contact Us, Profile Image Upload)
-- for migration 20261117130000_engagement__add_portal_content.sql: engagement.portal_content and engagement.profile_image (tenant RLS FORCE-d, staff write, patients read only active
-- portal content inside its date window, never write), idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001), users a300/a30c, memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/engagement/T0C-CONTENT-1_portal_content.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (the brief lists the columns; a different choice needs a ruling, not a silent test edit; names equal the contract test content1-openapi.test.ts):
--  - engagement.portal_content(id, tenant_id, kind, title, body, image_attachment_id, link_url, starts_on, ends_on, sort_order, active, published_at, version, created_at, created_by, updated_at, updated_by):
--    the brief names kind, title, body, image_attachment_id, link_url, starts_on, ends_on, sort_order, active, published_at, created_by; the standard columns id, tenant_id, version, created_at, updated_at, updated_by are added.
--    The flag is called `active` (brief) or `is_active` (neighbouring tables): this suite accepts either name (looked up once, see cfg below).
--    CHECKs: kind news | banner | offer | contact; title 1..200 chars; body at most 20000 chars and no "<" (no raw HTML, defence in depth for the contract rule); link_url https only, at most 2048 chars;
--    ends_on >= starts_on when both are set; sort_order >= 0. image_attachment_id is a composite FK (tenant_id, image_attachment_id) to identity.branding_assets (tenant_id, id): the existing branding image path is reused.
--  - engagement.profile_image(id, tenant_id, profile_kind, profile_id, image_attachment_id, active|is_active, version, created_at, created_by, updated_at, updated_by): profile_kind doctor | centre | staff, one row per
--    (tenant_id, profile_kind, profile_id) (set = upsert, ON CONFLICT works), image_attachment_id NOT NULL with the same composite FK. "Clear" = the flag goes false (the row stays, no DELETE grant).
--  - lims_app on both tables: SELECT, INSERT, UPDATE, no DELETE. Staff (user, system) read and write all rows of their tenant. A patient actor reads only the portal_content rows that are active and inside
--    their date window (starts_on <= today <= ends_on, open ends allowed) and writes nothing; a patient actor, portal actor and partner actor see no profile_image row (not part of the patient read operations of this task).
--  - Both tables carry the row audit trigger app.tg_row_audit (class M, like the neighbouring tables).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c700-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.s(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'user', p_mem uuid DEFAULT NULL, p_sub uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant,
    'sub', coalesce(p_sub, CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a300' ELSE '01a1a98a-ac40-7000-8000-00000000b300' END::uuid),
    'membership_id', coalesce(p_mem, CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid)) $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- run p_sql as p_role with claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.pat(p_sql text, p_mode text DEFAULT 'n', p_tenant uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(coalesce(p_tenant, pg_temp.ta()), 'patient'), p_sql, p_mode) $$;
-- one scalar as text, or 'E' || SQLSTATE (a missing column fails one assertion, not the whole file)
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, 'NULL'); EXCEPTION WHEN OTHERS THEN RETURN 'E' || SQLSTATE; END $f$;
-- insert a row from jsonb (keys of p_row only; created_by / updated_by / id added when the table has them); 'ok' or SQLSTATE
CREATE FUNCTION pg_temp.ins(p_tbl_name text, p_row jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE p_tbl regclass := to_regclass(p_tbl_name); r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  IF p_tbl IS NULL THEN RETURN '42P01'; END IF;
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = 'id' AND NOT attisdropped) AND NOT (r ? 'id') THEN r := r || jsonb_build_object('id', gen_random_uuid()); END IF;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  BEGIN
    EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN SQLSTATE;
  END;
END $f$;
-- fixture insert that must work (old tables, old columns only): raises when it does not
CREATE FUNCTION pg_temp.fx(p_tbl text, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s text := pg_temp.ins(p_tbl, p_row);
BEGIN IF s <> 'ok' THEN RAISE EXCEPTION 'fixture % failed with %', p_tbl, s; END IF; END $f$;
CREATE FUNCTION pg_temp.cols_missing(p_tbl text, p_cols text[]) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(c, ',') FROM unnest(p_cols) c WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(p_tbl) AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0) $$;
-- the name of the active flag per table: `active` (brief) or `is_active` (neighbouring tables); 'active' when the table does not exist yet (the assertions then fail for the table, not for this lookup)
CREATE TEMP TABLE cfg AS SELECT
  coalesce((SELECT attname::text FROM pg_attribute WHERE attrelid = to_regclass('engagement.portal_content') AND attname IN ('active', 'is_active') AND NOT attisdropped LIMIT 1), 'active') AS pc,
  coalesce((SELECT attname::text FROM pg_attribute WHERE attrelid = to_regclass('engagement.profile_image') AND attname IN ('active', 'is_active') AND NOT attisdropped LIMIT 1), 'active') AS pi;
GRANT SELECT ON cfg TO public;
CREATE FUNCTION pg_temp.pcf() RETURNS text LANGUAGE sql AS $$ SELECT pc FROM cfg $$;
CREATE FUNCTION pg_temp.pif() RETURNS text LANGUAGE sql AS $$ SELECT pi FROM cfg $$;

-- ===================================================================================================================================== fixtures: branding assets (the existing image resource) of tenant A and B
SELECT pg_temp.fx('identity.branding_assets', jsonb_build_object('id', pg_temp.uid(301), 'tenant_id', pg_temp.ta(), 'kind', 'logo', 'object_path', pg_temp.ta()::text || '/synthetic-a.png',
  'content_type', 'image/png', 'size_bytes', 1000, 'width_px', 100, 'height_px', 100, 'sha256', '\x' || repeat('ab', 32)));
SELECT pg_temp.fx('identity.branding_assets', jsonb_build_object('id', pg_temp.uid(302), 'tenant_id', pg_temp.tb(), 'kind', 'logo', 'object_path', pg_temp.tb()::text || '/synthetic-b.png',
  'content_type', 'image/png', 'size_bytes', 1000, 'width_px', 100, 'height_px', 100, 'sha256', '\x' || repeat('cd', 32)));

-- ===================================================================================================================================== (1) engagement.portal_content: shape
SELECT has_table('engagement'::name, 'portal_content'::name, 'engagement.portal_content exists');
SELECT is(pg_temp.cols_missing('engagement.portal_content', ARRAY['id','tenant_id','kind','title','body','image_attachment_id','link_url','starts_on','ends_on','sort_order',pg_temp.pcf(),'published_at','version','created_at','created_by','updated_at','updated_by']), NULL,
  'portal_content has the 17 columns (brief list plus the standard ones)');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('engagement.portal_content')), true, 'portal_content: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.portal_content') AND polcmd = 'd'), 0, 'portal_content: no DELETE policy (history is kept)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.portal_content') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0,
  'portal_content: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'engagement.portal_content', 'SELECT') AND has_table_privilege('lims_app', 'engagement.portal_content', 'INSERT')
  AND has_table_privilege('lims_app', 'engagement.portal_content', 'UPDATE') AND NOT has_table_privilege('lims_app', 'engagement.portal_content', 'DELETE'))::text$q$), 'true', 'portal_content: lims_app has SELECT, INSERT, UPDATE and no DELETE');
SELECT is(pg_temp.q($q$SELECT (EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'engagement.portal_content'::regclass AND NOT t.tgisinternal AND p.proname = 'tg_row_audit'))::text$q$), 'true',
  'portal_content: row audit trigger (a published text change is audited)');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM pg_constraint WHERE conrelid = 'engagement.portal_content'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) ~ 'identity\.branding_assets'$q$), '1',
  'portal_content: the image is a composite FK to the existing branding asset resource (no new upload table)');

-- ===================================================================================================================================== (2) portal_content: rows, checks
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(401), 'tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'Synthetic news item', 'body', E'# Heading\n\nSome **bold** text with [a link](https://example.org/a).')),
  'ok', 'portal_content insert: tenant A / news, Markdown body');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(402), 'tenant_id', pg_temp.ta(), 'kind', 'banner', 'title', 'Synthetic banner', 'image_attachment_id', pg_temp.uid(301),
  'link_url', 'https://example.org/offers', 'starts_on', current_date - 3, 'ends_on', current_date + 3, 'sort_order', 1)), 'ok', 'portal_content insert: tenant A / banner with an image, https link, window around today');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(403), 'tenant_id', pg_temp.ta(), 'kind', 'offer', 'title', 'Synthetic offer (future)', 'starts_on', current_date + 3, 'ends_on', current_date + 10)),
  'ok', 'portal_content insert: tenant A / offer that has not started');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(404), 'tenant_id', pg_temp.ta(), 'kind', 'offer', 'title', 'Synthetic offer (expired)', 'starts_on', current_date - 10, 'ends_on', current_date - 3)),
  'ok', 'portal_content insert: tenant A / offer that has ended');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(405), 'tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'Synthetic news (inactive)', pg_temp.pcf(), false)),
  'ok', 'portal_content insert: tenant A / inactive news');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(406), 'tenant_id', pg_temp.ta(), 'kind', 'contact', 'title', 'Contact us', 'body', E'Open 8 to 5.\n\n- Phone: +1 555 0100 (SYNTHETIC)')),
  'ok', 'portal_content insert: tenant A / contact');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(410), 'tenant_id', pg_temp.tb(), 'kind', 'news', 'title', 'Synthetic news B', 'image_attachment_id', pg_temp.uid(302))),
  'ok', 'portal_content insert: tenant B / news with its own image');
SELECT is(pg_temp.q($q$SELECT sort_order::text FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), '0', 'portal_content: sort_order defaults to 0');
SELECT is(pg_temp.q(format($q$SELECT %I::text FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000401'$q$, pg_temp.pcf())), 'true', 'portal_content: active by default');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('id', pg_temp.uid(411), 'tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'Synthetic news item')), 'ok', 'portal_content insert: the same title twice is allowed (no unique title)');
-- value checks
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'popup', 'title', 'x')), '23514', 'insert: unknown kind rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', '')), '23514', 'insert: empty title rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', repeat('t', 201))), '23514', 'insert: title over 200 characters rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', repeat('t', 200))), 'ok', 'insert: title of exactly 200 characters accepted');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'body', '<script>alert(1)</script>')), '23514', 'insert: raw HTML script in the body rejected by the table too');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'body', 'ok text <img src=x onerror=alert(1)>')), '23514', 'insert: raw HTML image with a handler in the body rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'body', repeat('a', 20001))), '23514', 'insert: body over 20000 characters rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'body', repeat('a', 20000))), 'ok', 'insert: body of exactly 20000 characters accepted');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'link_url', 'http://example.org')), '23514', 'insert: http link rejected (https only)');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'link_url', 'javascript:alert(1)')), '23514', 'insert: javascript link rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'link_url', 'data:text/html,x')), '23514', 'insert: data link rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'link_url', '//example.org/a')), '23514', 'insert: protocol relative link rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'link_url', 'https://example.org/' || repeat('a', 2100))), '23514', 'insert: link over 2048 characters rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'starts_on', current_date + 5, 'ends_on', current_date + 1)), '23514', 'insert: ends_on before starts_on rejected');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'starts_on', current_date + 5, 'ends_on', current_date + 5)), 'ok', 'insert: one day window (ends_on = starts_on) accepted');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'sort_order', -1)), '23514', 'insert: negative sort_order rejected');
-- the image must be a branding asset of the same tenant
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'banner', 'title', 'x', 'image_attachment_id', pg_temp.uid(302))), '23503', 'insert: an image of tenant B is rejected for tenant A (composite FK)');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'banner', 'title', 'x', 'image_attachment_id', pg_temp.uid(999))), '23503', 'insert: an unknown image id is rejected');

-- ===================================================================================================================================== (3) portal_content: isolation and actors
SELECT is(pg_temp.a($q$UPDATE engagement.portal_content SET sort_order = 7 WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'n=1', 'tenant A staff can reorder (UPDATE sort_order)');
SELECT is(pg_temp.a(format($q$UPDATE engagement.portal_content SET %I = false WHERE id = '0190c700-0000-7000-8000-000000000406'$q$, pg_temp.pcf())), 'n=1', 'tenant A staff can deactivate content');
SELECT is(pg_temp.a(format($q$UPDATE engagement.portal_content SET %I = true WHERE id = '0190c700-0000-7000-8000-000000000406'$q$, pg_temp.pcf())), 'n=1', 'tenant A staff can reactivate content');
SELECT is(pg_temp.a($q$UPDATE engagement.portal_content SET body = '<script>alert(1)</script>' WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E23514', 'tenant A staff cannot UPDATE the body to raw HTML (the check holds on update)');
SELECT is(pg_temp.a($q$UPDATE engagement.portal_content SET link_url = 'http://example.org' WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E23514', 'tenant A staff cannot UPDATE the link to http');
SELECT is(pg_temp.a($q$DELETE FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 'tenant A staff cannot DELETE content (no grant)');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.portal_content WHERE id IN ('0190c700-0000-7000-8000-000000000401', '0190c700-0000-7000-8000-000000000402', '0190c700-0000-7000-8000-000000000403',
  '0190c700-0000-7000-8000-000000000404', '0190c700-0000-7000-8000-000000000405', '0190c700-0000-7000-8000-000000000406', '0190c700-0000-7000-8000-000000000411')$q$, 'n'), 'n=7',
  'tenant A staff sees all 7 named rows, active or not, in any window (401 402 403 404 405 406 411)');
SELECT is(pg_temp.b($q$SELECT 1 FROM engagement.portal_content$q$, 'n'), 'n=1', 'tenant B staff sees its 1 row');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.portal_content WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B content by filter');
SELECT is(pg_temp.a($q$UPDATE engagement.portal_content SET title = 'hijack' WHERE id = '0190c700-0000-7000-8000-000000000410'$q$), 'n=0', 'tenant A cannot update a tenant B row');
SELECT is(pg_temp.a($q$INSERT INTO engagement.portal_content (id, tenant_id, kind, title, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000412',
  '01a1a98a-ac40-7000-8000-00000000b001', 'news', 'x', '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'E42501', 'tenant A cannot insert a row for tenant B');
-- patient actor: only active items inside the window, and no writes
SELECT is(pg_temp.pat($q$SELECT 1 FROM engagement.portal_content WHERE id IN ('0190c700-0000-7000-8000-000000000401', '0190c700-0000-7000-8000-000000000402', '0190c700-0000-7000-8000-000000000403',
  '0190c700-0000-7000-8000-000000000404', '0190c700-0000-7000-8000-000000000405', '0190c700-0000-7000-8000-000000000406', '0190c700-0000-7000-8000-000000000411')$q$, 'n'), 'n=4',
  'patient claims see exactly the active items inside their window: 401 (no window), 402 (window around today), 406 (contact), 411; not 403 (future), 404 (ended), 405 (inactive)');
SELECT is(pg_temp.pat($q$SELECT 1 FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000403'$q$, 'n'), 'n=0', 'patient claims do not see an offer that has not started');
SELECT is(pg_temp.pat($q$SELECT 1 FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000404'$q$, 'n'), 'n=0', 'patient claims do not see an offer that has ended');
SELECT is(pg_temp.pat($q$SELECT 1 FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000405'$q$, 'n'), 'n=0', 'patient claims do not see inactive content');
SELECT is(pg_temp.pat($q$SELECT 1 FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000402'$q$, 'n'), 'n=1', 'patient claims see the banner inside its window');
SELECT is(pg_temp.pat($q$SELECT 1 FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000410'$q$, 'n'), 'n=0', 'patient claims of tenant A do not see tenant B content');
SELECT is(pg_temp.pat('SELECT 1 FROM engagement.portal_content', 'n', pg_temp.tb()), 'n=1', 'patient claims of tenant B see the active tenant B item');
SELECT is(pg_temp.pat($q$UPDATE engagement.portal_content SET title = 'hijack' WHERE id = '0190c700-0000-7000-8000-000000000401'$q$, 'w'), 'n=0', 'patient claims cannot update content');
SELECT is(pg_temp.pat($q$INSERT INTO engagement.portal_content (id, tenant_id, kind, title, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000413',
  '01a1a98a-ac40-7000-8000-00000000a001', 'news', 'x', '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$, 'w'), 'E42501', 'patient claims cannot insert content');
SELECT is(pg_temp.pat($q$DELETE FROM engagement.portal_content$q$, 'w'), 'E42501', 'patient claims cannot delete content');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), 'SELECT 1 FROM engagement.portal_content', 'n'), 'n=0', 'portal (report link) claims see 0 content rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM engagement.portal_content', 'n'), 'n=0', 'partner claims see 0 content rows');

-- ===================================================================================================================================== (4) engagement.profile_image
SELECT has_table('engagement'::name, 'profile_image'::name, 'engagement.profile_image exists');
SELECT is(pg_temp.cols_missing('engagement.profile_image', ARRAY['id','tenant_id','profile_kind','profile_id','image_attachment_id',pg_temp.pif(),'version','created_at','created_by','updated_at','updated_by']), NULL, 'profile_image has the 11 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('engagement.profile_image')), true, 'profile_image: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.profile_image') AND polcmd = 'd'), 0, 'profile_image: no DELETE policy');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.profile_image') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'profile_image: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'engagement.profile_image', 'SELECT') AND has_table_privilege('lims_app', 'engagement.profile_image', 'INSERT')
  AND has_table_privilege('lims_app', 'engagement.profile_image', 'UPDATE') AND NOT has_table_privilege('lims_app', 'engagement.profile_image', 'DELETE'))::text$q$), 'true', 'profile_image: lims_app has SELECT, INSERT, UPDATE and no DELETE (clear = deactivate)');
SELECT is(pg_temp.q($q$SELECT (EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'engagement.profile_image'::regclass AND NOT t.tgisinternal AND p.proname = 'tg_row_audit'))::text$q$), 'true',
  'profile_image: row audit trigger (a profile photo change is audited)');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('id', pg_temp.uid(501), 'tenant_id', pg_temp.ta(), 'profile_kind', 'doctor', 'profile_id', pg_temp.uid(701), 'image_attachment_id', pg_temp.uid(301))), 'ok', 'profile_image insert: tenant A / doctor');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('id', pg_temp.uid(502), 'tenant_id', pg_temp.ta(), 'profile_kind', 'centre', 'profile_id', pg_temp.uid(702), 'image_attachment_id', pg_temp.uid(301))), 'ok', 'profile_image insert: tenant A / centre');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('id', pg_temp.uid(503), 'tenant_id', pg_temp.ta(), 'profile_kind', 'staff', 'profile_id', pg_temp.uid(703), 'image_attachment_id', pg_temp.uid(301))), 'ok', 'profile_image insert: tenant A / staff');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('id', pg_temp.uid(510), 'tenant_id', pg_temp.tb(), 'profile_kind', 'doctor', 'profile_id', pg_temp.uid(701), 'image_attachment_id', pg_temp.uid(302))), 'ok',
  'profile_image insert: tenant B / the same profile id as a tenant A doctor is fine (unique per tenant)');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('tenant_id', pg_temp.ta(), 'profile_kind', 'patient', 'profile_id', pg_temp.uid(704), 'image_attachment_id', pg_temp.uid(301))), '23514', 'insert: unknown profile_kind rejected');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('tenant_id', pg_temp.ta(), 'profile_kind', 'doctor', 'profile_id', pg_temp.uid(701), 'image_attachment_id', pg_temp.uid(301))), '23505', 'insert: a second image row for the same profile rejected (one row per profile)');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('tenant_id', pg_temp.ta(), 'profile_kind', 'centre', 'profile_id', pg_temp.uid(701), 'image_attachment_id', pg_temp.uid(301))), 'ok', 'insert: the same profile_id under another kind is a different profile');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('tenant_id', pg_temp.ta(), 'profile_kind', 'staff', 'profile_id', pg_temp.uid(705), 'image_attachment_id', pg_temp.uid(302))), '23503', 'insert: an image of tenant B is rejected for tenant A (composite FK)');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('tenant_id', pg_temp.ta(), 'profile_kind', 'staff', 'profile_id', pg_temp.uid(706), 'image_attachment_id', pg_temp.uid(999))), '23503', 'insert: an unknown image id is rejected');
SELECT is(pg_temp.ins('engagement.profile_image', jsonb_build_object('tenant_id', pg_temp.ta(), 'profile_kind', 'staff', 'profile_id', pg_temp.uid(707))), '23502', 'insert: image_attachment_id is required');
SELECT is(pg_temp.q(format($q$SELECT %I::text FROM engagement.profile_image WHERE id = '0190c700-0000-7000-8000-000000000501'$q$, pg_temp.pif())), 'true', 'profile_image: active by default');
-- set (upsert) and clear (deactivate) as tenant A staff
SELECT is(pg_temp.a($q$INSERT INTO engagement.profile_image (id, tenant_id, profile_kind, profile_id, image_attachment_id, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000520',
  '01a1a98a-ac40-7000-8000-00000000a001', 'doctor', '0190c700-0000-7000-8000-000000000701', '0190c700-0000-7000-8000-000000000301', '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')
  ON CONFLICT (tenant_id, profile_kind, profile_id) DO UPDATE SET image_attachment_id = EXCLUDED.image_attachment_id$q$), 'n=1', 'set image: INSERT ... ON CONFLICT (tenant_id, profile_kind, profile_id) DO UPDATE works for staff (upsert)');
SELECT is(pg_temp.a(format($q$UPDATE engagement.profile_image SET %I = false WHERE id = '0190c700-0000-7000-8000-000000000501'$q$, pg_temp.pif())), 'n=1', 'clear image: staff deactivates the row');
SELECT is(pg_temp.q(format($q$SELECT %I::text FROM engagement.profile_image WHERE id = '0190c700-0000-7000-8000-000000000501'$q$, pg_temp.pif())), 'false', 'clear image: the row is still there, inactive');
SELECT is(pg_temp.a(format($q$UPDATE engagement.profile_image SET %I = true WHERE id = '0190c700-0000-7000-8000-000000000501'$q$, pg_temp.pif())), 'n=1', 'set image again: staff reactivates the same row');
SELECT is(pg_temp.a($q$DELETE FROM engagement.profile_image WHERE id = '0190c700-0000-7000-8000-000000000501'$q$), 'E42501', 'tenant A staff cannot DELETE a profile image row (no grant)');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.profile_image$q$, 'n'), 'n=4', 'tenant A staff sees its 4 rows (501 502 503 and the centre row of 701)');
SELECT is(pg_temp.b($q$SELECT 1 FROM engagement.profile_image$q$, 'n'), 'n=1', 'tenant B staff sees its 1 row');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.profile_image WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B profile images by filter');
SELECT is(pg_temp.a($q$UPDATE engagement.profile_image SET image_attachment_id = '0190c700-0000-7000-8000-000000000301' WHERE id = '0190c700-0000-7000-8000-000000000510'$q$), 'n=0', 'tenant A cannot update a tenant B row');
SELECT is(pg_temp.a($q$UPDATE engagement.profile_image SET image_attachment_id = '0190c700-0000-7000-8000-000000000302' WHERE id = '0190c700-0000-7000-8000-000000000501'$q$), 'E23503', 'tenant A cannot point its row at a tenant B image by UPDATE');
SELECT is(pg_temp.a($q$INSERT INTO engagement.profile_image (id, tenant_id, profile_kind, profile_id, image_attachment_id, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000521',
  '01a1a98a-ac40-7000-8000-00000000b001', 'doctor', '0190c700-0000-7000-8000-000000000799', '0190c700-0000-7000-8000-000000000302', '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'E42501',
  'tenant A cannot insert a profile image for tenant B');
SELECT is(pg_temp.pat('SELECT 1 FROM engagement.profile_image', 'n'), 'n=0', 'patient claims see 0 profile image rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), 'SELECT 1 FROM engagement.profile_image', 'n'), 'n=0', 'portal claims see 0 profile image rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM engagement.profile_image', 'n'), 'n=0', 'partner claims see 0 profile image rows');
SELECT is(pg_temp.pat($q$INSERT INTO engagement.profile_image (id, tenant_id, profile_kind, profile_id, image_attachment_id, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000522',
  '01a1a98a-ac40-7000-8000-00000000a001', 'staff', '0190c700-0000-7000-8000-000000000798', '0190c700-0000-7000-8000-000000000301', '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$, 'w'), 'E42501',
  'patient claims cannot insert a profile image');

-- ===================================================================================================================================== (5) idempotent re-apply: the migration runs again, nothing changes
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'engagement'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'engagement'::regnamespace) AS cons,
         (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'engagement'::regnamespace) AS idxs,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'engagement'::regnamespace) AS pols,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'engagement'::regnamespace AND NOT t.tgisinternal) AS trgs,
         (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'engagement'::regnamespace AND c.relkind IN ('r','p')) AS tbls,
         (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'engagement'::regnamespace AND contype = 'c') AS checks,
         (SELECT count(*) FROM engagement.portal_content) AS n_pc, (SELECT count(*) FROM engagement.profile_image) AS n_pi;
\ir ../../migrations/20261117130000_engagement__add_portal_content.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'engagement'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'engagement'::regnamespace), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'engagement'::regnamespace), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'engagement'::regnamespace), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'engagement'::regnamespace AND NOT t.tgisinternal), (SELECT trgs FROM before_state), 're-apply: trigger count unchanged');
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'engagement'::regnamespace AND c.relkind IN ('r','p')), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is((SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'engagement'::regnamespace AND contype = 'c'), (SELECT checks FROM before_state), 're-apply: every CHECK is unchanged');
SELECT is((SELECT count(*) FROM engagement.portal_content), (SELECT n_pc FROM before_state), 're-apply: no portal_content row added or removed');
SELECT is((SELECT count(*) FROM engagement.profile_image), (SELECT n_pi FROM before_state), 're-apply: no profile_image row added or removed');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'body', '<script>alert(1)</script>')), '23514', 're-apply: the raw HTML check still holds');
SELECT is(pg_temp.ins('engagement.portal_content', jsonb_build_object('tenant_id', pg_temp.ta(), 'kind', 'news', 'title', 'x', 'link_url', 'http://example.org')), '23514', 're-apply: the https only check still holds');
SELECT is(pg_temp.pat($q$SELECT 1 FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000403'$q$, 'n'), 'n=0', 're-apply: a patient still cannot read content that has not started');
SELECT is(pg_temp.a($q$DELETE FROM engagement.portal_content WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 're-apply: still no DELETE grant');

SELECT * FROM finish();
ROLLBACK;
