APPROVE
Diff 0cd69972..HEAD: the only code change is session-kinds.app.test.ts:101. It matches T31-ruling.md word for word: line 101 only, every other assertion is kept, and there is no impl change.
Earlier CHANGES items checked at HEAD: (1) rotateToken returns boolean (mfa.repo.ts:151) and is called before GoTrue; a miss goes through reuse() (session.service.ts:220). (2) The login_failed reasonCode is 'auth.forbidden' (auth.service.ts:190). (3) CR C2.T31.nonblocking.md item (4) names the missing patient refresh op, and T31-impl.md says AU-T15 is proven for staff_mobile only.
No new names, PHI, secrets or non-owned paths in the diff.
Reviewer re-ran: T31 suites 102/102; identity 3434 pass / 0 fail / 72 skip.
Not proven: real DB/RLS, CHECKs, EdDSA signing. These stay open per T31-impl.md and the CR.
