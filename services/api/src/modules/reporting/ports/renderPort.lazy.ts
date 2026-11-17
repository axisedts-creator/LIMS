// LD-186 (C1 WIRE-REP): RenderPort for the API process, as a LAZY facade. The renderer URL and token file are WORKER settings
// (C1 02-TRD l.535-536, C6 02-TRD l.834-835), optional for the API, so nothing is read or built at import or boot.
// On a call: unset/unreadable settings -> LimsError('reporting.render_unavailable'). Never logs or echoes the URL, the token file path or the token.
import { readFileSync } from 'node:fs';
import { LimsError } from '../../../core/errors.js';
import { loadRendererConfig } from '../config.js';
import { createRenderPort, type RenderPort } from './RenderPort.impl.js';

export function createLazyRenderPort(env: Readonly<Record<string, string | undefined>> = process.env): RenderPort {
  let built: { key: string; port: RenderPort } | undefined;   // keyed on url+file: a changed or late-set setting is picked up, an unset one is never cached
  const resolve = (): RenderPort => {
    try {
      const { rendererUrl, rendererTokenFile } = loadRendererConfig(env);
      if (!rendererUrl || !rendererTokenFile) throw new LimsError('reporting.render_unavailable');
      const key = `${rendererUrl}\0${rendererTokenFile}`;
      if (built?.key !== key) {
        const token = readFileSync(rendererTokenFile, 'utf8').replace(/[\r\n]+$/, '');   // trailing newline only; an empty token is rejected by createRenderPort
        built = { key, port: createRenderPort({ url: rendererUrl, token }) };   // impl reads LIMS_ORIGIN_PORTAL from process.env at call time
      }
      return built.port;
    } catch {
      throw new LimsError('reporting.render_unavailable');   // swallow the cause: fs/URL errors carry the path or value
    }
  };
  return { renderPdf: async (ctx, input) => resolve().renderPdf(ctx, input) };   // async: an unset setting is a rejection, never a sync throw
}
