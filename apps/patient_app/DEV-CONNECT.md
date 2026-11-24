# Connecting Patient App to Live LIMS Test Server

## Prerequisites
1. Dev machine (or phone) connected to Tailscale tailnet with access to server `100.82.8.12`.
2. Bundled CA certificate `assets/ca/lims-internal-ca.pem` (trusted automatically in dev/staging).

## Run Command (Android / Device / Emulator)
```bash
flutter run -t lib/main_dev.dart \
  --flavor dev \
  --dart-define=API_BASE_URL=https://api.lmis.imisaxis.com \
  --dart-define=PORTAL_ORIGIN=https://portal.lmis.imisaxis.com \
  --dart-define=TENANT_CODE=demo_lab4 \
  --dart-define=DEV_HOST_OVERRIDE=api.lmis.imisaxis.com=100.82.8.12:8443,portal.lmis.imisaxis.com=100.82.8.12:8443
```

## How It Works
- `DEV_HOST_OVERRIDE` routes TCP socket connections to `100.82.8.12:8443` while retaining original hostname for SNI, the Host header, and TLS certificate validation.
- Internal CA (`assets/ca/lims-internal-ca.pem`) is trusted without disabling certificate verification (no `badCertificateCallback`).
- Strictly forbidden in production builds (guarded by compile-time and runtime checks).
