// Loads config, boots the API, listens (02-TRD §6.1). Port 8080 = C1 `http://api:8080` on app_net [CONV].
// T0B-PERF-1 (LD-310): nothing but bootstrap runs before listen, so readiness answers first while the API wakes;
// SIGTERM/SIGINT drain in-flight requests before exit.
import { bootstrap } from './core/bootstrap.js';
import { loadConfig } from './core/config.js';
import { installShutdown } from './core/shutdown.js';

// T0B-OPSDOC-1 (LD-277): readiness lists unset required LIMS_* names (names only).
const app = await bootstrap({ config: loadConfig(process.env), env: process.env });
installShutdown(app);
const listening = app.listen({ host: '0.0.0.0', port: 8080 });
await listening;
