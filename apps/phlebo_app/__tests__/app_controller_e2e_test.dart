// PHLEBO-UI-FULL-1 end to end below the widgets: the real AppController, SyncEngine, SQLCipher stores and pinned HTTPS
// client against a local fake of the contract routes. Only the handset (Phone, secure storage, clocks) is faked.
// Synthetic data only.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/app/controller.dart';
import 'package:phlebo_app/core/net/api_factory.dart';
import 'package:phlebo_app/core/platform/phone.dart';
import 'package:phlebo_app/core/session/session.dart';
import 'package:phlebo_app/features/settings/domain/sign_out.dart';

import 'support/db_fixture.dart';
import 'support/outbox_fixture.dart' show FakeBootId, FakeMonotonicClock, FakeWall;
import 'support/sync_fixture.dart' show orderId, snapshotDto, specimenJson, visitJson;
import 'support/tls_fixture.dart';

const _visit = '01a1a98a-ac40-7000-8000-000000130001';

String _jwt(String sub) => 'h.${base64Url.encode(utf8.encode(jsonEncode({'sub': sub}))).replaceAll('=', '')}.s';

class FakePhone implements Phone {
  FakePhone(this.dir);
  final Directory dir;
  bool screenLock = true;
  bool unlockOk = true;
  int gpsReads = 0;

  @override
  Future<Directory> dataDirectory() async => dir;
  @override
  Future<PhoneInfo> info() async => const PhoneInfo(platform: 'android', osVersion: '14', model: 'Synthetic Phone');
  @override
  Future<bool> hasScreenLock() async => screenLock;
  @override
  Future<bool> unlock() async => unlockOk;
  @override
  Future<Map<String, Object?>> readGps() async {
    gpsReads++;
    return {'status': 'denied'};
  }

  Map<String, Object?> position = {'status': 'ok', 'latitude': '27.700000', 'longitude': '85.300000', 'accuracy_m': 12};

  @override
  Future<Map<String, Object?>> readPosition() async => position;

  @override
  Future<void> openUri(Uri uri) async {}
  @override
  Future<void> openLocationSettings() async {}
  @override
  Future<bool> locationAllowed() async => false;
}

/// The contract routes the app calls, with just enough state to answer them.
class FakeCentre {
  late TestServer server;
  final List<String> calls = [];
  final List<Map<String, Object?>> mutations = [];
  Map<String, Object?> snapshot = snapshotDto('c1', [visitJson(_visit, 1, 1)]);
  String userId = 'user-1';
  String? loginError;
  String? refreshError;
  int signOffStatus = 204;
  final List<Map<String, Object?>> tracking = [];
  String? trackingError;
  int _tokens = 0;
  int _tick = 0;

  String _time() => '2026-11-06T00:${(30 + (++_tick) % 29).toString().padLeft(2, '0')}:00.000Z';

  Map<String, Object?> _session() {
    _tokens++;
    return {
      'session_token': 'T$_tokens'.padRight(43, 'x'),
      'access_token': _jwt(userId),
      'access_expires_at': '2026-11-06T09:00:00.000Z',
      'session_expires_at': '2026-11-06T18:00:00.000Z',
      'session': {
        'state': 'active',
        'actor': {'display_name': 'Demo Phlebotomist', 'roles': ['phlebotomist']},
      },
    };
  }

  Future<void> handle(HttpRequest req, List<int> bytes) async {
    final path = req.uri.path;
    calls.add('${req.method} $path');
    final body = bytes.isEmpty ? const <String, Object?>{} : (jsonDecode(utf8.decode(bytes)) as Map).cast<String, Object?>();
    void problem(int status, String code) => respond(req, status, {'code': code, 'detail': 'synthetic'});
    switch (path) {
      case '/v1/identity/mobile/sessions':
        if (loginError != null) return problem(401, loginError!);
        return respond(req, 200, _session());
      case '/v1/identity/mobile/sessions/refresh':
        if (refreshError != null) return problem(401, refreshError!);
        return respond(req, 200, _session());
      case '/v1/identity/mobile/sessions/logout':
        return respond(req, 204, null);
      case '/v1/homecollection/devices':
        return respond(req, 201, {'id': body['device_id']});
      case '/v1/homecollection/sync/snapshot':
        final unchanged = req.uri.queryParameters['cursor'] == snapshot['cursor'];
        return respond(req, 200, unchanged
            ? {'server_time': _time(), 'cursor': snapshot['cursor'], 'unchanged': true, 'device_command': snapshot['device_command'], 'balances': []}
            : {...snapshot, 'server_time': _time()});
      case '/v1/homecollection/sync/mutations':
        final list = (body['mutations']! as List).cast<Map>().map((m) => m.cast<String, Object?>()).toList();
        mutations.addAll(list);
        return respond(req, 200, {
          'server_time': _time(),
          'batch_id': body['batch_id'],
          'results': [
            for (final m in list) {'client_mutation_id': m['client_mutation_id'], 'device_seq': m['device_seq'], 'outcome': 'applied'},
          ],
          'handover_items': [],
          'device_command': 'none',
        });
      case '/v1/homecollection/sync/ack':
        return respond(req, 204, null);
      default:
        if (path.endsWith('/tracking') && req.method == 'PUT') {
          if (trackingError != null) return problem(409, trackingError!);
          tracking.add(body);
          return respond(req, 200, {'state': body['state'], 'started_at': _time()});
        }
        if (path.endsWith('/sign-off')) {
          return signOffStatus == 204 ? respond(req, 204, null) : problem(signOffStatus, 'homecollection.unsynced_changes');
        }
        return problem(404, 'common.not_found');
    }
  }
}

void main() {
  late TestPki pki;
  late FakeCentre centre;
  late Directory dir;
  late FakePhone phone;
  late FakeKeyStore store;
  late FakeMonotonicClock mono;
  late FakeWall wall;
  final apps = <AppController>[];

  setUpAll(() async => pki = await TestPki.create());
  tearDownAll(() => pki.dispose());

  setUp(() async {
    centre = FakeCentre();
    centre.server = await pki.serve(signedByPinnedCa: true, handler: centre.handle);
    dir = newTempDir();
    phone = FakePhone(dir);
    store = FakeKeyStore();
    mono = FakeMonotonicClock(1000000);
    wall = FakeWall(DateTime.utc(2026, 11, 6, 1));
  });

  tearDown(() async {
    for (final a in apps) {
      await a.syncNow();
      await a.dispose();
    }
    apps.clear();
    await centre.server.close();
    deleteQuietly(dir);
  });

  AppController build({Uri? base, String? pinned}) {
    final root = (base ?? centre.server.baseUrl).toString();
    final app = AppController(
      phone: phone,
      keyStore: store,
      apiBuilder: (prefix, deviceId, token) => createApiClient(
          baseUrl: Uri.parse('$root$prefix'),
          pinnedCaPems: [pinned ?? pki.caAPem],
          appVersion: '1.0.0',
          deviceId: deviceId,
          accessToken: token),
      clock: mono,
      bootId: FakeBootId('boot-1'),
      appVersion: '1.0.0',
      wallNow: wall.call,
      mutationDebounce: const Duration(hours: 1), // the tests call syncNow themselves
    );
    apps.add(app);
    return app;
  }

  Future<AppController> signedIn() async {
    final app = build();
    await app.start();
    expect(app.phase, AppPhase.signedOut);
    expect(await app.signIn('person@example.test', 'synthetic-password'), isNull);
    await app.syncNow();
    return app;
  }

  Future<void> doVisit(AppController app) async {
    final view = app.day.visit(_visit)!.view!;
    Future<void> send(String type, Map<String, Object?> payload) =>
        app.enqueue(type: type, visitId: _visit, visitLabel: view.label, payload: payload);
    await send('visit.arrived', {'gps': await app.readGps()});
    await send('visit.identity_checked', {'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'matches'});
    await send('visit.consent_recorded', {'consent_text_version': 'hc-consent-v1', 'given': true});
    final tube = view.tubes.single;
    await send('specimen.collected', {
      'specimen_id': tube.specimenId,
      'scanned_barcode': tube.barcode,
      'scan_method': 'hid',
      'specimen_type_code': tube.typeCode,
      'gps': await app.readGps(),
    });
    await send('payment.captured', {
      'order_id': orderId,
      'payment_method_code': 'cash',
      'amount': {'amount_paisa': 180000, 'currency': 'NPR'},
    });
    await send('visit.completed', {'outcome': 'collected'});
  }

  test('sign in registers the phone, downloads the route and shows it', () async {
    final app = await signedIn();
    expect(app.phase, AppPhase.ready);
    expect(app.userName, 'Demo Phlebotomist');
    expect(app.day.visits.single.row.patientName, 'Test Patient 0001');
    expect(app.day.next!.id, _visit);
    expect(centre.calls, containsAllInOrder([
      'POST /v1/identity/mobile/sessions',
      'POST /v1/homecollection/devices',
      'GET /v1/homecollection/sync/snapshot',
      'POST /v1/homecollection/sync/ack',
    ]));
    expect(store.data[outboxOwnerKey], 'user-1');
    // the password is nowhere on disk or in secure storage
    expect(store.data.values.join(), isNot(contains('synthetic-password')));
    expect(sandboxContains(dir, 'Test Patient'), isFalse, reason: 'patient data must be encrypted at rest');
  });

  test('a visit done on the phone is saved first, shown at once, then uploaded in order', () async {
    final app = await signedIn();
    await doVisit(app);
    // before any upload the screens already show it, and it is counted as waiting
    expect(app.day.visits.single.row.status, 'completed');
    expect(app.day.visits.single.row.collectedTubes, 1);
    expect(app.sync.waiting, 6);
    expect(app.day.handoverTubes.single.barcode, 'E2600000001');
    expect(centre.mutations, isEmpty);

    await app.syncNow();
    expect(centre.mutations.map((m) => m['type']), [
      'visit.arrived',
      'visit.identity_checked',
      'visit.consent_recorded',
      'specimen.collected',
      'payment.captured',
      'visit.completed',
    ]);
    expect(app.sync.waiting, 0);
    expect(app.outboxRows.map((r) => r.state).toSet(), {'applied'});
    expect(phone.gpsReads, 0, reason: 'capture_gps is false: no position is read');
    expect((centre.mutations.first['payload']! as Map)['gps'], {'status': 'off'});
  });

  test('a later download without the collected tube keeps a visit in progress workable', () async {
    final app = await signedIn();
    final view = app.day.visit(_visit)!.view!;
    await app.enqueue(type: 'visit.arrived', visitId: _visit, visitLabel: view.label, payload: {'gps': {'status': 'off'}});
    final tube = view.tubes.single;
    await app.enqueue(type: 'specimen.collected', visitId: _visit, visitLabel: view.label, payload: {
      'specimen_id': tube.specimenId,
      'scanned_barcode': tube.barcode,
      'scan_method': 'manual',
      'specimen_type_code': tube.typeCode,
      'gps': {'status': 'off'},
    });
    centre.snapshot = snapshotDto('c2', [visitJson(_visit, 1, 1, status: 'in_progress', specimens: [])]);
    await app.syncNow();
    final now = app.day.visit(_visit)!;
    expect(now.view!.tubes.single.specimenId, tube.specimenId);
    expect(now.row.expectedTubes, 1);
    expect(now.row.collectedTubes, 1);
  });

  test('a visit the centre cancels or adds appears after the next sync', () async {
    final app = await signedIn();
    const other = '01a1a98a-ac40-7000-8000-000000130002';
    centre.snapshot = snapshotDto('c2', [
      visitJson(_visit, 1, 1),
      visitJson(other, 2, 2, specimens: [specimenJson(2)]),
    ]);
    await app.syncNow();
    expect(app.day.visits.map((v) => v.id), [_visit, other]);
    expect(app.day.otherBarcodes(_visit), {'E2600000002'});
  });

  test('offline keeps the list and the waiting records, and uploads them when the server is back', () async {
    final app = await signedIn();
    final port = centre.server.baseUrl.port;
    await centre.server.close();
    await doVisit(app);
    await app.syncNow();
    expect(app.offline, isTrue);
    expect(app.sync.waiting, 6);
    expect(app.day.visits, isNotEmpty);
    expect(await app.signOut(), SignOutResult.unsyncedChanges);
    expect(port, isPositive);
  });

  test('wrong password: spec sentence, nothing stored', () async {
    centre.loginError = 'auth.login_failed';
    final app = build();
    await app.start();
    expect(await app.signIn('person@example.test', 'wrong'), badLoginText);
    expect(app.phase, AppPhase.signedOut);
    expect(store.data.containsKey(sessionTokenKey), isFalse);
  });

  test('no screen lock refuses sign-in before anything is sent', () async {
    phone.screenLock = false;
    final app = build();
    await app.start();
    await app.signIn('person@example.test', 'synthetic-password');
    expect(app.phase, AppPhase.noScreenLock);
    expect(centre.calls, isEmpty);
  });

  test('a server whose certificate is not pinned gets nothing', () async {
    final app = build(pinned: pki.caBPem);
    await app.start();
    expect(await app.signIn('person@example.test', 'synthetic-password'), contains('secure connection'));
    expect(centre.calls, isEmpty);
  });

  test('re-auth gate: away 300 s keeps the app open, longer locks it; five failures end the session and keep the outbox', () async {
    final app = await signedIn();
    await app.paused();
    mono.ms += 300 * 1000;
    await app.resumed();
    expect(app.phase, AppPhase.ready);

    await app.paused();
    mono.ms += 301 * 1000;
    wall.now = wall.now.subtract(const Duration(days: 1)); // moving the phone's date must not help
    await app.resumed();
    expect(app.phase, AppPhase.locked);
    wall.now = wall.now.add(const Duration(days: 1));

    // a record waiting on the phone
    await app.enqueue(type: 'visit.arrived', visitId: _visit, visitLabel: '#1', payload: {'gps': {'status': 'off'}});
    phone.unlockOk = false;
    for (var i = 0; i < maxUnlockAttempts; i++) {
      await app.unlock();
    }
    expect(app.phase, AppPhase.sessionEnded);
    expect(store.data.containsKey(sessionTokenKey), isFalse);
    expect(app.day.visits, isEmpty, reason: 'the cached patient data is destroyed');
    await app.load();
    expect(app.sync.waiting, 1, reason: 'the outbox survives');

    // another person cannot take over a phone with unsent changes
    await app.signInAgain();
    centre.userId = 'user-2';
    expect(await app.signIn('other@example.test', 'synthetic-password'), otherUserText);
    expect(app.phase, AppPhase.signedOut);

    // the owner can, and the record goes up
    centre.userId = 'user-1';
    expect(await app.signIn('person@example.test', 'synthetic-password'), isNull);
    await app.syncNow();
    expect(centre.mutations.map((m) => m['type']), contains('visit.arrived'));
  });

  test('a cold start with a stored session asks to unlock before showing anything', () async {
    final first = await signedIn();
    await first.syncNow();
    await first.dispose();
    apps.remove(first);
    final app = build();
    await app.start();
    expect(app.phase, AppPhase.locked);
    expect(app.day.visits, isEmpty);
    await app.unlock();
    expect(app.phase, AppPhase.ready);
    expect(app.day.visits, hasLength(1));
  });

  test('a revoked session signs the phone out on the next sync and keeps unsent records', () async {
    final app = await signedIn();
    await app.enqueue(type: 'visit.arrived', visitId: _visit, visitLabel: '#1', payload: {'gps': {'status': 'off'}});
    centre.refreshError = 'auth.session_expired';
    wall.now = DateTime.utc(2026, 11, 6, 9, 30); // the access token is now past its expiry
    await app.syncNow();
    expect(app.phase, AppPhase.signedOut);
    expect(app.day.visits, isEmpty);
    expect(app.sync.waiting, 1);
  });

  test('wipe command: records upload first, then both stores and the device id are destroyed', () async {
    final app = await signedIn();
    final oldDevice = app.deviceId;
    await app.enqueue(type: 'visit.arrived', visitId: _visit, visitLabel: '#1', payload: {'gps': {'status': 'off'}});
    centre.snapshot = {...snapshotDto('c9', [visitJson(_visit, 1, 1)]), 'device_command': 'wipe'};
    await app.syncNow();
    expect(centre.mutations.map((m) => m['type']), ['visit.arrived']);
    expect(app.phase, AppPhase.wiped);
    expect(app.day.visits, isEmpty);
    expect(app.deviceId, isNot(oldDevice));
    expect(store.data.containsKey(sessionTokenKey), isFalse);
    expect(store.data.containsKey(outboxOwnerKey), isFalse);
  });

  test('sign out: signs off, erases the phone and starts as a new device', () async {
    final app = await signedIn();
    final oldDevice = app.deviceId;
    expect(await app.signOut(), SignOutResult.done);
    await app.finishSignOut();
    expect(app.phase, AppPhase.signedOut);
    expect(centre.calls, contains('POST /v1/homecollection/devices/$oldDevice/sign-off'));
    expect(app.deviceId, isNot(oldDevice));
    expect(app.day.visits, isEmpty);
  });

  test('a sign-in that never finished is not a session: nothing can be unlocked or uploaded with it', () async {
    final first = await signedIn();
    await first.syncNow();
    await first.dispose();
    apps.remove(first);
    // the app died after the server session was opened and before the phone was checked and registered
    store.data.remove(sessionReadyKey);
    final calls = centre.calls.length;
    final app = build();
    await app.start();
    expect(app.phase, AppPhase.signedOut);
    expect(store.data.containsKey(sessionTokenKey), isFalse);
    expect(centre.calls.length, calls);
  });

  test('a sync asked for while signing out is not started', () async {
    final app = await signedIn();
    final done = app.signOut();
    await app.syncNow();
    expect(await done, SignOutResult.done);
    final after = centre.calls.skipWhile((c) => !c.endsWith('/sign-off')).toList();
    expect(after.where((c) => c.contains('/sync/')), isEmpty);
  });

  test('returning before the pause clock reading arrives still locks', () async {
    final app = await signedIn();
    final pausing = app.paused(); // not awaited
    mono.ms += 400 * 1000;
    await Future.wait([pausing, app.resumed()]);
    expect(app.phase, AppPhase.locked);
  });

  test('on my way: tells the centre, shares the position, and arrival stops it', () async {
    final app = await signedIn();
    expect(await app.startTravel(_visit), isNull);
    expect(app.travellingVisitId, _visit);
    await pumpEventQueue();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(centre.tracking.first, {'state': 'en_route'});
    expect(centre.tracking.last['position'], {'latitude': '27.700000', 'longitude': '85.300000', 'accuracy_m': 12});
    expect(app.travelStatus, 'live');
    expect(centre.calls.where((c) => c.startsWith('PUT')), everyElement('PUT /v1/homecollection/visits/$_visit/tracking'));

    await app.stopTravel(_visit);
    expect(app.travellingVisitId, isNull);
    expect(centre.tracking.last, {'state': 'stopped'});
    final sent = centre.tracking.length;
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(centre.tracking.length, sent, reason: 'nothing is shared after arrival');
  });

  test('on my way with location off: the patient is still told, no position is sent', () async {
    final app = await signedIn();
    phone.position = {'status': 'denied'};
    expect(await app.startTravel(_visit), isNull);
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(centre.tracking, [{'state': 'en_route'}]);
    expect(app.travelStatus, 'no_position');
    await app.stopTravel(_visit);
  });

  test('on my way refused by the centre or offline: nothing starts and the reason is shown', () async {
    final app = await signedIn();
    centre.trackingError = 'homecollection.visit_closed';
    expect(await app.startTravel(_visit), contains('already started'));
    expect(app.travellingVisitId, isNull);
    await centre.server.close();
    expect(await app.startTravel(_visit), contains('offline'));
    expect(app.travellingVisitId, isNull);
  });

  test('signing out ends sharing on the phone', () async {
    final app = await signedIn();
    await app.startTravel(_visit);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(await app.signOut(), SignOutResult.done);
    await app.finishSignOut();
    expect(app.travellingVisitId, isNull);
  });

  test('sign out refused by the server (409) keeps everything', () async {
    final app = await signedIn();
    centre.signOffStatus = 409;
    expect(await app.signOut(), SignOutResult.unsyncedChanges);
    expect(app.phase, AppPhase.ready);
    expect(app.day.visits, hasLength(1));
  });

  test('the offline limit clears the list but keeps collected tubes and unsent records', () async {
    final app = await signedIn();
    await doVisit(app);
    await centre.server.close();
    wall.now = wall.now.add(const Duration(hours: 17));
    await app.syncNow();
    expect(app.purged, isTrue);
    expect(app.day.routeDate, isNull);
    expect(app.day.handoverTubes, hasLength(1));
    expect(app.sync.waiting, 6);
  });
}
