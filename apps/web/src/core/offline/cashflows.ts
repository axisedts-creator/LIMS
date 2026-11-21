// T0D-OFFLINE-4 (LD-322; offline design operation catalogue; core.yaml SyncOpDailyCashClose): the daily cash close offline. One daily_cash.close operation per
// cash session (entity = the session, base_version = the version the user saw, payload = the strict CloseCashSessionRequest). Someone else closing the day
// meanwhile comes back from the server as a conflict the Offline panel lists; nothing is overwritten. A tenant step up for closing is online only.
import { t } from '../i18n/messages';
import type { Outbox } from './outbox';
import { OfflineError, type OfflineStore } from './store';

/* eslint-disable @typescript-eslint/no-explicit-any -- cached read documents, checked here */
type Any = any;
export interface CashFlowsOptions {
  store: OfflineStore; outbox: Outbox; permissions: readonly string[]; now?: () => number;
  /** tenant setting: closing the day needs MFA step up (CR: no cached source yet, default off) */
  requiresStepUp?: () => boolean | Promise<boolean>;
}

const MAX_COUNTED = 20;
const MAX_NOTE = 500;
const fail = (code: string): never => { throw new OfflineError(code); };
const bad = () => fail('common.validation_failed');
const str = (v: unknown) => typeof v === 'string' && v.trim() !== '';

export function createCashFlows(o: CashFlowsOptions) {
  const { store, outbox } = o;
  const stepUp = async () => { try { return (await o.requiresStepUp?.()) ?? false; } catch { return true; } }; // fail closed

  return {
    async closeDay(input: Any) {
      if (!o.permissions.includes('billing.payment.record')) fail('auth.forbidden');
      if (!store.isUnlocked()) fail('offline.locked');
      const counted: Any[] = input?.counted;
      if (!str(input?.session_id) || !Array.isArray(counted) || counted.length < 1 || counted.length > MAX_COUNTED) bad();
      for (const c of counted) {
        if (!c || typeof c !== 'object' || Object.keys(c).some((k) => k !== 'method_code' && k !== 'amount_paisa')) bad();
        if (typeof c.method_code !== 'string' || c.method_code.length < 1 || c.method_code.length > 64 || !Number.isSafeInteger(c.amount_paisa) || c.amount_paisa < 0) bad();
      }
      if (new Set(counted.map((c) => c.method_code)).size !== counted.length) bad();
      if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > MAX_NOTE)) bad();
      const s = await store.get<Any>('refdata', `cash_session:${input.session_id}`);
      if (!s) fail('common.not_found');
      if (s.status !== 'open') return { ok: false as const, code: 'common.immutable_record', message: t('offline.refusal.cash_closed') };
      if (await stepUp()) return { ok: false as const, code: 'sync.offline_not_allowed', message: t('offline.refusal.cash_step_up') };

      const exp: Array<{ method_code: string; amount_paisa: number }> = Array.isArray(s.expected) ? s.expected : [];
      const got = new Map(counted.map((c) => [c.method_code as string, c.amount_paisa as number]));
      const methods = [...exp.map((e) => e.method_code), ...counted.map((c) => c.method_code as string).filter((m) => !exp.some((e) => e.method_code === m))];
      const variance = methods.map((m) => {
        const expected_paisa = exp.find((e) => e.method_code === m)?.amount_paisa ?? 0; const counted_paisa = got.get(m) ?? 0;
        return { method_code: m, expected_paisa, counted_paisa, variance_paisa: counted_paisa - expected_paisa };
      });
      // one close per session (the server key is the centre and the business day): a second tap answers duplicate
      if ((await outbox.pending()).some((p) => p.op_type === 'daily_cash.close' && p.entity_id === s.id)) return { ok: true as const, queued: false, duplicate: true, variance };
      const payload = { counted: counted.map((c) => ({ method_code: c.method_code, amount_paisa: c.amount_paisa })), ...(input.note !== undefined ? { note: input.note } : {}) };
      const op = await outbox.append({ op_type: 'daily_cash.close', entity_id: s.id, base_version: s.version, payload });
      return { ok: true as const, queued: true, op_id: op.op_id, variance };
    },
  };
}

export type CashFlows = ReturnType<typeof createCashFlows>;
