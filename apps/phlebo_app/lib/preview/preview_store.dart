// DEV-FLAVOUR ONLY. In-memory state behind the clickable preview: it makes the whole flow react (statuses, tube counts,
// outbox rows, handover pool, alerts) the way the real shell will once it reads the cache DB and the outbox. It implements
// the same MutationSink seam the real OutboxRepository does, so the flow screens run unchanged.
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../features/alerts/domain/alert_models.dart';
import '../features/handover/domain/handover_models.dart';
import '../features/handover/domain/handover_status.dart';
import '../features/history/domain/history_models.dart';
import '../features/outbox/domain/outbox_row.dart';
import '../features/outbox/domain/sync_summary.dart';
import '../features/profile/ui/location_screen.dart' show LocationPermission;
import '../features/route/domain/route_models.dart';
import '../features/travel/domain/travel_models.dart';
import '../features/visit/data/mutation_sink.dart';
import '../features/visit/domain/visit_models.dart';
import '../features/visit/ui/visit_flow_screen.dart' show LogEntry;
import 'preview_data.dart';

class PreviewStore extends ChangeNotifier implements MutationSink {
  PreviewStore({DateTime Function()? now, this.syncDelay = const Duration(milliseconds: 900)}) : now = now ?? DateTime.now {
    final t = this.now();
    alerts = PreviewData.alerts(t);
    history = PreviewData.history(t);
    lastDownload = DateTime(t.year, t.month, t.day, 6, 45);
    lastUpload = DateTime(t.year, t.month, t.day, 9, 40);
    for (final s in _specs) {
      _status[s.id] = s.status;
      if (s.status == 'completed') _collected[s.id] = s.tubes.length;
      if (s.status == 'completed') {
        for (final tube in s.tubes) {
          _pool.add(HandoverTube(specimenId: tube.specimenId, typeDisplay: tube.typeDisplay, barcode: tube.barcode));
        }
        outbox.add(OutboxRow(clientMutationId: 'seed-${s.n}', type: 'visit.completed', visitLabel: _labelOf(s.n), capturedAt: DateTime(t.year, t.month, t.day, 7 + s.n, 5), state: 'applied', outcomeCode: null));
      }
    }
    outbox.add(OutboxRow(clientMutationId: 'seed-fail', type: 'visit.failed', visitLabel: _labelOf(3), capturedAt: DateTime(t.year, t.month, t.day, 9, 40), state: 'applied', outcomeCode: null));
  }

  final DateTime Function() now;
  final Duration syncDelay;
  final List<PreviewVisitSpec> _specs = PreviewData.visits();

  final Map<String, String> _status = {};
  final Map<String, int> _collected = {};
  final Map<String, TravelState> _travel = {};
  final Map<String, List<LogEntry>> _log = {};
  final List<HandoverTube> _pool = [];
  final Map<String, String> _handoverResults = {};

  final List<OutboxRow> outbox = [];
  late List<PhleboAlert> alerts;
  late List<HistoryDay> history;
  DateTime? lastDownload;
  DateTime? lastUpload;
  HandoverReceipt? lastReceipt;
  final List<Uri> launched = [];

  bool offline = false;
  bool syncing = false;
  bool locked = false;
  bool wipeRequested = false;
  bool updateRequired = false;
  LocationPermission location = LocationPermission.granted;
  int _seq = 0;

  String _labelOf(int n) {
    final s = _specs.firstWhere((x) => x.n == n);
    return '#${s.n} · ${s.start}–${s.end}';
  }

  PreviewVisitSpec? spec(String visitId) => _specs.where((s) => s.id == visitId).firstOrNull;

  List<RouteVisit> get routeVisits => [
        for (final s in _specs)
          s.toRoute(
            liveStatus: _status[s.id] ?? s.status,
            onTheWay: _travel[s.id]?.onTheWay ?? false,
            collectedOverride: _collected[s.id] ?? 0,
          ),
      ];

  VisitView? view(String visitId) => spec(visitId)?.toView();

  TravelState travelOf(String visitId) => _travel[visitId] ?? const TravelState();

  List<LogEntry> logOf(String visitId) => List.of(_log[visitId] ?? const []);

  Set<String> otherBarcodes(String visitId) => {
        for (final s in _specs)
          if (s.id != visitId)
            for (final t in s.tubes) t.barcode,
      };

  List<HandoverTube> get handoverPool => List.unmodifiable(_pool);
  Map<String, String> get handoverResults => Map.unmodifiable(_handoverResults);

  SyncSummary get sync => SyncSummary(waiting: outbox.where((r) => r.state == 'pending').length, lastUpload: lastUpload);
  int get pending => sync.waiting;
  int get unreadAlerts => alerts.where((a) => a.unread).length;

  // --- actions the screens call ---

  void startTravel(String visitId) {
    final s = spec(visitId);
    if (s == null) return;
    _travel[visitId] = TravelState(
      onTheWay: true,
      sharing: location == LocationPermission.granted ? (offline ? LocationSharing.noSignal : LocationSharing.live) : LocationSharing.permissionOff,
      lastShared: '4 s ago',
      etaMin: s.etaMin,
      distanceKm: s.distanceKm,
    );
    notifyListeners();
  }

  void setOffline(bool v) {
    offline = v;
    for (final e in _travel.entries.toList()) {
      if (e.value.onTheWay && location == LocationPermission.granted) _travel[e.key] = e.value.copyWith(sharing: v ? LocationSharing.noSignal : LocationSharing.live);
    }
    notifyListeners();
  }

  void setLocation(LocationPermission p) {
    location = p;
    for (final e in _travel.entries.toList()) {
      if (e.value.onTheWay) {
        _travel[e.key] = e.value.copyWith(sharing: p == LocationPermission.granted ? LocationSharing.live : LocationSharing.permissionOff);
      }
    }
    notifyListeners();
  }

  void setWipeRequested(bool v) {
    wipeRequested = v;
    notifyListeners();
  }

  void setUpdateRequired(bool v) {
    updateRequired = v;
    notifyListeners();
  }

  void setLocked(bool v) {
    locked = v;
    notifyListeners();
  }

  void markAllRead() {
    alerts = [for (final a in alerts) PhleboAlert(id: a.id, kind: a.kind, title: a.title, body: a.body, at: a.at, unread: false, visitId: a.visitId)];
    notifyListeners();
  }

  void markRead(String id) {
    alerts = [for (final a in alerts) a.id == id ? PhleboAlert(id: a.id, kind: a.kind, title: a.title, body: a.body, at: a.at, unread: false, visitId: a.visitId) : a];
    notifyListeners();
  }

  /// Uploads everything waiting (needs a connection). Returns once the (simulated) round trip ends.
  Future<void> syncNow() async {
    if (syncing) return;
    if (offline) throw StateError('offline');
    syncing = true;
    notifyListeners();
    await Future<void>.delayed(syncDelay);
    for (var i = 0; i < outbox.length; i++) {
      final r = outbox[i];
      if (r.state == 'pending') {
        outbox[i] = OutboxRow(clientMutationId: r.clientMutationId, type: r.type, visitLabel: r.visitLabel, capturedAt: r.capturedAt, state: 'applied', outcomeCode: null);
      }
    }
    if (lastReceipt != null && lastReceipt!.status == HandoverStatus.pending) {
      lastReceipt = HandoverReceipt(centreName: lastReceipt!.centreName, handedOverAt: lastReceipt!.handedOverAt, tubes: lastReceipt!.tubes, status: HandoverStatus.confirmed);
    }
    lastUpload = now();
    lastDownload = now();
    syncing = false;
    notifyListeners();
  }

  // --- MutationSink: the same seam the real OutboxRepository fills ---

  @override
  Future<SavedMutation> enqueue({required String type, String? visitId, String? visitLabel, required Map<String, Object?> payload}) async {
    _seq++;
    final id = 'preview-$_seq';
    if (visitId != null) (_log[visitId] ??= []).add((type, payload));
    outbox.insert(0, OutboxRow(clientMutationId: id, type: type, visitLabel: visitLabel, capturedAt: now(), state: offline ? 'pending' : 'applied', outcomeCode: null));
    if (!offline) lastUpload = now();
    switch (type) {
      case 'visit.arrived':
        if (visitId != null && _status[visitId] == 'assigned') _status[visitId] = 'in_progress';
        if (visitId != null) _travel[visitId] = (_travel[visitId] ?? const TravelState()).copyWith(onTheWay: false);
      case 'specimen.collected':
        if (visitId != null) {
          _collected[visitId] = (_collected[visitId] ?? 0) + 1;
          final tube = spec(visitId)?.tubes.where((t) => t.specimenId == payload['specimen_id']).firstOrNull;
          if (tube != null) _pool.add(HandoverTube(specimenId: tube.specimenId, typeDisplay: tube.typeDisplay, barcode: tube.barcode));
        }
      case 'visit.completed':
        if (visitId != null) _status[visitId] = 'completed';
      case 'visit.failed':
        if (visitId != null) _status[visitId] = 'failed';
      case 'handover.recorded':
        final ids = (payload['specimen_ids'] as List?)?.cast<String>() ?? const <String>[];
        final handed = _pool.where((t) => ids.contains(t.specimenId)).toList();
        for (final t in handed) {
          _handoverResults[t.specimenId] = 'included';
        }
        _pool.removeWhere((t) => ids.contains(t.specimenId));
        final centre = PreviewData.centres.where((c) => c.centreId == payload['to_centre_id']).firstOrNull;
        lastReceipt = HandoverReceipt(
          centreName: centre?.name ?? 'Centre',
          handedOverAt: now(),
          tubes: [for (final t in handed) '${t.typeDisplay} · …${t.barcode.substring(t.barcode.length - 4)}'],
          status: HandoverStatus.pending,
        );
    }
    notifyListeners();
    return SavedMutation(clientMutationId: id, deviceSeq: _seq);
  }
}
