SELECT '# P1 ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || roles::text || ' ' || cmd FROM pg_policies WHERE (qual ~ 'app\.(pre_|maintenance)' OR with_check ~ 'app\.(pre_|maintenance)') AND roles <> '{lims_owner}';
SELECT '# P2 ' || string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace = 'identity'::regnamespace AND c.relkind IN ('r','p');
SELECT '# P3 ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || roles::text FROM pg_policies WHERE qual = 'true' OR with_check = 'true';
SELECT '# P4 ' || count(*) || ' ' || string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c WHERE c.relnamespace = 'engagement'::regnamespace AND c.relkind IN ('r','p');
SELECT '# P5 ' || p.proname || ' ' || coalesce(p.proconfig::text, 'NULL') FROM pg_proc p WHERE p.pronamespace = 'engagement'::regnamespace AND p.proname IN ('resolve_preauth','resolve_display','purge_queue','purge_payment_requests');
SELECT '# P6 ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, 'NULL') FROM pg_proc p WHERE p.proname = 'uuidv7' AND p.pronamespace='app'::regnamespace;
SELECT '# P7 ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, 'NULL') FROM pg_proc p WHERE p.proname = 'identity_login_context';
