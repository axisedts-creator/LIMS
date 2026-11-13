// T-A4 — source rules that widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes); one primary button.
// LD-28: privacy/terms URLs are platform config, wired in the staging and prod entrypoints.
// 02-CV 9.2 / REQ-SEC-103: no logging, no local persistence in the auth feature. Synthetic data only.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> authSources() {
  final dir = Directory('lib/features/auth');
  final files = dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
  final gate = File('lib/app/app_lock_gate.dart');
  return [...files, if (gate.existsSync()) gate];
}

void main() {
  test('the auth feature exists: sign_in_flow.dart, patient_auth_api.dart, auth_providers.dart', () {
    for (final f in ['sign_in_flow', 'patient_auth_api', 'auth_providers']) {
      expect(File('lib/features/auth/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/auth/$f.dart');
    }
  });

  test('sign_in_flow.dart builds on lims_ui', () {
    final f = File('lib/features/auth/sign_in_flow.dart');
    expect(f.existsSync(), isTrue);
    expect(f.readAsStringSync(), contains("package:lims_ui/lims_ui.dart"));
  });

  group('LD-140 design-system rules', () {
    final banned = <String, RegExp>{
      'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
      'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
      'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
      'literal font size': RegExp(r'fontSize:\s*\d'),
      'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
    };
    test('there are sources to check', () => expect(authSources(), isNotEmpty));
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/auth or app_lock_gate.dart', () {
        for (final f in authSources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('log and storage hygiene (phone, OTP, tokens)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/auth', () {
        final dir = Directory('lib/features/auth');
        expect(dir.existsSync(), isTrue);
        for (final f in dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('LD-28 legal URLs are platform config', () {
    for (final entry in ['lib/main_staging.dart', 'lib/main_prod.dart']) {
      test('$entry sets privacyUrl and termsUrl from --dart-define values', () {
        final s = File(entry).readAsStringSync();
        expect(s, contains('privacyUrl:'));
        expect(s, contains('termsUrl:'));
        expect(RegExp(r'privacyUrl:\s*String\.fromEnvironment').hasMatch(s), isTrue, reason: 'privacy URL must come from the build config');
        expect(RegExp(r'termsUrl:\s*String\.fromEnvironment').hasMatch(s), isTrue, reason: 'terms URL must come from the build config');
      });
    }

    test('lib/main_prod.dart has no default for PRIVACY_URL / TERMS_URL (required in production, LD-28)', () {
      final s = File('lib/main_prod.dart').readAsStringSync();
      for (final k in ['PRIVACY_URL', 'TERMS_URL']) {
        expect(s, contains("'$k'"));
        expect(RegExp("'$k'\\s*,\\s*defaultValue").hasMatch(s), isFalse, reason: '$k must not have a placeholder default in prod');
      }
    });
  });
}
