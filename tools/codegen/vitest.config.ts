// [CONV] generateAll over all six module specs takes ~2.5 s; the double-run and CLI --check tests exceed vitest's 5 s default.
// T0C-ACCT-1: each openapi test file runs a whole-repo lintRepo; in parallel they starve the worker RPC ("Timeout calling onTaskUpdate", exit 1 with 1063/1063 green). Run files serially.
import { defineConfig } from "vitest/config";

// T0C-ACCT-1 round 6: even serial, whole-repo lintRepo / codegen --check took 68-111 s on a loaded machine (13 s idle) and hit 120 s. Budget raised; no assertion changed.
export default defineConfig({ test: { testTimeout: 300_000, fileParallelism: false } });
