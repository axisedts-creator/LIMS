// Worker-side clients of the renderer (/internal/render) and the PDF sandbox (/internal/sanitize, /internal/assemble), 02-TRD §5.1-§5.2.
// LAZY, like api ports/renderPort.lazy.ts: nothing is read at import; settings and token files are read on the first call.
// Unset / unreadable settings fail the call the same way the old stubs did (retryable), so a missing setting is loud, never a silent success.
// Errors never carry the URL, the token file path, the token or a response body. Redirects are refused: an internal service never redirects,
// and following one could send the bearer token or a patient PDF somewhere else.
import { readFileSync } from 'node:fs';
import { loadRendererConfig } from '../../../../api/src/modules/reporting/config.js';
import { createRenderClient, type RenderClient } from '../../../../api/src/modules/reporting/renderer-client/render.client.js';
import type { SandboxClient, SanitizeReply } from './tasks/process_input_file.js';
import type { RenderPorts } from './tasks/render_report_version.js';

type Env = Readonly<Record<string, string | undefined>>;
const TIMEOUT_MS = 60_000;   // [CONV] same bound as the render client and the sandbox's own job wall clock
const unavailable = (message: string) => Object.assign(new Error(message), { code: 'reporting.render_unavailable' });

/** Builds `T` from (url, token) on first use; rebuilt when the url or the token file path changes. Throws a bare Error when unset/unreadable. */
function lazy<T>(read: () => { url?: string | undefined; tokenFile?: string | undefined }, build: (url: string, token: string) => T): () => T {
  let built: { key: string; value: T } | undefined;
  return () => {
    const { url, tokenFile } = read();
    if (!url || !tokenFile) throw new Error('not_configured');
    const key = `${url}\0${tokenFile}`;
    if (built?.key !== key) {
      let token: string;
      try { token = readFileSync(tokenFile, 'utf8').trim(); } catch { throw new Error('not_configured'); }   // fs errors carry the path
      if (!token) throw new Error('not_configured');
      built = { key, value: build(url, token) };
    }
    return built.value;
  };
}

function sandboxSettings(env: Env): { url?: string | undefined; tokenFile?: string | undefined } {
  const url = env['LIMS_REPORTING_SANDBOX_URL'] || undefined;
  if (url !== undefined) {
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:'; } catch { /* ok stays false */ }
    if (!ok) throw new Error('not_configured');
  }
  return { url: url?.replace(/\/+$/, ''), tokenFile: env['LIMS_REPORTING_SANDBOX_TOKEN_FILE'] || undefined };
}

export function createReportingClients(env: Env = process.env): { renderer: RenderPorts['renderer']; sandbox: SandboxClient; assembler: RenderPorts['sandbox'] } {
  const renderClient = lazy<RenderClient>(
    () => { const c = loadRendererConfig(env); return { url: c.rendererUrl, tokenFile: c.rendererTokenFile }; },
    (url, token) => createRenderClient({ url, token }));
  const sandbox = lazy(() => sandboxSettings(env), (url, token) => ({ url, auth: `Bearer ${token}` }));

  return {
    renderer: {
      async render(req) {
        let client: RenderClient;
        try { client = renderClient(); } catch { throw unavailable('renderer_not_configured'); }
        return client.render(req as Parameters<RenderClient['render']>[0]);
      },
    },
    sandbox: {
      async sanitize(bytes): Promise<SanitizeReply> {
        let s: { url: string; auth: string };
        try { s = sandbox(); } catch { throw new Error('pdf_sandbox_not_configured'); }
        let res: Response;
        try {
          const form = new FormData();
          form.set('file', new Blob([bytes as BlobPart], { type: 'application/pdf' }), 'file.pdf');
          res = await fetch(`${s.url}/internal/sanitize`, { method: 'POST', headers: { authorization: s.auth }, body: form, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
          // 200 = sanitised, 422 = rejected with a reason; both are answers the task validates itself (nothing in the reply is trusted).
          if (res.status === 200 || res.status === 422) return (await res.json()) as SanitizeReply;
        } catch (e) {
          const name = (e as Error)?.name;
          if (name === 'TimeoutError' || name === 'AbortError') throw e;   // AC-04.7: the task turns a timeout into a rejection
          throw new Error('pdf_sandbox_unreachable');                     // no cause: undici errors can carry the URL / headers
        }
        throw new Error(`pdf sandbox answered ${res.status}`);
      },
    },
    assembler: {
      async assemble(req) {
        let s: { url: string; auth: string };
        try { s = sandbox(); } catch { throw unavailable('pdf_sandbox_not_configured'); }
        let res: Response; let body: Uint8Array;
        try {
          res = await fetch(`${s.url}/internal/assemble`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: s.auth },
            body: JSON.stringify(req), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
          // ponytail: a 422 (a part the sandbox rejects) is retried like an outage and ends in render_failed after the last attempt; the spec names no code for it.
          if (!res.ok) throw new Error('not ok');
          body = new Uint8Array(await res.arrayBuffer());
        } catch { throw unavailable('pdf sandbox unreachable or failed'); }
        const pageCount = Number(res.headers.get('x-page-count'));
        if (!Number.isInteger(pageCount) || pageCount < 1 || body.length === 0) throw unavailable('pdf sandbox returned an unusable reply');
        return { pdf: body, pageCount };
      },
    },
  };
}
