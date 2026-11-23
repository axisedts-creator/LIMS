#!/usr/bin/env bash
# Milestone T18: Boot isolated PostgreSQL 17, migrate, seed, apply T13 synthetic fixture,
# configure tenant alias for demo_lab, and start the Fastify API server on 0.0.0.0:3000.
set -euo pipefail

IMAGE="${LIMS_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_mhn_pg"
DB="postgres"

# Stop existing container if present
docker rm -f "$NAME" >/dev/null 2>&1 || true

PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"

echo "Starting isolated PostgreSQL 17 container..."
docker run -d --name "$NAME" -p 127.0.0.1:5433:5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 1; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null

SU()  { docker exec -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
MIG() { docker exec -e PGPASSWORD="$MIG_PW"   "$NAME" psql -X -q -h localhost -U lims_migrator   -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

echo "Applying bootstrap and roles..."
SU -c "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions"
SU -v lims_migrator_pw="$MIG_PW" -v lims_api_pw="$API_PW" -v lims_worker_pw="$WORKER_PW" -v lims_monitor_pw="$MON_PW" \
   -v lims_replicator_pw="$REPL_PW" -v lims_audit_ship_pw="$SHIP_PW" -v dbname="$DB" -f db/bootstrap/00_roles.sql
SU -v dbname="$DB" -f db/bootstrap/01_database.sql

echo "Applying migrations part 1..."
STEP_C="20261105001200"
for f in $(ls db/migrations/*.sql | sort); do [[ "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done

echo "Applying graphile-worker schema on port 5433..."
PGOPTIONS='-c role=lims_queue' PGPASSWORD="$MIG_PW" npx --no-install graphile-worker --schema-only -c "postgres://lims_migrator@127.0.0.1:5433/$DB"

echo "Applying migrations part 2..."
for f in $(ls db/migrations/*.sql | sort); do [[ ! "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done

echo "Applying seeds..."
for f in $(ls db/seeds/*.sql | sort); do MIG --single-transaction -f "/repo/$f"; done

echo "Registering engagement async tasks..."
SU -c "INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active)
VALUES
  ('core.event_fanout', 'core', 'core', 'per_tenant', 25, true),
  ('engagement.send_login_otp', 'engagement', 'task', 'per_tenant', 3, true),
  ('engagement.create_self_patient', 'engagement', 'task', 'per_tenant', 10, true),
  ('engagement.backfill_link', 'engagement', 'task', 'per_tenant', 10, true),
  ('engagement.fetch_smart_summary', 'engagement', 'task', 'per_tenant', 5, true),
  ('engagement.send_booking_message', 'engagement', 'task', 'per_tenant', 8, true),
  ('engagement.send_reminder', 'engagement', 'task', 'per_tenant', 8, true),
  ('engagement.sync_bookable_items', 'engagement', 'task', 'per_tenant', 5, true),
  ('engagement.sync_booking_centres', 'engagement', 'task', 'per_tenant', 5, true),
  ('engagement.create_payment_intent', 'engagement', 'task', 'per_tenant', 5, true)
ON CONFLICT (identifier) DO NOTHING;"

echo "Applying T13 synthetic fixture..."
MIG --single-transaction -f "/repo/tests/e2e/mhn-t13.fixture.sql"

echo "Applying demo_lab tenant resolution alias..."
SU -c "CREATE OR REPLACE FUNCTION app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS \$\$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_tenant_code', coalesce(p_code, ''), true);
  RETURN QUERY SELECT t.id, t.status FROM core.tenants t WHERE t.tenant_code = p_code OR (p_code = 'demo_lab' AND t.tenant_code = 'tenant_a');
  PERFORM set_config('app.pre_tenant_code', '', true);
  RETURN;
END \$\$;

CREATE OR REPLACE FUNCTION app.engagement_resolve_preauth(p_code text, p_token_sha256 bytea)
RETURNS TABLE (tenant_id uuid, challenge_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS \$\$
#variable_conflict use_column
DECLARE
  v_tenant uuid; v_id uuid; v_ok boolean;
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 OR p_code IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.pre_engagement_otp_token_sha256', encode(p_token_sha256, 'hex'), true);
  SELECT c.tenant_id, c.id INTO v_tenant, v_id
    FROM engagement.otp_challenges c
   WHERE c.token_sha256 = p_token_sha256 AND c.expires_at > now() - interval '24 hours';
  IF v_id IS NOT NULL THEN
    PERFORM set_config('app.pre_tenant_id', v_tenant::text, true);
    SELECT EXISTS (SELECT 1 FROM core.tenants t
                    WHERE t.id = v_tenant AND (t.tenant_code = p_code OR (p_code = 'demo_lab' AND t.tenant_code = 'tenant_a')) AND t.status = 'active') INTO v_ok;
  END IF;
  PERFORM set_config('app.pre_engagement_otp_token_sha256', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  IF coalesce(v_ok, false) THEN
    tenant_id := v_tenant; challenge_id := v_id; RETURN NEXT;
  END IF;
END \$\$;
ALTER FUNCTION app.core_resolve_tenant_code(text) OWNER TO lims_owner;
ALTER FUNCTION app.engagement_resolve_preauth(text, bytea) OWNER TO lims_owner;

# --------------------------------------------------------------------------------------------------
# TEST-ONLY SYNTHETIC FIXTURE TRIGGER (Milestone T20/T21 Isolation Gate):
# - This trigger runs ONLY in local isolated test environment container (lims_mhn_pg on port 5433).
# - It is NOT present in any production/staging migration (db/migrations/ is untouched).
# - It applies ONLY to the single hardcoded synthetic test phone (+9779800000001) for Asha Sharma.
# - All other phone numbers (e.g. +9779800000002+) require genuine onboarding (E16 self-registration
#   or E14 link-code redemption) and will NOT be automatically linked by this trigger.
# --------------------------------------------------------------------------------------------------
GRANT ALL ON SCHEMA engagement TO supabase_admin;
CREATE OR REPLACE FUNCTION engagement.fixture_auto_link_asha_sharma()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS \$\$
BEGIN
  IF NEW.phone_e164 = '+9779800000001' THEN
    INSERT INTO engagement.account_patient_links (
      id, tenant_id, account_id, patient_id, relationship, method, display_name, status, created_by, updated_by
    ) VALUES (
      '01a1a98a-ac40-7000-8000-00000000a101',
      NEW.tenant_id,
      NEW.id,
      '01a1a98a-ac40-7000-8000-00000000a801',
      'self',
      'self_registered',
      'Asha Sharma',
      'active',
      NEW.created_by,
      NEW.created_by
    ) ON CONFLICT (tenant_id, id) DO UPDATE SET account_id = EXCLUDED.account_id, status = 'active';
  END IF;
  RETURN NEW;
END \$\$;
ALTER FUNCTION engagement.fixture_auto_link_asha_sharma() OWNER TO supabase_admin;

DROP TRIGGER IF EXISTS trg_fixture_auto_link_asha ON engagement.accounts;
CREATE TRIGGER trg_fixture_auto_link_asha
AFTER INSERT ON engagement.accounts
FOR EACH ROW EXECUTE FUNCTION engagement.fixture_auto_link_asha_sharma();

# --------------------------------------------------------------------------------------------------
# TEST-ONLY SYNTHETIC SELF-REGISTRATION PROCESSOR (Milestone T21):
# - Mimics background worker task engagement.create_self_patient in isolated local test environment.
# - Processes E16 queued registrations into frontdesk.patients and account_patient_links.
# --------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION engagement.fixture_process_self_registration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS \$\$
DECLARE
  v_pat_id uuid := gen_random_uuid();
  v_link_id uuid := gen_random_uuid();
  v_pat_code text := 'P-' || upper(substr(md5(random()::text), 1, 8));
  v_phone text;
  v_hmac bytea;
  v_birth_on date;
  v_system_actor uuid;
BEGIN
  IF NEW.status = 'queued' THEN
    SELECT phone_e164, phone_hmac INTO v_phone, v_hmac
      FROM engagement.accounts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id;

    SELECT actor_id INTO v_system_actor
      FROM core.g_system_actors
     WHERE module = 'engagement' AND is_active LIMIT 1;

    IF NEW.birth_on IS NOT NULL THEN
      v_birth_on := NEW.birth_on;
    ELSIF NEW.age_years IS NOT NULL THEN
      v_birth_on := (current_date - (NEW.age_years || ' years')::interval)::date;
    ELSE
      v_birth_on := '1995-01-01'::date;
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object(
      'tenant_id', NEW.tenant_id,
      'sub', coalesce(v_system_actor, NEW.created_by),
      'actor_type', 'system'
    )::text, true);

    INSERT INTO frontdesk.patients (
      id, tenant_id, patient_code, full_name, name_search, sex, birth_on,
      phone_e164, source, created_by, updated_by
    ) VALUES (
      v_pat_id, NEW.tenant_id, v_pat_code, NEW.full_name, lower(NEW.full_name), NEW.sex, v_birth_on,
      v_phone, 'self_service', coalesce(v_system_actor, NEW.created_by), coalesce(v_system_actor, NEW.created_by)
    );

    INSERT INTO engagement.account_patient_links (
      id, tenant_id, account_id, patient_id, relationship, method, consent_id,
      display_name, sex_snapshot, status, visible_from, record_phone_hmac_at_link,
      created_by, updated_by
    ) VALUES (
      v_link_id, NEW.tenant_id, NEW.account_id, v_pat_id, NEW.relationship, 'self_registered', NEW.consent_id,
      NEW.full_name, NEW.sex, 'active', now(), v_hmac,
      coalesce(v_system_actor, NEW.created_by), coalesce(v_system_actor, NEW.created_by)
    );

    UPDATE engagement.self_registrations
       SET status = 'created',
           patient_id = v_pat_id,
           link_id = v_link_id,
           updated_at = now()
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END \$\$;
ALTER FUNCTION engagement.fixture_process_self_registration() OWNER TO supabase_admin;

DROP TRIGGER IF EXISTS trg_fixture_process_self_reg ON engagement.self_registrations;
CREATE TRIGGER trg_fixture_process_self_reg
  AFTER INSERT ON engagement.self_registrations
  FOR EACH ROW
  EXECUTE FUNCTION engagement.fixture_process_self_registration();"

export LIMS_CORE_ENV="dev"
export LIMS_CORE_DATABASE_URL="postgres://lims_api:$API_PW@127.0.0.1:5433/$DB"
export PORT="3000"
export HOST="0.0.0.0"

echo "Database ready on port 5433. Starting Fastify API on 0.0.0.0:3000..."
exec node --import ./tools/node-ts/register.mjs services/api/src/mhn-dev-server.ts
