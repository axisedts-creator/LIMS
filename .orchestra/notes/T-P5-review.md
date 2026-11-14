APPROVE

T-P5 review (diff 038e172e..HEAD).
- Names verbatim: operationIds listMyNotifications/markMyNotificationsRead, path /v1/engagement/me/notifications[/bulk-mark-read], permissions engagement.self.read/manage, outcome enum updated|not_found, Notification fields, kind/route enums all match contracts/openapi/engagement.yaml.
- Tenant isolation: every statement binds tenant_id; account scoping relies on existing PAT_ACC RLS (schema task, not in this diff); `ANY($2::uuid[])` cast present; only write is `SET read_at` with `read_at IS NULL`.
- Permission asserted before any query; fail closed without ctx/IdentityPort; Cache-Control no-store; x-idempotency optional / rate tier general handled by pipeline; error codes from registry.
- No PHI/text stored, selected or logged; no secrets; paths inside C16 engagement module + features/notifications.
- Tests cover done_when + US-EN-11.1-11.3 (mixed-id per-id not_found, per-kind rendering, refresh on launch/resume/pull, no push SDK). Re-ran: API 35/35, Flutter 80/80 pass.
- Non-blocking: booking kinds render without {booking_no} (spec: fetched on tap) — stated assumption, acceptable; "no push SDK" CI check is a Dart test, not a tools/ script.
