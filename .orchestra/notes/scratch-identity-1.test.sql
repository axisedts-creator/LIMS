SELECT '# Q4 membership statuses ' || status || ' ' || actor_type || ' ' || count(*) FROM core.memberships WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' GROUP BY status, actor_type ORDER BY 1;
SELECT '# Q5 users cols ' || (SELECT string_agg(column_name || ':' || is_nullable || ':' || coalesce(column_default,''), ',') FROM information_schema.columns WHERE table_schema='core' AND table_name='users');
SELECT '# Q7 audit trigger: ' || tgrelid::regclass::text FROM pg_trigger WHERE tgfoid = 'app.tg_row_audit()'::regprocedure AND tgrelid::regclass::text LIKE 'identity.%' ORDER BY 1;
SELECT '# Q8 sess policies ' || tablename || ' ' || policyname FROM pg_policies WHERE schemaname='identity' AND tablename IN ('sessions','mfa_factors') ORDER BY 1;
SELECT '# Q9 partner/patient membership users ' || actor_type || ' ' || user_id FROM core.memberships WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND actor_type <> 'user';
