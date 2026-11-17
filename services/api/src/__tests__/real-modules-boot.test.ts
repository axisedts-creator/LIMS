// T0D-01 / LD-53 (2): the real modules directory boots from the setup-provided env alone (no per-module process env
// supplied by the test). A module that fails boot at import on bad config is still a boot failure (TRD 10.1).
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../core/bootstrap.js';
import { loadConfig } from '../core/config.js';

describe('boot of the real modules directory with the setup env', () => {
  let app: FastifyInstance | undefined;
  afterAll(async () => { await app?.close(); });

  it('has the setup-provided ci env', () => {
    expect(process.env.LIMS_CORE_ENV).toBe('ci');
    expect(process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE).toBeTruthy();
    expect(process.env.LIMS_CORE_JWT_KEY_FILE).toBeTruthy();
  });

  it('bootstrap({ config: loadConfig(process.env) }) resolves and serves core health', async () => {
    app = await bootstrap({ config: loadConfig(process.env) });
    const res = await app.inject({ method: 'GET', url: '/v1/core/health/live' });
    expect(res.statusCode).toBe(200);
  }, 60_000);
});
