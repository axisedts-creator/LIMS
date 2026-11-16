// T0C-M4-PATIENT-2 (LD-258) source rules that widget tests cannot see. Runs from the package root (flutter test).
// 13-M-SERIES s6.3: no colour, radius, font or motion literal in app code; all from lims_ui tokens; fonts are bundled (no network fetch).
// The board's sample content is never copied (LD-258). RESTYLE ONLY: every PHI screen keeps LimsSecureScreen, the viewer keeps its temp-file
// cleanup, and no screen gains a log, a storage write, a clipboard use or a hand-typed route (the existing *_source_rules / design_rules tests
// keep guarding those; the checks below only make sure the restyle did not take them away).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const dirs = ['lib/features/profiles', 'lib/features/orders', 'lib/features/reports', 'lib/features/payments'];

List<File> touched() => [
      for (final d in dirs)
        if (Directory(d).existsSync()) ...Directory(d).listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')),
    ];

/// Source without whole-line comments (the spec wording quoted in comments is not app content).
String code(File f) => f.readAsStringSync().replaceAll(RegExp(r'^\s*//.*$', multiLine: true), '');

String read(String path) => File(path).readAsStringSync();

void main() {
  test('there are touched sources to check', () => expect(touched().length, greaterThan(20)));

  final banned = <String, RegExp>{
    'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
    'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
    'Colors.<name> (use LimsTokens)': RegExp(r'\bColors\.(?!transparent\b)\w+'),
    'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
    'literal font size': RegExp(r'fontSize:\s*\d'),
    'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
    'literal motion duration in ms (use LimsTokens.motionDuration*)': RegExp(r'Duration\(\s*milliseconds:\s*\d'),
    'network font fetch (google_fonts)': RegExp(r'google_fonts|GoogleFonts'),
  };
  for (final e in banned.entries) {
    test('no ${e.key} in profiles, orders, reports and payments', () {
      for (final f in touched()) {
        expect(e.value.hasMatch(code(f)), isFalse, reason: '${f.path} has a ${e.key}');
      }
    });
  }

  test('no board sample content is copied: no invented phone, price or opening hours in the touched sources', () {
    final invented = RegExp(r'Rs\.?\s?\d|NPR\s?\d|\b\d{1,2}\s?(am|pm)\s?[-–]\s?\d{1,2}\s?(am|pm)\b|\+977|\b9[78]\d{8}\b', caseSensitive: false);
    for (final f in touched()) {
      expect(invented.hasMatch(code(f)), isFalse, reason: '${f.path} carries invented board content');
    }
  });

  test('no board-only element is built: popular tests, categories, packages, offers, FAQ, visit-the-centre', () {
    final board = RegExp(r'popular tests|test categor|health package|special offer|\bFAQ\b|visit the centre|our centre|near you', caseSensitive: false);
    for (final f in touched()) {
      expect(board.hasMatch(code(f)), isFalse, reason: '${f.path} builds a board element the spec has no screen for');
    }
  });

  test('every PHI screen of the task keeps LimsSecureScreen (REQ-SEC-109)', () {
    const screens = [
      'profiles/profiles_screen',
      'profiles/link_code_screen',
      'profiles/report_link_screen',
      'profiles/register_screen',
      'orders/orders_list_screen',
      'orders/order_detail_screen',
      'reports/reports_list_screen',
      'reports/report_viewer_screen',
      'reports/smart/smart_summary_screen',
      'payments/pay_due_screen',
      'payments/payment_result_screen',
    ];
    for (final s in screens) {
      final t = read('lib/features/$s.dart');
      expect(t, contains('LimsSecureScreen'), reason: s);
      expect(t, contains('package:lims_ui/lims_ui.dart'), reason: s);
    }
  });

  test('the report viewer keeps its temp-file cleanup and the screen-leave hook (PopScope), and stays on SecureTempFiles', () {
    final t = read('lib/features/reports/report_viewer_screen.dart');
    expect(t, contains('secureTempFilesProvider'));
    expect(t, contains('PopScope'));
    expect(t, contains('_deleteFile'));
    expect(t, contains('reportViewerBuilderProvider'));
  });

  test('screens are restyled, not rerouted: no router or navigator-name change, no new route literal in the four features', () {
    for (final f in touched()) {
      final t = code(f);
      expect(RegExp(r'GoRoute\(|pushNamed|\.go\(\s*[\x27"]|\.push\(\s*[\x27"]').hasMatch(t), isFalse, reason: '${f.path} hand-types a route');
    }
  });

  test('the payment screens still never take an amount from the caller of E41 and never read the return link for a result (REQ-SEC-046, REQ-SEC-059)', () {
    final api = code(File('lib/features/payments/payments_api.dart'));
    expect(RegExp(r'createPaymentRequest\(\{[^}]*amount').hasMatch(api), isFalse, reason: 'E41 takes no amount');
    expect(RegExp(r'returnUri[^;\n]*(\[|\.queryParameters|\.query)').hasMatch(code(File('lib/features/payments/payment_result_screen.dart'))), isFalse, reason: 'the return link is never read for a result');
  });

  test('the task notes list the board elements that were not built as gaps for the founder', () {
    final f = File('../../.orchestra/notes/T0C-M4-PATIENT-2-impl.md');
    expect(f.existsSync(), isTrue, reason: 'write .orchestra/notes/T0C-M4-PATIENT-2-impl.md');
    final s = f.readAsStringSync().toLowerCase();
    expect(s, contains('gap'));
    expect(s, contains('lims_ui'), reason: 'say whether a shared widget is missing in packages/ui-flutter (e.g. a status chip with an icon) instead of editing it');
  });
}
