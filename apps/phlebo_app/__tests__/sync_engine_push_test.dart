// HC-T25 push side + chaos — plan row HC-T25 done_when "same batch_id and identical body on retry; 422 idempotency_key_reused ->
// new batch_id; ..." ; PRD US-08-2 (same key + byte-identical body, 422 re-form), US-08-10 (401 -> refresh -> same batch, same key);
// TRD §6.1 S-4/S-5, §7.2 (backoff 5 s, 15 s, 45 s, 2 min, 5 min cap; one cycle at a time), 05-SCHEMA B.2 invariant 3.
// Real SQLCipher outbox, real pinned ApiClient over TLS, scripted server (support/sync_fixture.dart documents the ASSUMED engine API).
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/core/sync/sync_engine.dart';

import 'support/outbox_fixture.dart';
import 'support/sync_fixture.dart';
import 'support/tls_fixture.dart';

List<String> _ids(SyncRequest r) => [for (final m in (r.json['mutations'] as List).cast<Map<String, Object?>>()) m['client_mutation_id']! as String];

void main() {
  late TestPki pki;
  late SyncFx fx;

  setUpAll(() async => pki = await TestPki.create());
  tearDownAll(() => pki.dispose());
  setUp(() async => fx = await SyncFx.create(pki));
  tearDown(() => fx.dispose());

  test('happy path: one batch, Idempotency-Key = batch_id, rows terminal, frozen batch row deleted, logout allowed (US-08-1)', () async {
    final saved = await enqueueVisitFlow(fx.ofx);
    final r = await fx.sync();
    expect(r.status, SyncStatus.ok);
    expect(r.batchesPushed, 1);
    expect(r.retryAfter, isNull);

    final p = fx.server.pushes.single;
    final body = p.json;
    expect(p.header('idempotency-key'), body['batch_id']);
    expect(p.header('x-lims-device-id'), deviceId);
    expect(p.header('authorization'), 'Bearer tok-1');
    expect(_ids(p), [for (final s in saved) s.clientMutationId]);
    expect([for (final m in body['mutations'] as List) (m as Map)['device_seq']], [1, 2, 3, 4, 5, 6, 7]);
    expect(await fx.states(), List.filled(7, 'applied'));
    expect(await fx.batchRows(), 0);
    expect(await fx.ofx.repo.canLogout(), isTrue);
  });

  test('S-5: push -> pull -> ack in that order; nothing pending = no push request at all', () async {
    fx.server.snapshot = snapshotDto('c1', [visitJson(visitA, 1, 42)]);
    await enqueueVisitFlow(fx.ofx);
    expect((await fx.sync()).status, SyncStatus.ok);
    expect(fx.server.routes, ['push', 'pull', 'ack']);
    expect((await fx.sync()).status, SyncStatus.ok);
    expect(fx.server.routes.skip(3), ['pull', 'ack']);
  });

  test('server wins: held / applied outcomes are stored as the server said, never resent (US-08-4 shape)', () async {
    fx.server.outcomeOverride['specimen.collected'] = ('held', 'homecollection.mutation_superseded');
    await enqueueVisitFlow(fx.ofx);
    await fx.sync();
    final rows = await fx.ofx.rows('SELECT type, state, outcome_code FROM mutation_log ORDER BY device_seq');
    expect([for (final r in rows) r['state']], ['applied', 'applied', 'applied', 'held', 'held', 'applied', 'applied']);
    expect(rows[3]['outcome_code'], 'homecollection.mutation_superseded');
    await fx.sync();
    expect(fx.server.pushes, hasLength(1), reason: 'terminal rows are never pushed again');
  });

  group('retry = same batch, same key, byte-identical body (done_when; US-08-2; invariant 3)', () {
    final faults = <String, Fault>{
      'response lost after the server applied it': const Fault.dropAfterApply(),
      'connection dropped before the server applied it': const Fault.dropBeforeApply(),
      '503 common.dependency_unavailable (E12)': Fault.status(503, LimsErrorCodes.commonDependencyUnavailable),
      '409 common.idempotency_in_progress (E1)': Fault.status(409, LimsErrorCodes.commonIdempotencyInProgress),
    };
    for (final e in faults.entries) {
      test(e.key, () async {
        await enqueueVisitFlow(fx.ofx);
        fx.server.faults['push']!.add(e.value);

        final r1 = await fx.sync();
        expect(r1.status, SyncStatus.retryLater);
        expect(r1.retryAfter, const Duration(seconds: 5));
        expect(await fx.states(), List.filled(7, 'sending'));
        expect(await fx.batchRows(), 1, reason: 'the frozen body survives a failed attempt');
        expect(fx.server.routes, ['push'], reason: 'no pull/ack on a failed push cycle');

        final r2 = await fx.sync();
        expect(r2.status, SyncStatus.ok);
        final pushes = fx.server.pushes;
        expect(pushes, hasLength(2));
        expect(pushes[1].body, pushes[0].body, reason: 'byte for byte');
        expect(pushes[1].header('idempotency-key'), pushes[0].header('idempotency-key'));
        expect(pushes[0].header('idempotency-key'), pushes[0].json['batch_id']);
        expect(await fx.states(), List.filled(7, 'applied'));
        expect((await fx.ofx.rows('SELECT min(attempts) AS a FROM mutation_log')).single['a'], 2);
        expect(await fx.batchRows(), 0);
        if (e.value.kind == FaultKind.dropAfterApply) {
          expect(fx.server.replays, 1, reason: 'the lost answer is replayed under the same key');
          expect(fx.server.appliedCount, 7, reason: 'applied once');
        }
      });
    }
  });

  test('a mutation captured while a batch is outstanding does not join it: old batch first (same bytes), then a new batch', () async {
    await enqueueType(fx.ofx, 'visit.arrived');
    await enqueueType(fx.ofx, 'visit.identity_checked');
    fx.server.faults['push']!.add(Fault.status(503, LimsErrorCodes.commonDependencyUnavailable));
    await fx.sync();
    final extra = await enqueueType(fx.ofx, 'visit.consent_recorded');

    final r = await fx.sync();
    expect(r.status, SyncStatus.ok);
    expect(r.batchesPushed, 2);
    final p = fx.server.pushes;
    expect(p, hasLength(3));
    expect(p[1].body, p[0].body);
    expect(p[2].json['batch_id'], isNot(p[0].json['batch_id']));
    expect(_ids(p[2]), [extra.clientMutationId]);
    expect(await fx.states(), List.filled(3, 'applied'));
  });

  test('app killed after the batch was frozen: first request after restart re-sends the stored body and key', () async {
    await enqueueType(fx.ofx, 'visit.arrived');
    await enqueueType(fx.ofx, 'visit.identity_checked');
    final frozen = (await fx.ofx.repo.formBatch())!;
    await fx.restart();

    expect((await fx.sync()).status, SyncStatus.ok);
    final first = fx.server.pushes.first;
    expect(first.body, frozen.bodyJson);
    expect(first.header('idempotency-key'), frozen.batchId);
    expect(fx.server.pushes, hasLength(1));
    expect(await fx.states(), ['applied', 'applied']);
  });

  test('backoff 5 s, 15 s, 45 s, 2 min, 5 min, 5 min (cap) over network errors, 5xx and in-progress; reset on success', () async {
    await enqueueType(fx.ofx, 'visit.arrived');
    fx.server.faults['push']!.addAll([
      const Fault.dropBeforeApply(),
      Fault.status(503, LimsErrorCodes.commonDependencyUnavailable),
      const Fault.dropAfterApply(),
      Fault.status(503, LimsErrorCodes.commonDependencyUnavailable),
      Fault.status(409, LimsErrorCodes.commonIdempotencyInProgress),
      Fault.status(503, LimsErrorCodes.commonDependencyUnavailable),
    ]);
    final waits = <Duration?>[];
    for (var i = 0; i < 6; i++) {
      final r = await fx.sync();
      expect(r.status, SyncStatus.retryLater, reason: 'attempt ${i + 1}');
      waits.add(r.retryAfter);
    }
    expect(waits, [5, 15, 45, 120, 300, 300].map((s) => Duration(seconds: s)).toList());

    final ok = await fx.sync();
    expect(ok.status, SyncStatus.ok);
    expect(ok.retryAfter, isNull);
    expect({for (final p in fx.server.pushes) p.body}, hasLength(1), reason: 'all 7 attempts carried the same body');

    await enqueueType(fx.ofx, 'visit.identity_checked');
    fx.server.faults['push']!.add(Fault.status(503, LimsErrorCodes.commonDependencyUnavailable));
    expect((await fx.sync()).retryAfter, const Duration(seconds: 5), reason: 'success reset the ladder');
  });

  test('US-08-10: 401 auth.token_expired -> refresh -> the SAME batch re-sent with the same key; later calls use the new token', () async {
    fx.server.validToken = 'tok-2';
    fx.session.tokenAfterRefresh = 'tok-2';
    fx.server.snapshot = snapshotDto('c1', [visitJson(visitA, 1, 42)]);
    await enqueueVisitFlow(fx.ofx);

    final r = await fx.sync();
    expect(r.status, SyncStatus.ok);
    expect(fx.session.refreshCalls, 1);
    final p = fx.server.pushes;
    expect(p, hasLength(2));
    expect(p[0].header('authorization'), 'Bearer tok-1');
    expect(p[1].header('authorization'), 'Bearer tok-2');
    expect(p[1].body, p[0].body);
    expect(p[1].header('idempotency-key'), p[0].header('idempotency-key'));
    expect(fx.server.pulls.single.header('authorization'), 'Bearer tok-2');
    expect(fx.server.acks, hasLength(1));
    expect(await fx.states(), List.filled(7, 'applied'));
  });

  test('S-4: the session is checked before EVERY api call (push, pull, ack), then the call follows', () async {
    fx.server.snapshot = snapshotDto('c1', [visitJson(visitA, 1, 42)]);
    await enqueueType(fx.ofx, 'visit.arrived');
    await fx.sync();
    final t = fx.trace;
    final calls = [for (var i = 0; i < t.length; i++) if (t[i].startsWith('req:')) i];
    expect(calls, hasLength(3));
    for (final i in calls) {
      expect(i, greaterThan(0));
      expect(t[i - 1], anyOf('ensure', 'refresh'), reason: '${t[i]} must be preceded by a session check');
    }
  });

  test('refresh refused (auth.session_expired): stop, no pull/ack, queue survives, relogin resumes with the same bytes (REQ-ARCH-070)', () async {
    fx.server.validToken = 'tok-2';
    fx.session.refreshThrows = sessionExpired();
    await enqueueVisitFlow(fx.ofx);

    final r = await fx.sync();
    expect(r.status, SyncStatus.sessionExpired);
    expect(r.retryAfter, isNull);
    expect(fx.server.routes, ['push']);
    expect(await fx.states(), List.filled(7, 'sending'));
    expect(await fx.ofx.repo.canLogout(), isFalse);

    fx.session
      ..refreshThrows = null
      ..token = 'tok-2'; // the user logged in again
    expect((await fx.sync()).status, SyncStatus.ok);
    expect(fx.server.pushes.last.body, fx.server.pushes.first.body);
    expect(await fx.states(), List.filled(7, 'applied'));
  });

  test('session check itself refused before any call: zero requests, queue intact', () async {
    fx.session.ensureThrows = sessionExpired();
    await enqueueVisitFlow(fx.ofx);
    final r = await fx.sync();
    expect(r.status, SyncStatus.sessionExpired);
    expect(fx.server.log, isEmpty);
    expect(await fx.states(), isNot(contains('applied')));
    expect((await fx.ofx.rows('SELECT count(*) AS n FROM mutation_log')).single['n'], 7);
  });

  group('422 common.idempotency_key_reused (US-08-2 last sentence, review #3)', () {
    Future<void> check(Future<void> Function() arrange, String expectedState) async {
      final saved = await enqueueVisitFlow(fx.ofx);
      await arrange();
      final before = [for (final r in await fx.ofx.rows('SELECT device_seq, payload_json, captured_wall_time FROM mutation_log ORDER BY device_seq')) r.toString()];

      final r = await fx.sync();
      expect(r.status, SyncStatus.ok, reason: 're-formed and answered inside the same cycle');
      expect(r.retryAfter, isNull);
      final p = fx.server.pushes;
      expect(p, hasLength(2));
      final first = p[0].json;
      final second = p[1].json;
      expect(second['batch_id'], isNot(first['batch_id']), reason: 'new batch_id');
      expect(p[1].header('idempotency-key'), second['batch_id'], reason: 'the key follows the new batch_id');
      expect(_ids(p[1]), [for (final s in saved) s.clientMutationId], reason: 'same mutations, same order');
      expect(_ids(p[1]), _ids(p[0]));
      expect(await fx.states(), List.filled(7, expectedState));
      expect(await fx.batchRows(), 0, reason: 'old and new frozen bodies are gone once terminal');
      final after = [for (final r in await fx.ofx.rows('SELECT device_seq, payload_json, captured_wall_time FROM mutation_log ORDER BY device_seq')) r.toString()];
      expect(after, before, reason: 'device_seq / payload / capture time are never rewritten');
    }

    test('key rejected before anything was applied -> every mutation applied', () async {
      await check(() async => fx.server.faults['push']!.add(Fault.status(422, LimsErrorCodes.commonIdempotencyKeyReused)), 'applied');
    });

    test('mutations had been applied under an older batch -> every mutation duplicate, no second effect', () async {
      await check(() async => fx.server.faults['push']!.add(Fault.applyThenStatus(422, LimsErrorCodes.commonIdempotencyKeyReused)), 'duplicate');
      expect(fx.server.appliedCount, 7, reason: 'applied exactly once');
    });
  });

  test('more than 100 pending: batches of 100 then 1, strictly one in flight, device_seq order kept, all in one cycle (S-5)', () async {
    for (var i = 0; i < 101; i++) {
      await enqueueType(fx.ofx, 'visit.arrived');
    }
    final r = await fx.sync();
    expect(r.status, SyncStatus.ok);
    expect(r.batchesPushed, 2);
    expect(fx.server.batchSizes, [100, 1]);
    expect(fx.server.maxInFlightPush, 1);
    expect([for (final m in fx.server.pushes[1].json['mutations'] as List) (m as Map)['device_seq']], [101]);
    expect(await fx.ofx.repo.canLogout(), isTrue);
  });

  group('not retryable: stop, keep the frozen batch, do not spin (blocked)', () {
    test('push 426 homecollection.app_version_unsupported', () async {
      await enqueueVisitFlow(fx.ofx);
      fx.server.faults['push']!.add(Fault.status(426, LimsErrorCodes.homecollectionAppVersionUnsupported));
      final r = await fx.sync();
      expect(r.status, SyncStatus.blocked);
      expect(r.code, LimsErrorCodes.homecollectionAppVersionUnsupported);
      expect(r.retryAfter, isNull);
      expect(fx.server.routes, ['push']);
      expect(await fx.states(), List.filled(7, 'sending'));
      expect(await fx.batchRows(), 1);
    });

    test('pull 409 homecollection.device_not_registered: the push before it still counted, no ack', () async {
      await enqueueVisitFlow(fx.ofx);
      fx.server.faults['pull']!.add(Fault.status(409, LimsErrorCodes.homecollectionDeviceNotRegistered));
      final r = await fx.sync();
      expect(r.status, SyncStatus.blocked);
      expect(r.code, LimsErrorCodes.homecollectionDeviceNotRegistered);
      expect(fx.server.routes, ['push', 'pull']);
      expect(await fx.states(), List.filled(7, 'applied'));
    });

    test('pull 426 homecollection.app_version_unsupported', () async {
      fx.server.faults['pull']!.add(Fault.status(426, LimsErrorCodes.homecollectionAppVersionUnsupported));
      final r = await fx.sync();
      expect(r.status, SyncStatus.blocked);
      expect(r.code, LimsErrorCodes.homecollectionAppVersionUnsupported);
      expect(fx.server.acks, isEmpty);
    });
  });

  test('REQ-SEC-104: pin mismatch (MITM CA) is not "offline": status tlsFailure, no retry schedule, queue intact', () async {
    final mitm = await SyncFx.create(pki, pinnedCaPems: [pki.caBPem]);
    addTearDown(mitm.dispose);
    await enqueueVisitFlow(mitm.ofx);
    final r = await mitm.sync();
    expect(r.status, SyncStatus.tlsFailure);
    expect(r.retryAfter, isNull);
    expect(mitm.server.log, isEmpty, reason: 'the handshake was refused, no request reached the server');
    expect(await mitm.states(), List.filled(7, 'sending'));
  });

  test('one cycle at a time: a second syncNow while one runs returns busy and sends nothing (TRD §7.2 mutex)', () async {
    await enqueueType(fx.ofx, 'visit.arrived');
    fx.server.faults['push']!.add(const Fault.delay(Duration(milliseconds: 400)));
    final a = fx.engine.syncNow();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    final b = await fx.engine.syncNow();
    final ra = await a;
    expect(b.status, SyncStatus.busy);
    expect(ra.status, SyncStatus.ok);
    expect(fx.server.routes, ['push', 'pull', 'ack']);
  });

  test('TRD §7.5: an anchor is stored for every successful push/pull answer (server_time verbatim); none for failed calls', () async {
    fx.server.snapshot = snapshotDto('c1', [visitJson(visitA, 1, 42)]);
    await enqueueType(fx.ofx, 'visit.arrived');
    fx.server.faults['push']!.add(Fault.status(503, LimsErrorCodes.commonDependencyUnavailable));
    await fx.sync();
    expect((await fx.ofx.rows('SELECT count(*) AS n FROM clock_anchors')).single['n'], 1, reason: 'only the fixture anchor: 503 is not a success');

    await fx.sync(); // push ok (server_time 00:31), pull ok (00:32); the ack has no body, so no anchor
    final anchors = await fx.ofx.rows('SELECT server_time FROM clock_anchors ORDER BY rowid');
    expect(anchors, hasLength(3));
    expect(anchors[1]['server_time'], '2026-11-06T00:31:00.000Z');
    expect(anchors[2]['server_time'], '2026-11-06T00:32:00.000Z');
  });

  test('frozen body is what is sent: the request body decodes to the stored batches.body_json (no re-serialisation)', () async {
    await enqueueVisitFlow(fx.ofx);
    final frozen = (await fx.ofx.repo.formBatch())!;
    await fx.sync();
    expect(utf8.encode(fx.server.pushes.single.body), utf8.encode(frozen.bodyJson));
  });
}
