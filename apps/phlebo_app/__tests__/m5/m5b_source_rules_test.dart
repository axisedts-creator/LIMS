// T0A-M5-PHLEBO-2 (LD-258) source rules that widget tests cannot see. Runs from the package root (flutter test).
// 13-M-SERIES s6.3: no colour, radius or font literal in app code; all from lims_ui tokens. Fonts are bundled (no network fetch).
// The board's sample content is never copied (LD-258). Line comments are ignored (they may quote spec amounts such as "NPR 0.01").
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Files this task may restyle: outcome, handover, payment, outbox/ui, settings (the brief's file list). Logic folders are guarded below.
List<File> touched() {
  final out = <File>[];
  for (final d in [
    'lib/features/outcome',
    'lib/features/handover/ui',
    'lib/features/payment',
    'lib/features/outbox/ui',
    'lib/features/settings/ui',
  ]) {
    final dir = Directory(d);
    if (dir.existsSync()) out.addAll(dir.listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')));
  }
  return out;
}

String code(File f) => f.readAsStringSync().replaceAll(RegExp(r'//[^\r\n]*'), '');

String read(String p) => File(p).readAsStringSync();

void main() {
  test('there are touched sources to check', () => expect(touched().length, greaterThanOrEqualTo(5)));

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
    test('no ${e.key} in outcome, handover, payment, outbox/ui, settings', () {
      for (final f in touched()) {
        expect(e.value.hasMatch(code(f)), isFalse, reason: '${f.path} has a ${e.key}');
      }
    });
  }

  test('no hand-sized touch target below 48 dp: a SizedBox or ConstrainedBox with a literal height under 48', () {
    final small = RegExp(r'(minHeight|height|width|dimension):\s*([0-9]|[1-3][0-9]|4[0-7])(\.\d+)?\s*[,)]');
    for (final f in touched()) {
      expect(small.hasMatch(code(f)), isFalse, reason: '${f.path} sizes a control with a literal under 48');
    }
  });

  test('google_fonts is not a dependency of the phlebotomist app (Poppins and Noto Sans Devanagari come from the bundled assets)', () {
    expect(read('pubspec.yaml'), isNot(contains('google_fonts')));
  });

  test('no board sample content is copied: no invented phone, price, opening hours or board wording in the touched sources', () {
    final invented = RegExp(
      r'Rs\.?\s?\d|NPR\s?\d|\b\d{1,2}\s?(am|pm)\s?[-–]\s?\d{1,2}\s?(am|pm)\b|\+977|\b9[78]\d{8}\b|Right patient\.|Right tube\.|On time\.|Field collection|Metro Labs',
      caseSensitive: false,
    );
    for (final f in touched()) {
      expect(invented.hasMatch(code(f)), isFalse, reason: '${f.path} carries invented board content');
    }
  });

  test('the packages/ui-flutter widgets are not edited by this task: it only uses what the first task delivered', () {
    final s = read('../../packages/ui-flutter/lib/src/cr16_widgets.dart');
    expect(s, contains('class LimsCard'));
    expect(s, contains('class LimsBottomNav'));
  });

  test('every screen of the task keeps its secure wrapper (REQ-SEC-109) and the shared lims_ui scaffold', () {
    for (final p in [
      'lib/features/payment/ui/payment_screen.dart',
      'lib/features/outcome/ui/complete_screen.dart',
      'lib/features/outcome/ui/fail_visit_screen.dart',
      'lib/features/handover/ui/handover_screen.dart',
      'lib/features/outbox/ui/outbox_screen.dart',
      'lib/features/settings/ui/settings_screen.dart',
    ]) {
      final s = read(p);
      expect(s, contains('LimsSecureScreen'), reason: '$p lost its secure wrapper');
      expect(s, contains('LimsScaffold'), reason: '$p no longer uses LimsScaffold');
    }
  });

  test('behaviour is not restyled away: mutation types, payload keys, outbox labels and sign-out wording are still in the sources', () {
    final pay = read('lib/features/payment/ui/payment_screen.dart');
    expect(pay, contains("'payment.captured'"));
    for (final k in ["'order_id'", "'payment_method_code'", "'amount_paisa'", "'NPR'", "'reference'"]) {
      expect(pay, contains(k), reason: 'payment payload key $k');
    }
    expect(pay, contains('_maxPaisa = 50000000'));
    expect(pay, contains('_minPaisa = 1'));
    final com = read('lib/features/outcome/ui/complete_screen.dart');
    expect(com, contains("'visit.completed'"));
    expect(com, contains("'partial'"));
    expect(com, contains("'collected'"));
    final fail = read('lib/features/outcome/ui/fail_visit_screen.dart');
    expect(fail, contains("'visit.failed'"));
    for (final k in ["'reason_code'", "'reason_text'", "'gps'"]) {
      expect(fail, contains(k), reason: 'fail payload key $k');
    }
    final ho = read('lib/features/handover/ui/handover_screen.dart');
    expect(ho, contains("'handover.recorded'"));
    for (final k in ["'handover_id'", "'to_centre_id'", "'specimen_ids'"]) {
      expect(ho, contains(k), reason: 'handover payload key $k');
    }
    expect(ho, contains('_maxTubes = 50'));
    final ob = read('lib/features/outbox/ui/outbox_screen.dart');
    for (final w in ['Waiting', 'Uploading', 'Uploaded', 'On hold at centre', 'Not accepted', 'The centre will review this. Your record is saved.', 'Upload now']) {
      expect(ob, contains(w), reason: 'outbox wording "$w"');
    }
    final se = read('lib/features/settings/ui/settings_screen.dart');
    for (final w in ["Signing out erases today's visit list from this phone.", 'Sync first', 'Sign out', 'Device ID (last 8)']) {
      expect(se, contains(w), reason: 'settings wording "$w"');
    }
  });

  test('outbox, sync, payment and sign-out logic files are not part of the restyle: they still exist where the tests import them', () {
    for (final p in [
      'lib/features/outbox/data/outbox_repository.dart',
      'lib/features/outbox/data/outbox_schema.dart',
      'lib/features/outbox/domain/outbox_row.dart',
      'lib/features/outbox/domain/sync_summary.dart',
      'lib/features/outbox/domain/time_labels.dart',
      'lib/features/settings/domain/sign_out.dart',
      'lib/features/handover/domain/handover_models.dart',
    ]) {
      expect(File(p).existsSync(), isTrue, reason: p);
    }
    // the logic folders are not scanned for UI: no widget code was moved into them
    for (final d in ['lib/features/outbox/data', 'lib/features/outbox/domain', 'lib/features/settings/domain', 'lib/features/handover/domain']) {
      for (final f in Directory(d).listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
        expect(f.readAsStringSync(), isNot(contains('package:flutter/material.dart')), reason: '${f.path} gained UI code');
      }
    }
  });

  test('the task notes list the board elements that were not built as gaps for the founder', () {
    final f = File('../../.orchestra/notes/T0A-M5-PHLEBO-2-impl.md');
    expect(f.existsSync(), isTrue, reason: 'write .orchestra/notes/T0A-M5-PHLEBO-2-impl.md');
    final s = f.readAsStringSync().toLowerCase();
    expect(s, contains('gap'));
    expect(s, contains('offline banner'), reason: 'say where the offline banner shows the real sync state (route) and that these screens have no offline input');
    expect(s, contains('history'), reason: 'the board History and Profile tabs have no screen in this app: list them as gaps');
    expect(s, contains('profile'));
  });
}
