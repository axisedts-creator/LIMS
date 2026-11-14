// T-N1 — source rules for lib/features/enquiries that widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes). 07-SECURITY §3: enquiry subject / message are P3 -> no local store, no log, no push / notification SDK.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/enquiries');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

void main() {
  test('the enquiries feature exists: enquiries_api / enquiries_providers / enquiries_screen / new_enquiry_screen / enquiry_thread_screen', () {
    for (final f in ['enquiries_api', 'enquiries_providers', 'enquiries_screen', 'new_enquiry_screen', 'enquiry_thread_screen']) {
      expect(File('lib/features/enquiries/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/enquiries/$f.dart');
    }
  });

  test('every screen is a PHI screen on lims_ui: LimsSecureScreen + LimsScaffold', () {
    for (final f in ['enquiries_screen', 'new_enquiry_screen', 'enquiry_thread_screen']) {
      final file = File('lib/features/enquiries/$f.dart');
      expect(file.existsSync(), isTrue, reason: f);
      final t = file.readAsStringSync();
      expect(t, contains('package:lims_ui/lims_ui.dart'));
      expect(t, contains('LimsSecureScreen'), reason: '$f must be wrapped for screenshot protection (REQ-SEC-109)');
      expect(t, contains('LimsScaffold'));
    }
    final t = File('lib/features/enquiries/enquiries_screen.dart');
    expect(t.existsSync() && ['LimsEmptyState', 'LimsErrorState', 'LimsLoading'].every(t.readAsStringSync().contains), isTrue);
  });

  test('forms use LimsTextField with the spec maxLength (subject 120, message 2000)', () {
    final all = sources().map((e) => e.readAsStringSync()).join('\n');
    expect(all, contains('LimsTextField'));
    expect(RegExp(r'maxLength:\s*120').hasMatch(all), isTrue);
    expect(RegExp(r'maxLength:\s*2000').hasMatch(all), isTrue);
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
      test('no ${e.key} in lib/features/enquiries', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('no storage, logs or push in feature code (P3 free text)', () {
    final banned = <String, RegExp>{
      'shared_preferences / secure storage / sqflite / hive / drift': RegExp(r'shared_preferences|flutter_secure_storage|sqflite|package:hive|package:drift|isar'),
      'print / debugPrint / developer.log / logger': RegExp(r'\b(print|debugPrint)\(|developer\.log|package:logging|Logger\('),
      'firebase_messaging / flutter_local_notifications / push SDK': RegExp(r'firebase_messaging|flutter_local_notifications|onesignal|awesome_notifications'),
      'file writes': RegExp(r'writeAsString|writeAsBytes|File\('),
    };
    for (final e in banned.entries) {
      test('no ${e.key}', () {
        expect(sources(), isNotEmpty);
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has ${e.key}');
        }
      });
    }
  });
}
