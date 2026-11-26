// Test database variables for the CI jobs `integration` and `isolation` (02-TRD gate 4, gate 10).
//
// The live suites were written module by module, each with its own harness script, and they do not agree on every name:
//   same meaning everywhere      LIMS_TEST_APP_URL            login lims_api (inherits lims_app, row security on)
//                                LIMS_TEST_SUPER_URL          superuser
//                                LIMS_TEST_ADMIN_DATABASE_URL superuser
//                                LIMS_TEST_WORKER_URL         login lims_worker
//   meaning depends on module    LIMS_TEST_DATABASE_URL       superuser in analytics, anatomic, billing, payments, identity and the
//                                                             worker jobs analytics / billing / frontdesk; lims_api everywhere else
//                                LIMS_TEST_APP_DATABASE_URL   anatomic, billing and payments need a login that IS lims_app when it
//                                                             connects (their requestTx calls run with no SET ROLE and must have row
//                                                             security on) AND may `SET LOCAL ROLE lims_app` (their raw SQL probes).
//                                                             lims_api may not SET ROLE (00_roles.sql) and a superuser bypasses row
//                                                             security, so CI creates the test-only login lims_ci_app for them
//                                                             (LIMS_CI_DB_APPROLE_URL). Other suites get lims_api.
// So the value is chosen per test file, from the module folder in its path. Three base URLs come from the environment
// (tools/devstack/test-env.ts writes them in CI). Without them nothing is set and every suite behaves as before.
//
// A value somebody exported by hand is never replaced: a variable is written only when it is unset or holds one of the
// base URLs (that is, an earlier test file in the same worker process set it).
export type Base = { superUrl: string; apiUrl: string; workerUrl: string; appRoleUrl?: string };

export const BASE_VARS = { superUrl: 'LIMS_CI_DB_SUPER_URL', apiUrl: 'LIMS_CI_DB_API_URL', workerUrl: 'LIMS_CI_DB_WORKER_URL', appRoleUrl: 'LIMS_CI_DB_APPROLE_URL' } as const;

const SUPER_AS_DATABASE_URL = /\/(?:modules\/(?:analytics|anatomic|billing|payments|identity)|jobs\/(?:analytics|billing|frontdesk))\//;
const APPROLE_AS_APP_DATABASE_URL = /\/modules\/(?:anatomic|billing|payments)\//;

const MANAGED = ['LIMS_TEST_APP_URL', 'LIMS_TEST_SUPER_URL', 'LIMS_TEST_ADMIN_DATABASE_URL', 'LIMS_TEST_WORKER_URL', 'LIMS_TEST_DATABASE_URL', 'LIMS_TEST_APP_DATABASE_URL'] as const;

/** The LIMS_TEST_* values one test file gets. `testPath` may use either slash. */
export function liveDbEnv(testPath: string, base: Base): Record<string, string> {
  const p = testPath.split('\\').join('/');
  return {
    LIMS_TEST_APP_URL: base.apiUrl,
    LIMS_TEST_SUPER_URL: base.superUrl,
    LIMS_TEST_ADMIN_DATABASE_URL: base.superUrl,
    LIMS_TEST_WORKER_URL: base.workerUrl,
    LIMS_TEST_DATABASE_URL: SUPER_AS_DATABASE_URL.test(p) ? base.superUrl : base.apiUrl,
    // without the test login these three modules are left unset (their suites skip) rather than run with row security off
    ...(APPROLE_AS_APP_DATABASE_URL.test(p) ? (base.appRoleUrl ? { LIMS_TEST_APP_DATABASE_URL: base.appRoleUrl } : {}) : { LIMS_TEST_APP_DATABASE_URL: base.apiUrl }),
  };
}

/** Reads the three base URLs; undefined unless all three are set. */
export function baseFromEnv(env: Record<string, string | undefined>): Base | undefined {
  const superUrl = env[BASE_VARS.superUrl], apiUrl = env[BASE_VARS.apiUrl], workerUrl = env[BASE_VARS.workerUrl];
  const appRoleUrl = env[BASE_VARS.appRoleUrl];
  return superUrl && apiUrl && workerUrl ? { superUrl, apiUrl, workerUrl, ...(appRoleUrl ? { appRoleUrl } : {}) } : undefined;
}

/** Writes the values for `testPath` into `env`. Returns the names it wrote. */
export function applyLiveDbEnv(testPath: string, env: Record<string, string | undefined>): string[] {
  const base = baseFromEnv(env);
  if (!base) return [];
  const ours = new Set([base.superUrl, base.apiUrl, base.workerUrl, base.appRoleUrl]);
  const written: string[] = [];
  const next = liveDbEnv(testPath, base);
  // a value this function set for an earlier file in the same process must not leak into a file that gets none
  for (const k of MANAGED) if (!(k in next) && env[k] !== undefined && ours.has(env[k])) delete env[k];
  for (const [k, v] of Object.entries(next)) {
    const cur = env[k];
    if (cur !== undefined && !ours.has(cur)) continue; // exported by hand: keep
    env[k] = v;
    written.push(k);
  }
  return written;
}
