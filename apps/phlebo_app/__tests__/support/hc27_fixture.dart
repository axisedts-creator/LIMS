// HC-T27 test support: synthetic route, handover, outbox and settings data. Synthetic data only.
//
// ASSUMED API (names are mine; the spec has only the screen names M2/M10/M11/M12 and 04-UI-UX §3.2/3.10-3.12). The writer provides:
//   features/outbox/domain/sync_summary.dart : class SyncSummary({required int waiting, DateTime? lastUpload})   // app-bar chip "{n} waiting · Last upload hh:mm"
//   features/outbox/domain/outbox_row.dart   : class OutboxRow({clientMutationId, type, visitLabel (String?), capturedAt (DateTime), state, outcomeCode (String?)})
//        state = the mutation_log state: pending | sending | applied | duplicate | held | rejected
//   features/outbox/data/outbox_repository.dart : OutboxRepository gains Future<List<OutboxRow>> listRows() (newest first) and Future<int> pendingCount()
//        (pending + sending, same set as canLogout()).
//   features/route/domain/route_models.dart  : class RouteVisit({visitId, sequence, patientName, windowStart, windowEnd, landmark, status,
//        expectedTubes, collectedTubes}); status = assigned | in_progress | completed | failed | cancelled
//   features/route/ui/route_screen.dart      : RouteScreen({routeDate, visits, purged, offline = false, sync, onRefresh, onOpenVisit(String visitId),
//        onOpenHandover, onOpenOutbox, onOpenSettings, onHelp})                                                            (M2)
//   features/handover/domain/handover_models.dart : HandoverCentre({centreId, name}), HandoverTube({specimenId, typeDisplay, barcode})
//   features/handover/ui/handover_screen.dart: HandoverScreen({centres, tubes, itemResults (Map<specimenId, included|skipped_not_collected|
//        skipped_already_handed_over>), sink (MutationSink), newId (String Function()), onDone(String handoverId)})          (M10)
//   features/outbox/ui/outbox_screen.dart    : OutboxScreen({rows, sync, onUploadNow (Future<void> Function())})                (M11)
//   features/settings/domain/sign_out.dart   : enum SignOutResult { done, unsyncedChanges }
//   features/settings/ui/settings_screen.dart: SettingsScreen({deviceId, appVersion, userDisplayName, lastDownload, lastUpload, pendingCount,
//        signOut (Future<SignOutResult> Function()), onSignedOut})                                                          (M12)
// Every screen: LimsSecureScreen + LimsScaffold, only lims_ui widgets, at most ONE non-secondary LimsButton (LD-140), no network, no DB.
import 'package:phlebo_app/features/handover/domain/handover_models.dart';
import 'package:phlebo_app/features/outbox/domain/outbox_row.dart';
import 'package:phlebo_app/features/route/domain/route_models.dart';

export 'visit_fixture.dart';

const centreA = '01a1a98a-ac40-7000-8000-000000020002';
const centreB = '01a1a98a-ac40-7000-8000-000000020003';
const handoverId = '01a1a98a-ac40-7000-8000-0000001e0001';
const specA = '01a1a98a-ac40-7000-8000-000000090011';
const specB = '01a1a98a-ac40-7000-8000-000000090012';
const specC = '01a1a98a-ac40-7000-8000-000000090013';
const deviceIdLong = '01a1a98a-ac40-7000-8000-0000001b0001';
const displayName = 'Test Phlebotomist';

const longLandmark = 'Opposite the synthetic temple near the blue water tank behind the school gate';

RouteVisit routeVisit(
  int seq, {
  String status = 'assigned',
  String name = 'Test Patient One',
  String landmark = 'Blue gate',
  int expected = 2,
  int collected = 0,
}) =>
    RouteVisit(
      visitId: '01a1a98a-ac40-7000-8000-0000001300${seq.toString().padLeft(2, '0')}',
      sequence: seq,
      patientName: name,
      windowStart: '0${6 + seq}:00',
      windowEnd: '0${7 + seq}:00',
      landmark: landmark,
      status: status,
      expectedTubes: expected,
      collectedTubes: collected,
    );

const centres = [
  HandoverCentre(centreId: centreA, name: 'Synthetic Centre A2'),
  HandoverCentre(centreId: centreB, name: 'Synthetic Centre B1'),
];

HandoverTube tube(String id, String type, String barcode) => HandoverTube(specimenId: id, typeDisplay: type, barcode: barcode);

List<HandoverTube> threeTubes() => [
      tube(specA, 'Serum', 'HC00000042'),
      tube(specB, 'EDTA whole blood', 'HC00000043'),
      tube(specC, 'Urine', 'HC00000044'),
    ];

OutboxRow outboxRow(String id, String type, String state, {String? code, String? label = '#2 · 09:00–10:00', DateTime? at}) =>
    OutboxRow(
      clientMutationId: id,
      type: type,
      visitLabel: label,
      capturedAt: at ?? DateTime(2026, 11, 14, 9, 15),
      state: state,
      outcomeCode: code,
    );
