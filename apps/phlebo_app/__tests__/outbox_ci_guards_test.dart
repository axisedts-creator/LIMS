// HC-T24 static guards — plan row HC-T24 "done_when" + 05-SCHEMA B.2 invariants 1 & 3 (no UPDATE of immutable columns / of batches.body_json),
// TRD §3.4 layout, §7.5 (monotonic = elapsedRealtime, boot id = BOOT_COUNT, spike recorded as UNVERIFIED/VERIFIED).
// cwd = package root when run via `flutter test`. Pure source/text checks: independent of the writer's own tests.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

Directory _appDir() {
  var d = Directory.current;
  for (var i = 0; i < 4; i++) {
    final f = File('${d.path}/pubspec.yaml');
    if (f.existsSync() && RegExp(r'^name:\s*phlebo_app\s*$', multiLine: true).hasMatch(f.readAsStringSync())) return d;
    d = d.parent;
  }
  throw StateError('apps/phlebo_app/pubspec.yaml not found from ${Directory.current.path}');
}

String _stripComments(String s) =>
    s.replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '').split('\n').map((l) => l.replaceFirst(RegExp(r'//.*$'), '')).join('\n');

List<File> _files(Directory d, bool Function(String path) keep) => d.existsSync()
    ? d.listSync(recursive: true).whereType<File>().where((f) => keep(f.path.replaceAll('\\', '/'))).toList()
    : <File>[];

void main() {
  final app = _appDir();
  final repoRoot = app.parent.parent;
  final lib = '${app.path}/lib';
  List<File> dart(String sub) => _files(Directory('$lib/$sub'), (p) => p.endsWith('.dart'));
  String code(Iterable<File> fs) => fs.map((f) => _stripComments(f.readAsStringSync())).join('\n');

  test('files from the plan row exist: core/sync/clock_anchor.dart, core/platform/{monotonic_clock,boot_id}.dart, features/outbox/*', () {
    for (final p in ['core/sync/clock_anchor.dart', 'core/platform/monotonic_clock.dart', 'core/platform/boot_id.dart']) {
      expect(File('$lib/$p').existsSync(), isTrue, reason: 'lib/$p');
    }
    expect(File('$lib/features/outbox/data/outbox_schema.dart').existsSync(), isTrue);
    expect(File('$lib/features/outbox/data/outbox_repository.dart').existsSync(), isTrue);
  });

  test('invariant 1: no SQL anywhere in outbox/sync code UPDATEs an immutable mutation_log column', () {
    final src = code([...dart('features/outbox'), ...dart('core/sync')]);
    final updates = RegExp(r'UPDATE\s+mutation_log\s+SET\s+((?:(?!\bWHERE\b)[^;"\x27])*)', caseSensitive: false).allMatches(src).map((m) => m.group(1)!).toList();
    expect(updates, isNotEmpty, reason: 'state transitions must exist (positive control for this scan)');
    final immutable = RegExp(
        r'\b(client_mutation_id|device_seq|type|visit_id|visit_label|payload_json|payload_sha256|captured_wall_time|anchor_id|elapsed_since_anchor_ms)\s*=',
        caseSensitive: false);
    for (final set in updates) {
      expect(immutable.hasMatch(set), isFalse, reason: 'UPDATE mutation_log SET $set touches an immutable column');
    }
  });

  test('invariant 3: batches.body_json is written once — no UPDATE batches, no UPDATE/REPLACE of clock_anchors', () {
    final src = code([...dart('features/outbox'), ...dart('core/sync')]);
    expect(RegExp(r'UPDATE\s+batches\b', caseSensitive: false).hasMatch(src), isFalse, reason: 'body_json is frozen; 422 path deletes + re-inserts');
    expect(RegExp(r'INSERT\s+OR\s+REPLACE\s+INTO\s+batches', caseSensitive: false).hasMatch(src), isFalse);
    expect(RegExp(r'REPLACE\s+INTO\s+mutation_log', caseSensitive: false).hasMatch(src), isFalse);
    expect(RegExp(r'UPDATE\s+clock_anchors\b', caseSensitive: false).hasMatch(src), isFalse, reason: 'anchors are facts');
  });

  test('no log/print/Sentry sink in outbox, sync or platform code (payloads carry barcodes/amounts, P2)', () {
    final src = code([...dart('features/outbox'), ...dart('core/sync'), ...dart('core/platform')]);
    for (final bad in [r'\bprint\s*\(', r'\bdebugPrint\s*\(', r'developer\.log', r'\bSentry\.', r'shared_preferences']) {
      expect(RegExp(bad).hasMatch(src), isFalse, reason: 'must not use $bad');
    }
  });

  test('monotonic/boot-id Dart channels never fall back to wall clock or Stopwatch (neither reliably includes deep sleep)', () {
    for (final n in ['monotonic_clock.dart', 'boot_id.dart']) {
      final f = File('$lib/core/platform/$n');
      expect(f.existsSync(), isTrue, reason: n);
      final src = _stripComments(f.readAsStringSync());
      expect(RegExp(r'DateTime\.now\s*\(').hasMatch(src), isFalse, reason: '$n must not use DateTime.now()');
      expect(RegExp(r'\bStopwatch\b').hasMatch(src), isFalse, reason: '$n must not use Stopwatch (CLOCK_MONOTONIC excludes suspend on Android)');
    }
    final mono = _stripComments(File('$lib/core/platform/monotonic_clock.dart').readAsStringSync());
    expect(mono, contains('MonotonicClock'));
    expect(_stripComments(File('$lib/core/platform/boot_id.dart').readAsStringSync()), contains('BootIdSource'));
  });

  test('Android side: elapsedRealtime() for the monotonic channel and Settings.Global.BOOT_COUNT for boot id (TRD §7.5)', () {
    final native = _files(Directory('${app.path}/android'), (p) => (p.endsWith('.kt') || p.endsWith('.java')) && !p.contains('/build/'));
    final src = native.map((f) => _stripComments(f.readAsStringSync())).join('\n');
    expect(native, isNotEmpty, reason: 'a Kotlin/Java platform-channel handler under apps/phlebo_app/android');
    expect(src, contains('SystemClock.elapsedRealtime'));
    expect(src, contains('BOOT_COUNT'));
    expect(RegExp(r'currentTimeMillis|uptimeMillis|nanoTime').hasMatch(src), isFalse,
        reason: 'wall clock / uptimeMillis (excludes deep sleep) / nanoTime must not feed the monotonic channel');
  });

  test('done_when: the spike result is recorded in .orchestra/notes/HC-T24-spike.md, both items marked UNVERIFIED or VERIFIED', () {
    final f = File('${repoRoot.path}/.orchestra/notes/HC-T24-spike.md');
    expect(f.existsSync(), isTrue, reason: 'writer records the spike here (review m#36)');
    final s = f.readAsStringSync();
    expect(s, contains('elapsedRealtime'));
    expect(s, contains('BOOT_COUNT'));
    expect(s.toLowerCase(), contains('deep sleep'));
    expect(RegExp(r'UNVERIFIED|VERIFIED', caseSensitive: true).allMatches(s).length, greaterThanOrEqualTo(2),
        reason: 'one verdict per question: elapsedRealtime/deep sleep, BOOT_COUNT readable');
  });
}
