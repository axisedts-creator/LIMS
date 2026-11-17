APPROVE
Reviewed `git diff 0751019e..HEAD` (T0D-15) against 04-UI-UX §8 (rows 393-399), 01-PRD AC-0D-9.1/9.2, plan row T0D-15, LD-46, LD-24.
- Ran: `flutter test` in packages/ui-flutter, 71/71 pass (Flutter 3.47.9, the local toolchain, same as the pin).
- Names: every §8 widget name (incl. all 13 CR-C16-016 ones + LimsSecureScreen, LimsTheme) exists verbatim. Pins are exact. pubspec.lock is committed. No dependency_overrides.
- LD-46: root sdk/flutter set to 3.13.7/3.47.9, workspace += packages/ui-flutter, T0-03 rows 57-58 have the manifest URL, fetch date and sha256. Edits outside packages/ui-flutter (root pubspec, shared-dart pubspec, T0-03 table, lock) are allowed by LD-46. shared-dart `test` 1.33.0->1.31.1 is a forced consequence (flutter_test pins test_api 0.7.12) and is recorded in T0-03 row 60.
- CR-C17-010/CR-C16-017: every capability (router, browser, local auth, PDF, QR, url hand-off, location) has a T0-03 row with licence and "no runtime egress". lib/ has no HTTP client. local_auth/geolocator/sentry_flutter are used only where spec or LD-24 names them.
- LD-24: beforeSend scrubber is installed even when off. sendDefaultPii=false, no screenshot or view hierarchy. Request body, query string and cookies are dropped. user = id only. Fails closed. DSN empty = SDK off. Tests cover the synthetic PHI event and the empty DSN.
- REQ-SEC-111: OTP/phone/code fields and `sensitive` text fields disable suggestions and autocorrect. REQ-SEC-109: LimsSecureScreen uses a ref-counted channel and does nothing when the channel is missing.
Non-blocking follow-ups (not in done_when):
1. 04-UI-UX §8 row 395 says "examples in `example/` use Riverpod". No example/ dir yet. Add it in a later pass (packages/ui-flutter/example/).
2. Writer's OPEN security items (mobile_scanner ML Kit metrics and web ZXing CDN, geolocator fused provider) need C0 security sign-off before C17 release. They are recorded in T0-03.
3. Goldens are writer-generated with the test font, so they are a weak oracle. The non-golden tests carry the contract.
