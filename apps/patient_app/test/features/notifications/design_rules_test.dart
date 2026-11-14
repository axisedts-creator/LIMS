// T-P5 — source rules for lib/features/notifications that widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes). US-EN-11.1: the app renders from local message keys, never from wire text;
// REQ-SEC-103: no local store, no log of notification content; REQ-SEC-106 / B11: no push or notification SDK API in feature code.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/notifications');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

void main() {
  test('the notifications feature exists: notifications_api / notifications_providers / notifications_screen / notification_bell', () {
    for (final f in ['notifications_api', 'notifications_providers', 'notifications_screen', 'notification_bell']) {
      expect(File('lib/features/notifications/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/notifications/$f.dart');
    }
  });

  test('notifications_screen.dart builds on lims_ui (LimsScaffold, LimsEmptyState, LimsErrorState, LimsLoading)', () {
    final f = File('lib/features/notifications/notifications_screen.dart');
    expect(f.existsSync(), isTrue);
    final t = f.readAsStringSync();
    expect(t, contains('package:lims_ui/lims_ui.dart'));
    for (final w in ['LimsScaffold', 'LimsEmptyState', 'LimsErrorState', 'LimsLoading']) {
      expect(t, contains(w));
    }
  });

  test('the message keys are local: the screen has the nine kind keys and never reads title/body/message/text from the wire', () {
    final f = File('lib/features/notifications/notifications_screen.dart');
    expect(f.existsSync(), isTrue);
    final all = sources().map((e) => e.readAsStringSync()).join('\n');
    for (final k in ['report_ready', 'sample_recollection', 'booking_confirmed', 'booking_cancelled', 'booking_reminder', 'payment_completed', 'follow_up_reminder', 'enquiry_reply', 'profile_paused']) {
      expect(all, contains(k), reason: 'kind $k has no local rendering');
    }
    expect(RegExp(r'''\[\s*['"](title|body|message|text)['"]\s*\]''').hasMatch(all), isFalse, reason: 'feature code reads a text field from the wire');
    expect(RegExp(r'''\[\s*['"]booking_no['"]\s*\]''').hasMatch(all), isFalse, reason: 'booking_no must come from the app\'s own booking data, never the notification row');
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
      test('no ${e.key} in lib/features/notifications', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('no storage, logs or push in feature code (US-EN-11.2, REQ-SEC-103/106)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'secure storage': RegExp(r'flutter_secure_storage|FlutterSecureStorage'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
      'clipboard': RegExp(r'Clipboard\.'),
      'share sheet': RegExp(r'share_plus|Share\.share'),
      'push / notification SDK': RegExp(r'firebase|fcm|apns|onesignal|flutter_local_notifications|awesome_notifications|pusher', caseSensitive: false),
      'background timer / polling': RegExp(r'Timer\.periodic|workmanager|background_fetch', caseSensitive: false),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/notifications', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });
}
