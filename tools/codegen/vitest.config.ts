// [CONV] generateAll over all six module specs takes ~2.5 s; the double-run and CLI --check tests exceed vitest's 5 s default.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 120_000 } });
