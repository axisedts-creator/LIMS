# C6-T40 impl
- NEW services/renderer/src/templates/access-slip/index.ts (`accessSlipTemplate`, QR via lab/qr.ts `qr` injected or `qrDataUri`; portalUrl not printed/linked). EDIT templates/registry.ts (registers it always), ports/RenderPort.impl.ts (`env` option; `partners.access_slip` portalUrl must start with `LIMS_ORIGIN_PORTAL/r/`, unset => template_invalid).
- [CONV] env defaults to process.env when not injected; template has its own element-content `esc` (lab `esc` entity-encodes `:` `/`, which breaks the timestamps/URL text the tests expect).
- Tests run: api render.access-slip + render.port (82 pass); renderer access-slip + registry (37 pass, real Chromium). tsc: no errors in touched files.
- Open: contracts/render/partners.access_slip.schema.json is C0-owned and absent (tests inject schemas); API log redaction of `portalUrl` has no config in repo.
