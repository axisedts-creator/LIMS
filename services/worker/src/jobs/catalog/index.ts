// Catalog WorkerManifest (02-CONVENTIONS §2.3). T0B-ASYNC-2 (CR-C0-T0B-ASYNC-1-001; LD-279, LD-189): declares only the three tasks the API
// enqueues. Cron tasks (./cron.ts: expire_imports, purge_files, global_release_fanout) and catalog.import_kinds are added by the task that enables them.
import type { WorkerManifest } from '../../core/manifest.js';
import { EXPORT_BUILD, exportBuild } from './tasks/catalog.export_build.js';
import { IMPORT_COMMIT, importCommit } from './tasks/catalog.import_commit.js';
import { IMPORT_VALIDATE, importValidate } from './tasks/catalog.import_validate.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'catalog',
  tasks: Object.freeze({ [EXPORT_BUILD]: exportBuild, [IMPORT_VALIDATE]: importValidate, [IMPORT_COMMIT]: importCommit }),
});
