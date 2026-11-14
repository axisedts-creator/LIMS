T31 debug (23:2x): only failure = session-kinds.app.test.ts:101 (rotateToken committed after GoTrue refusal).
Cause: tests :72 (rotate before GoTrue) and :101 (no rotation kept when GoTrue refuses) are mutually exclusive under commitOnError (no savepoint in the fake).
Fix: none in implementation; test contradicts itself, not the spec (08-CR-REGISTER.md:214, A3.1). Dispute written in T31-dispute.md; stopped.
