// PG-T08 shared types + validation helpers for the intent/outcome services (TRD §5.3, §6.1-§6.4).
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as merchant.service.ts).
import { isUuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { PaymentsConfig } from '../config.js';
import type { createEsewaAdapter } from '../gateways/esewa.adapter.js';
import type { createKhaltiAdapter } from '../gateways/khalti.adapter.js';
import type { Kek } from '../service/credentials.js';

export type Row = Record<string, any>;
export interface Money { amountPaisa: number; currency: 'NPR' }
export interface Ctx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> };
  now(): string; // ISO-8601 UTC; the services never read the wall clock
  readonly ports: {
    BillingPort: {
      getOrderBalance(ctx: any, i: { orderId: string }): Promise<{ balanceDue: Money }>;
      recordGatewayPayment(ctx: any, i: Record<string, unknown>): Promise<{ ledgerEntryId: string; duplicate: boolean }>;
    };
    FrontdeskPort: { getOrderSummary(ctx: any, i: { orderId: string }): Promise<{ branchId: string; centreId: string; status: string }> };
  };
}
export interface PaymentsDeps {
  config: PaymentsConfig;
  kek: Kek;
  adapters: { esewa: Pick<ReturnType<typeof createEsewaAdapter>, 'buildAction' | 'check'>; khalti: Pick<ReturnType<typeof createKhaltiAdapter>, 'initiate' | 'buildAction' | 'check'> & Partial<Pick<ReturnType<typeof createKhaltiAdapter>, 'refundViaApi'>> };
  events: { publish(ctx: any, type: string, i: { aggregate: { type: string; id: string; seq: number }; idempotencyKey: string; payload: Record<string, unknown> }): Promise<unknown> };
  jobs: { enqueue(ctx: any, task: string, payload: Record<string, unknown>, opts: { key: string; runAt?: Date }): Promise<void> };
  log?: { error(event: string, fields: Record<string, unknown>): void };
  newId?: () => string;
}

export const OPEN_STATUSES = ['created', 'initiated', 'pending'] as const;
export const IDEM_KEY = /^[A-Za-z0-9_.:-]{1,200}$/;
export const CODE = /^[A-Za-z0-9_-]{1,64}$/;

// Messages are fixed strings: a caller value never reaches an error.
export const invalid = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'invalid' }]);
};
export const notFound = (): never => { throw new LimsError('common.not_found'); };

/** TRD §5.3: callers are actor type user or system only. Runs before any state read. */
export function guardActor(ctx: Ctx): void {
  if (ctx.actor?.type !== 'user' && ctx.actor?.type !== 'system') throw new LimsError('auth.forbidden');
}
/** Strict input: a plain object with exactly the allowed keys (so no caller amount can ride along, REQ-SEC-046). */
export function strict(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid('body');
  for (const k of Object.keys(input)) if (!keys.includes(k)) invalid(k);
  return input as Record<string, unknown>;
}
export const uuid = (v: unknown, path: string): string => (typeof v === 'string' && isUuidv7(v) ? v : invalid(path));
export const money = (paisa: unknown): Money => ({ amountPaisa: Number(paisa), currency: 'NPR' });
export const iso = (d: unknown): string => new Date(d as Date).toISOString();
