# T0A-11 impl (writer)
- Added `lib/src/errors.dart`: `FieldError{path,code,message}` (const), `LimsException(code, {safeDetail, fieldErrors})` implements Exception (IC §4.1 shape).
- `lib/lims_shared.dart` barrel exports bsdate, error_codes.g, errors, money, routes.g, uuidv7.
- `lib/src/bsdate/bsdate.dart`: BsDateError removed; throws LimsException with `LimsErrorCodes.commonDateOutOfRange` / `commonValidationFailed`, message moved to safeDetail.
- Added `analysis_options.yaml` = `include: ../../analysis_options.yaml` [CONV] (single source of CV §1.3 strict flags).
- Ran T0A-11-verify.cmd steps after ruling fix (ca60286): `dart analyze --fatal-infos` = No issues found; `dart test` (4 files) = 43/43 pass.
- Dispute resolved by T0A-11-ruling.md (test-side cast fix); no impl change needed.
- Money top-level `add/sub/compare/format` exported unprefixed; consumers should prefix-import (per tester note).
