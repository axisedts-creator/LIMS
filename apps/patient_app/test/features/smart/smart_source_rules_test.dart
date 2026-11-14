// T-P4 — source rules widget tests cannot see, for lib/features/reports/smart/**. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names. 02-CV 9.2 / REQ-SEC-103: no logging, no local persistence, no files (a summary is PHI that lives in widget state only).
// 08 A2.3: the app only knows E24 (never a smart-report API). 07-SECURITY / TRD §5: the app never shows or handles test codes or ids. Synthetic data only.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/reports/smart');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

String read(String name) => File('lib/features/reports/smart/$name.dart').readAsStringSync();

void main() {
  test('the smart feature exists: smart_summary_api, _providers, _screen, _entry', () {
    for (final f in ['smart_summary_api', 'smart_summary_providers', 'smart_summary_screen', 'smart_summary_entry']) {
      expect(File('lib/features/reports/smart/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/reports/smart/$f.dart');
    }
  });

  test('the screen builds on lims_ui: LimsSecureScreen, LimsCard, LimsStatusChip, LimsErrorState, LimsEmptyState', () {
    final s = read('smart_summary_screen');
    expect(s, contains('package:lims_ui/lims_ui.dart'));
    for (final w in ['LimsSecureScreen', 'LimsCard', 'LimsStatusChip', 'LimsErrorState', 'LimsEmptyState']) {
      expect(s, contains(w), reason: '$w missing in smart_summary_screen.dart');
    }
  });

  test('the api talks to E24 only: the exact path, no other endpoint, no smart-report / storage URL', () {
    final a = read('smart_summary_api');
    expect(a, contains('/smart-summary'));
    expect(a, contains("'GET'"));
    for (final f in sources()) {
      expect(RegExp(r'smartreport|SmartReportPort|/v1/smartreport|signedUrl|signed_url|launchUrl|url_launcher|storage\.', caseSensitive: false).hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} reaches beyond E24');
    }
  });

  test('no test code, rule or id handling: the app never touches suggestedTestCode / ruleId / analyte ids', () {
    for (final f in sources()) {
      expect(RegExp(r'suggested_?[tT]est|rule_?[iI]d|analyte_?[iI]d|result_?[iI]ds?\b|template_?[bB]lock', caseSensitive: false).hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} handles ids / test codes');
    }
  });

  test('no file system and no cache: no File / Directory / path_provider, no static or top-level cache of the summary', () {
    for (final f in sources()) {
      final s = f.readAsStringSync();
      expect(RegExp(r'\bFile\(|Directory\(|writeAs(Bytes|String)|openWrite|path_provider|getTemporaryDirectory|dart:io').hasMatch(s), isFalse, reason: '${f.path} touches the file system');
      expect(RegExp(r'^(static\s+)?(final\s+|var\s+)?(Map|List)<[^>]*>\??\s+_?\w*(cache|Cache|last|Last)\w*\s*(=|;)', multiLine: true).hasMatch(s), isFalse, reason: '${f.path} caches a summary');
    }
  });

  group('LD-140 design-system rules', () {
    final banned = <String, RegExp>{
      'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
      'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
      'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
      'literal font size': RegExp(r'fontSize:\s*\d'),
      'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
      'Colors.* palette colour': RegExp(r'\bColors\.(?!transparent)\w+'),
    };
    test('there are sources to check', () => expect(sources(), isNotEmpty));
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/reports/smart', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('log, storage and transport hygiene (PHI: summary text, panel names)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'realtime / websocket / push': RegExp(r'WebSocket|web_socket|supabase|firebase_messaging|realtime', caseSensitive: false),
      'clipboard / share': RegExp(r'Clipboard|share_plus|Share\.share'),
      'timer / polling': RegExp(r'Timer\.periodic|Stream\.periodic'),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/reports/smart', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });
}
