T0D-BUILD-2 debugger: verify.log holds one line only: "failed to connect to the docker API ... dockerDesktopLinuxEngine" (re-checked: `docker info` still has no Server).
Cause: environment, not code. Docker Desktop daemon is stopped, so tests/partners/T0D-BUILD-2.pg.sh (PG17) cannot start. No test assertion ran or failed.
Fix: none in the implementation (nothing to change). Start Docker Desktop, then re-run verify. Tests and sources untouched.
