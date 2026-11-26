// Test database variables for the CI jobs `integration` and `isolation` (02-TRD gate 4, gate 10).
//
// The live suites were written module by module, each with its own harness script, and they do not agree on every name:
//   same meaning everywhere      LIMS_TEST_APP_URL            login lims_api (inherits lims_app, row security on)
//                                LIMS_TEST_SUPER_URL          superuser
//                                LIMS_TEST_ADMIN_DATABASE_URL superuser
//                                LIMS_TEST_WORKER_URL         login lims_worker
//   meaning depends on module    LIMS_TEST_DATABASE_URL       superuser in analytics, anatomic, billing, payments, identity and the
//                                                             worker jobs analytics / billing / frontdesk; lims_api everywhere else
//                                LIMS_TEST_APP_DATABASE_URL   a login that may SET ROLE lims_app (anatomic, billing, payments do
//                                                             `SET LOCAL ROLE lims_app`; lims_api may not, 00_roles.sql) -> superuser
//                                                             there; lims_api for the suites that only use requestTx
// So the value is chosen per test file, from the module folder in its path. Three base URLs come from the environment
// (tools/devstack/test-env.ts writes them in CI). Without them nothing is set and every suite behaves as before.
//
// A value somebody exported by hand is never replaced: a variable is written only when it is unset or holds one of the
// three base URLs (that is, an earlier test file in the same worker process set it).
export type Base = { superUrl: string; apiUrl: string; workerUrl: string };

export const BASE_VARS = { superUrl: 'LIMS_CI_DB_SUPER_URL', apiUrl: 'LIMS_CI_DB_API_URL', workerUrl: 'LIMS_CI_DB_WORKER_URL' } as const;

const SUPER_AS_DATABASE_URL = /\/(?:modules\/(?:analytics|anatomic|billing|payments|identity)|jobs\/(?:analytics|billing|frontdesk))\//;
const SUPER_AS_APP_DATABASE_URL = /\/modules\/(?:anatomic|billing|payments)\//;

/** The LIMS_TEST_* values one test file gets. `testPath` may use either slash. */
export function liveDbEnv(testPath: string, base: Base): Record<string, string> {
  const p = testPath.split('\\').join('/');
  return {
    LIMS_TEST_APP_URL: base.apiUrl,
    LIMS_TEST_SUPER_URL: base.superUrl,
    LIMS_TEST_ADMIN_DATABASE_URL: base.superUrl,
    LIMS_TEST_WORKER_URL: base.workerUrl,
    LIMS_TEST_DATABASE_URL: SUPER_AS_DATABASE_URL.test(p) ? base.superUrl : base.apiUrl,
    LIMS_TEST_APP_DATABASE_URL: SUPER_AS_APP_DATABASE_URL.test(p) ? base.superUrl : base.apiUrl,
  };
}

/** Reads the three base URLs; undefined unless all three are set. */
export function baseFromEnv(env: Record<string, string | undefined>): Base | undefined {
  const superUrl = env[BASE_VARS.superUrl], apiUrl = env[BASE_VARS.apiUrl], workerUrl = env[BASE_VARS.workerUrl];
  return superUrl && apiUrl && workerUrl ? { superUrl, apiUrl, workerUrl } : undefined;
}

/** Writes the values for `testPath` into `env`. Returns the names it wrote. */
export function applyLiveDbEnv(testPath: string, env: Record<string, string | undefined>): string[] {
  const base = baseFromEnv(env);
  if (!base) return [];
  const ours = new Set([base.superUrl, base.apiUrl, base.workerUrl]);
  const written: string[] = [];
  for (const [k, v] of Object.entries(liveDbEnv(testPath, base))) {
    const cur = env[k];
    if (cur !== undefined && !ours.has(cur)) continue; // exported by hand: keep
    env[k] = v;
    written.push(k);
  }
  return written;
}
