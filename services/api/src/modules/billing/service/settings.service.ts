// B32 get/updateBillingSettings and B34 listBillingCodes (02-TRD §6, §11.2; US-BL-01.5; 08 A13 D-23).
// Tenant and actor come from ctx only. Bodies are the OpenAPI snake_case shapes. Error details are fixed text: no submitted value is echoed.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { fiscalYearOf } from '../domain/fiscalYear.js';
import * as defaultRepo from '../repository/settings.repo.js';

export interface SettingsCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
  readonly now: () => string;
  readonly ports?: { readonly IdentityPort?: { getTenantSettings(ctx: any, input: { keys: readonly string[] }): Promise<any> } };
}
export type SettingsRepo = typeof defaultRepo;

const CODE_SETS = ['payment_methods', 'invoice_cancel_reasons', 'reversal_reasons', 'refund_reasons', 'override_reasons', 'cash_variance_reasons', 'lock_reasons'];
const BRANCH_TOKEN = /\{branch(?::\d+)?\}/; // same token grammar as domain/numberFormat
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const bool = (v: unknown, p: string): void => { if (typeof v !== 'boolean') fail(p); };
const int = (v: unknown, p: string, max: number): void => { if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) fail(p); };

const RULES: Record<string, (v: unknown, p: string) => void> = {
  invoice_series_scope: (v, p) => { if (v !== 'tenant' && v !== 'branch') fail(p); },
  prices_include_tax: bool, abbreviated_invoice_enabled: bool, pay_by_qr_enabled: bool, receipt_no_enabled: bool, credit_days_auto_lock: bool,
  cash_variance_alert_paisa: (v, p) => int(v, p, Number.MAX_SAFE_INTEGER),
  refund_alert_per_day: (v, p) => int(v, p, 10000),
};
const BODY_COLUMNS = Object.keys(RULES);

function scope(ctx: SettingsCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}
function version(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  // version is a Postgres integer: bounded to int32 so an oversized If-Match is a 400, not a 22003.
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) fail('/If-Match');
  return v as number;
}
function body(row: Record<string, any>) {
  const paisa = Number(row['cash_variance_alert_paisa']);
  if (!Number.isSafeInteger(paisa)) throw new LimsError('common.internal');
  return { ...Object.fromEntries([...BODY_COLUMNS, 'version'].map((c) => [c, row[c]])), cash_variance_alert_paisa: paisa } as Record<string, any>;
}

export function createSettingsService(deps: { repo?: SettingsRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  /** Lazy defaults (TRD §11.2); ON CONFLICT DO NOTHING, so losing the insert race re-reads the winner. */
  async function ensure(tx: any, tenantId: string, userId: string): Promise<Record<string, any>> {
    const found = await repo.getBillingSettings(tx, { tenantId });
    if (found) return found;
    const row = (await repo.insertDefaultBillingSettings(tx, { tenantId, userId })) ?? (await repo.getBillingSettings(tx, { tenantId }));
    if (!row) throw new LimsError('common.internal');
    return row;
  }

  return {
    async getSettings(ctx: SettingsCtx) {
      const { tx, tenantId, userId } = scope(ctx);
      return body(await ensure(tx, tenantId, userId));
    },

    async updateSettings(ctx: SettingsCtx, input: { expectedVersion: unknown; patch: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const expectedVersion = version(input?.expectedVersion);
      const patch = input?.patch;
      if (!isObj(patch)) return fail('/');
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'version') continue; // server-set
        const rule = Object.hasOwn(RULES, k) ? RULES[k] : undefined;
        if (!rule) fail(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
        rule!(v, `/${k}`);
        values[k] = v;
      }
      const current = await ensure(tx, tenantId, userId);
      const next = values['invoice_series_scope'] as string | undefined;
      const refuse = (message: string) => fail('/invoice_series_scope', 'common.field_invalid', message);
      if (next === 'branch') {
        // B32 / 08 A13 D-23: the tenant pattern must carry {branch}; the pattern is C2's (no local copy).
        const numbering = (await ctx.ports?.IdentityPort?.getTenantSettings(ctx, { keys: ['numbering'] }))?.numbering;
        if (typeof numbering?.invoiceNoPattern !== 'string' || !BRANCH_TOKEN.test(numbering.invoiceNoPattern)) refuse('Branch series needs {branch} in the invoice number pattern');
      }
      if (next !== undefined && next !== current['invoice_series_scope']
        && await repo.hasInvoiceInFiscalYear(tx, { tenantId, fiscalYearBs: fiscalYearOf(ctx.now() as never).long })) refuse('Series scope cannot change after the first invoice of the fiscal year');
      const row = await repo.updateBillingSettings(tx, { tenantId, userId, expectedVersion, values: values as never });
      if (!row) throw new LimsError('common.version_conflict');
      return body(row);
    },

    async listCodes(ctx: SettingsCtx, input: { setName: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const setName = input?.setName;
      if (typeof setName !== 'string' || !CODE_SETS.includes(setName)) fail('/set_name');
      const rows = await repo.listCodes(tx, { tenantId, setName: setName as string });
      const data = rows.filter((r) => r['is_active'] !== false)
        .map((r) => ({ code: r['code'] as string, display: r['display'] as string, sort_order: r['sort_order'] as number }))
        .sort((a, b) => a.sort_order - b.sort_order || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      return { data };
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
