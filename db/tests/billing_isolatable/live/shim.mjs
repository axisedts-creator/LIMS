// LD-51 (2026-11-07) T0B-11: live-run helper (test file). Forwards the tool's `psql` spawn into the test container (no host psql here).
import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module";
const real = cp.spawnSync;
cp.spawnSync = (cmd, args = [], opts = {}) => {
  if (cmd !== "psql") return real(cmd, args, opts);
  const name = real("docker", ["ps", "-q", "--filter", "name=lims_t0b11_"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  const a = args.map(s => s.replace(/@127\.0\.0\.1:\d+\//, "@localhost:5432/"));
  const env = opts.env?.PGOPTIONS ? ["-e", "PGOPTIONS=" + opts.env.PGOPTIONS] : [];
  return real("docker", ["exec", "-i", ...env, name, "psql", ...a], opts);
};
syncBuiltinESMExports();
