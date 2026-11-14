APPROVE
Scope: f3606b6f..HEAD, re-review after c906f094/d42f1e37 (fix for prior item 1).
Item 1 is resolved. services/worker/src/jobs/engagement/tasks/send_login_otp.ts:37 sets lastAttempt from jobCtx.attempt/maxAttempts (consumer.ts:61 fills them from job.attempts/max_attempts). On the last attempt, both a transient port error and an unknown status now call markFailed, which sets status 'failed' and code_ciphertext NULL (otp.repo.ts:61). That matches TRD §8.1 (02-TRD.md:655) and done_when. Earlier attempts still throw, roll back and retry with the same otp:<id> key. If attempt/maxAttempts are missing, the task fails closed and treats the run as the last attempt.
New worker tests cover attempt 3/3 (failed, ciphertext NULL, no audit) and attempt 2/3 (throws, still pending, ciphertext kept).
Verify run: api 49/49 passed; worker send_login_otp 20/20 passed.
Earlier checks still hold: names verbatim, tenant_id bound in every statement, no phone/code/token in logs or errors, owned paths only, no secrets.
