# Connecting Phlebo App to Live LIMS Test Server

## Prerequisites
1. Dev machine (or phone) connected to Tailscale tailnet with access to server `100.82.8.12`.
2. Bundled CA certificate `assets/ca/lims-internal-ca.pem` (pinned automatically in dev/staging).

## Run Command (Android / Device / Emulator)
```bash
flutter run -t lib/main.dart \
  --dart-define=FLAVOR=dev \
  --dart-define=API_BASE_URL=https://api.lmis.imisaxis.com \
  --dart-define=DEV_HOST_OVERRIDE=api.lmis.imisaxis.com=100.82.8.12:8443
```

## How It Works
- Uses pinned HTTPS client trusting `assets/ca/lims-internal-ca.pem` (no system roots, no bad certificate bypass).
- `DEV_HOST_OVERRIDE` routes TCP socket to `100.82.8.12:8443` while retaining SNI, Host header, and full TLS validation against the pinned CA.
- Strictly forbidden in production builds (guarded by compile-time and runtime checks).
