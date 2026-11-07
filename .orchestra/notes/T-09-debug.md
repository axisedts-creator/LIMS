# T-09 debugger
- Cause: 4 fails = missing real-world values, not code bugs. (1) Dockerfile `ARG PGBACKREST_TARBALL_SHA256=` empty; (2-4) DECISION.md T-09 section says "NOT yet run"/"NOT measured"/"still OPEN" (no check/full+incr results, no pgbackrest.org 2.60 re-check, no measured WAL/day).
- Fix: none applied. Values need network (curl to github denied here) and image build + data-1/dr-1 runs; inventing them violates CLAUDE.md. Tests are correct vs done_when, so no dispute.
- Needed from CI/host: sha256sum of github.com/pgbackrest/pgbackrest/archive/release/2.60.0.tar.gz -> Dockerfile ARG; check/full/incr results, multi-repo re-check, `WAL volume per day (measured ...): <n> GiB/day` -> DECISION.md.
- Remaining: 31/35 pass; T-09 done_when NOT met until the above is recorded.
- Round 2 (2026-11-07): re-read verify log, same 4 fails, same cause. No code change: values need network + image build + data-1/dr-1 run. Not invented. Escalate to human/CI.
