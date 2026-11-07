// deviceToken AuthResolver (02-TRD §7.1, §6.3; 07-SECURITY AB3/AB12, S-05; AC-01.5). One SELECT, no write (no tenant yet).
// Every failure returns the same { error } so core throws one identical 401 auth.device_token_invalid.
import type { AuthResolver } from '../../../core/auth/resolvers.js';
import { hashCredential, type QueryTx } from '../service/credentials.service.js';

export type CredentialFormat = 'device_token' | 'enrolment_code';
export interface MetricSink { inc(name: string, labels?: Record<string, string | number>): void }

const DEVICE_TOKEN = /^lmsd_[A-Za-z0-9_-]{43}$/; // no /m flag; '$' alone would accept a trailing \n, so length is checked too
const ENROLMENT_CODE = /^lmse_[A-Za-z0-9_-]{22}$/;
const FAILURE = Object.freeze({ error: 'auth.device_token_invalid' });
const FAIL_METRIC = 'lims_instruments_device_auth_failures_total';

export function classifyCredential(s: unknown): CredentialFormat | undefined {
  if (typeof s !== 'string') return undefined;
  if (s.length === 48 && DEVICE_TOKEN.test(s)) return 'device_token';
  if (s.length === 27 && ENROLMENT_CODE.test(s)) return 'enrolment_code';
  return undefined;
}

type Row = { tenant_id: string; agent_id: string; centre_id: string; credential_id: string; credential_kind: string };

export function createDeviceTokenResolver(deps: { metrics: MetricSink }): AuthResolver {
  const failed = (reason: 'format' | 'unknown') => { deps.metrics.inc(FAIL_METRIC, { reason }); return FAILURE; };
  return {
    async resolve(credential, tx) {
      if (!classifyCredential(credential)) return failed('format');
      const { rows } = await (tx as QueryTx).query(
        'SELECT * FROM app.instruments_resolve_device_credential($1)', [hashCredential(credential)],
      );
      const r = rows[0] as Row | undefined;
      if (!r) return failed('unknown');
      return {
        tenantId: r.tenant_id, actor: { type: 'device', id: r.agent_id }, centreId: r.centre_id,
        extraClaims: { credential_kind: r.credential_kind, credential_id: r.credential_id },
      };
    },
  };
}
