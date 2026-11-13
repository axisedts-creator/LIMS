// identity.import_breached_passwords (02-TRD §10 jobs table, §11 LIMS_IDENTITY_BREACHED_LIST_PATH; 05-SCHEMA §6; max_attempts 3; idempotent by file sha256).
// Manual platform task, payload {}. The file = one 40-hex SHA-1 per line (CRLF/blank lines tolerated). The whole file is validated BEFORE any DB call:
// a bad line or an empty file never reaches app.identity_finish_breached_import (which deletes every older list version).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LimsError, type ErrorCode } from '../../../../../../packages/shared-ts/src/errors/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { platformOnly } from './shared.js';
import { idMetrics } from '../../../../../api/src/modules/identity/metrics.js';

export const IMPORT_BREACHED_PASSWORDS = 'identity.import_breached_passwords';
const ENV = 'LIMS_IDENTITY_BREACHED_LIST_PATH';
const BATCH = 10_000;
const HASH = /^[0-9a-f]{40}$/i;

const reject = (code: string, why: string): never => { throw new LimsError(code as ErrorCode, `${IMPORT_BREACHED_PASSWORDS}: ${why}`); };

export const importBreachedPasswords: TaskHandler = async (payload, ctx) => {
  platformOnly(IMPORT_BREACHED_PASSWORDS, payload, ctx);
  const path = process.env[ENV];                                                   // read at run time, never at import
  if (!path) reject('common.internal', `${ENV} is not set`);
  // ponytail: whole file in memory (fine for a curated list); stream + two-pass hash if the list grows past a few hundred MB.
  const bytes = await readFile(path!).catch(() => reject('common.internal', 'list file unreadable'));
  const version = createHash('sha256').update(bytes).digest('hex');
  const unique = new Set<string>();
  let lineNo = 0;
  for (const raw of bytes.toString('utf8').split('\n')) {
    lineNo += 1;
    const line = raw.trim();
    if (line === '') continue;
    if (!HASH.test(line)) reject('common.validation_failed', `line ${lineNo} is not a 40-hex SHA-1`);   // no line content in the message
    unique.add(line.toLowerCase());
  }
  if (unique.size === 0) reject('common.validation_failed', 'list file is empty');

  const all = [...unique];
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH).map((h) => Buffer.from(h, 'hex'));
    await ctx.tx.query('SELECT app.identity_load_breached_batch($1, $2)', [batch, version]);
  }
  await ctx.tx.query('SELECT app.identity_finish_breached_import($1)', [version]);
  // T28 (02-TRD §13 IdentityBreachedListMissing): list present after this run. [CONV] set before commit; a rolled-back run retries.
  idMetrics.breachedListLoaded(ctx, true);
  ctx.log?.info?.({ event: IMPORT_BREACHED_PASSWORDS, hashes: all.length, batches: Math.ceil(all.length / BATCH), version });
};
