T0D-BUILD-2 impl (writer). Files: services/api/src/modules/partners/service/settings.service.ts (new), partners/index.ts (both ops bound, FIX-2 501 removed), apps/web/src/features/partners/components/PartnerSettings.tsx.
- API: assertRole first (partners.partner.read / .manage), staff actor only; If-Match via partyset.rules ifMatch (428 / 400); full-replace Checker (every bad field, JSON pointer, fixed text); SELECT ... FOR UPDATE then version check (409, no write) then ONE write.
- [CONV] no row = table defaults (migration 20261115130000), ETag "1"; first save INSERT version 2 ON CONFLICT DO NOTHING (lost race = 409); later saves version+1. Audit = settings__audit trigger. Nothing logged.
- [CONV] range breaches answer common.validation_failed (contract allows it); partners.setting_out_of_range not raised.
- Web: failed save = danger toast (in-page banner removed); texts for setting_out_of_range / precondition_required / validation_failed local to this screen (errorText of other screens unchanged).
- Runs: web build2 config 15/15 pass; api + web tsc clean (web tsc errors only in old test files: msw onUnhandledRequest, pre-existing); api contract+boot 58/60 (2 boot = dispute item 2).
- NOT run: settings.test.ts + probes on PG17 (no Docker daemon here). webfix1 config 6 fail incl. 5 engagement = pre-existing, not touched.
- Open: dispute items 1-2 (tester); auth.mfa_required not wired (contract lists it; no privileged flag on partners.partner.manage in the kit).
