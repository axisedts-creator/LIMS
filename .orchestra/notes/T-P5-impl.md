# T-P5 impl (writer)
Files: API `repository/notification.repo.ts`, `service/notification.service.ts`, `handlers/notification.handlers.ts` (+ wired in `handlers/index.ts`). App `lib/features/notifications/{notifications_api,notifications_providers,notifications_screen,notification_bell}.dart`.
Tests: API notification.handlers + world self-test 35/35; Flutter notifications 80/80; `flutter analyze` clean. Full engagement suite 1459/1460: `boot.test.ts` PHASE_STUBS (QualityPort) fails, not touched by T-P5.
[CONV] LD-140: lims_ui widgets + tokens only; one LimsButton ("Mark all read", secondary, app bar); unread = LimsStatusChip "New" (tone, icon, word).
[CONV] Account scoping is RLS only (PAT_ACC), no account_id bound in SQL; E46 = SELECT visible ids, then `UPDATE ... SET read_at = $3 ... AND read_at IS NULL` per own id (first read wins); the only write is read_at.
[CONV] Cursor = base64url [created_at ISO, id] keyset at ms precision (ponytail comment in service); first page only in the app (bell + A20), no "load more".
Open: `tsc --noEmit` shows only pre-existing repo-wide errors in contracts/ and packages/shared-ts (none in T-P5 files); CI "no push SDK" check is the Dart test (no tools/ script).
