# T-P2 impl (writer)
- API: `handlers/orders.handlers.ts` (E20/E21, wired in `handlers/index.ts`), `service/orders.service.ts`. `orders.handlers.test.ts` 32/32 pass.
- App: `lib/features/orders/{orders_api,orders_providers,orders_format,orders_list_screen,order_detail_screen}.dart`. After ruling fix (flutter_test import): `flutter test test/features/orders` 41/41 pass (A10, A11 polling, source rules); `flutter analyze` clean. No impl change needed.
- [CONV] E21 304 = transport returns `null` (typedef has no status/headers); ETag "<status_version>.<max specimen status_seq>.<report count>", body etag == header; If-None-Match exact match, checked only after the 404 visibility checks.
- [CONV] Poll 30 s fixed (`order_poll_seconds` not read); stops on hidden/paused/detached, 404, logout, dispose; one refresh on resumed; one E21 in flight. Display time Asia/Kathmandu (+05:45).
- Review #1 applied: 30-day cancelled hide removed from E21 (TRD §4.4 scopes it to E20); `reports: Row[]` typed (tsc clean for engagement). vitest 32/32 rerun.
- [CONV] List: per-link visible_from groups, cancelled hidden 30 d after updated_at (E20 only), paging in memory over <=1,000 rows/group (ponytail); discarded specimens neither listed nor counted.
- Open: 426 app-version guard, `order_poll_seconds` setting, router wiring of `patient_app.order`, [Pay now] / [Book a visit] (T-PAY1, T-BK1), real-Postgres RLS (PAT_VIS) not exercised.
