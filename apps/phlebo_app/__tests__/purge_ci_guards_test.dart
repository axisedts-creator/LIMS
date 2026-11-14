// HC-T28 static guards — plan row (files core/db/wipe.dart, core/sync/*), TRD §7.1 (destruction = key first, always through DbWipe),
// §7.5 (clocks injected), P2 (no log sink), REQ-SEC-104 (no own network stack), US-13-5 (wipe_completed on ackSync).
// Pure source/text checks, independent of the writer's own tests. cwd = package root under `flutter test`.
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

void main() {
  final app = _appDir();
  final triggers = File('${app.path}/lib/core/sync/purge_triggers.dart');
  final engine = File('${app.path}/lib/core/sync/sync_engine.dart');
  final wipe = File('${app.path}/lib/core/db/wipe.dart');

  test('lib/core/sync/purge_triggers.dart exists (plan row HC-T28)', () {
    expect(triggers.existsSync(), isTrue);
  });

  group('purge_triggers.dart source rules', () {
    late String code;
    setUpAll(() => code = triggers.existsSync() ? _stripComments(triggers.readAsStringSync()) : '');

    test('no log / print / Sentry sink', () {
      expect(RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\(').hasMatch(code), isFalse);
      expect(RegExp(r'sentry|Sentry|stderr|stdout').hasMatch(code), isFalse);
    });

    test('time is injected: no DateTime.now / DateTime.timestamp / Stopwatch / Timer', () {
      expect(RegExp(r'DateTime\s*\.\s*(now|timestamp)|Stopwatch|\bTimer\b').hasMatch(code), isFalse);
    });

    test('no network stack of its own', () {
      expect(RegExp(r'HttpClient\b|package:http|\bSocket\b|ApiClient').hasMatch(code), isFalse);
    });

    test('every destruction goes through DbWipe (key first): no direct File/Directory delete, no DELETE FROM / DROP in this file', () {
      expect(RegExp(r'\.deleteSync|\.delete\s*\(|File\s*\(|Directory\s*\(').hasMatch(code), isFalse);
      expect(RegExp(r'DELETE\s+FROM|DROP\s+TABLE|VACUUM', caseSensitive: false).hasMatch(code), isFalse);
      expect(code, contains('DbWipe'));
      expect(code, contains('destroyCache'));
      expect(code, contains('destroyAll'));
    });

    test('purging the cache never touches the outbox: destroyOutbox appears nowhere (wipe goes through destroyAll)', () {
      expect(code.contains('destroyOutbox'), isFalse);
    });

    test('limits come from the snapshot config and the spec default: offline_purge_hours, route_date, last_successful_pull_at, 16', () {
      expect(code, contains('offline_purge_hours'));
      expect(code, contains('route_date'));
      expect(code, contains('last_successful_pull_at'));
      expect(RegExp(r'\b16\b').hasMatch(code), isTrue);
    });
  });

  group('sync_engine.dart hooks', () {
    late String code;
    setUpAll(() => code = _stripComments(engine.readAsStringSync()));

    test('the engine reads device_command and acks with wipe_completed (A2/A4, US-13-5)', () {
      expect(code, contains("'device_command'"));
      expect(code, contains("'wipe'"));
      expect(code, contains("'wipe_completed'"));
    });

    test('the engine reaches the stores only through PurgeTriggers: no DbWipe, File or key access in the engine', () {
      expect(code, contains('PurgeTriggers'));
      expect(RegExp(r'DbWipe|DbKeys|File\s*\(|\.deleteSync').hasMatch(code), isFalse);
    });

    test('drain check looks at pending AND sending rows', () {
      expect(RegExp(r"state\s+IN\s*\(\s*'pending'\s*,\s*'sending'\s*\)", caseSensitive: false).hasMatch(code), isTrue);
    });
  });

  test('wipe.dart still deletes the key before touching a file (TRD §7.1) and was not given a second delete path', () {
    final code = _stripComments(wipe.readAsStringSync());
    final keyAt = code.indexOf('await deleteKey()');
    final fileAt = code.indexOf('deleteSync');
    expect(keyAt, greaterThanOrEqualTo(0));
    expect(fileAt, greaterThan(keyAt));
    expect('deleteSync'.allMatches(code).length, 1);
  });
}
