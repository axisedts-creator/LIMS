// T-A1 — "no token in shared prefs", no offline DB / HTTP cache / push / analytics SDK / TLS bypass / token logging,
// flavour entrypoints without secrets, exact dependency pins, LD-24 error tracking wiring (07-SECURITY T-SEC1 greps).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> dartFiles(String dir) {
  final d = Directory(dir);
  if (!d.existsSync()) return const [];
  return d.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList();
}

String slurp(Iterable<File> fs) => fs.map((f) => f.readAsStringSync()).join('\n');

void main() {
  final lib = dartFiles('lib');
  final src = slurp(lib);

  test('app sources exist (skeleton present)', () {
    expect(lib, isNotEmpty);
    for (final f in ['lib/main_dev.dart', 'lib/main_staging.dart', 'lib/main_prod.dart']) {
      expect(File(f).existsSync(), isTrue, reason: '$f (flavour entrypoint, 02-TRD §3.5)');
    }
  });

  test('no local database, key-value store or HTTP cache anywhere in lib/ (REQ-SEC-103)', () {
    const banned = ['shared_preferences', 'sqflite', 'package:hive', 'package:drift', 'package:isar', 'sembast', 'objectbox', 'dio_cache_interceptor', 'http_cache'];
    expect(lib, isNotEmpty);
    for (final b in banned) {
      expect(src.contains(b), isFalse, reason: 'lib/ references $b');
    }
  });

  test('pubspec: secure storage present; no shared_preferences, push or analytics SDK (07 T-SEC1)', () {
    final p = File('pubspec.yaml');
    expect(p.existsSync(), isTrue);
    final y = p.readAsStringSync();
    expect(y.contains('flutter_secure_storage'), isTrue);
    expect(y.contains('flutter_riverpod'), isTrue);
    for (final b in ['shared_preferences', 'firebase_', 'onesignal', 'google_mobile_ads', 'mixpanel', 'amplitude', 'appsflyer', 'adjust_sdk', 'google_analytics']) {
      expect(y.contains(b), isFalse, reason: 'pubspec.yaml lists $b');
    }
  });

  test('dependencies are exact pins (CV §15.1): no ^, ~, >=, any', () {
    final y = File('pubspec.yaml').readAsStringSync();
    final bad = RegExp(r'^\s{2}[a-z_0-9]+:\s*(\^|~|>=|>|<|any\b)', multiLine: true).allMatches(y).map((m) => m[0]!.trim()).toList();
    // lims_shared/lims_api_client/lims_ui are workspace members and may say `any`.
    final real = bad.where((l) => !RegExp(r'^lims_(shared|api_client|ui):').hasMatch(l)).toList();
    expect(real, isEmpty, reason: 'non-exact pins: $real');
  });

  test('no TLS bypass (07 T-SEC1)', () {
    expect(lib, isNotEmpty);
    for (final b in ['badCertificateCallback', 'allowBadCertificates', 'HttpOverrides.global', 'X509Certificate']) {
      expect(src.contains(b), isFalse, reason: 'lib/ contains $b');
    }
  });

  test('session and api code never print/log (tokens never logged, 02-CV §9.2)', () {
    final files = [...dartFiles('lib/core/session'), ...dartFiles('lib/core/api')];
    expect(files, isNotEmpty);
    final s = slurp(files);
    for (final b in ['print(', 'debugPrint(', 'developer.log(']) {
      expect(s.contains(b), isFalse, reason: 'session/api code contains $b');
    }
  });

  test('flavour entrypoints carry no secrets and non-dev URLs are https (REQ-SEC-107)', () {
    for (final f in ['main_dev', 'main_staging', 'main_prod']) {
      final t = File('lib/$f.dart').readAsStringSync();
      expect(RegExp(r'(secret|password|api[_-]?key|BEGIN (RSA|EC )?PRIVATE|bearer\s+ey)', caseSensitive: false).hasMatch(t), isFalse, reason: f);
      expect(t.contains('tenant'), isTrue, reason: '$f must set tenant_code');
      if (f != 'main_dev') {
        final plain = RegExp(r'''['"]http://''').hasMatch(t);
        expect(plain, isFalse, reason: '$f uses plain http');
      }
    }
  });

  test('LD-24: error tracking goes through lims_ui LimsErrorTracking; DSN comes from runtime config, never a literal', () {
    expect(src.contains('LimsErrorTracking.configure'), isTrue);
    expect(RegExp(r'''https?://[^'"\s]*@[^'"\s]+''').hasMatch(src), isFalse, reason: 'literal DSN in lib/');
    expect(src.contains('sendDefaultPii = true'), isFalse);
  });

  test('secure storage key is the only persisted key defined by the app', () {
    final store = File('lib/core/session/session_store.dart');
    expect(store.existsSync(), isTrue);
    expect(store.readAsStringSync().contains("'lims.patient.session_token'"), isTrue);
  });
}
