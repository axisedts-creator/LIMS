// tools/devstack/down.ts — `pnpm dev:down`: stop the dev stack, keep volumes (C0 02-TRD §3.6).
// By project name, so it works even when .env.devstack is gone (compose.yaml interpolation needs it).
import { spawnSync } from 'node:child_process';

const r = spawnSync('docker', ['compose', '-p', 'lims-devstack', 'down', '--remove-orphans'], { stdio: 'inherit' });
process.exitCode = r.status ?? 1;
