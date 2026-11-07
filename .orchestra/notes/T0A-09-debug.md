# T0A-09 debug
- Cause: tools/devstack/upstream.env.example absent (both failing tests need it); not a code defect. LD-23(1) fix = curl byte-for-byte from the Supabase commit matching C1 02-TRD §2 tags, first-line comment naming the commit.
- Not fixed: sandbox denies network (curl "requires approval", non-interactive). Commit sha not resolvable offline; not invented. Needs a human/orchestrator with network to run the curl, then re-run verify.
