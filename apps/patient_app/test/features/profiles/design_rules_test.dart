// T-L6 — source rules for lib/features/profiles that widget tests cannot see. Runs from the package root (flutter test).
// LD-140 (2026-11-13): screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes); one primary per page; masters list + per-section Save n/a here.
// 07-SECURITY / REQ-SEC-103: the lab code, the report-link token and the registration details (name, birth date, age) are never logged, stored or put on the clipboard.
// Routes are never hand-typed (02-TRD §3.5): navigation inside the feature is Navigator-based, and no literal route paths for other screens.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/profiles');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

String read(String name) => File('lib/features/profiles/$name.dart').readAsStringSync();

void main() {
  test('the feature exists: api, providers and the four screens', () {
    for (final f in ['profiles_api', 'profiles_providers', 'profiles_screen', 'link_code_screen', 'report_link_screen', 'register_screen']) {
      expect(File('lib/features/profiles/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/profiles/$f.dart');
    }
  });

  test('every screen builds on lims_ui and is a PHI screen (LimsSecureScreen)', () {
    for (final f in ['profiles_screen', 'link_code_screen', 'report_link_screen', 'register_screen']) {
      final t = read(f);
      expect(t, contains('package:lims_ui/lims_ui.dart'), reason: f);
      expect(t, contains('LimsSecureScreen'), reason: f);
    }
  });

  test('A7 uses LimsCodeField, A8 LimsTextField, A9 LimsSegmentedControl + LimsDatePicker + LimsTextField (04-UI-UX A7-A9)', () {
    expect(read('link_code_screen'), contains('LimsCodeField'));
    expect(read('report_link_screen'), contains('LimsTextField'));
    final a9 = read('register_screen');
    for (final w in ['LimsSegmentedControl', 'LimsDatePicker', 'LimsTextField']) {
      expect(a9, contains(w));
    }
    expect(read('profiles_screen'), contains('LimsListTile'));
    expect(read('profiles_screen'), contains('LimsConfirmDialog'));
  });

  test('the two user-facing error sentences exist exactly once in the feature (identical text on A7 and A8)', () {
    final all = sources().map((f) => f.readAsStringSync()).join('\n');
    expect(RegExp(r"This code didn\\?'t work\. Check it or ask the lab for a new one\.").allMatches(all).length, 1,
        reason: 'one shared constant, used by both screens');
    expect(RegExp(RegExp.escape('Too many tries. Try again in an hour.')).allMatches(all).length, 1);
    expect(RegExp(RegExp.escape('You have the maximum number of profiles.')).allMatches(all).length, 1);
  });

  group('LD-140 design-system rules', () {
    final banned = <String, RegExp>{
      'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
      'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
      'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
      'literal font size': RegExp(r'fontSize:\s*\d'),
      'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
      'Colors.<name> palette colour': RegExp(r'\bColors\.(?!transparent\b)[a-z]'),
    };
    test('there are sources to check', () => expect(sources(), isNotEmpty));
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/profiles', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
    test('no second primary: FilledButton / ElevatedButton are not used directly (LimsButton only)', () {
      expect(sources(), isNotEmpty);
      for (final f in sources()) {
        expect(RegExp(r'\b(FilledButton|ElevatedButton)\b').hasMatch(f.readAsStringSync()), isFalse, reason: f.path);
      }
    });
  });

  group('log and storage hygiene (lab code, report-link token, name, birth date, age)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'secure storage': RegExp(r'flutter_secure_storage|FlutterSecureStorage'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
      'clipboard': RegExp(r'Clipboard\.'),
      'share sheet': RegExp(r'share_plus|Share\.share'),
      'error reporter with the object': RegExp(r'FlutterError\.reportError|Sentry\.'),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/profiles', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }

    test('error text never interpolates safeDetail, toString() or the exception object into the UI', () {
      expect(sources(), isNotEmpty);
      for (final f in sources()) {
        final t = f.readAsStringSync();
        expect(RegExp(r'safeDetail').hasMatch(t), isFalse, reason: '${f.path} reads safeDetail');
        expect(RegExp(r"Text\(\s*['\x22]?\$?\{?(e|err|error|ex)\b").hasMatch(t), isFalse, reason: '${f.path} prints the exception');
      }
    });

    test('the profile screens do not call the pre-auth OTP endpoints or hand-type engagement paths (api file owns the wire)', () {
      expect(sources(), isNotEmpty);
      for (final f in sources().where((f) => !f.path.endsWith('profiles_api.dart'))) {
        expect(RegExp(r'/v1/engagement/').hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} hand-types an API path');
      }
    });
  });
}
