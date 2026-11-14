// T-AC1 - source rules for lib/features/settings that widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes); LD-28: legal links open in the system browser through the shared opener;
// REQ-SEC-103: no local store / log / clipboard of account data; the deletion must not depend on a server logout (sessions are revoked by C2).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/settings');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

String all() => sources().map((e) => e.readAsStringSync()).join('\n');

void main() {
  test('the settings feature exists: account_api / settings_providers / settings_screen', () {
    for (final f in ['account_api', 'settings_providers', 'settings_screen']) {
      expect(File('lib/features/settings/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/settings/$f.dart');
    }
  });

  test('settings_screen.dart builds on lims_ui (LimsScaffold) and the shared external URL opener (LD-28)', () {
    final f = File('lib/features/settings/settings_screen.dart');
    expect(f.existsSync(), isTrue);
    final t = f.readAsStringSync();
    expect(t, contains('package:lims_ui/lims_ui.dart'));
    expect(t, contains('LimsScaffold'));
    expect(t, contains('externalUrlOpenerProvider'));
    expect(t, isNot(contains('launchUrl')), reason: 'legal links go through externalUrlOpenerProvider, not a direct launch');
  });

  test('delete uses the local session wipe (expire), not a server logout, and never a second path to E12', () {
    final t = all();
    expect(t, contains('expire()'));
    expect(RegExp(r'deleteMyAccount').allMatches(t).length, greaterThanOrEqualTo(1));
    expect(t, contains('DELETE'), reason: 'typed confirmation word (04-UI-UX A23)');
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
      test('no ${e.key} in lib/features/settings', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('no storage, logs or push in feature code (REQ-SEC-103/106)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'secure storage': RegExp(r'flutter_secure_storage|FlutterSecureStorage'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
      'clipboard': RegExp(r'Clipboard\.'),
      'share sheet': RegExp(r'share_plus|Share\.share'),
      'push / notification SDK': RegExp(r'firebase|fcm|apns|onesignal|flutter_local_notifications', caseSensitive: false),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/settings', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });
}
