Title: CR-C0-LOGIN-1: tenant session settings ranges disagree with identity.sessions checks (LD-300)
From chunk: C0 (lane C0-0B)            To owner: C0-0B
Type: api
Blocking? no (T0B-LOGIN-1 clamps at login; this CR aligns the contract and settings validation)
Problem: contracts/openapi/identity.yaml TenantSettingsDto admits idle_timeout_minutes 1..1440 and absolute_session_hours 1..168. identity.sessions checks (db/migrations/20261105001300_identity__create_identity_schema.sql: sessions__idle__ck 15..30 for tenant_staff/platform/partner; sessions__absolute__ck <= created_at + 12 h, kind <> patient) cannot hold such values. A tenant admin can save a setting no session can use; login now silently clamps it (LD-300).
Spec text that supports which side: 04-consolidated-decisions A8 "Idle 15–30 min (tenant-configurable within range); absolute ≤12 h" (REQ-SEC-073). The check is correct; the SETTINGS RANGES must be narrowed. Do NOT widen the check.
Proposed change (exact):
- contracts/openapi/identity.yaml TenantSettingsDto (and any settings update request schema using the same fields): idle_timeout_minutes { minimum: 15, maximum: 30 }; absolute_session_hours { minimum: 1, maximum: 12 }.
- identity.tenant_settings: add CHECK idle_timeout_minutes BETWEEN 15 AND 30 and absolute_session_hours BETWEEN 1 AND 12 (new migration; first clamp existing rows).
- 05-SCHEMA identity.tenant_settings / identity.sessions text: state the ranges above and that absolute_expires_at and expires_at are capped at the database now() + 12 h in the INSERT (clock skew rule, LD-300).
Backward compatible? no for the API (narrower input): a settings update outside 15..30 / 1..12 now gets 400 common.validation_failed. Consumers: platform console / tenant settings UI (C0 web). Existing rows outside range: migrate by clamp.
Tenant/security impact: no RLS change, no PHI; tightens REQ-SEC-073.
Alternatives considered: widen sessions checks (rejected: contradicts 04 A8); keep clamp-only (works, but the UI shows values that are not applied).
Tests that will prove it: contract test on the two ranges; settings update 14 / 31 / 13 -> 400; migration test of the new CHECK; auth.session-clamp.test.ts stays green.
Status: RULED (LD-304, 2026-11-17): narrow the settings ranges, never widen the session checks. Amended by LD-306: no new migration (tenant_settings__idle__ck 15..30 and tenant_settings__absolute__ck 1..12 exist since 20261105001300 lines 475-476); OpenAPI and service narrowed in T0B-SESSRANGE-1; one static test pins the OpenAPI bounds to those CHECKs. No push-cloud.ps1 step.
