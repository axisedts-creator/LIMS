// C6-T25 service: M1 listMessageTemplates, M2 upsertMessageTemplateText, C1 listChannelAccounts, C2 upsertChannelAccount, C3 rotateChannelCallbackToken
// (02-TRD §6.5; 05-SCHEMA §2.8/§2.9; 01-PRD AC-13.4; 07-SECURITY REQ-SEC-024/128/136; 08 A13 P-8 E1).
// Tenant and actor come from ctx only. Error messages never carry input values. Approval and provider template names are recorded manually: nothing is sent anywhere.
// C3 is x-idempotency none: the plaintext callback token lives only in the response; only its SHA-256 is bound to SQL.
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as settings.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { issueToken } from '../domain/tokens.js';
import * as repo from '../repository/messaging-admin.repo.js';

export interface MessagingCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly tx: unknown;
  readonly now?: () => unknown;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_CODE = /^[a-z_]+\.[a-z0-9_]{1,60}$/;                 // g_message_templates__code__ck
const SECRET_REF = /^[a-z0-9_./-]{1,128}$/;                          // channel_accounts__secret_ref__ck
const PLACEHOLDER = /\{([^{}]*)\}/g;                                 // `{name}`, as 04-UI-UX §7
const CHANNELS = ['whatsapp', 'sms', 'email'];
const LANGUAGES = ['en', 'ne'];
const APPROVALS = ['not_required', 'draft', 'submitted', 'approved', 'rejected'];
const PROVIDER_KINDS = ['recording', 'whatsapp_cloud_api', 'sms_sparrow', 'sms_aakash', 'email_smtp_relay'];
const TEXT_KEYS = ['language', 'body_text', 'subject_text', 'provider_template_name', 'provider_template_language', 'provider_variable_order', 'approval_status', 'is_active'];
const ACCOUNT_KEYS = ['provider_kind', 'sender_id', 'secret_ref', 'is_active'];
// OpenAPI MessageTemplate.params[].max_length is required; seed rows carry it for short_text only, so the other kinds get their format length.
const KIND_MAX_LENGTH: Record<string, number> = { short_text: 40, label_text: 80, time_hhmm: 5, otp_code: 6, minutes: 2, datetime: 40, phone: 40, url: 1000, staff_url: 1000 };

const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
}
function optString(o: Record<string, unknown>, k: string, max: number): string | null {
  const v = o[k];
  if (v === undefined) return null;
  if (typeof v !== 'string' || v.length > max) fail(`/${k}`);
  return v as string;
}
function enumOf(v: unknown, allowed: readonly string[], path: string): string {
  if (typeof v !== 'string' || !allowed.includes(v)) fail(path);
  return v as string;
}
/** If-Match version: absent -> 428; a Postgres integer, so oversized or malformed is 400, not 22003 -> 500. */
function version(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) fail('/If-Match');
  return v as number;
}
function scope(ctx: MessagingCtx): { tx: repo.Tx; tenantId: string; actorId: string } {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as repo.Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const envOf = (ctx: MessagingCtx) => ctx.env ?? process.env;
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

const textBody = (r: any) => compact({
  channel: r.channel, language: r.language, body_text: r.body_text, subject_text: r.subject_text, provider_template_name: r.provider_template_name,
  provider_template_language: r.provider_template_language, provider_variable_order: r.provider_variable_order ? [...r.provider_variable_order] : null,
  approval_status: r.approval_status, is_active: r.is_active, version: r.version,
});
const accountBody = (r: any) => compact({
  id: r.id, channel: r.channel, provider_kind: r.provider_kind, sender_id: r.sender_id, secret_ref: r.secret_ref,
  callback_url_configured: r.callback_token_sha256 != null, is_active: r.is_active, version: r.version,
});

export function createMessagingAdminService(deps: { newId?: () => string } = {}) {
  const newId = deps.newId ?? uuidv7;

  return {
    async listMessageTemplates(ctx: MessagingCtx) {
      const { tx, tenantId } = scope(ctx);
      const [templates, texts] = await Promise.all([repo.listActiveTemplates(tx), repo.listTexts(tx, tenantId)]);
      return {
        data: templates.map((t) => ({
          code: t.code, purpose: t.purpose, channels: [...t.channels],
          params: (t.params as any[]).map((p) => ({ name: p.name, kind: p.kind, max_length: Number.isInteger(p.max_length) ? p.max_length : (KIND_MAX_LENGTH[p.kind] ?? 40) })),
          texts: texts.filter((x) => x.template_code === t.code).map(textBody),
        })),
      };
    },

    async upsertMessageTemplateText(ctx: MessagingCtx, input: { templateCode: unknown; channel: unknown; expectedVersion: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const channel = enumOf(input?.channel, CHANNELS, '/channel');
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, TEXT_KEYS);
      const language = enumOf(b['language'], LANGUAGES, '/language');
      if (typeof b['body_text'] !== 'string' || b['body_text'].length < 1 || b['body_text'].length > 1000) fail('/body_text');
      const bodyText = b['body_text'] as string;
      const subjectText = optString(b, 'subject_text', 150);
      const providerTemplateName = optString(b, 'provider_template_name', 128);
      const providerTemplateLanguage = optString(b, 'provider_template_language', 16);
      let order: string[] | null = null;
      if (b['provider_variable_order'] !== undefined) {
        const o = b['provider_variable_order'];
        if (!Array.isArray(o) || o.length > 20 || !o.every((x) => typeof x === 'string' && x.length <= 64)) fail('/provider_variable_order');
        order = [...(o as string[])];
      }
      const approvalStatus = enumOf(b['approval_status'], APPROVALS, '/approval_status');
      if (typeof b['is_active'] !== 'boolean') fail('/is_active');
      const isActive = b['is_active'] as boolean;
      const expectedVersion = input.expectedVersion === undefined ? undefined : version(input.expectedVersion);

      const code = input.templateCode;
      const tpl = typeof code === 'string' && TEMPLATE_CODE.test(code) ? await repo.findActiveTemplate(tx, code) : undefined;
      if (!tpl || !(tpl.channels as string[]).includes(channel)) throw new LimsError('reporting.notification_template_unknown');

      // AC-13.4: no parameter beyond the template's declared set, in the texts or in the provider variable order. Names are never echoed.
      const declared = new Set<string>((tpl.params as any[]).map((p) => String(p.name)));
      const undeclared = (s: string | null) => s !== null && [...s.matchAll(PLACEHOLDER)].some((m) => !declared.has(m[1]!));
      if (undeclared(bodyText) || undeclared(subjectText) || (order !== null && order.some((n) => !declared.has(n)))) throw new LimsError('reporting.notification_params_invalid');

      // Manual record of the provider approval (the columns exist for it); nothing is submitted to a provider.
      const recorded = approvalStatus !== 'not_required';
      const fields: repo.TextFields = {
        bodyText, subjectText, providerTemplateName, providerTemplateLanguage, providerVariableOrder: order, approvalStatus,
        approvalRecordedBy: recorded ? actorId : null, approvalRecordedAt: recorded ? (ctx.now ? ctx.now() : new Date()) : null, isActive,
      };
      const key = { tenantId, templateCode: code as string, channel, language, actorId };
      if (expectedVersion === undefined) {
        const row = await repo.insertText(tx, { ...key, id: newId(), ...fields });
        if (!row) throw new LimsError('common.version_conflict');   // already exists: a create is not an overwrite
        return textBody(row);
      }
      // Read first so a stale or missing version never reaches an UPDATE; the guarded UPDATE still decides a race.
      const current = await repo.textVersion(tx, tenantId, code as string, channel, language);
      if (current === undefined) throw new LimsError('common.not_found');
      const row = current === expectedVersion ? await repo.updateText(tx, { ...key, expectedVersion, ...fields }) : undefined;
      if (!row) throw new LimsError('common.version_conflict');
      return textBody(row);
    },

    async listChannelAccounts(ctx: MessagingCtx) {
      const { tx, tenantId } = scope(ctx);
      return { data: (await repo.listAccounts(tx, tenantId)).map(accountBody) };
    },

    async upsertChannelAccount(ctx: MessagingCtx, input: { channel: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const channel = enumOf(input?.channel, CHANNELS, '/channel');
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ACCOUNT_KEYS);   // a secret value, token hash, tenant id or version in the body is an unknown field
      const providerKind = enumOf(b['provider_kind'], PROVIDER_KINDS, '/provider_kind');
      // REQ-SEC-136: the recording provider never runs in production.
      if (providerKind === 'recording' && envOf(ctx)['LIMS_CORE_ENV'] === 'production') fail('/provider_kind');
      // REQ-SEC-128: a reference to a secret file, never the secret. `..` is rejected on top of the column CHECK.
      if (typeof b['secret_ref'] !== 'string' || !SECRET_REF.test(b['secret_ref']) || b['secret_ref'].includes('..')) fail('/secret_ref');
      if (typeof b['is_active'] !== 'boolean') fail('/is_active');
      const row = await repo.upsertAccount(tx, {
        id: newId(), tenantId, channel, providerKind, senderId: optString(b, 'sender_id', 64), secretRef: b['secret_ref'] as string,
        isActive: b['is_active'] as boolean, actorId,
      });
      return accountBody(row);
    },

    async rotateChannelCallbackToken(ctx: MessagingCtx, input: { channel: unknown; expectedVersion: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const channel = enumOf(input?.channel, CHANNELS, '/channel');
      const expectedVersion = version(input?.expectedVersion);
      const env = envOf(ctx);
      const origin = (env['LIMS_ORIGIN_API'] ?? '').replace(/\/+$/, '');
      if (!origin && env['LIMS_CORE_ENV'] === 'production') throw new LimsError('common.internal');   // ponytail: dev falls back to a relative URL
      const current = await repo.accountVersion(tx, tenantId, channel);
      if (current === undefined) throw new LimsError('common.not_found');
      if (current !== expectedVersion) throw new LimsError('common.version_conflict');
      const { token, tokenSha256 } = issueToken('callback');
      const row = await repo.rotateCallbackToken(tx, { tenantId, channel, expectedVersion, tokenSha256, actorId });
      if (!row) throw new LimsError('common.version_conflict');
      return { callback_url: `${origin}/v1/reporting/provider-callbacks/${token}` };
    },
  };
}
export type MessagingAdminService = ReturnType<typeof createMessagingAdminService>;
