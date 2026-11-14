// HC-T25 static guards — plan row (file core/sync/sync_engine.dart), TRD §3.4 (all network through the pinned ApiClient, REQ-SEC-104),
// §6.1 S-4, §7.2, 05-SCHEMA B.1 replace algorithm + B.2 invariant 3, P2 (no payload/PHI sink), clocks injected (§7.5).
// Pure source/text checks: independent of the writer's own tests. cwd = package root under `flutter test`.
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
  final file = File('${app.path}/lib/core/sync/sync_engine.dart');

  test('lib/core/sync/sync_engine.dart exists (plan row HC-T25)', () {
    expect(file.existsSync(), isTrue);
  });

  group('source rules', () {
    late String raw;
    late String code;
    setUpAll(() {
      raw = file.existsSync() ? file.readAsStringSync() : '';
      code = _stripComments(raw);
    });

    test('no log / print / Sentry sink: bodies and tokens carry barcodes, amounts and bearer credentials (P2)', () {
      expect(RegExp(r'\b(print|debugPrint|developer\.log|log)\s*\(').hasMatch(code), isFalse);
      expect(RegExp(r'sentry|Sentry|stderr|stdout').hasMatch(code), isFalse);
    });

    test('time is injected (wallNow) and monotonic time is not read here: no DateTime.now / Stopwatch', () {
      expect(RegExp(r'DateTime\s*\.\s*(now|timestamp)|Stopwatch').hasMatch(code), isFalse);
    });

    test('every call goes through the pinned ApiClient: no HttpClient, package:http, Socket or custom TLS callback (REQ-SEC-104)', () {
      expect(RegExp(r'HttpClient\b|package:http|\bSocket\b|badCertificateCallback|SecurityContext').hasMatch(code), isFalse);
      expect(code, contains('ApiClient'));
    });

    test('the three endpoints are the spec paths relative to the /v1/homecollection base; push sends batch_id as Idempotency-Key', () {
      expect(code, contains("'/sync/mutations'"));
      expect(code, contains("'/sync/snapshot'"));
      expect(code, contains("'/sync/ack'"));
      expect(RegExp(r'idempotencyKey\s*:').hasMatch(code), isTrue);
      expect(code.contains('/v1/'), isFalse, reason: 'the version prefix belongs to the configured base URL, not to the engine');
    });

    test('invariant 3: the frozen body is never edited in place (no UPDATE batches / REPLACE INTO batches) and never re-encoded for a retry', () {
      expect(RegExp(r'UPDATE\s+batches\b', caseSensitive: false).hasMatch(code), isFalse);
      expect(RegExp(r'REPLACE\s+INTO\s+batches', caseSensitive: false).hasMatch(code), isFalse);
      expect(RegExp(r'jsonEncode\s*\(\s*\w*[bB]atch\w*').hasMatch(code), isFalse, reason: 'send OutboxBatch.bodyJson as stored');
    });

    test('B.1 replace: BEGIN IMMEDIATE ... COMMIT with ROLLBACK on failure, and DELETE FROM of every cache table', () {
      expect(code, contains('BEGIN IMMEDIATE'));
      expect(code, contains('COMMIT'));
      expect(code, contains('ROLLBACK'));
      for (final t in ['meta', 'routes', 'visits', 'visit_specimens', 'reasons', 'payment_methods', 'handover_centres']) {
        expect(RegExp('DELETE\\s+FROM\\s+$t\\b', caseSensitive: false).hasMatch(code), isTrue, reason: 'DELETE FROM $t');
      }
    });

    test('backoff ladder 5 s, 15 s, 45 s, 2 min, 5 min is in the code (TRD §7.2) and 401 is handled via the session, not by editing the request', () {
      expect(RegExp(r'seconds\s*:\s*5\b').hasMatch(code), isTrue);
      expect(RegExp(r'seconds\s*:\s*15\b').hasMatch(code), isTrue);
      expect(RegExp(r'seconds\s*:\s*45\b').hasMatch(code), isTrue);
      expect(RegExp(r'minutes\s*:\s*2\b|seconds\s*:\s*120\b').hasMatch(code), isTrue);
      expect(RegExp(r'minutes\s*:\s*5\b|seconds\s*:\s*300\b').hasMatch(code), isTrue);
      expect(code, contains('refreshNow'));
      expect(code, contains('ensureFresh'));
    });
  });
}
