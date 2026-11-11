// R9 POST /reports/{report_id}/regenerations (02-TRD §6.3 R9, §4.5 rule 0; AC-02.6, AC-06.9, E8). Schema, auth, x-permission (reporting.report.regenerate) and
// Idempotency-Key are enforced by the core pipeline; this handler re-checks what it needs (fail closed) and never echoes input. 07-SECURITY: reason_text is P2 (never logged).
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { regenerateReport } from '../service/reports.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);

function parseBody(raw: unknown): { code: string; text?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('/');
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'reason_code' && k !== 'reason_text') throw invalid('/');   // additionalProperties: false
  const code = b['reason_code']; const text = b['reason_text'];
  if (typeof code !== 'string' || code.length < 1 || code.length > 64) throw invalid('/reason_code');
  if (text !== undefined && (typeof text !== 'string' || text.length > 500)) throw invalid('/reason_text');
  if (code === 'other' && (typeof text !== 'string' || text.trim() === '')) throw invalid('/reason_text');   // D-36: `other` needs a text
  return { code, ...(typeof text === 'string' && text.trim() !== '' ? { text } : {}) };
}

export const regenerateHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  // Privileged (REQ-SEC-100): IdentityPort.assertRole is the defence in depth and carries auth.mfa_required (aal1).
  regenerateReport: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as { tenantId?: string; actor?: { type?: string; id?: string }; tx?: any; ports?: Record<string, any> };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.ports) throw new LimsError('auth.unauthenticated');
    const id = (req.params as Record<string, unknown> | undefined)?.['report_id'];
    if (typeof id !== 'string' || !UUID.test(id)) throw new LimsError('common.not_found');
    const reason = parseBody(req.body);
    if (c.actor.type !== 'user') throw new LimsError('auth.forbidden');
    const idp = c.ports['IdentityPort'];
    if (!idp || typeof idp.assertRole !== 'function') throw new LimsError('common.internal');   // fail closed
    await idp.assertRole(c, { permission: 'reporting.report.regenerate' });
    await regenerateReport({ tx: c.tx, tenantId: c.tenantId, actor: { id: c.actor.id } }, id, reason);
    return { status: 202, body: { report_id: id, scheduled: true } };
  },
});
