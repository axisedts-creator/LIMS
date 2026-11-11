# Bridge agent spikes (AG-T02)

Task AG-T02: Windows virtual account, service control codes and WinVerifyTrustEx.
Supported and verified OS set for v1 is Windows 10 and Windows 11 (LD-93, Addendum A36). Windows Server 2016 is out of scope for v1 (A36-1).
Windows 10 is NOT RUN and is a pre-pilot release gate, not a build gate (LD-94, Addendum A36-4).

Test machine (Windows 11): Windows 11 Home Single Language 26H2, build 26300.9711, amd64, Go 1.26.10, golang.org/x/sys v0.49.0, run on 2026-11-11 by the human lead with a throw-away spike program kept outside the repo. Synthetic data only. Source of every figure below: the lead's measured evidence note for AG-T02 on Windows 11.

## S1: virtual account NT SERVICE\LimsBridgeAgent (COM, data root, DPAPI)

What was checked: the service starts as the virtual account NT SERVICE\LimsBridgeAgent, opens a serial (COM) port, writes into every folder of the data root `C:\ProgramData\LIMS\BridgeAgent` through its service SID (REQ-SEC-116), and round-trips DPAPI CryptProtectData/CryptUnprotectData in user scope and in machine scope (CRYPTPROTECT_LOCAL_MACHINE). Each check was repeated after a service restart.

| OS | Verdict | Notes |
|----|---------|-------|
| Windows 11 | PARTIAL | Virtual account start OK (SCM StartName and whoami = NT SERVICE\LimsBridgeAgent, profile under ServiceProfiles). Data-root write OK in all six folders (config, logs, queue, secrets, status, versions). DPAPI user scope and machine scope round trip OK. All of these OK again after a service restart. COM open not tested: the machine has no COM port. |
| Windows 10 | NOT RUN | release gate (A36-4): must be run before pilot. |

Data-root ACL used for the run: inheritance removed; SYSTEM full, Administrators full, NT SERVICE\LimsBridgeAgent modify, no Users entries.

Cross-context finding: from an elevated admin context, CryptUnprotectData of the user-scope blob written by the virtual account failed ("Key not valid for use in specified state"), while the machine-scope blob decrypted OK. Machine scope therefore gives no protection beyond the file ACL: any local process can decrypt it.

## S2: custom service control codes 128-255

What was checked: user-defined control codes sent with ControlService through x/sys/windows/svc reach the service handler; code 128 = heartbeat now, code 129 = flush uploads now; the fallback path `status\request.json` polled every 5 s.

| OS | Verdict | Notes |
|----|---------|-------|
| Windows 11 | PASS | Codes 128, 129 and 255 delivered to the handler (Control() OK, service running). Code 127 rejected by the SCM with "The parameter is incorrect" and not delivered. status\request.json consumed after 3.3 s against a 5 s poll. Measured from an elevated caller only; non-elevated callers not tested. |
| Windows 10 | NOT RUN | release gate (A36-4): must be run before pilot. |

## S3: WinVerifyTrustEx on a test-signed exe

What was checked: WinVerifyTrustEx on an executable signed with a self-signed test certificate trusted in LocalMachine\Root for the test, plus negative cases and the separate publisher check (subject/thumbprint comparison against the expected publisher, REQ-SEC-119). Two test publishers (A and B) were created.

| OS | Verdict | Notes |
|----|---------|-------|
| Windows 11 | PASS | Unsigned: TRUST_E_NOSIGNATURE 0x800B0100. Signed by publisher A with a trusted test certificate: 0. Tampered after signing (one byte flipped): TRUST_E_BAD_DIGEST 0x80096010. Root not trusted (A root removed): CERT_E_UNTRUSTEDROOT 0x800B0109. File signed by publisher B (also trusted) passes WinVerifyTrustEx with 0 and was rejected only by the subject/thumbprint publisher check. |
| Windows 10 | NOT RUN | release gate (A36-4): must be run before pilot. |

Finding: WinVerifyTrustEx alone accepts any trusted publisher. The subject/thumbprint publisher check is separate and required.

## Decisions

Impact on TRD §5.12 (service account, DPAPI scope, control path) and on `install --account localservice`:

- DECISION: account = virtual account NT SERVICE\LimsBridgeAgent by default; `install --account localservice` stays the documented fallback (S1).
- DECISION: DPAPI = user scope for the data-key wrap; machine scope CRYPTPROTECT_LOCAL_MACHINE only as the fallback, and then the file ACL is the only protection, because any local process can decrypt machine scope while user scope failed from the admin context (S1).
- DECISION: control = user-defined control codes 128 and 129 via x/sys/windows/svc as the primary path; status\request.json with its 5 s poll as the fallback; both measured from an elevated caller only (S2).

Open before pilot: the Windows 10 run of S1-S3 (release gate, A36-4); COM port open on a machine with a serial port; control from a non-elevated caller.
