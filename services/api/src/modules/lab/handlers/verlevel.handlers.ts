// T0B-VERLEVEL-1 handlers (LD-316; T0C-VERLEVEL-1 contract): listVerificationPolicies, upsertVerificationPolicy, getResultSignoffs. Request -> service (service/signoff.service.ts).
// The x-permission is asserted by the handlers/index.ts gate before this code; tenant comes from ctx only.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { getResultSignoffs, listVerificationPolicies, parsePolicyUpsert, upsertVerificationPolicy } from '../service/signoff.service.js';
import { authed, obj } from './resultEntry.handlers.js';
import { invalid, MAX_VERSION } from './verify.handlers.js';

/** optional If-Match "<n>" (absent = create). */
function optionalIfMatch(headers: unknown): number | undefined {
  const h = obj(headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) throw invalid('/headers/if-match');
  return Number(m[1]);
}

const list: Handler = async (_req, hctx) => ({ status: 200, body: { data: await listVerificationPolicies(authed(hctx)) } });

const upsert: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const body = parsePolicyUpsert(req.body);
  const ifMatch = optionalIfMatch(req.headers);
  return { status: 200, body: await upsertVerificationPolicy(ctx, { body, ...(ifMatch === undefined ? {} : { ifMatch }) }) };
};

const signoffs: Handler = async (req, hctx) => {
  const ctx = authed(hctx);
  const id = obj(req.params)['result_id'];
  if (typeof id !== 'string' || id === '') throw new LimsError('common.not_found');
  return { status: 200, body: { data: await getResultSignoffs(ctx, { resultId: id }) } };
};

export const verlevelHandlers: Readonly<Record<'listVerificationPolicies' | 'upsertVerificationPolicy' | 'getResultSignoffs', Handler>> = Object.freeze({
  listVerificationPolicies: list, upsertVerificationPolicy: upsert, getResultSignoffs: signoffs,
});
