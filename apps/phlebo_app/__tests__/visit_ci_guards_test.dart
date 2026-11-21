// HC-T26 source guards (REQ-SEC-103/109/111, LD-140, offline-first): static checks over the visit-flow screens.
// Files (plan row HC-T26 + the ASSUMED API of support/visit_fixture.dart). Paths are relative to apps/phlebo_app (flutter test cwd).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _screens = [
  'lib/features/visit/ui/visit_screen.dart',
  'lib/features/identity/ui/identity_screen.dart',
  'lib/features/consent/ui/consent_screen.dart',
  'lib/features/collect/ui/collect_screen.dart',
  'lib/features/payment/ui/payment_screen.dart',
  'lib/features/outcome/ui/complete_screen.dart',
  'lib/features/outcome/ui/fail_visit_screen.dart',
];
const _others = [
  'lib/features/visit/ui/visit_flow_screen.dart',
  'lib/features/visit/domain/visit_guard.dart',
  'lib/features/visit/domain/visit_models.dart',
  'lib/features/visit/data/mutation_sink.dart',
];

String _src(String p) => File(p).readAsStringSync();

/// Source with comments removed, so a rule mentioned in a comment is not a violation.
String _code(String p) => _src(p).split('\n').map((l) {
      final i = l.indexOf('//');
      return i < 0 ? l : l.substring(0, i);
    }).join('\n');

List<String> get _all => [..._screens, ..._others];

void main() {
  test('all HC-T26 files exist', () {
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

      test('$p: no copy-to-clipboard on patient data, no log output, no wall-clock reads', () {
        final c = _code(p);
        expect(RegExp(r'Clipboard|SelectableText|SelectionArea').hasMatch(c), isFalse, reason: 'no copy on patient fields');
        expect(RegExp(r'\b(print|debugPrint|log)\s*\(|developer\.log|Sentry\.').hasMatch(c), isFalse, reason: 'no logging of visit data');
        expect(c.contains('DateTime.now'), isFalse, reason: 'inject `now` so tests control time');
        expect(RegExp(r'enableSuggestions\s*:\s*true|autocorrect\s*:\s*true').hasMatch(c), isFalse, reason: 'REQ-SEC-111');
      });
    }
  });

  group('offline + layering', () {
    for (final p in _all) {
      test('$p: no network and no direct DB access (screens only talk to MutationSink)', () {
        final c = _code(p);
        expect(
            RegExp(r'dart:io|package:http|pinned_http|api_factory|HttpClient|sync_engine|connectivity').hasMatch(c), isFalse,
            reason: 'US-07 must pass in airplane mode');
        expect(RegExp(r'OutboxDb|package:sqlite3|package:drift|cache_db|outbox_db').hasMatch(c), isFalse,
            reason: 'persist via MutationSink (OutboxRepository) only');
      });
    }

    test('MutationSink is the one enqueue seam with the OutboxRepository signature', () {
      final s = _code('lib/features/visit/data/mutation_sink.dart');
      expect(s, contains('abstract interface class MutationSink'));
      expect(s, contains('Future<SavedMutation> enqueue('));
      expect(_code('lib/features/outbox/data/outbox_repository.dart'), contains('implements MutationSink'));
    });

    test('mutation type names are copied verbatim from the TRD table (no invented names)', () {
      final all = _all.map(_code).join('\n');
      for (final t in [
        'visit.arrived',
        'visit.identity_checked',
        'visit.consent_recorded',
        'specimen.collected',
        'specimen.not_collected',
        'payment.captured',
        'visit.completed',
        'visit.failed',
      ]) {
        expect(all, contains("'$t'"), reason: t);
      }
      for (final bad in ['visit.arrive', 'visit.identity', 'visit.consent', 'payment.recorded', 'specimen.scanned', 'visit.finished']) {
        expect(RegExp("'${RegExp.escape(bad)}'").hasMatch(all), isFalse, reason: 'invented mutation type $bad');
      }
    });
  });

  group('payment', () {
    test('payment codes are not hard-coded in the screen (the list and requires_reference come from config)', () {
      final c = _code('lib/features/payment/ui/payment_screen.dart');
      expect(RegExp(r"'(fonepay_qr|bank_transfer|esewa|khalti)'").hasMatch(c), isFalse);
      expect(c, contains('requiresReference'));
    });

    test('amount handled as integer paisa via LimsMoneyField, never double.parse', () {
      final c = _code('lib/features/payment/ui/payment_screen.dart');
      expect(c, contains('LimsMoneyField'));
      expect(RegExp(r'double\.(parse|tryParse)|\bdouble\b').hasMatch(c), isFalse);
    });
  });
}
