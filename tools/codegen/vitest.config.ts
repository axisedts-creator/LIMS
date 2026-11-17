// [CONV] generateAll over all six module specs takes ~2.5 s; the double-run and CLI --check tests exceed vitest's 5 s default.
// T0C-ACCT-1: each openapi test file runs a whole-repo lintRepo; in parallel they starve the worker RPC ("Timeout calling onTaskUpdate", exit 1 with 1063/1063 green). Run files serially.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 120_000, fileParallelism: false } });
