// PHLEBO-UI-FULL-1: the app shell. It owns the two encrypted stores, the session and the sync loop, and is the only place
// screens' callbacks reach the network or the database.
// Sync triggers (TRD §7.2): unlock/resume, every sync_interval_seconds in the foreground, 2 s after a new mutation,
// manual refresh; nothing runs in the background. ponytail: ChangeNotifier, not Riverpod (see the CR note); one screen
// tree listening to one object is enough here.
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:lims_shared/lims_shared.dart';

import '../core/db/cache_db.dart';
import '../core/db/cache_schema.dart';
import '../core/db/keys.dart';
import '../core/db/outbox_db.dart';
import '../core/db/wipe.dart';
import '../core/net/api_factory.dart';
import '../core/platform/boot_id.dart';
import '../core/platform/monotonic_clock.dart';
import '../core/platform/phone.dart';
import '../core/session/session.dart';
import '../core/sync/clock_anchor.dart';
import '../core/sync/purge_triggers.dart';
import '../core/sync/sync_engine.dart';
import '../features/apply/domain/application.dart';
import '../features/outbox/data/outbox_repository.dart';
import '../features/outbox/data/outbox_schema.dart';
import '../features/outbox/domain/outbox_row.dart';
import '../features/outbox/domain/sync_summary.dart';
import '../features/route/data/day_reader.dart';
import '../features/settings/domain/sign_out.dart';
import '../features/visit/data/mutation_sink.dart';

enum AppPhase { booting, signedOut, locked, sessionEnded, noScreenLock, updateRequired, blocked, wiped, ready, misconfigured }

const lockAfter = Duration(seconds: 300); // TRD §7.4 step 4
const maxUnlockAttempts = 5;

const otherUserText =
    'This phone has unsent changes from another user. Ask that user to sign in, or the lab admin to wipe it.';
const offlineSignInText = 'You need an internet connection to sign in.';
const badLoginText = 'Mobile number or password is incorrect.';
const _tlsText = 'The secure connection to the server failed. Your records stay on this phone.';

/// Builds the pinned client for a path prefix of the configured API host.
typedef ApiBuilder = ApiClient Function(String prefix, String deviceId, String? Function() token);

class AppController extends ChangeNotifier implements MutationSink {
  AppController({
    required this.phone,
    required this.keyStore,
    required this.apiBuilder,
    required this.clock,
    required this.bootId,
    required this.appVersion,
    DateTime Function()? wallNow,
    String Function()? newId,
    this.mutationDebounce = const Duration(seconds: 2),
  })  : wallNow = wallNow ?? DateTime.now,
        newId = newId ?? uuidv7;

  final Phone phone;
  final SecureKeyStore keyStore;
  final ApiBuilder apiBuilder;
  final MonotonicClock clock;
  final BootIdSource bootId;
  final String appVersion;
  final DateTime Function() wallNow;
  final String Function() newId;
  final Duration mutationDebounce;

  AppPhase phase = AppPhase.booting;
  DayData day = const DayData();
  List<OutboxRow> outboxRows = const [];
  SyncSummary sync = const SyncSummary(waiting: 0);
  bool offline = false;
  bool syncing = false;

  /// The offline limit or a new day cleared the list (US-13-3); cleared again by the next successful download.
  bool purged = false;
  bool wipePending = false;
  String? syncMessage;

  /// Live sharing (PHLEBO-UI-FULL-1): the visit the phlebotomist is on the way to, and what the last attempt to share did.
  /// 'live' | 'no_position' | 'offline'. Online only and only while the app is open; never queued.
  String? travellingVisitId;
  String travelStatus = 'live';
  DateTime? lastSharedAt;
  Timer? _travel;

  /// The application form is open over the sign-in screen.
  bool applying = false;

  /// Set by the entry point: the phone's file picker and the call that sends an application.
  Future<PickedFile?> Function(DocKind kind)? pickApplicationFile;
  Future<String?> Function(ApplicationDraft draft)? sendApplication;

  void setApplying(bool open) {
    applying = open;
    _notify();
  }

  /// Shown once on the sign-in screen (for example after the session ended).
  String? signInNotice;
  int unlockAttemptsLeft = maxUnlockAttempts;

  String deviceId = '';
  late Directory _dir;
  late DbWipe _wipe;
  CacheDb? _cache;
  OutboxDb? _outboxDb;
  OutboxRepository? _outbox;
  SyncEngine? _engine;
  PurgeTriggers? _purge;
  ApiClient? _api;
  SessionManager? _session;

  Timer? _interval;
  Timer? _soon;
  Future<void>? _running;
  Future<int>? _pausedAt;
  bool _closing = false;
  bool _foreground = true;
  bool _disposed = false;

  String get userName => _session?.displayName ?? '';
  Future<bool> get hasSession async => await _session?.hasStoredSession ?? false;

  void _set(AppPhase p) {
    phase = p;
    if (p != AppPhase.ready) _stopTimers();
    if (p != AppPhase.ready && p != AppPhase.locked) _dropTravel();
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  // ---------------------------------------------------------------------------------------------------------- start up

  Future<void> start() async {
    try {
      _dir = await phone.dataDirectory();
      _wipe = DbWipe(dir: _dir, keys: DbKeys(keyStore));
      var id = await keyStore.read(deviceIdKey);
      if (id == null) {
        id = newId(); // before the first login: it is also the C2 app_instance_id (TRD §7.4 step 1)
        await keyStore.write(deviceIdKey, id);
      }
      deviceId = id;
      await _openStores();
      await _session!.restore();
      if (await _session!.hasStoredSession) {
        unlockAttemptsLeft = maxUnlockAttempts;
        _set(AppPhase.locked);
      } else {
        await _session!.forget(); // also drops a half-finished sign-in
        _set(AppPhase.signedOut);
      }
    } catch (_) {
      _set(AppPhase.misconfigured);
    }
  }

  Future<void> _openStores() async {
    final keys = DbKeys(keyStore);
    final outboxDb = _outboxDb ??= await OutboxDb.open(dir: _dir, keys: keys);
    await OutboxSchema.ensure(outboxDb);
    await _openCache();

    final anchors = ClockAnchorStore(db: outboxDb, clock: clock, bootId: bootId, wallNow: wallNow, newId: newId);
    _outbox = OutboxRepository(
        db: outboxDb, anchors: anchors, clock: clock, bootId: bootId, wallNow: wallNow, newId: newId, deviceId: deviceId);
    _api?.close();
    _api = apiBuilder('/v1/homecollection', deviceId, () => _session?.accessToken);
    final session = _session ??=
        SessionManager(identityApi: apiBuilder('', deviceId, () => null), store: keyStore, wallNow: wallNow);
    _purge = PurgeTriggers(wipe: _wipe, cache: _cache!, outboxDb: outboxDb, wallNow: wallNow, localNow: () => wallNow().toLocal());
    _engine = SyncEngine(
      api: _api!,
      deviceId: deviceId,
      outbox: _outbox!,
      outboxDb: outboxDb,
      cache: _cache!,
      anchors: anchors,
      session: session,
      wallNow: wallNow,
      purge: _purge,
      onWiped: _afterWipe,
    );
  }

  /// cache.db is disposable: if it cannot be opened or migrated it is destroyed and pulled again (05-SCHEMA B).
  Future<void> _openCache() async {
    final keys = DbKeys(keyStore);
    try {
      _cache = await CacheDb.open(dir: _dir, keys: keys);
      await CacheSchema.ensure(_cache!);
    } catch (_) {
      await _wipe.destroyCache(open: _cache);
      _cache = await CacheDb.open(dir: _dir, keys: keys);
      await CacheSchema.ensure(_cache!);
    }
  }

  Future<void> load() async {
    final cache = _cache, db = _outboxDb, outbox = _outbox;
    if (cache == null || db == null || outbox == null) return;
    // SQLite calls complete without yielding to the event loop, so a read never sees half of a snapshot replace.
    final data = await readDay(cache, db);
    final rows = await outbox.listRows();
    final waiting = await outbox.pendingCount();
    final last = await db.select("SELECT value FROM device_state WHERE key = 'last_successful_push_at'");
    day = data;
    outboxRows = rows;
    sync = SyncSummary(waiting: waiting, lastUpload: last.isEmpty ? null : DateTime.tryParse(last.single['value']! as String)?.toLocal());
    _notify();
  }

  // ---------------------------------------------------------------------------------------------------------- sign in

  /// Null on success (or when a device state page takes over), else the sentence to show on the sign-in form.
  Future<String?> signIn(String email, String password) async {
    final session = _session;
    if (session == null) return "Couldn't sign in. Restart the app and try again.";
    try {
      if (!await phone.hasScreenLock()) {
        _set(AppPhase.noScreenLock);
        return null;
      }
      await session.open(loginId: email, password: password, deviceId: deviceId, platform: (await phone.info()).platform);
      final userId = session.userId;
      if (userId == null) {
        await session.logout();
        return "Couldn't sign in. Try again.";
      }
      final pending = await _outbox!.pendingCount();
      final owner = await keyStore.read(outboxOwnerKey);
      if (pending > 0 && owner != null && owner != userId) {
        await session.logout();
        return otherUserText;
      }
      await keyStore.write(outboxOwnerKey, userId);
      final registered = await _register(pending);
      if (registered != null) return registered;
      if (phase == AppPhase.blocked) return null;
      await session.markReady();
      signInNotice = null;
      offline = false;
      await load();
      _set(AppPhase.ready);
      unawaited(syncNow());
      return null;
    } on ApiTransportException catch (e) {
      return e.isTlsFailure ? _tlsText : offlineSignInText;
    } on LimsException catch (e) {
      if (e.code == LimsErrorCodes.homecollectionAppVersionUnsupported) {
        _set(AppPhase.updateRequired);
        return null;
      }
      return switch (e.code) {
        LimsErrorCodes.authLoginFailed => badLoginText,
        LimsErrorCodes.commonRateLimited => 'Too many attempts. Wait a while, then try again.',
        LimsErrorCodes.authAccountLocked => 'This account is locked. Ask your lab administrator.',
        LimsErrorCodes.authStepUpRequired =>
          'This account needs an extra sign-in step that this app cannot do. Ask your lab administrator.',
        LimsErrorCodes.authForbidden => "This account can't use the phlebotomist app.",
        _ => "Couldn't sign in. Try again.",
      };
    } catch (_) {
      return "Couldn't sign in. Try again.";
    }
  }

  /// A1. Returns an error sentence, or null when the phone is registered.
  Future<String?> _register(int pending) async {
    final info = await phone.info();
    try {
      await _api!.postJson(
        '/devices',
        {
          'device_id': deviceId,
          'platform': info.platform,
          'os_version': info.osVersion,
          'app_version': appVersion,
          if (info.model != null) 'model': info.model,
        },
        idempotencyKey: newId(),
      );
      return null;
    } on LimsException catch (e) {
      await _session!.logout();
      if (e.code != LimsErrorCodes.homecollectionDeviceNotRegistered) rethrow;
      if (pending > 0) {
        _set(AppPhase.blocked);
        return null;
      }
      // The id belongs to someone else and nothing is waiting: start over as a new device (05-SCHEMA B.3).
      await _resetDevice();
      return 'This phone was set up again. Sign in once more.';
    } on ApiTransportException {
      await _session!.logout();
      rethrow;
    }
  }

  /// Destroys both stores and their keys, then starts over with a new device id.
  Future<void> _resetDevice() async {
    await _wipe.destroyAll(cache: _cache, outbox: _outboxDb);
    _cache = null;
    _outboxDb = null;
    await keyStore.delete(deviceIdKey);
    await keyStore.delete(outboxOwnerKey);
    deviceId = newId();
    await keyStore.write(deviceIdKey, deviceId);
    // The session client carries the device id header, so it is rebuilt too.
    _session?.identityApi.close();
    _session = null;
    day = const DayData();
    outboxRows = const [];
    sync = const SyncSummary(waiting: 0);
    purged = false;
    wipePending = false;
    await _openStores();
  }

  /// From the "wiped" and "session ended" pages.
  Future<void> signInAgain() async => _set(AppPhase.signedOut);

  // ---------------------------------------------------------------------------------------------------------- re-auth gate

  Future<void> unlock() async {
    if (phase != AppPhase.locked) return;
    if (!await phone.hasScreenLock()) {
      _set(AppPhase.noScreenLock);
      return;
    }
    if (await phone.unlock()) {
      if (phase != AppPhase.locked) return;
      unlockAttemptsLeft = maxUnlockAttempts;
      try {
        await _running; // a cycle started before the lock must finish before stores can be reopened
        if (await _purge!.purgeIfStale() != null) await _reopenAfterPurge();
        await load();
      } catch (_) {
        _set(AppPhase.misconfigured);
        return;
      }
      _set(AppPhase.ready);
      unawaited(syncNow());
      return;
    }
    unlockAttemptsLeft--;
    if (unlockAttemptsLeft <= 0) {
      await _session!.logout();
      await _sessionEnded();
      _set(AppPhase.sessionEnded);
    } else {
      _notify();
    }
  }

  Future<void> paused() async {
    _foreground = false;
    _stopTimers();
    if (phase != AppPhase.ready) return;
    // The reading is kept as a future so that a quick return still waits for it instead of skipping the lock.
    // -1 (no clock) locks on return.
    _pausedAt = freshMonotonicMs(clock).then((v) => v, onError: (_) => -1);
    await _pausedAt;
  }

  Future<void> resumed() async {
    _foreground = true;
    final pausedAt = _pausedAt;
    _pausedAt = null;
    final since = await pausedAt;
    if (phase != AppPhase.ready) return;
    if (since != null) {
      var away = lockAfter + const Duration(seconds: 1);
      if (since >= 0) away = Duration(milliseconds: await freshMonotonicMs(clock) - since);
      if (away > lockAfter) {
        unlockAttemptsLeft = maxUnlockAttempts;
        _set(AppPhase.locked);
        return;
      }
    }
    await syncNow();
  }

  // ---------------------------------------------------------------------------------------------------------- sync

  /// One cycle at a time; a caller that arrives while one runs waits for it.
  Future<void> syncNow() => _closing ? Future<void>.value() : _running ??= _cycle().whenComplete(() => _running = null);

  Future<void> _cycle({bool afterPurge = false}) async {
    if (phase != AppPhase.ready || _engine == null) return;
    _soon?.cancel();
    syncing = true;
    _notify();
    Duration? retryAfter;
    var again = false;
    try {
      final r = await _engine!.syncNow();
      wipePending = r.wipePending;
      switch (r.status) {
        case SyncStatus.ok:
          offline = false;
          purged = false;
          syncMessage = null;
          await _outbox!.purge();
        case SyncStatus.retryLater:
          offline = r.code == null;
          syncMessage = r.code == null ? null : "Couldn't sync. Your records stay on this phone and will try again.";
          retryAfter = r.retryAfter;
        case SyncStatus.sessionExpired:
          await _sessionEnded();
          signInNotice = 'Your session ended. Sign in again. Unsent changes are kept.';
          _set(AppPhase.signedOut);
        case SyncStatus.tlsFailure:
          syncMessage = _tlsText;
        case SyncStatus.blocked:
          if (r.code == LimsErrorCodes.homecollectionAppVersionUnsupported) {
            _set(AppPhase.updateRequired);
          } else if (r.code == LimsErrorCodes.homecollectionDeviceNotRegistered) {
            _set(AppPhase.blocked);
          } else {
            syncMessage = "Couldn't sync (${r.code}). Tell your lab administrator.";
          }
        case SyncStatus.purged:
          await _reopenAfterPurge();
          again = !afterPurge;
        case SyncStatus.wiped || SyncStatus.busy:
          break;
      }
      if (phase != AppPhase.wiped) await load();
    } catch (_) {
      syncMessage = "Couldn't sync. Your records stay on this phone and will try again.";
    }
    syncing = false;
    _notify();
    if (again) return _cycle(afterPurge: true);
    _schedule(retryAfter);
  }

  void _schedule(Duration? retryAfter) {
    _interval?.cancel();
    if (phase != AppPhase.ready || !_foreground || _disposed) return;
    _interval = Timer(retryAfter ?? day.syncInterval, () => unawaited(syncNow()));
  }

  void _stopTimers() {
    _interval?.cancel();
    _soon?.cancel();
  }

  /// Signing out, a session end or a wipe also ends sharing on this phone.
  void _dropTravel() {
    _travel?.cancel();
    _travel = null;
    travellingVisitId = null;
    lastSharedAt = null;
  }

  Future<void> _reopenAfterPurge() async {
    _cache = null;
    purged = true;
    await _openStores();
  }

  /// US-13-4: the cached patient data goes, the outbox stays for the next sign-in.
  Future<void> _sessionEnded() async {
    try {
      await _purge!.purgeOnSessionEnd();
    } finally {
      await _session!.forget();
      await _reopenAfterPurge();
      day = const DayData();
    }
  }

  /// US-13-5: the engine has destroyed both stores.
  Future<void> _afterWipe() async {
    await _session!.logout();
    _cache = null;
    _outboxDb = null;
    await _resetDevice();
    _set(AppPhase.wiped);
  }

  // ---------------------------------------------------------------------------------------------------------- visit flow

  @override
  Future<SavedMutation> enqueue({
    required String type,
    String? visitId,
    String? visitLabel,
    required Map<String, Object?> payload,
  }) async {
    final saved = await _outbox!.enqueue(type: type, visitId: visitId, visitLabel: visitLabel, payload: payload);
    // The row is committed; a failure to refresh the lists must not report the save as failed.
    try {
      await load();
    } catch (_) {}
    _soon?.cancel();
    if (_foreground && !_disposed) _soon = Timer(mutationDebounce, () => unawaited(syncNow()));
    return saved;
  }

  /// A point is read only when the centre switched capture on (TRD §2, §6.3).
  Future<Map<String, Object?>> readGps() async => day.captureGps ? phone.readGps() : {'status': 'off'};

  // ---------------------------------------------------------------------------------------------------------- live sharing

  static const _shareEvery = Duration(seconds: 15);

  /// "On my way". Null when sharing started, else the sentence to show. The patient then sees "on the way".
  Future<String?> startTravel(String visitId) async {
    try {
      await _session!.ensureFresh();
      await _api!.putJson('/visits/$visitId/tracking', {'state': 'en_route'});
    } on ApiTransportException {
      return "You're offline, so the patient can't be told yet. You can still go and tap I've arrived.";
    } on LimsException catch (e) {
      return e.code == 'homecollection.visit_closed' ? 'This visit has already started or is closed.' : "Couldn't start sharing. Try again.";
    } catch (_) {
      return "Couldn't start sharing. Try again.";
    }
    travellingVisitId = visitId;
    travelStatus = 'no_position';
    lastSharedAt = null;
    _travel?.cancel();
    _travel = Timer.periodic(_shareEvery, (_) => unawaited(_sharePosition()));
    _notify();
    unawaited(_sharePosition());
    return null;
  }

  Future<void> _sharePosition() async {
    final visitId = travellingVisitId;
    if (visitId == null || !_foreground || phase != AppPhase.ready) return;
    final gps = await phone.readPosition();
    if (travellingVisitId != visitId) return;
    var status = 'no_position';
    if (gps['status'] == 'ok') {
      try {
        await _session!.ensureFresh();
        await _api!.putJson('/visits/$visitId/tracking', {
          'state': 'en_route',
          'position': {'latitude': gps['latitude'], 'longitude': gps['longitude'], if (gps['accuracy_m'] != null) 'accuracy_m': gps['accuracy_m']},
        });
        status = 'live';
        lastSharedAt = wallNow();
      } on LimsException catch (e) {
        // The centre closed, cancelled or reassigned the visit: stop quietly.
        if (e.code == 'homecollection.visit_closed' || e.code == 'homecollection.visit_not_assigned') return _endTravel();
        status = 'offline';
      } catch (_) {
        status = 'offline';
      }
    }
    if (travellingVisitId != visitId) return;
    travelStatus = status;
    _notify();
  }

  void _endTravel() {
    _travel?.cancel();
    _travel = null;
    travellingVisitId = null;
    lastSharedAt = null;
    _notify();
  }

  /// Arrived, cannot do the visit, or left the page: sharing stops on the phone at once and the server is told when reachable.
  Future<void> stopTravel(String visitId) async {
    if (travellingVisitId != visitId) return;
    _endTravel();
    try {
      await _session!.ensureFresh();
      await _api!.putJson('/visits/$visitId/tracking', {'state': 'stopped'});
    } catch (_) {
      // offline: the server stops it itself when the arrival or outcome uploads
    }
  }

  // ---------------------------------------------------------------------------------------------------------- sign out

  /// TRD §7.4 step 5. Throws when the server cannot be reached (the settings screen says to connect).
  Future<SignOutResult> signOut() async {
    _closing = true; // no sync may start against a device that is being signed off
    _stopTimers();
    try {
      await _running;
      final result = await _signOff();
      if (result != SignOutResult.done) _schedule(null);
      return result;
    } catch (_) {
      _schedule(null);
      rethrow;
    } finally {
      _closing = false;
    }
  }

  Future<SignOutResult> _signOff() async {
    if (await _outbox!.pendingCount() > 0) return SignOutResult.unsyncedChanges;
    final seq = await _outboxDb!.select("SELECT value FROM device_state WHERE key = 'next_device_seq'");
    final lastSeq = int.parse(seq.single['value']! as String) - 1;
    try {
      await _session!.ensureFresh();
      await _api!.postJson('/devices/$deviceId/sign-off', {'last_device_seq': lastSeq});
    } on LimsException catch (e) {
      if (e.code == LimsErrorCodes.homecollectionUnsyncedChanges) return SignOutResult.unsyncedChanges;
      rethrow;
    }
    await _session!.logout();
    await _resetDevice();
    return SignOutResult.done;
  }

  Future<void> finishSignOut() async => _set(AppPhase.signedOut);

  @override
  Future<void> dispose() async {
    _disposed = true;
    _stopTimers();
    _travel?.cancel();
    _api?.close();
    _session?.identityApi.close();
    super.dispose();
    await _cache?.close();
    await _outboxDb?.close();
  }
}
