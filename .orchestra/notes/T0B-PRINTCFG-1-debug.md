# T0B-PRINTCFG-1 debug 2026-11-18
- Verify log: only 2 fails, both render.client.integration (real Chromium render), error "renderer unreachable or failed" (render.client.ts:34 hides cause). 4564 pass; all print tests green.
- Re-ran file alone now: 6/6 pass (1.97 s). Test uses its own test-only template (data fn), not renderReport/print_profile path; PRINTCFG diff in renderer render.ts/server.ts/pool.ts does not touch that path. No code cause found; no code change made.
- Could NOT reproduce the DB-harness run (pg.sh needs docker/approval, denied in this session). Root cause under pg.sh unproven; ruling point 2 (env/load) stands as unverified. Next: run pg.sh with PRINTCFG_SUITE=that one file, log res.status in a scratch copy of the client.
