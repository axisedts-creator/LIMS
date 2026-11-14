// HC-T29 release hardening (REQ-SEC-107/109/111/112/113; LD-28 checklist part; LD-140 n/a: no UI here).
// Static checks only: no Android SDK, device or store account is needed. Paths are relative to apps/phlebo_app (flutter test cwd).
// ASSUMPTIONS (spec names no paths): the release script and checklist live under android/ (the only HC-T29-owned folder besides
// secure_screen.dart): android/release_android.sh and android/RELEASE.md. The FLAG_SECURE channel is the one LimsSecureScreen already
// calls: MethodChannel('lims_ui/secure_screen') with methods `enable` / `disable`.
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

String _read(String p) => File(p).readAsStringSync();

/// Source with comments removed, so a rule mentioned in a comment is not a violation.
String _code(String p) => _read(p).replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '').split('\n').map((l) {
      final i = l.indexOf('//');
      return i < 0 ? l : l.substring(0, i);
    }).join('\n');

String _norm(String p) => p.replaceAll('\\', '/');

List<File> _libDart() => Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList();

/// Text between the '(' at [open] and its matching ')'.
String _args(String s, int open) {
  var depth = 0;
  for (var i = open; i < s.length; i++) {
    if (s[i] == '(') depth++;
    if (s[i] == ')' && --depth == 0) return s.substring(open + 1, i);
  }
  return s.substring(open + 1);
}

void main() {
  final gradle = _read('android/app/build.gradle.kts');
  final releaseBlock = RegExp(r'release\s*\{[\s\S]*?\n {8}\}').firstMatch(gradle)?.group(0) ?? '';

  group('REQ-SEC-112 obfuscation + minify, REQ-SEC-107 signing material', () {
    test('release buildType exists, is minified, is NOT signed with the debug key', () {
      expect(releaseBlock, isNotEmpty, reason: 'android.buildTypes.release block (8-space indent, like patient_app)');
      expect(releaseBlock.contains('getByName("debug")'), isFalse, reason: 'release must never use debug signing');
      expect(releaseBlock, contains('isMinifyEnabled = true'));
      expect(releaseBlock, contains('signingConfig'));
    });

    test('release signingConfig is read from env / untracked file, never literals (REQ-SEC-107/128)', () {
      expect(RegExp(r'create\("release"\)|getByName\("release"\)|register\("release"\)').hasMatch(gradle), isTrue);
      expect(RegExp(r'System\.getenv|providers\.environmentVariable|keystoreProperties').hasMatch(gradle), isTrue);
      for (final f in ['storePassword', 'keyPassword', 'keyAlias', 'storeFile']) {
        expect(gradle, contains(f), reason: '$f must be configured');
        expect(RegExp('$f\\s*=\\s*"[^"\\\$]+"').hasMatch(gradle), isFalse, reason: '$f must not be a string literal');
      }
    });

    test('release build fails closed when signing inputs are missing (no silent debug fallback)', () {
      expect(gradle, contains('GradleException'), reason: 'missing secret-store inputs must stop a release build');
    });

    test('dev/staging/prod flavours from HC-T21 still exist', () {
      for (final n in ['dev', 'staging', 'prod']) {
        expect(gradle, contains('create("$n")'));
      }
    });

    test('no keystore, key.properties or credential file under apps/phlebo_app; .gitignore blocks them', () {
      final bad = Directory('.')
          .listSync(recursive: true)
          .whereType<File>()
          .map((f) => _norm(f.path))
          .where((p) => !p.contains('/build/') && !p.contains('/.dart_tool/') && !p.contains('/.gradle/') && !p.startsWith('./build/'))
          .where((p) => RegExp(r'\.(jks|keystore|p12|pfx)$|key\.properties$|service-account.*\.json$').hasMatch(p))
          .toList();
      expect(bad, isEmpty, reason: 'signing material belongs in the C1 secret store');
      final ig = ['.gitignore', 'android/.gitignore'].where((p) => File(p).existsSync()).map(_read).join('\n');
      expect(ig, contains('key.properties'));
      expect(ig.contains('*.jks') && ig.contains('*.keystore'), isTrue);
    });

    test('release script builds the prod flavour with --obfuscate --split-debug-info outside tracked folders', () {
      final f = File('android/release_android.sh');
      expect(f.existsSync(), isTrue, reason: 'android/release_android.sh (ASSUMED path)');
      final s = f.readAsStringSync();
      expect(s, matches(RegExp(r'flutter build (apk|appbundle|aab)')));
      expect(s, contains('--release'));
      expect(s, contains('--flavor prod'));
      expect(s, contains('--dart-define=FLAVOR=prod'), reason: 'main.dart reads FLAVOR from a dart-define');
      expect(s, contains('--obfuscate'));
      expect(s, contains('--split-debug-info'));
      expect(s.contains('--flavor dev') || s.contains('--flavor staging') || s.contains('FLAVOR=dev') || s.contains('FLAVOR=staging'), isFalse,
          reason: 'only prod ships');
      final dir = RegExp(r'--split-debug-info[= ]+(\S+)').firstMatch(s)!.group(1)!.replaceAll('"', '');
      expect(dir.startsWith('build/') || dir.startsWith(r'$') || dir.startsWith('/'), isTrue, reason: 'symbols dir $dir must be under build/ or external');
      expect(RegExp(r'(storePassword|keyPassword)\s*[=:]\s*["' "'" r']?[A-Za-z0-9+/_\-]{6,}').hasMatch(s), isFalse);
      expect(s.contains('-----BEGIN'), isFalse);
    });

    test('release script does not bake secrets: only FLAVOR / API_BASE_URL (and optional SENTRY_DSN) dart-defines (REQ-SEC-107)', () {
      final s = _read('android/release_android.sh');
      for (final m in RegExp(r'--dart-define=([A-Za-z_]+)').allMatches(s)) {
        expect(['FLAVOR', 'API_BASE_URL', 'SENTRY_DSN'], contains(m.group(1)), reason: 'unexpected compile-time define ${m.group(1)}');
      }
    });

    test('RELEASE.md: C1 secret store, mapping files, obfuscation, scan, device test record, min_app_version, LD-28 legal URLs', () {
      final f = File('android/RELEASE.md');
      expect(f.existsSync(), isTrue, reason: 'android/RELEASE.md (ASSUMED path; LD-28 "release checklist")');
      final t = f.readAsStringSync().toLowerCase();
      for (final k in [
        'c1 secret store',
        'split-debug-info',
        'obfuscat',
        'mapping',
        'scan_apk.sh',
        'phlebo-v',
        'flag_secure',
        'min_app_version',
        'legal.privacy_url', // LD-28
        'legal.terms_url', // LD-28
        'privacy policy',
        'terms of use',
      ]) {
        expect(t, contains(k), reason: 'checklist must mention "$k"');
      }
      for (final k in ['screenshot', 'recent apps', 'device']) {
        expect(t, contains(k), reason: 'manual device test record must mention "$k" (plan row tests column)');
      }
      expect(RegExp(r'- \[ \]').allMatches(t).length, greaterThanOrEqualTo(8), reason: 'at least 8 checklist items');
    });
  });

  group('REQ-SEC-109 FLAG_SECURE / switcher masking', () {
    test('MainActivity.kt serves lims_ui/secure_screen enable/disable with WindowManager FLAG_SECURE', () {
      final k = _code('android/app/src/main/kotlin/np/lims/phlebo_app/MainActivity.kt');
      expect(k, contains('"lims_ui/secure_screen"'));
      expect(k, contains('FLAG_SECURE'));
      expect(k, matches(RegExp(r'window\.addFlags\(\s*(WindowManager\.LayoutParams\.)?FLAG_SECURE')), reason: 'enable');
      expect(k, matches(RegExp(r'window\.clearFlags\(\s*(WindowManager\.LayoutParams\.)?FLAG_SECURE')), reason: 'disable');
      expect(k, contains('"enable"'));
      expect(k, contains('"disable"'));
      expect(k, contains('notImplemented'), reason: 'unknown methods stay notImplemented');
    });

    test('the HC-T24 platform channel is untouched (monotonicMs, bootId)', () {
      final k = _code('android/app/src/main/kotlin/np/lims/phlebo_app/MainActivity.kt');
      expect(k, contains('"np.lims.phlebo/platform"'));
      expect(k, contains('"monotonicMs"'));
      expect(k, contains('"bootId"'));
    });

    test('lib/core/platform/secure_screen.dart exists and names the same channel as LimsSecureScreen', () {
      final f = File('lib/core/platform/secure_screen.dart');
      expect(f.existsSync(), isTrue, reason: 'plan row HC-T29 / TRD §2 file list');
      final c = _code(f.path);
      expect(c, contains("'${LimsSecureScreen.channel.name}'"), reason: 'Dart contract and MainActivity.kt must use one channel name');
      expect(RegExp(r'dart:io|package:http|print\(|debugPrint\(|Sentry').hasMatch(c), isFalse);
    });

    test('every *_screen.dart in lib wraps LimsSecureScreen (login screen excepted)', () {
      final screens = _libDart().map((f) => _norm(f.path)).where((p) => p.endsWith('_screen.dart') && !p.contains('login')).toList();
      expect(screens, isNotEmpty);
      for (final p in screens) {
        expect(_code(p), contains('LimsSecureScreen'), reason: '$p shows patient data without FLAG_SECURE');
      }
    });

    test('screens never opt out of the channel: no direct FLAG_SECURE disable call from Dart outside lims_ui', () {
      for (final f in _libDart()) {
        final c = _code(f.path);
        if (_norm(f.path) == 'lib/core/platform/secure_screen.dart') continue;
        expect(c.contains('lims_ui/secure_screen'), isFalse, reason: '${f.path} talks to the secure-screen channel directly');
      }
    });

    testWidgets('contract with the native side: PHI screen mount calls enable, last one leaving calls disable', (tester) async {
      final calls = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(LimsSecureScreen.channel, (c) async {
        calls.add(c.method);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(LimsSecureScreen.channel, null));
      await tester.pumpWidget(const Directionality(textDirection: TextDirection.ltr, child: LimsSecureScreen(child: SizedBox())));
      expect(calls, ['enable']);
      await tester.pumpWidget(const SizedBox());
      expect(calls, ['enable', 'disable']);
    });
  });

  group('REQ-SEC-111 text-field flags', () {
    test('every LimsTextField( in lib passes sensitive: true (= enableSuggestions:false, autocorrect:false)', () {
      final bad = <String>[];
      for (final f in _libDart()) {
        final c = _code(f.path);
        for (final m in RegExp(r'\bLimsTextField\(').allMatches(c)) {
          if (!RegExp(r'\bsensitive:\s*true\b').hasMatch(_args(c, m.end - 1))) {
            bad.add('${_norm(f.path)}:${c.substring(0, m.start).split('\n').length}');
          }
        }
      }
      expect(bad, isEmpty, reason: 'text fields without sensitive: true keep keyboard suggestions/autocorrect on');
    });

    test('any raw TextField/TextFormField (should be none) sets enableSuggestions:false and autocorrect:false', () {
      for (final f in _libDart()) {
        final c = _code(f.path);
        for (final m in RegExp(r'(?<![A-Za-z])(TextField|TextFormField|CupertinoTextField)\(').allMatches(c)) {
          final a = _args(c, m.end - 1);
          expect(RegExp(r'enableSuggestions:\s*false').hasMatch(a) && RegExp(r'autocorrect:\s*false').hasMatch(a), isTrue, reason: f.path);
        }
      }
    });

    test('no copy on patient fields: no Clipboard, SelectableText or SelectionArea anywhere in lib (04-UI-UX §3)', () {
      final hits = [for (final f in _libDart()) if (RegExp(r'Clipboard|SelectableText|SelectionArea').hasMatch(_code(f.path))) _norm(f.path)];
      expect(hits, isEmpty);
    });
  });

  group('REQ-SEC-113 min_app_version', () {
    test('every request carries X-Lims-App-Version and the 426 code is a non-retryable blocked outcome (engine tests exist)', () {
      expect(_code('lib/core/net/api_factory.dart'), contains("'X-Lims-App-Version'"));
      final push = _read('__tests__/sync_engine_push_test.dart');
      expect(push, contains('push 426 homecollection.app_version_unsupported'));
      expect(push, contains('pull 426 homecollection.app_version_unsupported'));
    });
  });

  group('REQ-SEC-107 no secrets in the app source or manifest', () {
    test('AndroidManifest.xml (main): not debuggable, no cleartext traffic', () {
      final m = _read('android/app/src/main/AndroidManifest.xml');
      expect(m.contains('android:debuggable="true"'), isFalse);
      expect(m.contains('usesCleartextTraffic="true"'), isFalse, reason: 'pinned HTTPS only (REQ-SEC-104)');
    });
  });
}
