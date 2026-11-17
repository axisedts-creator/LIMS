APPROVE

Reviewed `git diff 6efee832..80a5e1c6` (T-Q3: Q8 list/pair/revoke, Q9 board, queueDisplayToken resolver).

Checked against 02-TRD §4.10 / §5 Q8-Q9, CR-C16-005, 05-SCHEMA (queue_displays, queue_definitions, queue_tokens, queue_counters, booking_centres, settings, app.engagement_resolve_display, policy matrix incl. DISP), openapi engagement.yaml (QueueBoard, QueueDisplay, pair 201, revoke If-Match):
- Names verbatim: operationIds, permissions (engagement.queue.manage / engagement.queue.board_read), error codes, column names, DEFINER signature (bytea, 08 R24), claims {device, centre_id, device_kind: queue_display}.
- Tenant isolation: every statement binds tenant_id; `$5::uuid[]` on insert; board scoped to display's own centre + queue_ids; DISP policy relies on centre claim, which the resolver sets.
- Permissions: assertRole before any query; Q9 device-only (others -> auth.forbidden); revoke re-asserts on row centre; foreign/unknown -> identical common.not_found.
- Idempotency/tier left to core per contract (pair none/E1, revoke optional, general). Token plaintext only in 201 body; only SHA-256 stored; token_sha256 never selected. No logging, no secrets (synthetic tokens in tests).
- ETag/304 per TRD; board body contract-only fields (P0 labels).

Non-blocking notes (no change required):
- waiting_count has no business_date filter (relies on close_queue_day; [CONV] in impl notes).
- Missing booking_centres row -> centre_display_name '' (spec silent).
- pgTAP db/tests/engagement/T-Q3_resolve_display.test.sql not executed (no psql); must run in CI against migrated DB.
- Reviewer could not re-run vitest (host fork/resource failures); relied on writer's reported 780 pass / 2 skipped.
