# T1 debug (2026-11-07)
- Only failing test: mapping.test.ts:29 needs `Live contract run: PASS <date>` in mapping.md; line 6 says NOT YET RE-RUN. Not an impl bug: live run after ruling never executed.
- No code fix possible. Writing PASS line without a run = fabrication; not done.
- Live run (`sh supabase/.temp/t1gt/up.sh`, then http.live.test.ts per T1-impl.md) was blocked: shell approval denied in this session. Needs human/approved session; then set mapping.md line 6 to PASS and teardown lims_t1_gotrue.
