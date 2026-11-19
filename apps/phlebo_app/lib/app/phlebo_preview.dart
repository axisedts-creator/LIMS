// Sample-data host for the phlebotomist screens (build with --dart-define=PHLEBO_PREVIEW=true).
// The real app shell (sign-in, cache DB, sync engine) is a later HC task; until then this wires the finished screens
// M2-M12 to in-memory synthetic data so the whole visit flow can be walked through on a phone. No network, no DB, no PHI.
import 'package:flutter/material.dart';

import '../features/handover/domain/handover_models.dart';
import '../features/handover/ui/handover_screen.dart';
import '../features/outbox/domain/outbox_row.dart';
import '../features/outbox/domain/sync_summary.dart';
import '../features/outbox/ui/outbox_screen.dart';
import '../features/route/domain/route_models.dart';
import '../features/route/ui/route_screen.dart';
import '../features/settings/domain/sign_out.dart';
import '../features/settings/ui/settings_screen.dart';
import '../features/visit/data/mutation_sink.dart';
import '../features/visit/domain/visit_models.dart';
import '../features/visit/ui/visit_flow_screen.dart';

const kPhleboPreview = bool.fromEnvironment('PHLEBO_PREVIEW');

// ---- synthetic data (no real people, no real barcodes) -------------------------------------------------------------

String _id(int n) => '01a1a98a-ac40-7000-8000-${n.toString().padLeft(12, '0')}';

ExpectedTube _tube(int n, String code, String display, String container, String barcode) =>
    ExpectedTube(specimenId: _id(900000 + n), typeCode: code, typeDisplay: display, container: container, barcode: barcode);

VisitView _visit(int seq, String name, String phone, String address, String landmark, String from, String to, int due, List<ExpectedTube> tubes,
        {String? note}) =>
    VisitView(
      visitId: _id(130000 + seq),
      sequence: seq,
      patientName: name,
      phone: phone,
      birthDate: '1990-01-15',
      secondIdentifier: 'phone',
      address: address,
      landmark: landmark,
      windowStart: from,
      windowEnd: to,
      noteFromCentre: note,
      orderId: _id(50000 + seq),
      amountDuePaisa: due,
      amountAsOf: '07:45',
      specimensStale: false,
      tubes: tubes,
    );

final _visits = <VisitView>[
  _visit(1, 'Sample Patient One', '9800000001', 'Sample Tole 7, Testville', 'Blue gate near the temple', '07:00', '08:00', 180000,
      [_tube(1, 'SERUM', 'Serum', 'Gel tube', 'HC00000041'), _tube(2, 'EDTA_WB', 'EDTA whole blood', 'Purple top', 'HC00000042')],
      note: 'Ring the bell twice'),
  _visit(2, 'Sample Patient Two', '9800000002', 'Sample Marg 12, Testville', 'Opposite the pharmacy', '08:30', '09:30', 95000,
      [_tube(3, 'FLUORIDE', 'Fluoride plasma', 'Grey top', 'HC00000043')]),
  _visit(3, 'Sample Patient Three', '9800000003', 'Sample Chowk 3, Testville', 'Green shutter shop', '10:00', '11:00', 0,
      [_tube(4, 'SERUM', 'Serum', 'Gel tube', 'HC00000044')]),
];

const _centres = <HandoverCentre>[
  HandoverCentre(centreId: '01a1a98a-ac40-7000-8000-000000700001', name: 'Sample Lab, Main Centre'),
  HandoverCentre(centreId: '01a1a98a-ac40-7000-8000-000000700002', name: 'Sample Lab, Collection Point'),
];

const _config = VisitConfig(
  mapHandoffEnabled: false, // no maps app hand-off in the sample build
  manualBarcodeEntryAllowed: true,
  consentText: 'I agree to a blood sample being taken at my home (sample consent text).',
  consentTextVersion: 'sample-consent-v1',
  paymentMethods: [
    PaymentMethodOption(code: 'cash', display: 'Cash', requiresReference: false),
    PaymentMethodOption(code: 'fonepay_qr', display: 'Fonepay QR', requiresReference: true),
    PaymentMethodOption(code: 'esewa', display: 'eSewa', requiresReference: false),
  ],
  visitFailReasons: [
    ReasonOption(code: 'patient_not_home', display: 'Patient not home', requiresText: false),
    ReasonOption(code: 'address_not_found', display: 'Address not found', requiresText: false),
    ReasonOption(code: 'patient_refused', display: 'Patient refused', requiresText: false),
    ReasonOption(code: 'identity_mismatch', display: 'Identity mismatch', requiresText: false),
    ReasonOption(code: 'unable_to_draw', display: 'Unable to draw', requiresText: false),
    ReasonOption(code: 'other', display: 'Other', requiresText: true),
  ],
  notCollectedReasons: [
    ReasonOption(code: 'unable_to_draw', display: 'Unable to draw', requiresText: false),
    ReasonOption(code: 'patient_declined_tube', display: 'Patient declined tube', requiresText: false),
    ReasonOption(code: 'tube_missing', display: 'Tube missing', requiresText: false),
    ReasonOption(code: 'other', display: 'Other', requiresText: false),
  ],
);

// ---- in-memory state ------------------------------------------------------------------------------------------------

class _Store implements MutationSink {
  final Map<String, String> status = {for (final v in _visits) v.visitId: 'assigned'};
  final Map<String, List<LogEntry>> logs = {for (final v in _visits) v.visitId: []};
  final Set<String> collectedSpecimens = {};
  final List<OutboxRow> rows = [];
  final Set<String> handedOver = {};
  int _seq = 0;
  DateTime? lastUpload;

  @override
  Future<SavedMutation> enqueue({required String type, String? visitId, String? visitLabel, required Map<String, Object?> payload}) async {
    _seq++;
    final id = 'preview-mutation-$_seq';
    rows.insert(0, OutboxRow(clientMutationId: id, type: type, visitLabel: visitLabel, capturedAt: DateTime.now(), state: 'pending', outcomeCode: null));
    if (visitId != null && logs.containsKey(visitId)) {
      logs[visitId]!.add((type, payload));
      if (status[visitId] == 'assigned') status[visitId] = 'in_progress';
    }
    if (type == 'specimen.collected') collectedSpecimens.add(payload['specimen_id']! as String);
    if (type == 'handover.recorded') handedOver.addAll((payload['specimen_ids']! as List<Object?>).cast<String>());
    return SavedMutation(clientMutationId: id, deviceSeq: _seq);
  }

  int get waiting => rows.where((r) => r.state == 'pending').length;

  void uploadAll() {
    for (var i = 0; i < rows.length; i++) {
      final r = rows[i];
      if (r.state == 'pending') {
        rows[i] = OutboxRow(clientMutationId: r.clientMutationId, type: r.type, visitLabel: r.visitLabel, capturedAt: r.capturedAt, state: 'applied', outcomeCode: null);
      }
    }
    lastUpload = DateTime.now();
  }

  List<HandoverTube> get tubesToHand => [
        for (final v in _visits)
          for (final t in v.tubes)
            if (collectedSpecimens.contains(t.specimenId) && !handedOver.contains(t.specimenId))
              HandoverTube(specimenId: t.specimenId, typeDisplay: t.typeDisplay, barcode: t.barcode),
      ];
}

// ---- host -----------------------------------------------------------------------------------------------------------

class PhleboPreviewHome extends StatefulWidget {
  const PhleboPreviewHome({super.key});

  @override
  State<PhleboPreviewHome> createState() => _PhleboPreviewHomeState();
}

class _PhleboPreviewHomeState extends State<PhleboPreviewHome> {
  final _store = _Store();
  int _idCounter = 800000;
  final DateTime _openedAt = DateTime.now();

  List<RouteVisit> get _routeVisits => [
        for (final v in _visits)
          RouteVisit(
            visitId: v.visitId,
            sequence: v.sequence,
            patientName: v.patientName,
            windowStart: v.windowStart,
            windowEnd: v.windowEnd,
            landmark: v.landmark,
            status: _store.status[v.visitId]!,
            expectedTubes: v.tubes.length,
            collectedTubes: v.tubes.where((t) => _store.collectedSpecimens.contains(t.specimenId)).length,
          ),
      ];

  SyncSummary get _sync => SyncSummary(waiting: _store.waiting, lastUpload: _store.lastUpload);

  Future<void> _push(Widget screen) => Navigator.of(context).push<void>(MaterialPageRoute<void>(builder: (_) => screen));

  void _openVisit(String visitId) {
    final v = _visits.firstWhere((x) => x.visitId == visitId);
    if (_store.status[visitId] == 'completed' || _store.status[visitId] == 'failed') return;
    final others = {for (final o in _visits) if (o.visitId != visitId) for (final t in o.tubes) t.barcode};
    _push(VisitFlowScreen(
      visit: v,
      config: _config,
      otherVisitBarcodes: others,
      sink: _store,
      initialLog: List.of(_store.logs[visitId]!),
      readGps: () async => const {'status': 'off'},
      now: DateTime.now,
      launchUri: (_) async {},
      onExit: (outcome) {
        setState(() => _store.status[visitId] = outcome);
        Navigator.of(context).pop();
      },
    ));
  }

  void _openHandover() => _push(HandoverScreen(
        centres: _centres,
        tubes: _store.tubesToHand,
        itemResults: const {},
        sink: _store,
        newId: () => _id(_idCounter++),
        onDone: (_) {
          setState(() {});
          Navigator.of(context).pop();
        },
      ));

  void _openOutbox() => _push(OutboxScreen(
        rows: List.of(_store.rows),
        sync: _sync,
        onUploadNow: () async {
          await Future<void>.delayed(const Duration(milliseconds: 600));
          setState(_store.uploadAll);
          if (mounted) Navigator.of(context).pop();
          _openOutbox();
        },
      ));

  void _openSettings() => _push(SettingsScreen(
        deviceId: 'preview-device',
        appVersion: '0.0.0+1 (sample data)',
        userDisplayName: 'Sample Phlebotomist',
        lastDownload: _openedAt,
        lastUpload: _store.lastUpload,
        pendingCount: _store.waiting,
        signOut: () async => _store.waiting > 0 ? SignOutResult.unsyncedChanges : SignOutResult.done,
        onSignedOut: () => Navigator.of(context).pop(),
      ));

  @override
  Widget build(BuildContext context) => RouteScreen(
        routeDate: _openedAt,
        visits: _routeVisits,
        purged: false,
        dataAsOf: _openedAt,
        sync: _sync,
        onRefresh: () async => setState(() {}),
        onOpenVisit: _openVisit,
        onOpenHandover: _openHandover,
        onOpenOutbox: _openOutbox,
        onOpenSettings: _openSettings,
        onHelp: () => ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Help: call your centre. (sample build)'))),
      );
}
