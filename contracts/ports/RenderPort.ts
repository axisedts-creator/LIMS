// contracts/ports/RenderPort.ts
import type { RequestContext } from './common';
export const RENDER_PORT_VERSION = 1 as const;
export type RenderTemplateKey = 'billing.invoice' | 'billing.credit_note' | 'billing.register' | 'analytics.report'
  | 'partners.access_slip';                                   // added by 08 Addendum A5.1 (CR-C13-014, additive)
export interface RenderPortV1 {
  /** System actors in worker tasks only. Data validated against contracts/render/<templateKey>.schema.json; bundled assets only (REQ-SEC-086);
   *  60 s timeout; the caller stores the bytes in its own bucket. analytics.report: ≤ 5,000 rows.
   *  @throws reporting.render_unavailable, reporting.template_invalid, common.payload_too_large (> 10 MB output), auth.forbidden (non-system actor) */
  renderPdf(ctx: RequestContext, input: { templateKey: RenderTemplateKey; data: Readonly<Record<string, unknown>>; idempotencyKey: string }):
    Promise<{ contentBase64: string; sha256: string; byteSize: number; pageCount: number }>;
}
export type RenderPort = RenderPortV1;
