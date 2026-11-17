# API-T03 impl
- New: `instruments/auth/deviceTokenResolver.ts` (classifyCredential, createDeviceTokenResolver), `instruments/service/credentials.service.ts` (generateDeviceToken/EnrolmentCode, hashCredential, requireCredentialKind, touchCredential). Edited `instruments/index.ts`: manifest.authResolvers.deviceToken.
- [CONV] Generation via shared-ts randomToken/sha256Bytes by relative import (same as reporting tokens.ts).
- [CONV] Format check = regex + exact length (blocks trailing-\n `$` pitfall). Every failure returns frozen `{ error: 'auth.device_token_invalid' }`; DB errors propagate.
- [CONV] Touch: `last_used_at < now() - make_interval(secs => $2)`; window must be positive safe integer (RangeError before query).
- Open: manifest uses a no-op metric sink until CR `.orchestra/cr/API-T03.md` (core DEFS + module metrics seam) lands.
- Run: device-credentials.test.ts 61/61 pass. instruments suite 409/411 — 2 boot.test failures pre-existing (API-T01 ESCALATE: LIMS_CORE_ENV / reporting manifest), not touched.
