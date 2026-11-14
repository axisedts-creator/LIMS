APPROVE

- Ran T0A-11-verify.cmd steps: `dart analyze --fatal-infos` = No issues found; `dart test` (4 files) = 43/43 pass.
- errors.dart matches the IC §4.1 LimsError/FieldError shape (code, safeDetail?, fieldErrors?; path/code/message). It uses the generated `LimsErrorCodes` from T0C-05. The `ErrorCode` named in TRD §3.4 does not exist in the codegen output, which C0-0C owns, so this is not a defect for T0A-11.
- bsdate now throws LimsException with registered codes `common.date_out_of_range` / `common.validation_failed`. BsDateError is removed. nepali_utils is imported only under lib/src/bsdate.
- analysis_options.yaml includes the root file, and the test checks for the CV §1.3 strict flags. The pubspec has workspace resolution and is listed in the root workspace.
- The money_golden_test.dart change follows the ruling: only the helper casts changed, no assertions changed. All edits are in packages/shared-dart/** and notes.
- No secrets, no PHI, and no names that are not in the spec. RLS, permissions, idempotency and rate tier don't apply here (pure library).
