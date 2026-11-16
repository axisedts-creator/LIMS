// T0A-M5-PHLEBO-1 (LD-258) source rules that widget tests cannot see. Runs from the package root (flutter test).
// 13-M-SERIES s6.3: no colour, radius or font literal in app code; all from lims_ui tokens. Fonts are bundled (no network fetch).
// The board's sample content is never copied (LD-258): no invented address, hours, price, count or policy wording in the touched sources.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Files this task may touch: the four feature folders of the brief (route, visit, identity, consent) and collect (the tube checklist).
List<File> touched() {
  final out = <File>[];
  for (final d in ['lib/features/route', 'lib/features/visit', 'lib/features/identity', 'lib/features/consent', 'lib/features/collect']) {
    final dir = Directory(d);
    if (dir.existsSync()) out.addAll(dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')));
  }
  return out;
}

void main() {
  test('there are touched sources to check', () => expect(touched().length, greaterThan(8)));

  final banned = <String, RegExp>{
    'hex colour literal Color(0x..)': RegExp(r'Color\(\s*0x', caseSensitive: false),
    'hex colour string': RegExp(r'#[0-9a-fA-F]{6}\b'),
    'Colors.<name> (use LimsTokens)': RegExp(r'\bColors\.(?!transparent\b)\w+'),
    'pixel radius': RegExp(r'(Border|Radius)\.circular\(\s*\d'),
    'literal font size': RegExp(r'fontSize:\s*\d'),
    'literal font family': RegExp(r'fontFamily:\s*[\x27"]'),
    'literal motion duration in ms (use LimsTokens.motionDuration*)': RegExp(r'Duration\(\s*milliseconds:\s*\d'),
    'looping animation (repeat())': RegExp(r'\.repeat\('),
    'network font fetch (google_fonts)': RegExp(r'google_fonts|GoogleFonts'),
  };
  for (final e in banned.entries) {
    test('no ${e.key} in route, visit, identity, consent, collect', () {
      for (final f in touched()) {
        expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
      }
    });
  }

  test('no hand-sized touch target below 48 dp: a SizedBox or ConstrainedBox with a literal height under 48', () {
    final small = RegExp(r'(minHeight|height|width|dimension):\s*([0-9]|[1-3][0-9]|4[0-7])(\.\d+)?\s*[,)]');
    for (final f in touched()) {
      expect(small.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} sizes a control with a literal under 48');
    }
  });

  test('google_fonts is not a dependency of the phlebotomist app (Poppins and Noto Sans Devanagari come from the bundled assets)', () {
    expect(File('pubspec.yaml').readAsStringSync(), isNot(contains('google_fonts')));
  });

  test('the bundled font assets exist in lims_ui: Poppins 400/500/600/700 and the Devanagari fallback', () {
    final pub = File('../../packages/ui-flutter/pubspec.yaml').readAsStringSync();
    expect(pub, contains('Poppins'));
    expect(pub, contains('Noto Sans Devanagari'));
    for (final w in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      expect(File('../../packages/ui-flutter/assets/fonts/Poppins-$w.ttf').existsSync(), isTrue, reason: 'Poppins-$w.ttf');
    }
  });

  test('no board sample content is copied: no invented phone, price, opening hours or board wording in the touched sources', () {
    final invented = RegExp(
      r'Rs\.?\s?\d|NPR\s?\d|\b\d{1,2}\s?(am|pm)\s?[-–]\s?\d{1,2}\s?(am|pm)\b|\+977|\b9[78]\d{8}\b|Right patient\.|Right tube\.|On time\.|Field collection|Metro Labs',
      caseSensitive: false,
    );
    for (final f in touched()) {
      expect(invented.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} carries invented board content');
    }
  });

  test('the packages/ui-flutter widgets are not edited by this task (shared widgets belong to the first task of the series)', () {
    // patient-1 already delivered LimsCard.title optional, LimsBottomNav and LimsSecureScreen; phlebo-1 only uses them
    final s = File('../../packages/ui-flutter/lib/src/cr16_widgets.dart').readAsStringSync();
    expect(s, contains('class LimsCard'));
    expect(s, contains('class LimsBottomNav'));
  });

  test('behaviour files of the offline queue, identity and consent are not restyled away: the mutation types and payload keys are still in the sources', () {
    final id = File('lib/features/identity/ui/identity_screen.dart').readAsStringSync();
    final co = File('lib/features/consent/ui/consent_screen.dart').readAsStringSync();
    final vi = File('lib/features/visit/ui/visit_screen.dart').readAsStringSync();
    expect(id, contains("'visit.identity_checked'"));
    expect(id, contains("'name_check'"));
    expect(id, contains("'second_check'"));
    expect(co, contains("'visit.consent_recorded'"));
    expect(co, contains("'consent_text_version'"));
    expect(vi, contains("'visit.arrived'"));
    for (final f in [id, co, vi]) {
      expect(f, contains('LimsSecureScreen'), reason: 'a PHI screen lost its secure wrapper (REQ-SEC-109)');
    }
  });

  test('the task notes list the board elements that were not built as gaps for the founder', () {
    final f = File('../../.orchestra/notes/T0A-M5-PHLEBO-1-impl.md');
    expect(f.existsSync(), isTrue, reason: 'write .orchestra/notes/T0A-M5-PHLEBO-1-impl.md');
    final s = f.readAsStringSync().toLowerCase();
    expect(s, contains('gap'));
    expect(s, contains('history'), reason: 'the board History and Profile tabs have no screen in this app: list them as gaps');
    expect(s, contains('profile'));
    expect(s, contains('tube colour'), reason: 'the board tube colour dots have no data in the API model: list as a gap');
  });
}
