// T0C-M4-PATIENT-3 (LD-258) source rules that widget tests cannot see. Runs from the package root (flutter test).
// 13-M-SERIES s6.3: no colour, radius, font or motion literal in app code; all from lims_ui tokens; fonts are bundled (no network fetch).
// The board's sample content is never copied (LD-258). RESTYLE ONLY: every PHI screen keeps LimsSecureScreen, the wizard keeps its Idempotency-Key
// per review step, A21 keeps its brightness raise/restore, and no screen gains a log, a storage write, a clipboard use or a hand-typed route.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const dirs = ['lib/features/bookings', 'lib/features/membership', 'lib/features/enquiries'];

List<File> touched() => [
      for (final d in dirs)
        if (Directory(d).existsSync()) ...Directory(d).listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')),
    ];

/// Source without whole-line comments (the spec wording quoted in comments is not app content).
String code(File f) => f.readAsStringSync().replaceAll(RegExp(r'^\s*//.*$', multiLine: true), '');

String read(String path) => File(path).readAsStringSync();

void main() {
  test('there are touched sources to check', () => expect(touched().length, greaterThan(12)));

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
    test('no ${e.key} in bookings, membership and enquiries', () {
      for (final f in touched()) {
        // the wizard's 300 ms search debounce is behaviour (04-UI-UX A17), not motion
        final src = e.key.startsWith('literal motion') ? code(f).replaceAll(RegExp(r'Timer\(\s*const Duration\(\s*milliseconds:\s*300\s*\)'), '') : code(f);
        expect(e.value.hasMatch(src), isFalse, reason: '${f.path} has a ${e.key}');
      }
    });
  }

  test('no board sample content is copied: no invented phone, price or opening hours in the touched sources', () {
    final invented = RegExp(r'Rs\.?\s?\d|NPR\s?\d|\b\d{1,2}(:\d\d)?\s?(am|pm)\b|\b9[78]\d{8}\b', caseSensitive: false);
    for (final f in touched()) {
      expect(invented.hasMatch(code(f)), isFalse, reason: '${f.path} carries invented board content');
    }
  });

  test('no board-only element is built: popular tests, categories, packages, offers, FAQ, visit-the-centre, privacy and terms pages', () {
    final board = RegExp(r'popular tests|test categor|health package|special offer|\bFAQ\b|visit the centre|our centre|near you|privacy policy|terms (of|and) |opening hours', caseSensitive: false);
    for (final f in touched()) {
      expect(board.hasMatch(code(f)), isFalse, reason: '${f.path} builds a board element the spec has no screen for');
    }
  });

  test('every PHI screen of the task keeps LimsSecureScreen and uses lims_ui (REQ-SEC-109)', () {
    const screens = [
      'bookings/bookings_list_screen',
      'bookings/booking_detail_screen',
      'bookings/booking_wizard_screen',
      'bookings/addresses_screen',
      'membership/membership_screen',
      'enquiries/enquiries_screen',
      'enquiries/new_enquiry_screen',
      'enquiries/enquiry_thread_screen',
    ];
    for (final s in screens) {
      final t = read('lib/features/$s.dart');
      expect(t, contains('LimsSecureScreen'), reason: s);
      expect(t, contains('package:lims_ui/lims_ui.dart'), reason: s);
    }
  });

  test('the wizard keeps its Idempotency-Key per review step, its in-flight guard and its quote/price lines from the booking model', () {
    final t = code(File('lib/features/bookings/booking_wizard_screen.dart'));
    expect(t, contains('newIdempotencyKey()'));
    expect(t, contains('idempotencyKey: _key!'));
    expect(t, contains("import 'bookings_format.dart'"), reason: 'prices come from the E30 model through the shared formatter');
    expect(t, contains('Final price is confirmed at the lab.'));
    expect(t, contains('Suitability is confirmed at the lab'));
  });

  test('A21 keeps its screen-brightness raise and restore, and still never prints the card token', () {
    final t = code(File('lib/features/membership/membership_screen.dart'));
    expect(t, contains('cardBrightnessProvider'));
    expect(t, contains('_brightness.raise'));
    expect(t, contains('_brightness.restore'));
    expect(RegExp(r'Text\([^)]*card_?[tT]oken').hasMatch(t), isFalse, reason: 'the token is the QR content only');
  });

  test('screens are restyled, not rerouted: no router or navigator-name change, no new route literal in the three features', () {
    for (final f in touched()) {
      final t = code(f);
      expect(RegExp(r'GoRoute\(|pushNamed|\.go\(\s*[\x27"]|\.push\(\s*[\x27"]').hasMatch(t), isFalse, reason: '${f.path} hand-types a route');
    }
  });

  test('no screen gains a log, a clipboard use or a storage write', () {
    for (final f in touched()) {
      final t = code(f);
      expect(RegExp(r'\bprint\(|debugPrint\(|Clipboard\.|SharedPreferences|SecureStorage|writeAsString|writeAsBytes').hasMatch(t), isFalse, reason: '${f.path}');
    }
  });

  test('the task notes list the board elements that were not built as gaps for the founder, and name the shared widgets lims_ui lacks', () {
    final f = File('../../.orchestra/notes/T0C-M4-PATIENT-3-impl.md');
    expect(f.existsSync(), isTrue, reason: 'write .orchestra/notes/T0C-M4-PATIENT-3-impl.md');
    final s = f.readAsStringSync().toLowerCase();
    expect(s, contains('gap'));
    expect(s, contains('lims_ui'), reason: 'say whether a shared widget is missing in packages/ui-flutter instead of editing it');
  });
}
