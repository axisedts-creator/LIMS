Title: CR-C1-AUTH-MFA-COMPLETE-1.actor: SessionState.actor now present in verifyMfaChallenge and completeMfaEnrolment replies (closes CR T6 item 2)
From chunk: C1   To owner: C0-0C (contracts) / lead   Type: bug   Blocking? no (LD-221 item 5, founder yes 2026-11-15 17:10 NPT)
Problem: both MFA code steps answered 200 SessionState without actor, but contracts/openapi/identity.yaml SessionState requires it; staging validates responses -> response_contract_violation 500 (same defect LD-208 fixed for loginStaff and resolveSession).
Change made (no contract change): handlers/verifyMfaChallenge.ts loadActor/sessionState use repo.sessionActor + loadSessionActor (service/session-actor.ts), read BEFORE the GoTrue code check so a missing actor never consumes a code; tenant and platform paths of both operations.
Ask: record in the identity notes that CR T6 item 2 (actor has no source on the MFA path) is resolved by app.identity_session_actor; no yaml change needed.
Not covered live: the normal login code step on a tenant (never run live).
