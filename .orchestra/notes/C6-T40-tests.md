# C6-T40 tests (partners.access_slip, 02-TRD §7.4 cases 6-10; 07-SECURITY 4b/8d)
- services/api/src/modules/reporting/__tests__/render.access-slip.test.ts: (6) API half, (7) extra/missing/mistyped, (8) portalUrl origin rule, (9) planted-URL log scan + no db/storage, (10) non-system actors.
- services/renderer/src/templates/__tests__/access-slip.test.ts: module content, QR = qr(portalUrl) module-for-module, escaping/REQ-SEC-086, static (no log/fs/net/Date), registry, real Chromium PDF text (case 6), determinism, renderer-side log scan.
- Edited T36 `render.helpers.ts`: world now passes `env: { LIMS_ORIGIN_PORTAL: 'https://portal.invalid' }` (C0 contract SLIP lives there; without it T36 contract cases 4/5 would fail once the origin rule exists). No assertion changed.
- Run: `.orchestra\notes\C6-T40-verify.cmd` (also re-runs T36 render.port + registry tests).
- ASSUMED APIs: `createRenderPort({..., env})` reads env.LIMS_ORIGIN_PORTAL at call time, unset => template_invalid; `access-slip/index.ts` exports `accessSlipTemplate`; registry registers it always; missing portalUrl in module => throw (422).
- Not covered: QR decoded from the PDF itself (vector, no decoder dep) — checked as the embedded data: URI vs report encoder; default load of contracts/render/partners.access_slip.schema.json (C0-owned, absent); API log redaction config (none exists in repo).
