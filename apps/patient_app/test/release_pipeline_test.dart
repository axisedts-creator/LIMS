// T-REL1 — Android internal-track release pipeline (plan row T-REL1; REQ-SEC-112/128; D-STORE, research/04 §13).
// Static checks only: no store account or key is needed. Release signing must come from the C1 secret store
// (file/env supplied at build time), never debug signing and never a key or password in the repo.
// Checklist file name `RELEASE.md` and script placement are tester assumptions (spec names none).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String read(String p) => File(p).readAsStringSync();

String norm(File f) => f.path.replaceAll('\\', '/').replaceFirst('./', '');

bool skipped(String p) =>
    p.startsWith('build/') ||
    p.startsWith('.dart_tool/') ||
    p.contains('/build/') ||
    p.contains('/.gradle/') ||
    p.contains('/.dart_tool/') ||
    p.contains('/Pods/');

List<File> allFiles() => Directory('.').listSync(recursive: true).whereType<File>().where((f) => !skipped(norm(f))).toList();

/// Release tooling text files (scripts, docs, gradle), excluding Dart sources and tests.
List<File> tooling() => allFiles().where((f) {
      final p = norm(f);
      if (p.startsWith('lib/') || p.startsWith('test/') || p.startsWith('integration_test/')) return false;
      return RegExp(r'\.(sh|cmd|ps1|yml|yaml|md|kts|gradle|properties)$').hasMatch(p);
    }).toList();

List<File> scripts() => tooling().where((f) => RegExp(r'\.(sh|cmd|ps1)$').hasMatch(f.path)).toList();

void main() {
  final gradle = read('android/app/build.gradle.kts');
  final releaseBlock = RegExp(r'release\s*\{[\s\S]*?\n {8}\}').firstMatch(gradle)?.group(0) ?? '';

  test('release buildType exists and is NOT signed with the debug key', () {
    expect(releaseBlock, isNotEmpty, reason: 'buildTypes.release block');
    expect(releaseBlock.contains('getByName("debug")'), isFalse, reason: 'release must never use debug signing');
  });

  test('release signingConfig is read from secret-store-supplied inputs (file/env), not literals', () {
    expect(gradle, contains('signingConfigs'));
    expect(RegExp(r'create\("release"\)|getByName\("release"\)|register\("release"\)').hasMatch(gradle), isTrue);
    expect(releaseBlock, contains('signingConfigs'));
    expect(RegExp(r'System\.getenv|providers\.environmentVariable|Properties\(\)|keystoreProperties|rootProject\.file|file\(').hasMatch(gradle), isTrue,
        reason: 'store/key material must be read from a file or env, not inlined');
    for (final f in ['storePassword', 'keyPassword', 'keyAlias', 'storeFile']) {
      expect(gradle, contains(f), reason: '$f must be configured');
      expect(RegExp('$f\\s*=\\s*"[^"\\\$]+"').hasMatch(gradle), isFalse, reason: '$f must not be a string literal');
    }
  });

  test('release build fails closed when signing inputs are missing (no silent fallback to debug)', () {
    expect(RegExp(r'GradleException|error\(|require\(|check\(|throw ').hasMatch(gradle), isTrue,
        reason: 'missing secret-store inputs must stop a release build');
  });

  test('release build is minified (REQ-SEC-112)', () {
    expect(releaseBlock, contains('isMinifyEnabled = true'));
  });

  test('no keystore, key.properties or credential file is present in the app dir', () {
    final bad = allFiles().map(norm).where((p) => RegExp(r'\.(jks|keystore|p12|pfx|pem)$|key\.properties$|service-account.*\.json$').hasMatch(p)).toList();
    expect(bad, isEmpty, reason: 'signing material belongs in the C1 secret store, never the repo');
  });

  test('.gitignore blocks keystores and key.properties (app or android level)', () {
    final ig = ['.gitignore', 'android/.gitignore'].where((p) => File(p).existsSync()).map(read).join('\n');
    expect(ig, contains('key.properties'));
    expect(ig.contains('*.jks') && ig.contains('*.keystore'), isTrue, reason: '*.jks and *.keystore must be git-ignored');
  });

  test('no signing secret literal or key material in release tooling', () {
    final pw = RegExp(r'(storePassword|keyPassword|store_password|key_password)\s*[=:]\s*["' "'" r']?[A-Za-z0-9+/_\-]{6,}');
    for (final f in tooling()) {
      final t = f.readAsStringSync();
      expect(pw.hasMatch(t), isFalse, reason: '${f.path} holds a password literal');
      expect(t.contains('-----BEGIN'), isFalse, reason: '${f.path} holds key material');
    }
  });

  test('a release script builds the prod flavour appbundle with --obfuscate --split-debug-info (TRD §2.3)', () {
    final hit = scripts().map((f) => f.readAsStringSync()).where((t) => t.contains('flutter build appbundle') || t.contains('flutter build aab')).toList();
    expect(hit, isNotEmpty, reason: 'no release script under apps/patient_app runs `flutter build appbundle`');
    final s = hit.join('\n');
    expect(s, contains('--flavor prod'));
    expect(s, contains('lib/main_prod.dart'));
    expect(s, contains('--obfuscate'));
    expect(s, contains('--split-debug-info'));
    expect(s.contains('--flavor dev') || s.contains('lib/main_dev.dart'), isFalse, reason: 'only prod ships');
  });

  test('split-debug-info output is outside tracked folders (symbol files go to the C1 store)', () {
    final s = scripts().map((f) => f.readAsStringSync()).join('\n');
    final m = RegExp(r'--split-debug-info[= ]+(\S+)').firstMatch(s);
    expect(m, isNotNull);
    final dir = m!.group(1)!.replaceAll('"', '');
    expect(dir.startsWith('build/') || dir.startsWith(r'$') || dir.startsWith('/') || dir.startsWith('%'), isTrue,
        reason: 'symbols dir $dir must be under build/ or an external path');
  });

  test('release checklist RELEASE.md covers C1 secret store keys, client-owned accounts, internal track, iOS after Android', () {
    final f = File('RELEASE.md');
    expect(f.existsSync(), isTrue, reason: 'apps/patient_app/RELEASE.md (plan row T-REL1 "release checklist")');
    final t = f.readAsStringSync().toLowerCase();
    for (final k in ['c1 secret store', 'client-owned', 'internal', 'obfuscat', 'ios', 'android', 'debug', 'applicationid']) {
      expect(t, contains(k), reason: 'checklist must mention "$k"');
    }
    expect(RegExp(r'- \[ \]').allMatches(t).length, greaterThanOrEqualTo(6), reason: 'at least 6 checklist items');
  });
}
