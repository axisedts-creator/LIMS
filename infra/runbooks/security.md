# Security runbook (`security`)

Owner C1. One section per alert in `monitoring/rules/security.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2). `LimsAuthJailBan` is in `edge.md#limsauthjailban`.
These alerts are possible security events. Do not "tidy up" first: preserve evidence (`incident-response.md`) before changing anything on the host.

## SshLoginOutsideOps
Severity: page   Owner: C1   Last tested: never
**Means:** an SSH login by an account that is not an ops account happened in the last 10 min.  **Impact:** possible intrusion or a misconfigured account; SEV1 until explained.
**Check first:** `last -n 20` and `journalctl -u ssh --since -30min` on the host named in the alert (account, source address, key fingerprint); who is on call and doing maintenance (`ops_audit`).
**Fix:** 1. If a known engineer used a wrong account, record it and fix the account list through the `hardening` role. 2. If unexplained: isolate and preserve first (`incident-response.md`, state `contained`), lock the account (`usermod -L <account>`), end its sessions (`pkill -KILL -u <account>`). 3. Rotate secrets that host held (`secrets.md`) if access cannot be excluded.
**Escalate when:** unexplained after 15 min -> founder, SEV1.
**Close-out:** incident record or ops log line with account, source, decision.

## SudoByUnknown
Severity: page   Owner: C1   Last tested: never
**Means:** `sudo` was used by an account that is not in the ops list in the last 10 min.  **Impact:** possible privilege escalation; SEV1 until explained.
**Check first:** `journalctl _COMM=sudo --since -30min` on the host (account, command, tty); `getent group sudo`.
**Fix:** 1. Same decision as `SshLoginOutsideOps`: known and mistaken -> fix the account list and record; unknown -> contain and preserve evidence, then lock the account. 2. Review `/etc/sudoers.d` against the repo (`host.md#configdrift`).
**Escalate when:** unexplained -> founder, SEV1.
**Close-out:** incident record or ops log line.

## SecretDecryptUnexpected
Severity: page   Owner: C1   Last tested: never
**Means:** a secret was decrypted outside a deploy window on a host in the last 10 min.  **Impact:** a person or process read secrets outside the normal rendering path; possible exposure.
**Check first:** `ops_audit` and the deploy log for a window at that time; `journalctl -t lims-secrets --since -30min` on the host; who was logged in (`last`).
**Fix:** 1. If a planned break-glass or rotation was running, record the reference and close. 2. Otherwise contain (lock the account, `usermod -L <account>`), preserve evidence, and treat the secrets listed for that host as exposed: rotate them with `secrets.md`. 3. Never paste a decrypted value into chat or tickets.
**Escalate when:** always the secondary on-call; unexplained -> founder, SEV1.
**Close-out:** incident record: window, who, which secrets were rotated.
