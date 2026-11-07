# T0A-11 impl (writer)
- Added `lib/src/errors.dart`: `FieldError{path,code,message}` (const), `LimsException(code, {safeDetail, fieldErrors})` implements Exception (IC §4.1 shape).
- `lib/lims_shared.dart` barrel exports bsdate, error_codes.g, errors, money, routes.g, uuidv7.
- `lib/src/bsdate/bsdate.dart`: BsDateError removed; throws LimsException with `LimsErrorCodes.commonDateOutOfRange` / `commonValidationFailed`, message moved to safeDetail.
- Added `analysis_options.yaml` = `include: ../../analysis_options.yaml` [CONV] (single source of CV §1.3 strict flags).
- Ran: `dart test` (4 files) = 43/43 pass; `dart analyze --fatal-infos` on lib + 3 other tests = clean.
- OPEN: `dart analyze` fails on `test/money_golden_test.dart` (11 strict-casts errors, test-owned) — see T0A-11-dispute.md.
- Money top-level `add/sub/compare/format` exported unprefixed; consumers should prefix-import (per tester note).
