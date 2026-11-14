APPROVE
C6-T25 review (103cd06a..HEAD).
- Names verbatim: operationIds M1/M2/C1–C3, routes, `reporting.notification_template_unknown` / `reporting.notification_params_invalid`, `common.version_conflict` / `common.precondition_required` match 02-TRD §6.5 and contracts/openapi/reporting.yaml; `LIMS_ORIGIN_API` (03-IC §7), `LIMS_CORE_ENV` (C0), `issueToken('callback')`.
- Tenant isolation: every tenant-table statement binds `tenant_id = $1` explicitly; g_message_templates read-only; no new tables/RLS in this task (schema owned by earlier tasks).
- Idempotency: all five x-idempotency none; C3 version-guarded UPDATE + pre-read, 428 when If-Match absent, double submit -> 409; only SHA-256 bound; no `core.idempotency_keys` statement; `cache-control: no-store`.
- AC-13.4: undeclared `{name}` in body/subject/provider_variable_order rejected; provider name + approval recorded manually; params not editable. C2 never writes callback_token_sha256; recording rejected in production; secret_ref only.
- Checks run: verify suite 145/145 pass (vitest 4 files); tsc: 21 pre-existing errors, none in messaging-admin files.
- Note (not a defect): M1 `KIND_MAX_LENGTH` defaults for kinds without seed max_length are writer [CONV] (short_text/label_text/phone/otp/time from 02-TRD §7.2; url/datetime values assumed).
