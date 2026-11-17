// GET /platform/dead-letters (02-TRD §5.10; 08 A9.2, A10.2). Query snake -> camel 1:1; an unknown or repeated key -> 400 (D-T15); no ETag.
import { LimsError } from '../../../core/errors.js';
import { bindDeadLetter } from './dead-letter.http.js';
import { obj } from './role.http.js';

const KEYS: Record<string, string> = {
  state: 'state', platform_rows: 'platformRows', tenant_id: 'tenantId', task_identifier: 'taskIdentifier',
  dead_at_from: 'deadAtFrom', dead_at_to: 'deadAtTo', cursor: 'cursor', limit: 'limit',
};
const invalid = (k: string) => new LimsError('common.validation_failed', undefined, [{ path: `/${k}`, code: 'common.field_invalid', message: 'Field invalid' }]);

export const listDeadLetters = bindDeadLetter((s, ctx, req) => {
  const f: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj(req.query))) {
    if (!Object.hasOwn(KEYS, k) || Array.isArray(v)) throw invalid(k);
    if (v !== undefined) f[KEYS[k]!] = v;
  }
  if (f['platformRows'] === 'true') f['platformRows'] = true;
  else if (f['platformRows'] === 'false') f['platformRows'] = false;
  if (typeof f['limit'] === 'string' && /^[0-9]{1,4}$/.test(f['limit'])) f['limit'] = Number(f['limit']);
  return s.listDeadLetters(ctx, f);
});
