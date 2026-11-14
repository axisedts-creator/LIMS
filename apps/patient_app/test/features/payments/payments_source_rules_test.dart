// T-PAY1 — source rules widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names. 02-CV 9.2 / REQ-SEC-103: no logging, no local persistence of payment data. REQ-SEC-046: the app never sends an amount. REQ-SEC-059: the return-URL outcome is never read.
// 02-TRD §4.6: polling, not Realtime. Synthetic data only.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/payments');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

String all() => sources().map((f) => f.readAsStringSync()).join('\n');

void main() {
  test('the payments feature exists: payments_api, payments_providers, pay_due_screen, payment_result_screen', () {
    for (final f in ['payments_api', 'payments_providers', 'pay_due_screen', 'payment_result_screen']) {
      expect(File('lib/features/payments/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/payments/$f.dart');
    }
  });

  test('both screens build on lims_ui: LimsSecureScreen, LimsStatusChip; the start view uses LimsSegmentedControl', () {
    final start = File('lib/features/payments/pay_due_screen.dart').readAsStringSync();
    final result = File('lib/features/payments/payment_result_screen.dart').readAsStringSync();
    for (final s in [start, result]) {
      expect(s, contains('package:lims_ui/lims_ui.dart'));
      expect(s, contains('LimsSecureScreen'));
    }
    expect(start, contains('LimsSegmentedControl'));
    expect(result, contains('LimsStatusChip'));
  });

  test('poll cadence: 2 s / 30 s on the start view and 3 s / 60 s on the result view (03-APP-FLOW payment sequence)', () {
    final start = File('lib/features/payments/pay_due_screen.dart').readAsStringSync();
    final result = File('lib/features/payments/payment_result_screen.dart').readAsStringSync();
    expect(RegExp(r'Duration\(\s*seconds:\s*2\s*\)').hasMatch(start), isTrue);
    expect(RegExp(r'Duration\(\s*seconds:\s*30\s*\)').hasMatch(start), isTrue);
    expect(RegExp(r'Duration\(\s*seconds:\s*3\s*\)').hasMatch(result), isTrue);
    expect(RegExp(r'Duration\(\s*seconds:\s*60\s*\)').hasMatch(result), isTrue);
  });

  test('REQ-SEC-046: the E41 call carries no amount - payments_api.dart has no amount parameter or body key', () {
    final api = File('lib/features/payments/payments_api.dart').readAsStringSync();
    expect(RegExp('amount', caseSensitive: false).hasMatch(api), isFalse);
    expect(api, contains('gateway'));
    expect(RegExp('idempotency', caseSensitive: false).hasMatch(api), isTrue);
  });

  test('REQ-SEC-059: no code reads the return URL outcome (no "outcome", no query parameter of the app link used to decide)', () {
    final text = all();
    expect(RegExp('outcome', caseSensitive: false).hasMatch(text), isFalse, reason: 'the outcome query parameter is ignored');
    expect(RegExp(r'queryParameters|\.query\b|intent_id').hasMatch(text), isFalse);
  });

  test('the Idempotency-Key comes from a random source, not from the order or gateway', () {
    expect(RegExp('newIdempotencyKey|Random\\.secure|uuid', caseSensitive: false).hasMatch(all()), isTrue);
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
      test('no ${e.key} in lib/features/payments', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('log, storage and transport hygiene (the action url carries the gateway callback token)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
      'clipboard': RegExp(r'Clipboard'),
      'in-app web view (the gateway opens in the SYSTEM browser)': RegExp(r'webview|WebView|InAppWebView', caseSensitive: false),
      'realtime / websocket / push (polling only, TRD §4.6)': RegExp(r'WebSocket|web_socket|supabase|firebase_messaging|realtime', caseSensitive: false),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/payments', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });
}
