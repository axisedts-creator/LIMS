Title: CR-C16-T-P3: patient app needs (a) a binary-capable transport for E23 and (b) a share/save plugin for A13
From chunk: C16            To owner: C16 T-A1 / lims_api_client owner (CR-C16-016/017) for (a); C0-0D / pubspec owner for (b)
Type: shared-lib (a); dependency (b)
Blocking? no for T-P3 delivery. (a) `TransportPatientReportsApi.downloadReport` expects the transport to return a `Uint8List` for `application/pdf` and throws common.internal otherwise (untested against a real transport); (b) the default `ReportSharer` refuses and A13 shows "The report could not be saved."
Problem:
 (a) `PatientTransport` (lib/core/api/api_client_factory.dart) returns decoded JSON only; E23 answers `application/pdf` (02-TRD §5 E23).
 (b) 04-UI-UX A13 requires Share/Save after the confirmation dialog; no share dependency exists in apps/patient_app/pubspec.yaml.
Proposed change (exact):
 (a) The generated client / inner transport returns the raw body as `Uint8List` when the response content-type is `application/pdf`.
 (b) Add a share dependency chosen by the pubspec owner and implement `ReportSharer` in lib/features/reports/reports_providers.dart (override `reportSharerProvider`).
Backward compatible? yes — additive.
Tenant/security impact: bytes only through the API (REQ-SEC-034/035); the shared file is the transient temp file, consent asked on every share (US-EN-08.6).
IRD/regulatory impact: n/a
Alternatives considered: base64 JSON body for E23 (rejected: TRD fixes `application/pdf` stream).
Tests that will prove it: transport test returning bytes for E23; a sharer test with the real plugin faked at the platform channel.
