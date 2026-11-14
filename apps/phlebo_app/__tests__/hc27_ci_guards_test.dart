// HC-T27 source guards (REQ-SEC-103/109/111, LD-140, offline-first): static checks over the route, handover, outbox and settings screens.
// Paths are relative to apps/phlebo_app (flutter test cwd).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _screens = [
  'lib/features/route/ui/route_screen.dart',
  'lib/features/handover/ui/handover_screen.dart',
  'lib/features/outbox/ui/outbox_screen.dart',
  'lib/features/settings/ui/settings_screen.dart',
];
const _others = [
  'lib/features/route/domain/route_models.dart',
  'lib/features/handover/domain/handover_models.dart',
  'lib/features/outbox/domain/outbox_row.dart',
  'lib/features/outbox/domain/sync_summary.dart',
  'lib/features/settings/domain/sign_out.dart',
];

String _src(String p) => File(p).readAsStringSync();

/// Source with comments removed, so a rule mentioned in a comment is not a violation.
String _code(String p) => _src(p).split('\n').map((l) {
      final i = l.indexOf('//');
      return i < 0 ? l : l.substring(0, i);
    }).join('\n');

List<String> get _all => [..._screens, ..._others];

void main() {
  test('all HC-T27 files exist', () {
    for (final p in _all) {
      expect(File(p).existsSync(), isTrue, reason: 'missing $p');
    }
  });

  group('every screen', () {
    for (final p in _screens) {
      test('$p: LimsSecureScreen + LimsScaffold, cites LD-140', () {
        final s = _src(p);
        expect(s, contains('LimsSecureScreen'), reason: 'REQ-SEC-109: FLAG_SECURE on every PHI screen');
        expect(s, contains('LimsScaffold'));
        expect(s, contains('LD-140'), reason: 'binding lead decision cited in a code comment');
      });

      test('$p: only lims_ui widgets (no raw Material buttons/fields/dialogs)', () {
        final c = _code(p);
        for (final raw in [
          RegExp(r'\b(ElevatedButton|FilledButton|OutlinedButton|TextButton|IconButton)\s*\('),
          RegExp(r'(?<![A-Za-z])(TextField|TextFormField)\s*\('),
          RegExp(r'\b(AlertDialog|SimpleDialog|Scaffold)\s*\('),
        ]) {
          expect(raw.hasMatch(c), isFalse, reason: '$p uses ${raw.pattern}; use lims_ui');
        }
      });

      test('$p: no hex colours, pixel radii or inline style objects (LD-140)', () {
        final c = _code(p);
        expect(RegExp(r'Color\(\s*0x').hasMatch(c), isFalse, reason: 'hex Color(0x..)');
        expect(RegExp(r"#[0-9a-fA-F]{6}\b").hasMatch(c), isFalse, reason: 'hex literal');
        expect(RegExp(r'\bColors\.').hasMatch(c), isFalse, reason: 'use lims_ui tokens, not Colors.*');
        expect(RegExp(r'(BorderRadius|Radius)\.(circular|all)\s*\(\s*\d').hasMatch(c), isFalse, reason: 'pixel radius');
        expect(RegExp(r'\b(TextStyle|BoxDecoration)\s*\(').hasMatch(c), isFalse, reason: 'inline style object');
      });

      test('$p: no copy-to-clipboard, no log output, no wall-clock reads', () {
        final c = _code(p);
        expect(RegExp(r'Clipboard|SelectableText|SelectionArea').hasMatch(c), isFalse, reason: 'no copy on patient fields');
        expect(RegExp(r'\b(print|debugPrint|log)\s*\(|developer\.log|Sentry\.').hasMatch(c), isFalse, reason: 'no logging of visit data');
        expect(c.contains('DateTime.now'), isFalse, reason: 'dates and times come from the caller so tests control them');
      });
    }
  });

  group('offline + layering', () {
    for (final p in _all) {
      test('$p: no network and no direct DB access (screens take data and callbacks)', () {
        final c = _code(p);
        expect(
            RegExp(r'dart:io|package:http|pinned_http|api_factory|HttpClient|sync_engine|connectivity').hasMatch(c), isFalse,
            reason: 'US-07/US-12 must work in airplane mode; the server calls live behind the injected callbacks');
        expect(RegExp(r'OutboxDb|package:sqlite3|package:drift|cache_db|outbox_db').hasMatch(c), isFalse,
            reason: 'persist via MutationSink; read via OutboxRepository in the app shell');
      });
    }

    test('handover writes only through MutationSink with the TRD type name and no visit id', () {
      final c = _code('lib/features/handover/ui/handover_screen.dart');
      expect(c, contains('MutationSink'));
      expect(c, contains("'handover.recorded'"));
      expect(RegExp(r"'handover\.(record|created|handed_over|submitted)'").hasMatch(c), isFalse, reason: 'invented mutation type');
      expect(c, contains("'handover_id'"));
      expect(c, contains("'to_centre_id'"));
      expect(c, contains("'specimen_ids'"));
    });

    test('OutboxRepository exposes listRows and pendingCount for M11/M12', () {
      final c = _code('lib/features/outbox/data/outbox_repository.dart');
      expect(c, contains('Future<List<OutboxRow>> listRows('));
      expect(c, contains('Future<int> pendingCount('));
    });

    test('outbox and handover models carry no patient fields (no name/phone/address/dob)', () {
      for (final p in [
        'lib/features/outbox/domain/outbox_row.dart',
        'lib/features/handover/domain/handover_models.dart',
      ]) {
        expect(RegExp(r'patientName|phoneNumber|birthDate|address|\bdob\b', caseSensitive: false).hasMatch(_code(p)), isFalse,
            reason: '$p: no PHI on the outbox, handover or settings screens');
      }
    });

    test('the sign-out confirmation and the pending text are copied from the spec', () {
      final c = _code('lib/features/settings/ui/settings_screen.dart');
      expect(c, contains('Signing out erases today'));
      expect(c, contains('visit list from this phone.'));
      expect(c, contains('Sync first'));
    });
  });
}
