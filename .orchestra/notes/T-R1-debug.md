# T-R1 debug
Cause: send_reminder had no terminal failed path; port error on last attempt (8/8) always threw, so 2 worker tests failed (resolves expected) and the row stayed scheduled, re-enqueued every 5 min.
Fix: tasks/send_reminder.ts wraps sendSms; if attempt >= maxAttempts, finish('failed', failure_code = LimsError code else common.internal) and return; earlier attempts still throw (03-APP-FLOW scheduled -> failed).
Result: worker src/jobs/engagement 33/33 pass. Tests untouched.
