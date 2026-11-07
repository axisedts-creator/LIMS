APPROVE
- Diff f4d11bf..HEAD: Dart LD-08 first-day override (2093-10 -> 2037-01-15, matches golden row l.6884-6887), review.json tests accept resolved_by 'LD-08' only with verify_before_golive:true (TS + Dart), pubspec.lock populated (root Dart workspace, C0-0A owned).
- done_when: golden-2000-2099.json and review.json tracked in git; all entries resolved (LD-08 flagged).
- Reviewer RAN: `node --test packages/shared-ts/test/bsdate.test.mjs` 20/20 pass; `dart test test/bsdate_golden_test.dart` 9/9 pass.
- LD-08 packages recorded in db/meta/decisions/T0-03-dependencies.md (l.47 @remotemerge/nepali-date-converter 1.2.7 MIT; l.58 nepali_utils 3.0.8 MIT).
- N/A for this task: RLS, permissions, idempotency, rate tier. No PHI/secrets; only owned paths.
- Non-blocking: all 107 LD-08 months (B.S. 2084–2097, incl. 2093-09/10 where libraries disagree) must be checked against an official calendar before go-live.
