// tools/devstack/reset.ts — `pnpm dev:reset`: stop, drop volumes (all dev data), re-run up (C0 02-TRD §3.6).
// .env.devstack is kept (secrets are not rotated); delete it first to get fresh ones.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const down = spawnSync('docker', ['compose', '-p', 'lims-devstack', 'down', '--volumes', '--remove-orphans'], { stdio: 'inherit' });
if (down.status !== 0) process.exit(down.status ?? 1);
const up = spawnSync(process.execPath, [join(import.meta.dirname, 'up.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = up.status ?? 1;
