# HC-T08 debug
- Cause: env, not code. verify.log only line: Docker daemon down (npipe dockerDesktopLinuxEngine missing); HC-T08.pg.sh cannot bootstrap PG17. `docker info` still shows no server.
- Fix: none in implementation. Start Docker Desktop, rerun .orchestra/notes/HC-T08-verify.cmd.
- Also (impl note OPEN): tester-owned boot.test.ts IMPLEMENTED list lacks the 5 HC-T08 handlers; boot specs also need LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE. Neither is impl code.
