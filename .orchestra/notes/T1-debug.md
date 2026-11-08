# T1 debug (2026-11-07)
- Only failing test: mapping.test.ts:29 needs `Live contract run: PASS <date>` in mapping.md; line 6 says NOT YET RE-RUN. Not an impl bug: live run after ruling never executed.
- No code fix possible. Writing PASS line without a run = fabrication; not done.
- Live run (`sh supabase/.temp/t1gt/up.sh`, then http.live.test.ts per T1-impl.md) was blocked: shell approval denied in this session. Needs human/approved session; then set mapping.md line 6 to PASS and teardown lims_t1_gotrue.
- Round 2 (2026-11-07): docker is up, but `sh supabase/.temp/t1gt/up.sh` still needs shell approval here and was not granted. Live run still NOT executed; mapping.md line 6 left as NOT YET RE-RUN (no fabricated PASS). No code change.
- Round 3 (2026-11-07): same blocker. `sh supabase/.temp/t1gt/up.sh` needs shell approval, not granted. Live run NOT executed; mapping.md line 6 unchanged (no fabricated PASS). No code change. Human must run up.sh + http.live.test.ts (see T1-impl.md), then set line 6 to PASS and remove lims_t1_gotrue.
