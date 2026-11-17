// Child process of boot-smoke.test.ts (T0D-DEP-01, LD-179 (4)). Runs under the REAL node with the production --import flag:
//   node --import <register.mjs> src/core/__tests__/boot-smoke-child.ts
// It imports exactly the module graph of src/main.ts (bootstrap + the three job manifests) and of src/core/replay.ts, WITHOUT calling
// createWorkerRuntime / startWorker: no database, no Graphile runner, no metrics server, no port. Erasable TypeScript only.
const boot = await import('../bootstrap.js');
const replay = await import('../replay.js');
const manifests = await Promise.all([
  import('../../jobs/instruments/index.js'),
  import('../../jobs/lab/index.js'),
  import('../../jobs/reporting/index.js'),
]);
const problems: string[] = [];
if (typeof boot.createWorkerRuntime !== 'function') problems.push('bootstrap.createWorkerRuntime is not a function');
if (typeof boot.startWorker !== 'function') problems.push('bootstrap.startWorker is not a function');
if (typeof replay.parseReplayArgs !== 'function') problems.push('replay.parseReplayArgs is not a function');
manifests.forEach((m, i) => { if (typeof m.manifest !== 'object' || m.manifest === null) problems.push(`jobs manifest #${i} missing`); });
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}
console.log('WORKER_GRAPH_OK');
process.exit(0);
