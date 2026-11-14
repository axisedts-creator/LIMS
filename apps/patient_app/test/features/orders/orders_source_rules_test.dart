// T-P2 — source rules widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names (no hex colours, pixel radii, literal font sizes). 02-CV 9.2 / REQ-SEC-103: no logging, no local persistence, no caching of PHI in the orders feature.
// 02-TRD §4.6: polling, not Realtime (no websocket / realtime / push SDK). Synthetic data only.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/orders');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

void main() {
  test('the orders feature exists: orders_api, orders_providers, orders_list_screen, order_detail_screen', () {
    for (final f in ['orders_api', 'orders_providers', 'orders_list_screen', 'order_detail_screen']) {
      expect(File('lib/features/orders/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/orders/$f.dart');
    }
  });

  test('both screens build on lims_ui and use LimsStatusChip + LimsStageTimeline (A11)', () {
    final list = File('lib/features/orders/orders_list_screen.dart').readAsStringSync();
    final detail = File('lib/features/orders/order_detail_screen.dart').readAsStringSync();
    expect(list, contains('package:lims_ui/lims_ui.dart'));
    expect(detail, contains('package:lims_ui/lims_ui.dart'));
    expect(list, contains('LimsStatusChip'));
    expect(detail, contains('LimsStageTimeline'));
    expect(list, contains('LimsSecureScreen'));
    expect(detail, contains('LimsSecureScreen'));
  });

  test('the poll interval is 30 s [CONV] (02-TRD §4.6; 04-UI-UX A11 default order_poll_seconds)', () {
    final all = sources().map((f) => f.readAsStringSync()).join('\n');
    expect(RegExp(r'Duration\(\s*seconds:\s*30\s*\)').hasMatch(all) || all.contains('order_poll_seconds'), isTrue);
  });

  test('A11 listens to the app lifecycle (the only way to stop polling in the background)', () {
    final detail = File('lib/features/orders/order_detail_screen.dart').readAsStringSync();
    expect(RegExp(r'AppLifecycleListener|WidgetsBindingObserver|didChangeAppLifecycleState|onStateChange').hasMatch(detail), isTrue);
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
      test('no ${e.key} in lib/features/orders', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('log, storage and transport hygiene (PHI: order stage, balance, centre)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'file write': RegExp(r'writeAsString|writeAsBytes|File\('),
      'realtime / websocket / push (polling only, TRD §4.6)': RegExp(r'WebSocket|web_socket|supabase|firebase_messaging|realtime', caseSensitive: false),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/orders', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });
}
