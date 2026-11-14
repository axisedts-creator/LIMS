// HC-T25 test support: a scripted HTTPS stand-in for the three app endpoints (A2 pull, A3 push, A4 ack) + real SQLCipher
// outbox.db / cache.db + the real pinned ApiClient. Synthetic data only.
//
// Prism is NOT used: the plan row says "integration_test vs Prism + chaos", but Prism needs the generated OpenAPI file (CR-C17-004,
// C0 build) which is not in the repo. FakeHcServer re-implements the contract rules that matter to the engine (TRD §6.1-6.4):
// Idempotency-Key == batch_id; same key + same body = replay; same key + different body = 422 common.idempotency_key_reused;
// per-mutation dedupe on client_mutation_id; Bearer check -> 401 auth.token_expired.
//
// ASSUMED API (names are mine; the spec only names the file core/sync/sync_engine.dart). The writer must provide, in sync_engine.dart:
//   abstract interface class SyncSession {
//     Future<void> ensureFresh();  // refresh when the access JWT expires in < 60 s (TRD 7.4 step 2); throws LimsException(auth.session_expired) if refused
//     Future<void> refreshNow();   // called after 401 auth.token_expired; throws LimsException(auth.session_expired) if refused
//   }
//   enum SyncStatus { ok, retryLater, sessionExpired, tlsFailure, blocked, busy }
//   class SyncCycleResult { SyncStatus status; Duration? retryAfter; String? code; int batchesPushed; bool pulled; bool acked; }
//   class SyncEngine({ApiClient api, String deviceId, OutboxRepository outbox, OutboxDb outboxDb, CacheDb cache,
//                     ClockAnchorStore anchors, SyncSession session, DateTime Function() wallNow}) {
//     Future<SyncCycleResult> syncNow();   // ONE cycle: [push all pending, batches <= 100] -> pull -> ack. No sleeping, no timers:
//   }                                      // the caller waits `retryAfter` (5 s, 15 s, 45 s, 2 min, 5 min cap; reset on success).
// The ApiClient base URL carries the path prefix /v1/homecollection, so the engine calls '/sync/mutations', '/sync/snapshot', '/sync/ack'.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/core/db/cache_db.dart';
import 'package:phlebo_app/core/net/api_factory.dart';
import 'package:phlebo_app/core/sync/sync_engine.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart';

import 'outbox_fixture.dart';
import 'tls_fixture.dart';

const routeId = '01a1a98a-ac40-7000-8000-000000170001';
const centreId = '01a1a98a-ac40-7000-8000-000000020009';
const visitC = '01a1a98a-ac40-7000-8000-000000130003';
const orderId = '01a1a98a-ac40-7000-8000-000000050002';

// ---------------------------------------------------------------------------------------------------------------- faults

enum FaultKind { status, dropBeforeApply, dropAfterApply, applyThenStatus, delay }

/// One scripted misbehaviour, consumed by the next request of the route it is queued for.
class Fault {
  const Fault._(this.kind, {this.status = 0, this.code = '', this.delay = Duration.zero});
  const Fault.status(int status, String code) : this._(FaultKind.status, status: status, code: code);

  /// The request reaches the server, nothing is applied, the connection dies.
  const Fault.dropBeforeApply() : this._(FaultKind.dropBeforeApply);

  /// The server applies the request (idempotency record stored) and the response is lost.
  const Fault.dropAfterApply() : this._(FaultKind.dropAfterApply);

  /// Mutations are applied (as in a lost earlier batch) but this answer is an error.
  const Fault.applyThenStatus(int status, String code) : this._(FaultKind.applyThenStatus, status: status, code: code);

  /// The answer is correct but late.
  const Fault.delay(Duration d) : this._(FaultKind.delay, delay: d);

  final FaultKind kind;
  final int status;
  final String code;
  final Duration delay;
}

class SyncRequest {
  SyncRequest(this.route, this.method, this.uri, this.headers, this.body);
  final String route; // push | pull | ack | other
  final String method;
  final Uri uri;
  final Map<String, String> headers; // lower-case names
  final String body;
  String? header(String n) => headers[n.toLowerCase()];
  Map<String, Object?> get json => jsonDecode(body) as Map<String, Object?>;
}

// ---------------------------------------------------------------------------------------------------------------- server

class FakeHcServer {
  FakeHcServer._(this._server, this.trace);

  final HttpServer _server;
  final List<String> trace;
  final List<SyncRequest> log = [];
  final List<Object> errors = [];
  final Map<String, List<Fault>> faults = {'push': [], 'pull': [], 'ack': []};

  /// The Bearer token the server accepts (the session fake starts with 'tok-1').
  String validToken = 'tok-1';

  /// Per-type forced outcome for NEW mutations, e.g. {'specimen.collected': ('held', 'homecollection.mutation_superseded')}.
  final Map<String, (String, String?)> outcomeOverride = {};

  /// The snapshot the server currently holds (a full `unchanged: false` DTO with a `cursor`) and the balances it reports when unchanged.
  Map<String, Object?> snapshot = snapshotDto('c0', const []);
  List<Map<String, Object?>> unchangedBalances = [];

  int replays = 0;
  int appliedCount = 0; // mutations answered `applied` (new)
  int inFlightPush = 0;
  int maxInFlightPush = 0;
  final List<int> batchSizes = [];
  final List<Map<String, Object?>> acks = [];

  int _tick = 0;
  final Map<String, ({String body, String response})> _idem = {};
  final Map<String, ({String outcome, String? code})> _seen = {};

  Uri get baseUrl => Uri.parse('https://127.0.0.1:${_server.port}/v1/homecollection');

  /// server_time of the n-th answer: 2026-11-06T00:3n:00.000Z (strictly increasing).
  String nextServerTime() => '2026-11-06T00:${(30 + (++_tick)).toString().padLeft(2, '0')}:00.000Z';

  static Future<FakeHcServer> start(TestPki pki, List<String> trace) async {
    final ctx = SecurityContext(withTrustedRoots: false)
      ..useCertificateChain('${pki.dir.path}/a-srv.pem') // leaf signed by the pinned CA (TestPki naming: <issuer>-srv.pem/.key)
      ..usePrivateKey('${pki.dir.path}/a-srv.key');
    final s = FakeHcServer._(await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx), trace);
    s._server.listen((req) {
      s._handle(req).catchError((Object e) {
        s.errors.add(e);
      });
    }, onError: (_) {
      // refused TLS handshake (pin mismatch test): the client side asserts.
    });
    return s;
  }

  List<SyncRequest> get pushes => [for (final r in log) if (r.route == 'push') r];
  List<SyncRequest> get pulls => [for (final r in log) if (r.route == 'pull') r];
  List<String> get routes => [for (final r in log) r.route];

  Future<void> close() => _server.close(force: true);

  Future<void> _handle(HttpRequest req) async {
    final body = utf8.decode(await req.fold<List<int>>(<int>[], (a, b) => a..addAll(b)));
    final path = req.uri.path;
    final route = path == '/v1/homecollection/sync/mutations'
        ? 'push'
        : path == '/v1/homecollection/sync/snapshot'
            ? 'pull'
            : path == '/v1/homecollection/sync/ack'
                ? 'ack'
                : 'other';
    final headers = <String, String>{};
    req.headers.forEach((n, v) => headers[n.toLowerCase()] = v.join(','));
    final seen = SyncRequest(route, req.method, req.uri, headers, body);
    log.add(seen);
    trace.add('req:$route');
    final isPush = route == 'push';
    if (isPush) {
      inFlightPush++;
      if (inFlightPush > maxInFlightPush) maxInFlightPush = inFlightPush;
    }
    try {
      if (route == 'other') return await _problem(req, 404, 'common.not_found');
      if (headers['authorization'] != 'Bearer $validToken') return await _problem(req, 401, 'auth.token_expired');
      final queue = faults[route]!;
      final f = queue.isEmpty ? null : queue.removeAt(0);
      if (f != null) {
        switch (f.kind) {
          case FaultKind.status:
            return await _problem(req, f.status, f.code);
          case FaultKind.dropBeforeApply:
            return await _drop(req);
          case FaultKind.delay:
            await Future<void>.delayed(f.delay);
          case FaultKind.dropAfterApply:
          case FaultKind.applyThenStatus:
            break;
        }
      }
      switch (route) {
        case 'push':
          final res = _push(seen, applyOnly: f?.kind == FaultKind.applyThenStatus);
          if (f?.kind == FaultKind.dropAfterApply) return await _drop(req);
          if (f?.kind == FaultKind.applyThenStatus) return await _problem(req, f!.status, f.code);
          return await _json(req, res.$1, res.$2);
        case 'pull':
          final cursor = req.uri.queryParameters['cursor'];
          final snap = snapshot;
          if (req.uri.queryParameters['device_id'] != headers['x-lims-device-id']) return await _problem(req, 400, 'common.validation_failed');
          Map<String, Object?> out;
          if (cursor != null && cursor == snap['cursor']) {
            out = {
              'server_time': nextServerTime(),
              'cursor': snap['cursor'],
              'unchanged': true,
              'device_command': snap['device_command'] ?? 'none', // HC-T28: wipe also arrives on an unchanged pull
              'balances': unchangedBalances,
            };
          } else {
            out = {...snap, 'server_time': nextServerTime()};
          }
          if (f?.kind == FaultKind.dropAfterApply) return await _drop(req);
          return await _json(req, 200, out);
        case 'ack':
          acks.add(jsonDecode(body) as Map<String, Object?>);
          if (f?.kind == FaultKind.dropAfterApply) return await _drop(req);
          req.response.statusCode = 204;
          await req.response.close();
      }
    } finally {
      if (isPush) inFlightPush--;
    }
  }

  (int, Map<String, Object?>) _push(SyncRequest r, {required bool applyOnly}) {
    final key = r.header('idempotency-key');
    Map<String, Object?> j;
    try {
      j = r.json;
    } catch (_) {
      return (400, _problemBody('common.validation_failed'));
    }
    final muts = (j['mutations'] as List?)?.cast<Map<String, Object?>>() ?? const [];
    if (key == null || key != j['batch_id'] || j['device_id'] != r.header('x-lims-device-id') || muts.isEmpty) {
      return (400, _problemBody('common.validation_failed'));
    }
    if (muts.length > 100 || utf8.encode(r.body).length > 512 * 1024) return (413, _problemBody('common.payload_too_large'));
    var last = 0;
    for (final m in muts) {
      final s = m['device_seq'] as int;
      if (s <= last) return (400, _problemBody('common.validation_failed'));
      last = s;
    }
    final prev = _idem[key];
    if (prev != null) {
      if (prev.body != r.body) return (422, _problemBody('common.idempotency_key_reused'));
      replays++;
      return (200, jsonDecode(prev.response) as Map<String, Object?>);
    }
    batchSizes.add(muts.length);
    final results = <Map<String, Object?>>[];
    for (final m in muts) {
      final id = m['client_mutation_id']! as String;
      final stored = _seen[id];
      if (stored != null) {
        results.add({'client_mutation_id': id, 'device_seq': m['device_seq'], 'outcome': 'duplicate', if (stored.code != null) 'code': stored.code});
        continue;
      }
      final o = outcomeOverride[m['type']] ?? ('applied', null);
      _seen[id] = (outcome: o.$1, code: o.$2);
      if (o.$1 == 'applied') appliedCount++;
      results.add({'client_mutation_id': id, 'device_seq': m['device_seq'], 'outcome': o.$1, if (o.$2 != null) 'code': o.$2});
    }
    final resp = {
      'server_time': nextServerTime(),
      'batch_id': key,
      'results': results,
      'handover_items': <Object?>[],
      'device_command': 'none',
    };
    if (!applyOnly) _idem[key] = (body: r.body, response: jsonEncode(resp));
    return (200, resp);
  }

  Map<String, Object?> _problemBody(String code) => {'code': code, 'detail': 'synthetic'};

  Future<void> _problem(HttpRequest req, int status, String code) => _json(req, status, _problemBody(code));

  Future<void> _json(HttpRequest req, int status, Map<String, Object?> body) async {
    req.response
      ..statusCode = status
      ..headers.contentType = ContentType.json
      ..write(jsonEncode(body));
    await req.response.close();
  }

  Future<void> _drop(HttpRequest req) async {
    final s = await req.response.detachSocket(writeHeaders: false);
    s.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------------- session

class FakeSession implements SyncSession {
  FakeSession(this.token, this.trace);
  String token;
  final List<String> trace;
  int ensureCalls = 0;
  int refreshCalls = 0;
  String? tokenAfterRefresh;
  Object? ensureThrows;
  Object? refreshThrows;

  @override
  Future<void> ensureFresh() async {
    trace.add('ensure');
    ensureCalls++;
    if (ensureThrows != null) throw ensureThrows!;
  }

  @override
  Future<void> refreshNow() async {
    trace.add('refresh');
    refreshCalls++;
    if (refreshThrows != null) throw refreshThrows!;
    if (tokenAfterRefresh != null) token = tokenAfterRefresh!;
  }
}

LimsException sessionExpired() => LimsException(LimsErrorCodes.authSessionExpired);

// ---------------------------------------------------------------------------------------------------------------- DTO builders

String _n(int n, int w) => n.toString().padLeft(w, '0');

Map<String, Object?> specimenJson(int n) => {
      'specimen_id': '01a1a98a-ac40-7000-8000-0000000900${_n(n, 2)}',
      'barcode': 'E26000${_n(n, 5)}',
      'specimen_type_code': 'EDTA_WB',
      'container_code': 'LAV_3ML',
      'status': 'ordered',
    };

/// A SnapshotVisit (TRD §6.2 / §5.3.1). [n] picks the synthetic patient/specimen numbers.
Map<String, Object?> visitJson(String id, int seq, int n,
        {String status = 'assigned', int due = 180000, List<Map<String, Object?>>? specimens, bool stale = false, bool patientUnavailable = false}) =>
    {
      'visit_id': id,
      'version': 3,
      'route_id': routeId,
      'route_sequence': seq,
      'status': status,
      'kind': 'booking',
      'window_start': '2026-11-06T01:15:00.000Z',
      'window_end': '2026-11-06T01:45:00.000Z',
      'order_id': orderId,
      if (patientUnavailable) 'patient_unavailable': true else 'patient': {'full_name': 'Test Patient ${_n(n, 4)}', 'phone_e164': '+97798000${_n(n, 5)}'},
      'address': {'address_text': 'House $n, Synthetic Tole, Ward 4', 'landmark': 'Near the blue gate $n'},
      'note_for_phlebotomist': 'Fasting sample $n',
      'specimens': stale ? <Object?>[] : (specimens ?? [specimenJson(n)]),
      if (stale) 'specimens_stale': true,
      'balance': {
        'balance_due': {'amount_paisa': due, 'currency': 'NPR'},
        'as_of': '2026-11-06T00:30:00.000Z',
      },
    };

Map<String, Object?> stubJson(String id, int seq) => {
      'visit_id': id,
      'version': 5,
      'route_id': routeId,
      'route_sequence': seq,
      'status': 'cancelled',
      'kind': 'booking',
      'window_start': '2026-11-06T02:15:00.000Z',
      'window_end': '2026-11-06T02:45:00.000Z',
    };

const configJson = <String, Object?>{
  'sync_interval_seconds': 300,
  'offline_purge_hours': 16,
  'capture_gps': false,
  'map_handoff_enabled': true,
  'manual_barcode_entry_allowed': true,
  'second_identifier': 'phone',
  'collection_consent_text_version': 'hc-consent-v1',
  'collection_consent_text': 'I agree to give a blood sample (synthetic text).',
  'payment_methods': [
    {'code': 'cash', 'display': 'Cash', 'requires_reference': false},
    {'code': 'fonepay_qr', 'display': 'Fonepay QR', 'requires_reference': true},
  ],
  'reasons': {
    'visit_fail_reasons': [
      {'code': 'patient_not_home', 'display': 'Patient not at home'},
    ],
    'specimen_not_collected_reasons': [
      {'code': 'unable_to_draw', 'display': 'Unable to draw'},
    ],
  },
  'handover_centres': [
    {'centre_id': '01a1a98a-ac40-7000-8000-000000020002', 'name': 'Synthetic Centre A2'},
  ],
  'min_app_version': '1.0.0',
};

/// A full (unchanged:false) SnapshotDto.
Map<String, Object?> snapshotDto(String cursor, List<Map<String, Object?>> visits, {int routeVersion = 4}) => {
      'server_time': '2026-11-06T00:30:00.000Z',
      'cursor': cursor,
      'unchanged': false,
      'route_date': '2026-11-06',
      'device_command': 'none',
      'config': configJson,
      'routes': [
        {'route_id': routeId, 'centre_id': centreId, 'version': routeVersion},
      ],
      'visits': visits,
      'balances': <Object?>[],
    };

// ---------------------------------------------------------------------------------------------------------------- cache.db

/// 05-SCHEMA B.1 verbatim. The engine only fills/replaces rows; creating the file's schema is the fixture's job here.
const cacheDdl = <String>[
  'CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
  'CREATE TABLE routes (route_id TEXT PRIMARY KEY NOT NULL, centre_id TEXT NOT NULL, version INTEGER NOT NULL)',
  '''CREATE TABLE visits (
  visit_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, route_id TEXT NOT NULL REFERENCES routes(route_id),
  route_sequence INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('assigned','in_progress','completed','failed','cancelled')),
  kind TEXT NOT NULL, window_start TEXT, window_end TEXT, order_id TEXT,
  patient_full_name TEXT, patient_phone_e164 TEXT, patient_birth_on TEXT,
  patient_unavailable INTEGER NOT NULL DEFAULT 0,
  address_text TEXT, landmark TEXT, latitude TEXT, longitude TEXT, note_for_phlebotomist TEXT,
  balance_due_paisa INTEGER, balance_as_of TEXT, balance_unavailable INTEGER NOT NULL DEFAULT 0,
  specimens_stale INTEGER NOT NULL DEFAULT 0
)''',
  '''CREATE TABLE visit_specimens (
  specimen_id TEXT PRIMARY KEY NOT NULL, visit_id TEXT NOT NULL REFERENCES visits(visit_id),
  barcode TEXT NOT NULL CHECK (length(barcode) BETWEEN 1 AND 20),
  specimen_type_code TEXT NOT NULL, container_code TEXT, status TEXT NOT NULL
)''',
  'CREATE INDEX visit_specimens_barcode ON visit_specimens(barcode)',
  '''CREATE TABLE reasons (set_code TEXT NOT NULL, code TEXT NOT NULL, display TEXT NOT NULL, requires_text INTEGER NOT NULL,
                      PRIMARY KEY (set_code, code))''',
  'CREATE TABLE payment_methods (code TEXT PRIMARY KEY NOT NULL, display TEXT NOT NULL, requires_reference INTEGER NOT NULL)',
  'CREATE TABLE handover_centres (centre_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)',
];

const cacheTables = ['meta', 'routes', 'visits', 'visit_specimens', 'reasons', 'payment_methods', 'handover_centres'];

Future<Map<String, List<Map<String, Object?>>>> dumpCache(CacheDb db) async => {
      for (final t in cacheTables) t: await db.select('SELECT * FROM $t ORDER BY 1, 2'),
    };

// ---------------------------------------------------------------------------------------------------------------- fixture

class SyncFx {
  SyncFx._(this.ofx, this.server, this.cache, this.session, this.trace, this.api);

  final OutboxFx ofx;
  final FakeHcServer server;
  final CacheDb cache;
  final FakeSession session;
  final List<String> trace;
  ApiClient api;
  late SyncEngine engine;

  /// [pinnedCaPems] defaults to the CA that signed the server (caA); pass [TestPki.caBPem] for the MITM/pin-mismatch case.
  static Future<SyncFx> create(TestPki pki, {List<String>? pinnedCaPems}) async {
    final ofx = await OutboxFx.create();
    final trace = <String>[];
    final server = await FakeHcServer.start(pki, trace);
    final cacheDir = Directory('${ofx.dir.path}/cache')..createSync();
    final cache = await CacheDb.open(dir: cacheDir, keys: ofx.keys);
    for (final s in cacheDdl) {
      await cache.execute(s);
    }
    final session = FakeSession('tok-1', trace);
    final api = createApiClient(
      baseUrl: server.baseUrl,
      pinnedCaPems: pinnedCaPems ?? [pki.caAPem],
      appVersion: '1.0.0',
      deviceId: deviceId,
      accessToken: () => session.token,
    );
    final fx = SyncFx._(ofx, server, cache, session, trace, api);
    fx._buildEngine();
    return fx;
  }

  void _buildEngine() {
    engine = SyncEngine(
      api: api,
      deviceId: deviceId,
      outbox: ofx.repo,
      outboxDb: ofx.db,
      cache: cache,
      anchors: ofx.anchors,
      session: session,
      wallNow: ofx.wall.call,
    );
  }

  Future<SyncCycleResult> sync() => engine.syncNow();

  /// The app was killed and restarted: outbox.db reopened, new engine (in-memory backoff state is gone), same cache.db.
  Future<void> restart() async {
    await ofx.restart();
    _buildEngine();
  }

  Future<void> dispose() async {
    api.close();
    await server.close();
    try {
      await cache.close();
    } catch (_) {}
    await ofx.dispose();
    if (server.errors.isNotEmpty) throw StateError('fake server threw: ${server.errors.first}');
  }

  Future<List<String>> states() async =>
      [for (final r in await ofx.rows('SELECT state FROM mutation_log ORDER BY device_seq')) r['state']! as String];

  Future<int> batchRows() async => (await ofx.rows('SELECT count(*) AS n FROM batches')).single['n']! as int;
}

/// US-07-1 flow: arrived, identity, consent, 2 tubes, cash payment, completed = 7 mutations (device_seq 1..7).
Future<List<SavedMutation>> enqueueVisitFlow(OutboxFx fx) async => [
      await enqueueType(fx, 'visit.arrived'),
      await enqueueType(fx, 'visit.identity_checked'),
      await enqueueType(fx, 'visit.consent_recorded'),
      await enqueueType(fx, 'specimen.collected', payload: payloadFor('specimen.collected', barcode: 'E2600000042', specimenId: specimen1)),
      await enqueueType(fx, 'specimen.collected', payload: payloadFor('specimen.collected', barcode: 'E2600000043', specimenId: specimen2)),
      await enqueueType(fx, 'payment.captured'),
      await enqueueType(fx, 'visit.completed'),
    ];
