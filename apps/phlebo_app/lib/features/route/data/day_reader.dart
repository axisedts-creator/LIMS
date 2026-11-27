// PHLEBO-UI-FULL-1: what the screens show = cache.db (the centre's last snapshot) overlaid with outbox.db (what this phone
// has recorded since). Nothing derived is stored (TRD §7.3). A change the server rejected is ignored: server wins (S-3).
import 'dart:convert';

import '../../../core/db/cache_db.dart';
import '../../../core/db/outbox_db.dart';
import '../../handover/domain/handover_models.dart';
import '../../outbox/domain/time_labels.dart';
import '../../visit/domain/visit_models.dart';
import '../domain/route_models.dart';

/// (mutation type, payload)
typedef VisitLog = List<(String, Map<String, Object?>)>;

class DayVisit {
  const DayVisit({required this.row, required this.kind, required this.view, required this.log, this.note, this.partial = false});

  final RouteVisit row;

  /// booking | front_desk | recollection | revisit
  final String kind;

  /// Null when the visit cannot be worked on: cancelled, or already closed at the centre (no patient fields are sent).
  final VisitView? view;
  final VisitLog log;
  final String? note;
  final bool partial;

  String get id => row.visitId;
  bool get open => row.status == 'assigned' || row.status == 'in_progress';
  bool get done => row.status == 'completed' || row.status == 'failed';
  bool get started => log.isNotEmpty;
}

class DayData {
  const DayData({
    this.routeDate,
    this.visits = const [],
    this.config,
    this.captureGps = false,
    this.syncInterval = const Duration(seconds: 300),
    this.centres = const [],
    this.handoverTubes = const [],
    this.barcodes = const {},
    this.dataAsOf,
  });

  /// Null = nothing has been downloaded (new install, or the list was cleared).
  final DateTime? routeDate;
  final List<DayVisit> visits;
  final VisitConfig? config;
  final bool captureGps;
  final Duration syncInterval;
  final List<HandoverCentre> centres;
  final List<HandoverTube> handoverTubes;

  /// barcode -> visit id, for the wrong-patient tube check.
  final Map<String, String> barcodes;
  final DateTime? dataAsOf;

  DayVisit? visit(String id) => visits.where((v) => v.id == id).firstOrNull;

  /// The stop to work on now: the one already started, else the first open one in route order.
  DayVisit? get next => visits.where((v) => v.open && v.started).firstOrNull ?? visits.where((v) => v.open).firstOrNull;

  Set<String> otherBarcodes(String visitId) => {for (final e in barcodes.entries) if (e.value != visitId) e.key};
}

String _hm(Object? iso) {
  final d = iso is String ? DateTime.tryParse(iso) : null;
  return d == null ? '--:--' : formatHm(d.toLocal());
}

String? _str(Object? v) => v is String ? v : null;

Future<DayData> readDay(CacheDb cache, OutboxDb outbox) async {
  final meta = {for (final r in await cache.select('SELECT key, value FROM meta')) r['key']! as String: r['value']! as String};
  final mutations = await outbox.select(
      "SELECT type, visit_id, payload_json FROM mutation_log WHERE state <> 'rejected' ORDER BY device_seq");

  final logs = <String, VisitLog>{};
  final collected = <String, (String barcode, String type)>{}; // specimen id -> what was scanned
  final handedOver = <String>{};
  for (final m in mutations) {
    final type = m['type']! as String;
    final payload = (jsonDecode(m['payload_json']! as String) as Map).cast<String, Object?>();
    final visitId = m['visit_id'] as String?;
    if (visitId != null) (logs[visitId] ??= []).add((type, payload));
    if (type == 'specimen.collected') {
      collected[payload['specimen_id']! as String] = (payload['scanned_barcode']! as String, payload['specimen_type_code']! as String);
    } else if (type == 'handover.recorded') {
      handedOver.addAll((payload['specimen_ids']! as List).cast<String>());
    }
  }
  // Collected tubes stay on this list even after the list is cleared: they are physically in the bag.
  final handoverTubes = [
    for (final e in collected.entries)
      if (!handedOver.contains(e.key)) HandoverTube(specimenId: e.key, typeDisplay: e.value.$2, barcode: e.value.$1),
  ];

  final config = meta['config_json'] == null ? null : (jsonDecode(meta['config_json']!) as Map).cast<String, Object?>();
  final routeDate = DateTime.tryParse(meta['route_date'] ?? '');
  final centres = [
    for (final r in await cache.select('SELECT centre_id, name FROM handover_centres ORDER BY name'))
      HandoverCentre(centreId: r['centre_id']! as String, name: r['name']! as String),
  ];
  if (config == null || routeDate == null) return DayData(handoverTubes: handoverTubes, centres: centres);

  final reasons = <String, List<ReasonOption>>{};
  for (final r in await cache.select('SELECT set_code, code, display, requires_text FROM reasons ORDER BY rowid')) {
    (reasons[r['set_code']! as String] ??= [])
        .add(ReasonOption(code: r['code']! as String, display: r['display']! as String, requiresText: r['requires_text'] == 1));
  }
  final visitConfig = VisitConfig(
    mapHandoffEnabled: config['map_handoff_enabled'] == true,
    manualBarcodeEntryAllowed: config['manual_barcode_entry_allowed'] == true,
    consentText: '${config['collection_consent_text']}',
    consentTextVersion: '${config['collection_consent_text_version']}',
    paymentMethods: [
      for (final r in await cache.select('SELECT code, display, requires_reference FROM payment_methods ORDER BY rowid'))
        PaymentMethodOption(code: r['code']! as String, display: r['display']! as String, requiresReference: r['requires_reference'] == 1),
    ],
    visitFailReasons: reasons['visit_fail_reasons'] ?? const [],
    notCollectedReasons: reasons['specimen_not_collected_reasons'] ?? const [],
  );
  final secondIdentifier = config['second_identifier'] == 'birth_date' ? 'birth_date' : 'phone';

  final specimens = <String, List<ExpectedTube>>{};
  final barcodes = <String, String>{};
  for (final r in await cache.select('SELECT * FROM visit_specimens ORDER BY rowid')) {
    final tube = ExpectedTube(
      specimenId: r['specimen_id']! as String,
      typeCode: r['specimen_type_code']! as String,
      typeDisplay: r['specimen_type_code']! as String,
      container: _str(r['container_code']) ?? '',
      barcode: r['barcode']! as String,
    );
    (specimens[r['visit_id']! as String] ??= []).add(tube);
    barcodes[tube.barcode] = r['visit_id']! as String;
  }

  final visits = <DayVisit>[];
  for (final r in await cache.select('SELECT * FROM visits ORDER BY route_sequence, window_start')) {
    final id = r['visit_id']! as String;
    final log = logs[id] ?? const [];
    final types = {for (final e in log) e.$1};
    var status = r['status']! as String;
    if (status != 'cancelled') {
      if (types.contains('visit.failed')) {
        status = 'failed';
      } else if (types.contains('visit.completed')) {
        status = 'completed';
      } else if (types.isNotEmpty && status == 'assigned') {
        status = 'in_progress';
      }
    }

    // A later snapshot lists only tubes still waiting, so tubes this phone already collected are added back.
    final tubes = [...?specimens[id]];
    for (final (type, p) in log) {
      if (type != 'specimen.collected') continue;
      if (tubes.any((t) => t.specimenId == p['specimen_id'])) continue;
      final code = p['specimen_type_code']! as String;
      tubes.add(ExpectedTube(
          specimenId: p['specimen_id']! as String, typeCode: code, typeDisplay: code, container: '', barcode: p['scanned_barcode']! as String));
    }
    final collectedHere = {for (final (type, p) in log) if (type == 'specimen.collected') p['specimen_id']};
    final sequence = r['route_sequence']! as int;
    final name = _str(r['patient_full_name']);
    final open = status == 'assigned' || status == 'in_progress';
    final start = _hm(r['window_start']), end = _hm(r['window_end']);
    final unavailable = r['patient_unavailable'] == 1;

    visits.add(DayVisit(
      kind: r['kind']! as String,
      note: _str(r['note_for_phlebotomist']),
      log: log,
      partial: log.any((e) => e.$1 == 'visit.completed' && e.$2['outcome'] == 'partial'),
      row: RouteVisit(
        visitId: id,
        sequence: sequence,
        patientName: name ?? (unavailable ? 'Patient details unavailable' : 'Visit #$sequence'),
        windowStart: start,
        windowEnd: end,
        landmark: _str(r['landmark']) ?? '',
        status: status,
        expectedTubes: tubes.length,
        collectedTubes: collectedHere.length,
      ),
      view: !open || name == null || r['order_id'] == null
          ? null
          : VisitView(
              visitId: id,
              sequence: sequence,
              patientName: name,
              phone: _str(r['patient_phone_e164']) ?? '',
              birthDate: _str(r['patient_birth_on']) ?? '',
              secondIdentifier: secondIdentifier,
              address: _str(r['address_text']) ?? '',
              landmark: _str(r['landmark']) ?? '',
              windowStart: start,
              windowEnd: end,
              noteFromCentre: _str(r['note_for_phlebotomist']),
              orderId: r['order_id']! as String,
              amountDuePaisa: r['balance_due_paisa'] as int? ?? 0,
              amountAsOf: r['balance_unavailable'] == 1 ? 'unavailable' : _hm(r['balance_as_of']),
              specimensStale: r['specimens_stale'] == 1,
              tubes: tubes,
            ),
    ));
  }

  final pulled = DateTime.tryParse(meta['pulled_at_device'] ?? '');
  final seconds = config['sync_interval_seconds'];
  return DayData(
    routeDate: routeDate,
    visits: visits,
    config: visitConfig,
    captureGps: config['capture_gps'] == true,
    syncInterval: Duration(seconds: seconds is int ? seconds.clamp(60, 900) : 300),
    centres: centres,
    handoverTubes: handoverTubes,
    barcodes: barcodes,
    dataAsOf: pulled?.toLocal(),
  );
}
