// tools/devstack/push-all-db.ts — Push all migrations and seeds to database (dev/staging/local)
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

function execQuery(sql: string): string {
  const res = spawnSync('docker', [
    'exec', '-i',
    'supabase_db_LIMS',
    'psql', '-U', 'postgres', '-d', 'postgres',
    '-tAc', sql
  ], {
    encoding: 'utf8',
  });
  return (res.stdout || '').trim();
}

function runSql(sql: string, label: string): void {
  const res = spawnSync('docker', [
    'exec', '-i',
    'supabase_db_LIMS',
    'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1',
    '-1',
    '-q',
    '-f', '-'
  ], {
    input: sql,
    encoding: 'utf8',
  });

  if (res.status !== 0) {
    console.error(`FAILED: ${label}`);
    console.error(res.stderr);
    throw new Error(`Execution failed for ${label}: ${res.stderr}`);
  }
  console.log(`OK: ${label}`);
}

async function main() {
  console.log('=== Initializing Migration Tracking ===');
  runSql(`
    CREATE SCHEMA IF NOT EXISTS migrations_meta AUTHORIZATION lims_migrator;
    CREATE TABLE IF NOT EXISTS migrations_meta.revisions (
      version varchar(255) PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    );
  `, 'Create revisions table');

  // Check if schemas were already created
  const hasAppSchema = execQuery("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app';");
  if (hasAppSchema === '1') {
    runSql("INSERT INTO migrations_meta.revisions (version) VALUES ('20261105000000_app__create_schemas.sql') ON CONFLICT DO NOTHING;", 'Record initial schemas');
  }

  // Ensure graphile_worker ownership by lims_queue
  runSql(`
    ALTER SCHEMA graphile_worker OWNER TO lims_queue;
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'graphile_worker' LOOP
        BEGIN
          EXECUTE 'ALTER TABLE graphile_worker.' || quote_ident(r.tablename) || ' OWNER TO lims_queue;';
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END LOOP;
      FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'graphile_worker' LOOP
        BEGIN
          EXECUTE 'ALTER VIEW graphile_worker.' || quote_ident(r.viewname) || ' OWNER TO lims_queue;';
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END LOOP;
      FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'graphile_worker' LOOP
        BEGIN
          EXECUTE 'ALTER SEQUENCE graphile_worker.' || quote_ident(r.sequencename) || ' OWNER TO lims_queue;';
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END LOOP;
      FOR r IN SELECT proname, oidvectortypes(proargtypes) as args FROM pg_proc WHERE pronamespace = 'graphile_worker'::regnamespace LOOP
        BEGIN
          EXECUTE 'ALTER FUNCTION graphile_worker.' || quote_ident(r.proname) || '(' || r.args || ') OWNER TO lims_queue;';
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END LOOP;
    END $$;
  `, 'Ensure graphile_worker ownership');

  const appliedRevisions = new Set(execQuery('SELECT version FROM migrations_meta.revisions;').split(/\r?\n/).filter(Boolean));

  console.log('\n=== Pushing Migrations ===');
  const migrationsDir = join(ROOT, 'db', 'migrations');
  const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of migrationFiles) {
    if (appliedRevisions.has(file)) {
      console.log(`SKIPPED (already applied): ${file}`);
      continue;
    }

    const fullPath = join(migrationsDir, file);
    const sql = readFileSync(fullPath, 'utf8');
    runSql(`
      ${sql}
      INSERT INTO migrations_meta.revisions (version) VALUES ('${file}') ON CONFLICT DO NOTHING;
    `, `Migration: ${file}`);
  }

  console.log('\n=== Pushing Seeds ===');
  const seedsDir = join(ROOT, 'db', 'seeds');
  const seedFiles = readdirSync(seedsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of seedFiles) {
    const fullPath = join(seedsDir, file);
    const sql = readFileSync(fullPath, 'utf8');
    runSql(sql, `Seed: ${file}`);
  }

  console.log('\n=== Database Push Complete! All migrations and seeds applied successfully. ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
