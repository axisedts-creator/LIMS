// HC-T25 pull + ack side — plan row HC-T25 done_when "snapshot atomic replace"; PRD US-06-1 (snapshot content on the device),
// US-06-2 (unchanged = balances only), US-06-3 (cancelled stub), US-06-8 (specimens_stale); TRD §6.2, §6.4, 03-APP-FLOW E4;
// 05-SCHEMA B.1 replace algorithm ("BEGIN IMMEDIATE; DELETE FROM every table; insert snapshot; COMMIT; never partially applied";
// unchanged pulls update only visits.balance_* and meta.server_time_at_pull).
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/core/sync/sync_engine.dart';

import 'support/outbox_fixture.dart';
import 'support/sync_fixture.dart';
import 'support/tls_fixture.dart';

void main() {
  late TestPki pki;
  late SyncFx fx;

  setUpAll(() async => pki = await TestPki.create());
  tearDownAll(() => pki.dispose());
  setUp(() async => fx = await SyncFx.create(pki));
  tearDown(() => fx.dispose());

  Future<Map<String, String>> meta() async => {
        for (final r in await fx.cache.select('SELECT key, value FROM meta')) r['key']! as String: r['value']! as String,
      };
  Future<Map<String, Object?>> visit(String id) async => (await fx.cache.select('SELECT * FROM visits WHERE visit_id = ?', [id])).single;
  Future<int> count(String table) async => (await fx.cache.select('SELECT count(*) AS n FROM $table')).single['n']! as int;

  group('first pull, no cursor (US-06-1)', () {
    setUp(() {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42), visitJson(visitB, 2, 43, due: 90000)]);
    });

    test('request: GET /sync/snapshot?device_id=<id> and NO cursor parameter', () async {
      expect((await fx.sync()).status, SyncStatus.ok);
      final q = fx.server.pulls.single.uri.queryParameters;
      expect(q['device_id'], deviceId);
      expect(q.containsKey('cursor'), isFalse);
    });

    test('cache.db holds exactly the 2 visits with patient, address, note, balance, window, order', () async {
      await fx.sync();
      expect(await count('visits'), 2);
      final a = await visit(visitA);
      expect(a['version'], 3);
      expect(a['route_id'], routeId);
      expect(a['route_sequence'], 1);
      expect(a['status'], 'assigned');
      expect(a['kind'], 'booking');
      expect(a['window_start'], '2026-11-06T01:15:00.000Z');
      expect(a['window_end'], '2026-11-06T01:45:00.000Z');
      expect(a['order_id'], orderId);
      expect(a['patient_full_name'], 'Test Patient 0042');
      expect(a['patient_phone_e164'], '+9779800000042');
      expect(a['address_text'], 'House 42, Synthetic Tole, Ward 4');
      expect(a['landmark'], 'Near the blue gate 42');
      expect(a['note_for_phlebotomist'], 'Fasting sample 42');
      expect(a['balance_due_paisa'], 180000);
      expect(a['balance_as_of'], '2026-11-06T00:30:00.000Z');
      expect(a['patient_unavailable'], 0);
      expect(a['specimens_stale'], 0);
      expect((await visit(visitB))['balance_due_paisa'], 90000);
    });

    test('expected specimens stored with barcode, type, container, status', () async {
      await fx.sync();
      final s = await fx.cache.select('SELECT * FROM visit_specimens WHERE visit_id = ?', [visitA]);
      expect(s, hasLength(1));
      expect(s.single['specimen_id'], specimenJson(42)['specimen_id']);
      expect(s.single['barcode'], 'E2600000042');
      expect(s.single['specimen_type_code'], 'EDTA_WB');
      expect(s.single['container_code'], 'LAV_3ML');
      expect(s.single['status'], 'ordered');
    });

    test('meta: snapshot_cursor, route_date, server_time_at_pull, pulled_at_device, config_json verbatim, schema_version', () async {
      fx.ofx.wall.now = DateTime.utc(2026, 11, 6, 0, 45, 7, 250);
      await fx.sync();
      final m = await meta();
      expect(m['snapshot_cursor'], 'cursor-1');
      expect(m['route_date'], '2026-11-06');
      expect(m['server_time_at_pull'], '2026-11-06T00:31:00.000Z'); // the answer's own server_time (first server answer = 00:31)
      expect(m['pulled_at_device'], '2026-11-06T00:45:07.250Z');
      expect(jsonDecode(m['config_json']!), configJson);
      expect(m.containsKey('schema_version'), isTrue);
    });

    test('routes, reasons, payment methods and handover centres come from the snapshot', () async {
      await fx.sync();
      expect(await fx.cache.select('SELECT route_id, centre_id, version FROM routes'), [
        {'route_id': routeId, 'centre_id': centreId, 'version': 4},
      ]);
      expect(
          [for (final r in await fx.cache.select('SELECT set_code, code FROM reasons ORDER BY 1, 2')) '${r['set_code']}/${r['code']}'],
          ['specimen_not_collected_reasons/unable_to_draw', 'visit_fail_reasons/patient_not_home']);
      expect(await fx.cache.select('SELECT code, requires_reference FROM payment_methods ORDER BY code'), [
        {'code': 'cash', 'requires_reference': 0},
        {'code': 'fonepay_qr', 'requires_reference': 1},
      ]);
      expect(await count('handover_centres'), 1);
    });

    test('cancelled stub (US-06-3) and stale / unavailable flags (US-06-8) are stored without inventing patient data', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [
        visitJson(visitA, 1, 42, stale: true),
        stubJson(visitB, 2),
        visitJson(visitC, 3, 44, patientUnavailable: true),
      ]);
      await fx.sync();
      final a = await visit(visitA);
      expect(a['specimens_stale'], 1);
      expect(await fx.cache.select('SELECT 1 FROM visit_specimens WHERE visit_id = ?', [visitA]), isEmpty, reason: 'specimens: []');
      final stub = await visit(visitB);
      expect(stub['status'], 'cancelled');
      expect(stub['route_sequence'], 2);
      for (final c in ['patient_full_name', 'patient_phone_e164', 'address_text', 'landmark', 'note_for_phlebotomist', 'order_id', 'balance_due_paisa']) {
        expect(stub[c], isNull, reason: 'stub has no $c');
      }
      final c = await visit(visitC);
      expect(c['patient_unavailable'], 1);
      expect(c['patient_full_name'], isNull);
    });
  });

  group('second pull', () {
    test('sends the stored cursor; unchanged:true touches ONLY balances and server_time_at_pull (US-06-2)', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42), visitJson(visitB, 2, 43)]);
      await fx.sync();
      final before = await dumpCache(fx.cache);

      fx.server.unchangedBalances = [
        {
          'visit_id': visitA,
          'balance_due': {'amount_paisa': 55000, 'currency': 'NPR'},
          'as_of': '2026-11-06T00:50:00.000Z',
        },
      ];
      expect((await fx.sync()).status, SyncStatus.ok);
      expect(fx.server.pulls[1].uri.queryParameters['cursor'], 'cursor-1');

      final after = await dumpCache(fx.cache);
      final a = await visit(visitA);
      expect(a['balance_due_paisa'], 55000);
      expect(a['balance_as_of'], '2026-11-06T00:50:00.000Z');
      expect((await meta())['server_time_at_pull'], '2026-11-06T00:32:00.000Z'); // the 2nd pull is the server's 2nd answer
      final strip = (Map<String, Object?> r) => {...r}..remove('balance_due_paisa')..remove('balance_as_of');
      expect([for (final r in after['visits']!) strip(r)], [for (final r in before['visits']!) strip(r)]);
      for (final t in ['routes', 'visit_specimens', 'reasons', 'payment_methods', 'handover_centres']) {
        expect(after[t], before[t], reason: '$t untouched by an unchanged pull');
      }
      expect((await visit(visitB))['balance_due_paisa'], 180000, reason: 'a visit without a balance item keeps its old balance');
      expect((await meta())['snapshot_cursor'], 'cursor-1');
    });

    test('a changed snapshot replaces EVERYTHING: dropped visit and its tubes gone, new visit present, new cursor stored', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42), visitJson(visitB, 2, 43)]);
      await fx.sync();
      fx.server.snapshot = snapshotDto('cursor-2', [visitJson(visitA, 1, 42, due: 1000), visitJson(visitC, 2, 44)], routeVersion: 5);
      await fx.sync();

      expect(fx.server.pulls[1].uri.queryParameters['cursor'], 'cursor-1');
      expect([for (final r in await fx.cache.select('SELECT visit_id FROM visits ORDER BY route_sequence')) r['visit_id']], [visitA, visitC]);
      expect([for (final r in await fx.cache.select('SELECT barcode FROM visit_specimens ORDER BY barcode')) r['barcode']], ['E2600000042', 'E2600000044']);
      expect((await visit(visitA))['balance_due_paisa'], 1000);
      expect((await fx.cache.select('SELECT version FROM routes')).single['version'], 5);
      expect((await meta())['snapshot_cursor'], 'cursor-2');
    });
  });

  group('E4 / done_when: snapshot replace is atomic', () {
    test('a snapshot that fails halfway leaves the OLD cache byte-for-byte, no ack, not ok, and the next pull still sends the OLD cursor', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42), visitJson(visitB, 2, 43)]);
      await fx.sync();
      final before = await dumpCache(fx.cache);
      final acksBefore = fx.server.acks.length;

      final bad = specimenJson(45)..['barcode'] = 'E260000000000000000045'; // 22 chars: violates CHECK (length BETWEEN 1 AND 20), mid-insert
      fx.server.snapshot = snapshotDto('cursor-2', [
        visitJson(visitA, 1, 42, due: 1),
        visitJson(visitC, 2, 44),
        visitJson('01a1a98a-ac40-7000-8000-000000130004', 3, 45, specimens: [bad]),
      ]);
      final r = await fx.sync();
      expect(r.status, isNot(SyncStatus.ok));
      expect(r.acked, isFalse);
      expect(fx.server.acks, hasLength(acksBefore), reason: 'never ack a cursor that was not stored');
      expect(await dumpCache(fx.cache), before);

      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42), visitJson(visitB, 2, 43)]);
      await fx.sync();
      expect(fx.server.pulls.last.uri.queryParameters['cursor'], 'cursor-1');
    });

    test('a snapshot that breaks a foreign key (visit on an unknown route) is rejected whole, nothing half-written', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42)]);
      await fx.sync();
      final before = await dumpCache(fx.cache);
      final orphan = visitJson(visitB, 2, 43)..['route_id'] = '01a1a98a-ac40-7000-8000-00000017ffff'; // unknown route -> FK violation
      fx.server.snapshot = snapshotDto('cursor-2', [visitJson(visitC, 1, 44), orphan]);
      expect((await fx.sync()).status, isNot(SyncStatus.ok));
      expect(await dumpCache(fx.cache), before);
    });

    test('a mutation captured while the pull is in flight survives the replace and is not acked (S-5 "a pull never discards pending mutations")', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42)]);
      await fx.sync();
      fx.server.snapshot = snapshotDto('cursor-2', []); // everything for today is gone
      fx.server.faults['pull']!.add(const Fault.delay(Duration(milliseconds: 400)));
      final running = fx.sync();
      await Future<void>.delayed(const Duration(milliseconds: 150)); // push stage is over (nothing pending), the pull is waiting
      await enqueueType(fx.ofx, 'visit.arrived');
      final r = await running;
      expect(r.status, SyncStatus.ok);
      expect(await count('visits'), 0);
      expect(await fx.states(), ['pending']);
      expect(fx.server.acks.last['max_device_seq_acked'], 0, reason: 'seq 1 has no server outcome yet');

      expect((await fx.sync()).status, SyncStatus.ok);
      expect(await fx.states(), ['applied']);
    });
  });

  group('ack (A4, TRD §6.4)', () {
    test('after the cache is replaced: {device_id, cursor, applied_at_device, max_device_seq_acked}, no wipe_completed; recorded in device_state', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42)]);
      await enqueueVisitFlow(fx.ofx);
      fx.ofx.wall.now = DateTime.utc(2026, 11, 6, 0, 46, 0, 5);
      final r = await fx.sync();
      expect(r.status, SyncStatus.ok);
      expect(r.pulled, isTrue);
      expect(r.acked, isTrue);

      final ack = fx.server.acks.single;
      expect(ack['device_id'], deviceId);
      expect(ack['cursor'], 'cursor-1');
      expect(ack['max_device_seq_acked'], 7);
      expect(ack['applied_at_device'], matches(isoUtcMs));
      expect(ack.containsKey('wipe_completed'), isFalse);
      expect(ack.keys.toSet(), {'device_id', 'cursor', 'applied_at_device', 'max_device_seq_acked'});

      final ds = {for (final x in await fx.ofx.rows('SELECT key, value FROM device_state')) x['key']! as String: x['value']! as String};
      expect(ds['last_ack_cursor'], 'cursor-1');
      expect(ds['last_successful_push_at'], isNotNull);
      expect(ds['last_successful_pull_at'], isNotNull);
    });

    test('nothing ever pushed: max_device_seq_acked is 0 (int >= 0), not absent', () async {
      await fx.sync();
      expect(fx.server.acks.single['max_device_seq_acked'], 0);
    });

    test('an unchanged pull is acked too, with the (unchanged) cursor', () async {
      fx.server.snapshot = snapshotDto('cursor-1', []);
      await fx.sync();
      await fx.sync();
      expect([for (final a in fx.server.acks) a['cursor']], ['cursor-1', 'cursor-1']);
    });

    test('ack failure (503): retryLater 5 s, cache already replaced, next cycle = pull + ack only, nothing pushed twice', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42)]);
      await enqueueType(fx.ofx, 'visit.arrived');
      fx.server.faults['ack']!.add(Fault.status(503, LimsErrorCodes.commonDependencyUnavailable));
      final r1 = await fx.sync();
      expect(r1.status, SyncStatus.retryLater);
      expect(r1.retryAfter, const Duration(seconds: 5));
      expect(await count('visits'), 1, reason: 'the replace is not undone by a failed ack');
      expect((await fx.ofx.rows("SELECT value FROM device_state WHERE key = 'last_ack_cursor'")), isEmpty);

      final r2 = await fx.sync();
      expect(r2.status, SyncStatus.ok);
      expect(fx.server.routes, ['push', 'pull', 'ack', 'pull', 'ack']);
      expect(fx.server.pulls[1].uri.queryParameters['cursor'], 'cursor-1');
      expect(fx.server.acks.last['max_device_seq_acked'], 1);
    });

    test('pull failure (503) after a good push: retryLater, the push is not repeated next cycle', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      fx.server.faults['pull']!.add(Fault.status(503, LimsErrorCodes.commonDependencyUnavailable));
      final r1 = await fx.sync();
      expect(r1.status, SyncStatus.retryLater);
      expect(r1.batchesPushed, 1);
      expect(await fx.states(), ['applied']);
      expect((await fx.sync()).status, SyncStatus.ok);
      expect(fx.server.pushes, hasLength(1));
      expect(fx.server.routes, ['push', 'pull', 'pull', 'ack']);
    });

    test('dropped pull response (transport error) is retryable and leaves the cache as it was', () async {
      fx.server.snapshot = snapshotDto('cursor-1', [visitJson(visitA, 1, 42)]);
      await fx.sync();
      final before = await dumpCache(fx.cache);
      fx.server.snapshot = snapshotDto('cursor-2', [visitJson(visitC, 1, 44)]);
      fx.server.faults['pull']!.add(const Fault.dropAfterApply());
      expect((await fx.sync()).status, SyncStatus.retryLater);
      expect(await dumpCache(fx.cache), before);
    });
  });
}
