// Source rules for the full phlebotomist UI (kit, shell, entry, history, alerts, profile, support, travel, queue, receipt).
// 13-M-SERIES s6.3: no colour, radius, font-size or duration literal in app code, everything from lims_ui tokens; bundled fonts
// only; no map SDK (C17 TRD, grep_forbidden.sh); the synthetic preview is reachable from the dev flavour only.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

List<File> dartIn(List<String> paths) {
  final out = <File>[];
  for (final p in paths) {
    if (FileSystemEntity.isDirectorySync(p)) {
      out.addAll(Directory(p).listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')));
    } else if (File(p).existsSync()) {
      out.add(File(p));
    }
  }
  return out;
}

String code(File f) => f.readAsStringSync().replaceAll(RegExp(r'//[^\r\n]*'), '');

final uiFiles = dartIn([
  'lib/ui',
  'lib/features/entry',
  'lib/features/shell',
  'lib/features/history',
  'lib/features/alerts',
  'lib/features/profile',
  'lib/features/support',
  'lib/features/travel',
  'lib/features/route/ui/queue_screen.dart',
  'lib/features/handover/ui/handover_receipt_screen.dart',
  'lib/preview',
]);

void main() {
  test('there are UI sources to check', () => expect(uiFiles.length, greaterThan(25)));

  final banned = <String, RegExp>{
    'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
    'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
    'Colors.<name> (use LimsTokens)': RegExp(r'\bColors\.(?!transparent\b)\w+'),
    'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
    'literal font size': RegExp(r'fontSize:\s*\d'),
    'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
    'literal motion duration in ms': RegExp(r'Duration\(\s*milliseconds:\s*\d'),
    'looping animation (repeat())': RegExp(r'\.repeat\('),
    'network font fetch (google_fonts)': RegExp(r'google_fonts|GoogleFonts'),
    'map SDK (map hand-off is a geo: link only)': RegExp(r'google_maps_flutter|flutter_map|mapbox', caseSensitive: false),
    'push SDK (the app polls, C17 PRD out of scope)': RegExp(r'firebase|firebase_messaging|FCM', caseSensitive: false),
    'clipboard / selectable patient text': RegExp(r'Clipboard|SelectableText|SelectionArea'),
    'logging': RegExp(r'\b(print|debugPrint)\s*\('),
  };
  for (final e in banned.entries) {
    test('no ${e.key} in the phlebotomist UI', () {
      for (final f in uiFiles) {
        // the dev preview's Duration literals are simulated network delays, not motion; every other rule still holds there
        if (e.key.startsWith('literal motion duration') && f.path.startsWith('lib/preview')) continue;
        expect(e.value.hasMatch(code(f)), isFalse, reason: '${f.path} has a ${e.key}');
      }
    });
  }

  test('no hand-sized touch target below 48 dp (literal height/width/dimension under 48)', () {
    final small = RegExp(r'(minHeight|height|width|dimension):\s*([0-9]|[1-3][0-9]|4[0-7])(\.\d+)?\s*[,)]');
    for (final f in uiFiles) {
      expect(small.hasMatch(code(f)), isFalse, reason: '${f.path} sizes a control with a literal under 48');
    }
  });

  test('text fields turn suggestions and autocorrect off (REQ-SEC-111)', () {
    for (final f in uiFiles) {
      final c = code(f);
      expect(RegExp(r'enableSuggestions\s*:\s*true|autocorrect\s*:\s*true').hasMatch(c), isFalse, reason: f.path);
      // a raw TextField must say enableSuggestions: false itself (LimsTextField does it by default)
      for (final m in RegExp(r'(?<![A-Za-z])TextField\s*\(').allMatches(c)) {
        final window = c.substring(m.start, (m.start + 500).clamp(0, c.length));
        expect(window.contains('enableSuggestions: false'), isTrue, reason: '${f.path}: TextField without enableSuggestions: false');
      }
    }
  });

  test('every full screen is wrapped in LimsSecureScreen except sign-in (spec §3 Global)', () {
    for (final f in uiFiles.where((f) => f.path.endsWith('_screen.dart') && !f.path.contains('login'))) {
      expect(code(f), contains('LimsSecureScreen'), reason: '${f.path} shows data without FLAG_SECURE');
    }
  });

  test('the preview (synthetic data) is only built for FLAVOR=dev and only main.dart imports it', () {
    final main = File('lib/main.dart').readAsStringSync();
    expect(main, contains('Flavor.dev'));
    expect(main, contains('PreviewScreens'));
    expect(RegExp(r'config\.flavor\s*==\s*Flavor\.dev\s*\?\s*PreviewScreens').hasMatch(main), isTrue, reason: 'preview must be gated on the dev flavour');
    for (final f in dartIn(['lib']).where((f) => !f.path.startsWith('lib/preview') && f.path != 'lib/main.dart')) {
      expect(f.readAsStringSync().contains("preview/"), isFalse, reason: '${f.path} imports the preview');
    }
  });

  test('the preview data says it is synthetic', () {
    expect(File('lib/preview/preview_data.dart').readAsStringSync(), contains('SYNTHETIC DATA ONLY'));
  });

  test('brand marks are app assets declared in pubspec, not fetched', () {
    expect(File('pubspec.yaml').readAsStringSync(), contains('assets/brand/'));
    for (final n in ['ml-logo-white.png', 'ml-logo-landscape-white.png']) {
      expect(File('assets/brand/$n').existsSync(), isTrue, reason: n);
    }
  });
}
