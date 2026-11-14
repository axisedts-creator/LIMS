// T-M1 — source rules for lib/features/membership that widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes). 07-SECURITY: the card token is a secret (never logged, never persisted).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/membership');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

void main() {
  test('the membership feature exists: membership_api.dart, membership_providers.dart, membership_screen.dart', () {
    for (final f in ['membership_api', 'membership_providers', 'membership_screen']) {
      expect(File('lib/features/membership/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/membership/$f.dart');
    }
  });

  test('membership_screen.dart builds on lims_ui (LimsCard, LimsQrCode, LimsSecureScreen)', () {
    final f = File('lib/features/membership/membership_screen.dart');
    expect(f.existsSync(), isTrue);
    final t = f.readAsStringSync();
    expect(t, contains('package:lims_ui/lims_ui.dart'));
    for (final w in ['LimsCard', 'LimsQrCode', 'LimsSecureScreen']) {
      expect(t, contains(w));
    }
  });

  test('the QR is built from card_token only (error correction M is the lims_ui default; no other data field concatenated)', () {
    final t = File('lib/features/membership/membership_screen.dart');
    expect(t.existsSync(), isTrue);
    final s = t.readAsStringSync();
    expect(s, contains('card_token'));
    expect(RegExp(r'LimsQrCode\([^)]*data:\s*[^,)]*(\+|\$\{|\$[a-z])', dotAll: true).hasMatch(s), isFalse, reason: 'QR data must be the bare token');
  });

  group('LD-140 design-system rules', () {
    final banned = <String, RegExp>{
      'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
      'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
      'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
      'literal font size': RegExp(r'fontSize:\s*\d'),
      'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
    };
    test('there are sources to check', () => expect(sources(), isNotEmpty));
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/membership', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('log and storage hygiene (card token, card number)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'secure storage': RegExp(r'flutter_secure_storage|FlutterSecureStorage'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
      'clipboard': RegExp(r'Clipboard\.'),
      'share sheet': RegExp(r'share_plus|Share\.share'),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/membership', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
    test('the token is not rendered as text: no Text(...) with card_token / cardToken', () {
      expect(sources(), isNotEmpty);
      for (final f in sources()) {
        expect(RegExp(r'Text\([^;]*card_?[tT]oken').hasMatch(f.readAsStringSync()), isFalse, reason: f.path);
      }
    });
  });
}
