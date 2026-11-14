// T-P3 — source rules widget tests cannot see. Runs from the package root (flutter test).
// LD-140: screens only from lims_ui + token names. 02-CV 9.2 / REQ-SEC-103: no logging, no local persistence; the only file the app writes is the transient PDF, inside SecureTempFiles.dir.
// REQ-SEC-034/035: a Storage URL never reaches the app. Synthetic data only.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> sources() {
  final dir = Directory('lib/features/reports');
  return dir.existsSync() ? dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList() : <File>[];
}

String read(String name) => File('lib/features/reports/$name.dart').readAsStringSync();

void main() {
  test('the reports feature exists: reports_api, reports_providers, reports_list_screen, report_viewer_screen', () {
    for (final f in ['reports_api', 'reports_providers', 'reports_list_screen', 'report_viewer_screen']) {
      expect(File('lib/features/reports/$f.dart').existsSync(), isTrue, reason: 'missing lib/features/reports/$f.dart');
    }
  });

  test('both screens build on lims_ui; the list uses LimsStatusChip, the viewer LimsPdfViewer + LimsConfirmDialog; both are LimsSecureScreen', () {
    final list = read('reports_list_screen'), viewer = read('report_viewer_screen'), providers = read('reports_providers');
    expect(list, contains('package:lims_ui/lims_ui.dart'));
    expect(viewer, contains('package:lims_ui/lims_ui.dart'));
    expect(list, contains('LimsStatusChip'));
    expect(list, contains('LimsSecureScreen'));
    expect(viewer, contains('LimsSecureScreen'));
    expect(viewer, contains('LimsConfirmDialog'), reason: 'Save/Share only after the confirmation dialog');
    expect(providers, contains('LimsPdfViewer'), reason: 'the default viewer builder renders with LimsPdfViewer (CR-C16-016)');
  });

  test('the temp file lives only in secureTempFilesProvider.dir: no other directory API', () {
    final viewer = read('report_viewer_screen');
    expect(viewer, contains('secureTempFilesProvider'));
    final other = RegExp(r'getTemporaryDirectory|getApplicationDocumentsDirectory|getApplicationSupportDirectory|getExternalStorage|getDownloadsDirectory|Directory\.systemTemp|path_provider');
    for (final f in sources()) {
      expect(other.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} writes outside SecureTempFiles.dir');
    }
  });

  test('the viewer deletes its file (delete call present) and the list / api never touch the file system', () {
    expect(RegExp(r'\.delete(Sync)?\(|deleteAll\(').hasMatch(read('report_viewer_screen')), isTrue);
    for (final n in ['reports_list_screen', 'reports_api', 'reports_providers']) {
      expect(RegExp(r'writeAs(Bytes|String)(Sync)?|File\(|Directory\(|openWrite').hasMatch(read(n)), isFalse, reason: '$n touches the file system');
    }
  });

  test('no signed / storage URL handling in the app (REQ-SEC-034/035): bytes only through the API', () {
    for (final f in sources()) {
      final s = f.readAsStringSync();
      expect(RegExp(r'signedUrl|signed_url|launchUrl|url_launcher|storage\.', caseSensitive: false).hasMatch(s), isFalse, reason: '${f.path} handles a storage / external URL');
    }
  });

  test('the PDF is never kept in memory beyond the screen: no static / top-level byte cache', () {
    for (final f in sources()) {
      expect(RegExp(r'^(static\s+)?(final\s+|var\s+)?(Uint8List|List<int>)\s+\w+\s*(=|;)', multiLine: true).hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} caches bytes');
    }
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
      test('no ${e.key} in lib/features/reports', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });

  group('log, storage and transport hygiene (PHI: report, panel names)', () {
    final banned = <String, RegExp>{
      'print/debugPrint/log call': RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\('),
      'shared_preferences': RegExp(r'shared_preferences|SharedPreferences'),
      'local database': RegExp(r'sqflite|drift|hive|isar'),
      'realtime / websocket / push': RegExp(r'WebSocket|web_socket|supabase|firebase_messaging|realtime', caseSensitive: false),
      'clipboard': RegExp(r'Clipboard'),
    };
    for (final e in banned.entries) {
      test('no ${e.key} in lib/features/reports', () {
        for (final f in sources()) {
          expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
        }
      });
    }
  });
}
