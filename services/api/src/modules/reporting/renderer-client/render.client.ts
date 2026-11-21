// Client of the renderer's POST /internal/render (02-TRD §5.1). Worker-side use. Errors carry a stable `.code` only: never the token, the document or the response body.
//   408 / 5xx / other non-2xx / refused / timeout / dropped body -> reporting.render_unavailable (retryable, AC-03.9); 422 (page limit, template error) -> reporting.template_invalid.
export interface RenderRequest {
  readonly template_id: string; readonly template_version_config: unknown; readonly variant: 'letterhead' | 'plain';
  readonly watermark_override?: string; readonly document: unknown;
  /** T0B-PRINTCFG-1 (LD-316): the resolved print profile (contract PrintProfile, snake_case); absent = template config and variant decide. */
  readonly print_profile?: {
    readonly paper_mode: 'letterhead_image' | 'typed_header_footer' | 'preprinted_paper' | 'plain'; readonly header_text: string; readonly footer_text: string;
    readonly reserve_top_mm: number; readonly reserve_bottom_mm: number; readonly show_logo: boolean; readonly show_seller_pan?: boolean; readonly grayscale: boolean; readonly font_size_pt: number;
  };
  readonly assets: Readonly<Record<string, { mime_type: string; base64: string }>>;
}
export interface RenderResult { readonly pdf: Uint8Array; readonly pageCount: number }
export interface RenderClient { render(req: RenderRequest): Promise<RenderResult> }

const DEFAULT_TIMEOUT_MS = 60_000;   // [CONV] renderer's own job timeout is 30 s (§5.1); this bounds queueing + transfer on top
const fail = (code: 'reporting.render_unavailable' | 'reporting.template_invalid', message: string) => Object.assign(new Error(message), { code });

export function createRenderClient(o: { url: string; token: string; timeoutMs?: number }): RenderClient {
  if (typeof o?.token !== 'string' || o.token.length === 0) throw new Error('render client: token is required');
  const endpoint = `${String(o.url).replace(/\/+$/, '')}/internal/render`;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async render(req) {
      let res: Response; let body: Uint8Array;
      try {
        const signal = AbortSignal.timeout(timeoutMs);   // covers connect, headers and body
        res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` }, body: JSON.stringify(req), signal });
        if (res.status === 422) throw fail('reporting.template_invalid', 'renderer rejected the document (422)');
        if (!res.ok) throw fail('reporting.render_unavailable', `renderer answered ${res.status}`);
        body = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if ((e as { code?: string })?.code === 'reporting.template_invalid') throw e;
        throw fail('reporting.render_unavailable', 'renderer unreachable or failed');   // no cause: undici errors can carry the URL / headers
      }
      const pageCount = Number(res.headers.get('x-page-count'));
      if (!Number.isInteger(pageCount) || pageCount < 1 || body.length === 0) throw fail('reporting.render_unavailable', 'renderer returned an unusable reply');
      return { pdf: body, pageCount };
    },
  };
}
