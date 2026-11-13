// C12 consumption_facts.basis_key builders — 02-TRD §8.1 table (AC-12.4). Only UUIDs, kinds, dates and a SHA-256 digest; never a raw idempotency key.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { isValidYmd } from './ymd.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (what: string): never => {
  throw new LimsError('common.validation_failed', `invalid ${what}`);
};
const uuid = (v: unknown): string => (typeof v === 'string' && UUID.test(v) ? v : bad('uuid'));
const digest = (v: unknown): string =>
  typeof v === 'string' && v.length > 0 ? createHash('sha256').update(v, 'utf8').digest('hex') : bad('idempotency key');
const ymd = (v: unknown): string => (isValidYmd(v) ? v : bad('business date'));

export const testBasisKey = (orderItemId: string, testId: string): string => `test:${uuid(orderItemId)}:${uuid(testId)}`;
export const analyteBasisKey = (resultId: string): string => `analyte:${uuid(resultId)}`;
export const rerunBasisKey = (instrumentMessageId: string, testId: string): string => `rerun:${uuid(instrumentMessageId)}:${uuid(testId)}`;
export const calibrationBasisKey = (idempotencyKey: string): string => `cal:${digest(idempotencyKey)}`;
export const qcBasisKey = (idempotencyKey: string): string => `qc:${digest(idempotencyKey)}`;
export const manualBasisKey = (id: string): string => `manual:${uuid(id)}`;
export const fixedBasisKey = (ruleId: string, businessDate: string): string => `fixed:${uuid(ruleId)}:${ymd(businessDate)}`;
