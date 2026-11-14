# T0A-13 impl
- Changed: `.github/workflows/pr.yml` only — added `actions/setup-go@v5` with `go-version-file: apps/bridge-agent/go.mod` to c7-go-build, c7-go-windows, c7-go-sessions (after plan, before command).
- Review round: c17-db-forensics gets `subosito/flutter-action@v2` with `flutter-version-file: packages/ui-flutter/pubspec.yaml` (C0 02-TRD §2.2 Flutter pin), gated, after plan and before KVM/emulator.
- [CONV] setup steps gated on `steps.plan.outputs.run == 'true'` like every post-plan step; c7-go-insecure-tls-gate left without Go (grep gate). Actions pinned to major tags, matching existing pr.yml style.
- Result: `node --test tools/lint/tests/ci-chunk-jobs.test.mjs` 111/111 pass.
- Open: apps/bridge-agent/go.mod and packages/ui-flutter/pubspec.yaml do not exist yet; flutter-action needs an exact `environment: flutter:` version in that pubspec. Non-blocking typecheck/lint SDK provisioning (pr.yml:63-69, 91-92) routed to T0A-10 owner.
