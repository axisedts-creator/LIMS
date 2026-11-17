APPROVE

C6-T38 review (diff b084b3a9..HEAD: tests + notes only; implementation pre-existed via T19/T32/T37/T41).

02-TRD §14 row "08 Addendum A2" coverage:
- (a) CHECK all-or-none: migration 20261105001900 L346-349 matches 05-SCHEMA; t38.a2.static.test.ts (DDL) + C6-T38.a2.test.sql (8 combos). UPDATE -> immutable_row already proven live in T0B-10.C6_behaviour.test.sql:229; trigger list excludes smart_summary_*.
- (b) assemble_smart_regeneration.test.ts: approved -> 3 cols set from summaryId/templateLibraryVersion; draft/smartreport.* errors/flag off -> all NULL; v1 untouched.
- (c) portal.service.test.ts:176 (P3) + reportingport.t37.test.ts:113-129 (partner + patient, SmartReportPort spy = zero calls).
- (d) code_hmac bytea + octet_length=32 CHECK; verifyOtp 31/33/bit-flip; timingSafeEqual, no hex decode.
- (e) notification.port.test.ts:247-278 (IdentityPort.getStaffNotificationContact fake, queued; other purposes suppressed_no_contact). (f) superseded by A4 (c). (g) code CHECK regex + seed row (label_text schedule_name, staff_url).
Names verbatim; no new tables/routes/permissions/error codes; no PHI/secrets (synthetic ids/text); paths owned (reporting module tests, db/tests/reporting). pending.json untouched (LD-70, no stub turned real).

Ran by reviewer: api 5 files / 154 tests PASS; worker 2 files / 42 tests PASS.
Not run: pgTAP C6-T38.a2.test.sql (no Postgres here); lint/typecheck.
