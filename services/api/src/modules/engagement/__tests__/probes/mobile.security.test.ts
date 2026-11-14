// C16.T-SEC1 — mobile security checks for apps/patient_app (07-SECURITY §6.6 "Mobile (T-SEC1)"; REQ-SEC-102/103/105/106/108/109/112; 02-TRD §3.5, §2.3; 04-UI-UX §1.1 PHI screen list).
// Static / source-level checks that run in CI without a device or a Flutter toolchain. Complements apps/patient_app/test/storage_hygiene_test.dart (T-A1, lib/ + pubspec.yaml only):
// this file ALSO covers the lock file (transitive deps), the Android native side (manifest, MainActivity, gradle), the release script and PHI-screen coverage.
// NOT covered (needs a built binary / device, listed in .orchestra/notes/T-SEC1-tests.md): real `adb` device dump, `strings` scan of the release AAB, iOS snapshot masking (no ios/ project exists yet).
// Lead decision LD-24 (error tracking via the self-hosted GlitchTip wrapper in lims_ui) is why sentry_flutter is allowed; a hosted sentry.io endpoint is not.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATIENT_APP_DIR, read, walk } from './support.js';

const A = (...p: string[]) => join(PATIENT_APP_DIR, ...p);
const files = (dir: string, ext: RegExp) => (existsSync(dir) ? walk(dir).filter((f) => ext.test(f)) : []);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"])\/\/.*$/gm, '$1'); // comments are not behaviour
const lib = files(A('lib'), /\.dart$/);
const libSrc = lib.map((f) => strip(read(f))).join('\n');
const android = files(A('android'), /\.(kt|java|kts|gradle|xml|properties)$/).filter((f) => !/GeneratedPluginRegistrant|local\.properties/.test(f));
const androidSrc = (re: RegExp) => android.filter((f) => re.test(f)).map((f) => ({ f, s: read(f) }));
const pubspec = read(A('pubspec.yaml'));
const lock = existsSync(A('pubspec.lock')) ? read(A('pubspec.lock')) : '';
const lockPackages = [...lock.matchAll(/^  ([a-z0-9_]+):\s*$/gm)].map((m) => m[1]!);
const manifest = read(A('android/app/src/main/AndroidManifest.xml'));

describe('REQ-SEC-109 screenshot / recents protection on PHI screens (Android FLAG_SECURE)', () => {
  const native = androidSrc(/src[\\/]main[\\/].*\.(kt|java)$/).map((x) => x.s).join('\n');

  it('the native side implements the lims_ui/secure_screen channel LimsSecureScreen calls: enable -> FLAG_SECURE set, disable -> cleared (without it the Dart widget is a silent no-op)', () => {
    expect(native, 'MainActivity (or a plugin class under android/app/src/main) must register the channel').toContain('lims_ui/secure_screen');
    expect(native).toContain('FLAG_SECURE');
    expect(native).toMatch(/"enable"/);
    expect(native).toMatch(/"disable"/);
    expect(native).toMatch(/addFlags|setFlags/);
    expect(native).toMatch(/clearFlags/);
  });

  it('every screen of a PHI feature is wrapped in LimsSecureScreen (04-UI-UX §1.1: A6-A15, A18, A21, A22)', () => {
    const phi = ['orders', 'reports', 'bookings', 'payments', 'enquiries', 'membership', 'profiles']; // A20 notifications (no text, REQ-SEC-106) and A23 settings are not on the 04-UI-UX §1.1 PHI list
    const screens = phi.flatMap((d) => files(A('lib/features', d), /_screen\.dart$/));
    expect(screens.length).toBeGreaterThanOrEqual(15);
    const unwrapped = screens.filter((f) => !/\bLimsSecureScreen\(/.test(strip(read(f)))).map((f) => f.slice(PATIENT_APP_DIR.length + 1).replace(/\\/g, '/'));
    expect(unwrapped).toEqual([]);
  });

  it('phone / OTP / link-code inputs use the lims_ui fields that switch suggestions + autocorrect off (REQ-SEC-111); no raw TextField / TextFormField in lib/', () => {
    expect(libSrc).not.toMatch(/\b(TextField|TextFormField|CupertinoTextField)\(/);
    const widgets = read(join(PATIENT_APP_DIR, '../../packages/ui-flutter/lib/src/code_inputs.dart'));
    expect((widgets.match(/enableSuggestions:\s*false/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((widgets.match(/autocorrect:\s*false/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(libSrc).toMatch(/LimsPhoneField\(/);
    expect(libSrc).toMatch(/LimsCodeField\(/);
  });
});

describe('REQ-SEC-105 no TLS bypass, no cleartext (grep)', () => {
  it('Dart: no badCertificateCallback, HttpOverrides, allow-invalid-certs or insecure client options', () => {
    for (const bad of ['badCertificateCallback', 'HttpOverrides', 'allowInvalidCertificates', 'allowBadCertificates', 'SecurityContext(withTrustedRoots: false', 'trustAllCerts', 'onBadCertificate', 'validateCertificate: false', 'ignoreBadCertificate'])
      expect(libSrc, bad).not.toContain(bad);
  });

  it('Android: no custom TrustManager / HostnameVerifier / WebView ssl override, no cleartext traffic, no user-CA trust anchors in a network security config', () => {
    const all = android.map((f) => ({ f, s: read(f) }));
    for (const { f, s } of all) {
      expect(s, `${f} X509TrustManager`).not.toMatch(/X509TrustManager|TrustManagerFactory|HostnameVerifier|onReceivedSslError|ALLOW_ALL_HOSTNAME_VERIFIER|SSLSocketFactory/);
      expect(s, `${f} cleartext`).not.toMatch(/usesCleartextTraffic\s*=\s*"true"|cleartextTrafficPermitted\s*=\s*"true"/);
      expect(s, `${f} user CA`).not.toMatch(/<certificates\s+src="user"/);
    }
  });

  it('non-dev flavour entrypoints use https base URLs only; http:// appears nowhere in lib/ except loopback / emulator hosts in main_dev.dart', () => {
    const offenders: string[] = [];
    for (const f of lib) {
      const s = strip(read(f));
      for (const m of s.matchAll(/http:\/\/[^\s'")]+/g)) {
        const isDevLoopback = /main_dev\.dart$/.test(f) && /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:|\/|$)/.test(m[0]);
        if (!isDevLoopback) offenders.push(`${f.slice(PATIENT_APP_DIR.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const flavour of ['main_staging.dart', 'main_prod.dart']) expect(strip(read(A('lib', flavour))), flavour).toMatch(/apiBaseUrl:[^\n]*'https:\/\//);
  });
});

describe('REQ-SEC-106 / SEC-102 / SEC-103 dependency deny-list (pubspec.yaml + pubspec.lock, i.e. the transitive tree)', () => {
  const DENY: Array<[string, RegExp]> = [
    ['push / messaging', /^(firebase_messaging|firebase_core|firebase_.*|onesignal_flutter|flutter_apns|awesome_notifications|pusher_.*|pushy_flutter|huawei_push)$/],
    ['analytics / attribution / ads', /^(firebase_analytics|google_analytics.*|mixpanel_flutter|amplitude_flutter|appsflyer_sdk|adjust_sdk|segment_.*|posthog_flutter|datadog_.*|clarity_flutter|uxcam|flutter_branch_sdk|facebook_app_events|google_mobile_ads|unity_ads.*|applovin_.*)$/],
    ['hosted crash reporting', /^(firebase_crashlytics|bugsnag_flutter|instabug_flutter|appcenter.*)$/],
    ['offline stores / HTTP caches (no offline DB, REQ-SEC-103)', /^(shared_preferences.*|sqflite.*|hive.*|drift.*|isar.*|sembast.*|objectbox.*|dio_cache_interceptor.*|http_cache.*|floor|realm)$/],
    ['web views (no payments / reports in a WebView; gateway pages open in the system browser)', /^(webview_flutter.*|flutter_inappwebview.*|flutter_webview_plugin|webview_windows)$/],
    ['vendor RASP / device-risk SDKs that phone home (REQ-SEC-108)', /^(freerasp|talsec.*|appdome.*|jailbreak_root_detection_foreign)$/],
  ];

  it('the lock file is present and parsed (an empty lock would make the deny-list vacuous)', () => {
    expect(lockPackages.length).toBeGreaterThan(30);
    expect(lockPackages).toContain('flutter_secure_storage');
  });

  for (const [why, re] of DENY) {
    it(`no ${why}`, () => {
      const declared = [...pubspec.matchAll(/^  ([a-z0-9_]+):/gm)].map((m) => m[1]!);
      expect([...new Set([...declared, ...lockPackages])].filter((p) => re.test(p))).toEqual([]);
    });
  }

  it('error tracking is the LD-24 self-hosted GlitchTip path: sentry_flutter only through the lims_ui wrapper, no hosted sentry.io DSN in source or build config', () => {
    expect(libSrc).toContain('LimsErrorTracking.configure');
    for (const f of [...lib, ...android.map((x) => x), A('pubspec.yaml')]) expect(read(f), f).not.toMatch(/sentry\.io|ingest\.sentry/i);
  });

  it('the Android build has no Google services / Firebase plugin or dependency', () => {
    for (const { f, s } of androidSrc(/\.(kts|gradle)$/)) expect(s, f).not.toMatch(/google-services|com\.google\.firebase|firebase-|crashlytics|play-services-ads|com\.google\.android\.gms:play-services-analytics/i);
    expect(existsSync(A('android/app/google-services.json'))).toBe(false);
    expect(existsSync(A('ios/Runner/GoogleService-Info.plist'))).toBe(false);
  });

  it('the manifest requests no push, ads, storage, location or microphone permission', () => {
    const perms = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]!);
    for (const p of perms) expect(p, p).not.toMatch(/POST_NOTIFICATIONS|AD_ID|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION|RECORD_AUDIO|READ_CONTACTS|CAMERA|C2D_MESSAGE|RECEIVE_BOOT_COMPLETED|SYSTEM_ALERT_WINDOW/);
  });
});

describe('device dump: no token outside secure storage (REQ-SEC-102 / SEC-103)', () => {
  it('Android auto-backup is off, so `adb backup` / cloud backup cannot carry app files', () => {
    expect(manifest).toMatch(/android:allowBackup="false"/);
  });

  it('the session token key is read and written only through FlutterSecureStorage in session_store.dart', () => {
    const store = read(A('lib/core/session/session_store.dart'));
    expect(store).toContain('FlutterSecureStorage');
    const users = lib.filter((f) => /SessionStore\.key|lims\.patient\.session_token|FlutterSecureStorage/.test(read(f))).map((f) => f.slice(PATIENT_APP_DIR.length + 1).replace(/\\/g, '/'));
    expect(users.filter((f) => !/^lib[\\/]core[\\/]session[\\/]session_store\.dart$|^lib[\\/]app[\\/]providers\.dart$|^lib[\\/]core[\\/]session[\\/]session_controller\.dart$/.test(f))).toEqual([]);
  });

  it('the only file writes in lib/ are the transient-PDF helper (secure_temp_files.dart); nothing else writes File / Directory contents', () => {
    const writers = lib.filter((f) => /\.(writeAsBytes|writeAsString|openWrite)\(|getApplicationDocumentsDirectory|getExternalStorageDirectory|getApplicationSupportDirectory/.test(strip(read(f)))).map((f) => f.slice(PATIENT_APP_DIR.length + 1).replace(/\\/g, '/'));
    expect(writers.every((f) => /secure_temp_files\.dart$/.test(f)), writers.join(', ')).toBe(true);
  });

  it('no token, OTP, phone or report content is logged: no print / debugPrint / developer.log of tokens in lib/', () => {
    expect(libSrc).not.toMatch(/\bprint\(/);
    expect(libSrc).not.toMatch(/\b(debugPrint|developer\.log|log\.(info|warning|severe|fine))\([^;]*\b(token|otp|session|phone|bearer|authorization)\b/i);
  });
});

describe('REQ-SEC-112 obfuscated release build, symbols kept out of the repo', () => {
  const script = read(A('tool/release_android.sh'));
  it('the release script builds with --obfuscate and --split-debug-info', () => {
    expect(script).toMatch(/flutter build (appbundle|apk)[^\n]*--release/);
    expect(script).toContain('--obfuscate');
    expect(script).toMatch(/--split-debug-info=\S+/);
  });
  it('symbol files go under a git-ignored path (build/) and signing secrets come from the environment, never the repo', () => {
    expect(script).toMatch(/--split-debug-info=build\//);
    expect(read(A('.gitignore'))).toMatch(/^\/?build\/?$/m);
    expect(script).toMatch(/LIMS_RELEASE_STORE_FILE|secret store/);
    for (const f of walk(A('android'))) expect(f, 'signing material committed').not.toMatch(/\.(jks|keystore|p12)$|key\.properties$/);
  });
  it('R8 / minify is not disabled for release in the app gradle config', () => {
    for (const { f, s } of androidSrc(/app[\\/]build\.gradle(\.kts)?$/)) expect(s, f).not.toMatch(/isMinifyEnabled\s*=\s*false|minifyEnabled\s+false/);
  });
});

describe('REQ-SEC-107 no secrets in the binary inputs (`strings` scan stand-in on sources)', () => {
  const SECRET = [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /AKIA[0-9A-Z]{16}/, /sk_(live|test)_[A-Za-z0-9]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /AIza[0-9A-Za-z_-]{35}/, /(api[_-]?key|secret|passw(or)?d|client_secret)\s*[:=]\s*['"][A-Za-z0-9+/_=-]{12,}['"]/i];
  it('no JWT, cloud key, payment key, private key, API key or password literal in lib/ or android/', () => {
    for (const f of [...lib, ...android]) { const s = read(f); for (const re of SECRET) expect(s, `${f} ${re}`).not.toMatch(re); }
  });
  it('flavour entrypoints carry only public values (tenant code, URLs); no token or secret named field', () => {
    for (const flavour of ['main_dev.dart', 'main_staging.dart', 'main_prod.dart']) expect(strip(read(A('lib', flavour))), flavour).not.toMatch(/token|secret|password|apikey|api_key/i);
  });
});

describe('REQ-SEC-098 attack surface: exported components and deep links', () => {
  it('only the launcher activity is exported; no extra receiver / service / provider is exported', () => {
    const exported = [...manifest.matchAll(/<(activity|service|receiver|provider)\b[^>]*android:exported="true"[^>]*>/g)].map((m) => m[0]);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toContain('.MainActivity');
    expect(manifest).not.toMatch(/<(service|receiver|provider)\b/);
  });
  it('app-link intent filters (if any) are https + autoVerify only; no custom-scheme browsable filter for PHI routes', () => {
    for (const m of manifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g)) {
      if (!/android\.intent\.category\.BROWSABLE/.test(m[2]!)) continue;
      expect(m[1]).toMatch(/android:autoVerify="true"/);
      expect(m[2]).toMatch(/android:scheme="https"/);
      expect(m[2]).not.toMatch(/android:scheme="(?!https")/);
    }
  });
  it('debug-only settings are not in the main manifest: debuggable is not set, no test-only flags', () => {
    expect(manifest).not.toMatch(/android:debuggable="true"/);
    expect(manifest).not.toMatch(/android:testOnly="true"/);
  });
});
