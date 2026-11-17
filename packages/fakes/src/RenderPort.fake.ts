// packages/fakes/src/RenderPort.fake.ts — IC §4.16 fake: system actor only, P-40 key grammar, per-template required fields,
// deterministic bytes (same key + data ⇒ same sha256), programmable renderer outage.
import { createHash } from "node:crypto";
import type { RenderPort, RenderTemplateKey } from "@lims/contracts/ports/RenderPort";
import { actorType, checkIdempotencyKey, err, forbidden, invalid, makeFake, stableJson, tenantOf, type FakeOpts } from "./base";

export interface RenderFixtures {
  /** Required top-level data fields per template. contracts/render/*.schema.json are not in the repo yet: only
   *  partners.access_slip's field list is specified (IC §4.16) [CONV: other templates require an object only]. */
  templates: Record<RenderTemplateKey, { required: string[] }>;
  rendererDown: boolean;
}

const defaults = (): RenderFixtures => ({
  templates: {
    "billing.invoice": { required: [] },
    "billing.credit_note": { required: [] },
    "billing.register": { required: [] },
    "analytics.report": { required: [] },
    "partners.access_slip": { required: ["tenantDisplayName", "partnerName", "patientDisplayName", "orderRef", "portalUrl", "expiresAtLocal", "issuedAtLocal"] },
  },
  rendererDown: false,
});

const MAX_BYTES = 10 * 1024 * 1024;

export function createFakeRenderPort(opts: FakeOpts<RenderFixtures>) {
  return makeFake(defaults, opts, (s) => {
    const byKey = new Map<string, { fp: string; out: { contentBase64: string; sha256: string; byteSize: number; pageCount: number } }>();
    const port: RenderPort = {
      async renderPdf(ctx, input) {
        const t = tenantOf(ctx);
        if (actorType(ctx) !== "system") throw forbidden();
        checkIdempotencyKey(input?.idempotencyKey);                                   // P-40 / A22.0
        const tpl = (s.fixtures.templates as Record<string, { required: string[] }>)[input.templateKey];
        if (!tpl) throw invalid("template_key_unknown");
        const data = input.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) throw err("reporting.template_invalid");
        const missing = tpl.required.filter((k) => (data as any)[k] === undefined || (data as any)[k] === null);
        if (missing.length) throw err("reporting.template_invalid", `missing:${missing.join(",")}`);
        if (s.fixtures.rendererDown) throw err("reporting.render_unavailable");
        const fp = stableJson({ templateKey: input.templateKey, data });
        const k = `${t}|${input.idempotencyKey}`;
        const prev = byKey.get(k);
        if (prev) { if (prev.fp !== fp) throw err("common.idempotency_key_reused"); return { ...prev.out }; }
        const bytes = Buffer.from(`%PDF-1.7\n%fake ${fp}\n%%EOF\n`, "utf8");
        if (bytes.length > MAX_BYTES) throw err("common.payload_too_large");
        const out = { contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, pageCount: 1 };
        byKey.set(k, { fp, out });
        return { ...out };
      },
    };
    return port;
  });
}
