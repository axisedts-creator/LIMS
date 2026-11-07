// Loads config, boots the API, listens (02-TRD §6.1). Port 8080 = C1 `http://api:8080` on app_net [CONV].
import { bootstrap } from './core/bootstrap.js';
import { loadConfig } from './core/config.js';

const app = await bootstrap({ config: loadConfig(process.env) });
await app.listen({ host: '0.0.0.0', port: 8080 });
