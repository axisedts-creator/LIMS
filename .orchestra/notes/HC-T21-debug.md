# HC-T21 debug
- Cause: verify fails at `flutter pub get`: apps/phlebo_app/pubspec.yaml has `resolution: workspace` but root /pubspec.yaml `workspace:` lacks `apps/phlebo_app`. Not an impl-code defect; tests pass 50/50 once resolved.
- Root pubspec.yaml is owned by C0-0A (TRD:14, CHUNK-MAP §3); C17 may not edit it. No impl change made (dropping `resolution: workspace` would break the workspace contract).
- Fix = apply CR-C17-015 (.orchestra/cr/HC-T21.md): C0-0A adds `  - apps/phlebo_app` to root `workspace:`. Then re-run verify.
- Recheck: verify.log unchanged (same pub-workspace error); root pubspec.yaml still lacks `apps/phlebo_app`; CR-C17-015 still unapplied. Blocked, no code change possible within C17 ownership.
