// vitest setupFile (services/api, services/worker): runs before each test file is imported, so helpers that read
// LIMS_TEST_* at import time see the values. Does nothing unless the three LIMS_CI_DB_* base URLs are set (see live-db.ts).
import { expect } from 'vitest';
import { applyLiveDbEnv } from './live-db.ts';

const testPath = expect.getState().testPath;
if (testPath) applyLiveDbEnv(testPath, process.env);
