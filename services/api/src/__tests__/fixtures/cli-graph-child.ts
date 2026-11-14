// Child process of boot-smoke.test.ts (T0D-DEP-01, LD-179 (4)): the import graph of the script
// `identity:bootstrap-platform-admin` (src/modules/identity/cli/bootstrap-platform-admin.ts and the HTTP GoTrue gateway it loads).
// Imported, not executed as the entry, so its main-guard stays false: no database connection, no network.
const cli = await import('../../modules/identity/cli/bootstrap-platform-admin.js');
const gw = await import('../../modules/identity/gotrue/gateway.http.js');
if (typeof cli.main !== 'function' || typeof gw.gotrueGatewayFromEnv !== 'function') {
  console.error('identity CLI graph loaded but main / gotrueGatewayFromEnv are not functions');
  process.exit(2);
}
console.log('CLI_GRAPH_OK');
process.exit(0);
