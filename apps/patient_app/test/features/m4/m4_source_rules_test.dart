// T0C-M4-PATIENT-1 (LD-258) source rules that widget tests cannot see. Runs from the package root (flutter test).
// 13-M-SERIES s6.3: no colour, radius or font literal in app code; all from lims_ui tokens. Fonts are bundled (no network fetch).
// The board's sample content is never copied (LD-258): no invented address, hours, price, count or policy wording in the touched sources.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Files this task may touch: the shell and lock chrome in lib/app, lib/core, and the auth, notifications and settings features.
List<File> touched() {
  final out = <File>[];
  for (final d in ['lib/app', 'lib/core', 'lib/features/auth', 'lib/features/notifications', 'lib/features/settings']) {
    final dir = Directory(d);
    if (dir.existsSync()) out.addAll(dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')));
  }
  return out;
}

void main() {
  test('there are touched sources to check', () => expect(touched().length, greaterThan(10)));

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
    test('no ${e.key} in the app shell, auth, notifications and settings', () {
      for (final f in touched()) {
        expect(e.value.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} has a ${e.key}');
      }
    });
  }

  test('google_fonts is not a dependency of the patient app (Poppins and Noto Sans Devanagari come from the bundled assets)', () {
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

  test('the router no longer builds a text placeholder for home (A5 is the shell)', () {
    final s = File('lib/app/router.dart').readAsStringSync();
    expect(RegExp(r"GoRoute\(path:\s*kHomePath,\s*builder:\s*\(_,\s*_\)\s*=>\s*phi\('Home'\)\)").hasMatch(s), isFalse, reason: "home is still phi('Home')");
  });

  test('no board sample content is copied: no invented phone, price or opening hours in the touched sources', () {
    final invented = RegExp(r'Rs\.?\s?\d|NPR\s?\d|\b\d{1,2}\s?(am|pm)\s?[-–]\s?\d{1,2}\s?(am|pm)\b|\+977|\b9[78]\d{8}\b', caseSensitive: false);
    for (final f in touched()) {
      expect(invented.hasMatch(f.readAsStringSync()), isFalse, reason: '${f.path} carries invented board content');
    }
  });

  test('main_staging.dart and main_prod.dart still read the legal URLs from --dart-define (no theme or behaviour change)', () {
    for (final entry in ['lib/main_staging.dart', 'lib/main_prod.dart']) {
      final s = File(entry).readAsStringSync();
      expect(RegExp(r'privacyUrl:\s*String\.fromEnvironment').hasMatch(s), isTrue, reason: entry);
      expect(RegExp(r'termsUrl:\s*String\.fromEnvironment').hasMatch(s), isTrue, reason: entry);
    }
  });

  test('the task notes list the board elements that were not built as gaps for the founder', () {
    final f = File('../../.orchestra/notes/T0C-M4-PATIENT-1-impl.md');
    expect(f.existsSync(), isTrue, reason: 'write .orchestra/notes/T0C-M4-PATIENT-1-impl.md');
    final s = f.readAsStringSync().toLowerCase();
    expect(s, contains('gap'));
  });
}
