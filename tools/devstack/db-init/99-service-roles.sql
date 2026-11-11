-- Dev stack only: give the Supabase service login roles (SP-3 names) the stack's Postgres password, as the upstream
-- self-hosting stack's roles.sql does. Runs once, on first init of the db volume. Password from the container env, never literal.
\set pgpass `echo "$POSTGRES_PASSWORD"`
ALTER USER authenticator          WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin    WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
