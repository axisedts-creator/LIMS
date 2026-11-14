// Single reader for the web BFF's X-Lims-Bff-Key (02-TRD §11, §12.1). Server-only: imported by c2.ts and admin auth actions.
// LD-174: the key file always wins; the LIMS_WEB_BFF_KEY environment fallback is honoured only when LIMS_CORE_ENV is
// exactly dev, ci or staging. Production, unset or any other value fails closed exactly as before.
// The build-mode variable is deliberately not consulted (it is production in every deployed build). Never log the key.
import { readFileSync } from 'node:fs';

const FALLBACK_ENVS = new Set(['dev', 'ci', 'staging']);

export function readBffKey(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.LIMS_WEB_BFF_KEY_FILE;
  if (file) {
    const key = readFileSync(file, 'utf8').trim();
    if (!key) throw new Error('LIMS_WEB_BFF_KEY_FILE is empty');
    return key;
  }
  const value = env.LIMS_WEB_BFF_KEY;
  if (value !== undefined && FALLBACK_ENVS.has(env.LIMS_CORE_ENV ?? '')) {
    const key = value.trim();
    if (!key) throw new Error('LIMS_WEB_BFF_KEY is empty');
    return key;
  }
  throw new Error('LIMS_WEB_BFF_KEY_FILE is not set');
}
