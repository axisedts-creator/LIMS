# AG-T02 measured evidence, Windows 11 (human lead run, 2026-11-11)
Measured by the human lead with the throw-away spike program (C:\LIMS-state\spikes\ag-t02\, not part of the repo) on Windows 11 Home Single Language 26H2 build 26300.9711, amd64, Go 1.26.10, golang.org/x/sys v0.49.0. Raw file: C:\LIMS-state\spikes\ag-t02\evidence-RAUNAK-20261111-101527.txt. The service ran as NT SERVICE\LimsBridgeAgent (whoami: nt service\limsbridgeagent; profile C:\WINDOWS\ServiceProfiles\LimsBridgeAgent). Synthetic data only.
Windows 10: NOT RUN (release gate, Addendum A36-4). No Server 2016 (dropped, A36-1).
Not tested on this machine: COM port open (no COM port present); service control from a non-elevated caller (the controller ran elevated); anything on Windows 10.

```
ENV: Microsoft Windows 11 Home Single Language | edition CoreSingleLanguage | display version 26H2 | build 26300.9711 | arch AMD64 | PowerShell 5.1.26100.9711
ENV: date 2026-11-11T10:15:28 on RAUNAK
ENV: go=go1.26.10 goos=windows goarch=amd64
ENV: golang.org/x/sys=v0.49.0
S1 data-root ACL set with inheritance removed: SYSTEM full, Administrators full, NT SERVICE\LimsBridgeAgent modify, no Users entries
S1.round1 {
S1.round1   "CryptProtectData_CRYPTPROTECT_LOCAL_MACHINE": "OK",
S1.round1   "CryptProtectData_user_scope": "OK",
S1.round1   "CryptUnprotectData_machine_scope_roundtrip": "OK",
S1.round1   "CryptUnprotectData_user_scope_roundtrip": "OK",
S1.round1   "com": "no COM port present on this machine",
S1.round1   "datarootwrite_config": "OK",
S1.round1   "datarootwrite_logs": "OK",
S1.round1   "datarootwrite_queue": "OK",
S1.round1   "datarootwrite_secrets": "OK",
S1.round1   "datarootwrite_status": "OK",
S1.round1   "datarootwrite_versions": "OK",
S1.round1   "goarch": "amd64",
S1.round1   "round": 1,
S1.round1   "time": "2026-11-11T10:16:05+05:45",
S1.round1   "userprofile": "C:\\WINDOWS\\ServiceProfiles\\LimsBridgeAgent",
S1.round1   "whoami": "nt service\\limsbridgeagent"
S1.round1 }
S1 SCM StartName = NT SERVICE\LimsBridgeAgent
S2 control code 128: Control() result=OK service_state=4 delivered_to_handler=true
S2 control code 129: Control() result=OK service_state=4 delivered_to_handler=true
S2 control code 255: Control() result=OK service_state=4 delivered_to_handler=true
S2 control code 127: Control() result=FAIL: The parameter is incorrect. service_state=0 delivered_to_handler=false
S2 request.json: consumed by the service after 3.3 s (service polls every 5 s)
S1.round2 {
S1.round2   "after_restart_machine_scope_unprotect": "OK",
S1.round2   "after_restart_user_scope_unprotect": "OK",
S1.round2   "com": "no COM port present on this machine",
S1.round2   "datarootwrite_config": "OK",
S1.round2   "datarootwrite_logs": "OK",
S1.round2   "datarootwrite_queue": "OK",
S1.round2   "datarootwrite_secrets": "OK",
S1.round2   "datarootwrite_status": "OK",
S1.round2   "datarootwrite_versions": "OK",
S1.round2   "goarch": "amd64",
S1.round2   "round": 2,
S1.round2   "time": "2026-11-11T10:16:15+05:45",
S1.round2   "userprofile": "C:\\WINDOWS\\ServiceProfiles\\LimsBridgeAgent",
S1.round2   "whoami": "nt service\\limsbridgeagent"
S1.round2 }
S1 admin-context CryptUnprotectData(dpapi-user.bin): FAIL: Key not valid for use in specified state.  [user-scope blob written by the virtual account]
S1 admin-context CryptUnprotectData(dpapi-machine.bin): OK  [machine-scope blob written by the virtual account]
S3 two self-signed test code-signing certificates created (publisher A and publisher B) and trusted in LocalMachine\Root for the test
S3 Set-AuthenticodeSignature status: publisher A = Valid, publisher B = Valid
S3 unsigned exe: WinVerifyTrustEx HRESULT=0x800B0100 (TRUST_E_NOSIGNATURE)
S3 signed by publisher A, root trusted: WinVerifyTrustEx HRESULT=0x00000000 (ERROR_SUCCESS (signature valid and trusted))
S3 publisher check on the A-signed file, expected publisher A: Get-AuthenticodeSignature status=Valid subject=CN=LIMS Spike Test Publisher A thumbprint=CF94C73E9C8F264650F4D662F94033B371CB6255 matches_expected_publisher=True
S3 signed by A then tampered (one byte flipped mid-file): WinVerifyTrustEx HRESULT=0x80096010 (TRUST_E_BAD_DIGEST)
S3 signed by publisher B, root trusted: WinVerifyTrustEx HRESULT=0x00000000 (ERROR_SUCCESS (signature valid and trusted))
S3 publisher check on the B-signed file, expected publisher A: Get-AuthenticodeSignature status=Valid subject=CN=LIMS Spike Test Publisher B thumbprint=D65486F646519C34F12BE41CF77055CE3617F74C matches_expected_publisher=False
S3 signed by A, publisher A root removed from the trust store: WinVerifyTrustEx HRESULT=0x800B0109 (CERT_E_UNTRUSTEDROOT)
```
