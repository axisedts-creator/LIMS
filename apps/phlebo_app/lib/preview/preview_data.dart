// DEV-FLAVOUR ONLY, SYNTHETIC DATA ONLY. Sample content for the clickable preview of the whole app (every name, address
// and number below is invented; none is real). Nothing here ships in staging or prod: main.dart builds the preview only
// for FLAVOR=dev. Real data will come from the cache DB and the sync engine when the shell is wired to them.
import '../features/alerts/domain/alert_models.dart';
import '../features/handover/domain/handover_models.dart';
import '../features/history/domain/history_models.dart';
import '../features/profile/domain/staff_profile.dart';
import '../features/route/domain/route_models.dart';
import '../features/support/ui/contact_screen.dart';
import '../features/visit/domain/visit_models.dart';

String previewVisitId(int n) => '00000000-0000-4000-8000-${n.toString().padLeft(12, '0')}';

const _purple = 'Purple · EDTA';
const _red = 'Red · Plain';
const _gold = 'Gold · SST gel';
const _grey = 'Grey · Fluoride';
const _urine = 'Urine cup';

ExpectedTube _tube(int visit, int n, String typeDisplay, String container, List<String> tests) => ExpectedTube(
      specimenId: '10000000-0000-4000-8000-${(visit * 10 + n).toString().padLeft(12, '0')}',
      typeCode: typeDisplay.toUpperCase().replaceAll(' ', '_'),
      typeDisplay: typeDisplay,
      container: container,
      barcode: 'DEMO${(visit * 100 + n).toString().padLeft(6, '0')}',
      tests: tests,
    );

class PreviewVisitSpec {
  const PreviewVisitSpec({
    required this.n,
    required this.name,
    required this.ageSex,
    required this.locality,
    required this.address,
    required this.landmark,
    required this.start,
    required this.end,
    required this.status,
    required this.tubes,
    this.kind = 'booking',
    this.fasting = const [],
    this.flags = const [],
    this.note,
    this.distanceKm,
    this.etaMin,
    this.amountPaisa = 0,
    this.recollectionReason,
  });

  final int n;
  final String name;
  final String ageSex;
  final String locality;
  final String address;
  final String landmark;
  final String start;
  final String end;
  final String status;
  final List<ExpectedTube> tubes;
  final String kind;
  final List<String> fasting;
  final List<String> flags;
  final String? note;
  final double? distanceKm;
  final int? etaMin;
  final int amountPaisa;
  final String? recollectionReason;

  String get id => previewVisitId(n);
  String get phone => '000000000$n';
  int get collected => status == 'completed' ? tubes.length : 0;

  RouteVisit toRoute({String? liveStatus, bool onTheWay = false, int? collectedOverride}) => RouteVisit(
        visitId: id,
        sequence: n,
        patientName: name,
        windowStart: start,
        windowEnd: end,
        landmark: landmark,
        status: liveStatus ?? status,
        expectedTubes: tubes.length,
        collectedTubes: collectedOverride ?? collected,
        kind: kind,
        ageSex: ageSex,
        locality: locality,
        fasting: fasting.isNotEmpty,
        tubeLabels: [for (final t in tubes) t.container],
        distanceKm: distanceKm,
        etaMin: etaMin,
        onTheWay: onTheWay,
        flags: flags,
      );

  VisitView toView() => VisitView(
        visitId: id,
        sequence: n,
        patientName: name,
        phone: phone,
        birthDate: '1980-01-0$n',
        secondIdentifier: 'phone',
        address: address,
        landmark: landmark,
        windowStart: start,
        windowEnd: end,
        noteFromCentre: note,
        orderId: '20000000-0000-4000-8000-${n.toString().padLeft(12, '0')}',
        amountDuePaisa: amountPaisa,
        amountAsOf: '06:45',
        specimensStale: false,
        tubes: tubes,
        ageSex: ageSex,
        kind: kind,
        locality: locality,
        fastingTests: fasting,
        flags: flags,
        recollectionReason: recollectionReason,
      );
}

abstract final class PreviewData {
  static List<PreviewVisitSpec> visits() => [
        PreviewVisitSpec(
          n: 1,
          name: 'Asha Demo',
          ageSex: '46 yrs · Female',
          locality: 'Lazimpat',
          address: 'Demo Lane 12, Lazimpat, Kathmandu',
          landmark: 'Green gate, ground floor',
          start: '07:30',
          end: '08:30',
          status: 'completed',
          tubes: [_tube(1, 1, 'Whole blood', _purple, ['CBC']), _tube(1, 2, 'Serum', _red, ['Lipid Profile']), _tube(1, 3, 'Plasma', _grey, ['Fasting Glucose'])],
          fasting: const ['Lipid Profile', 'Fasting Glucose'],
          distanceKm: 1.2,
          etaMin: 6,
        ),
        PreviewVisitSpec(
          n: 2,
          name: 'Bikash Demo',
          ageSex: '58 yrs · Male',
          locality: 'Patan',
          address: 'Demo Road 4, Patan, Lalitpur',
          landmark: 'Blue shutter, first floor',
          start: '08:30',
          end: '09:30',
          status: 'completed',
          tubes: [_tube(2, 1, 'Whole blood', _purple, ['HbA1c']), _tube(2, 2, 'Plasma', _grey, ['Fasting Glucose'])],
          fasting: const ['Fasting Glucose'],
          distanceKm: 2.1,
          etaMin: 11,
        ),
        PreviewVisitSpec(
          n: 3,
          name: 'Chandra Demo',
          ageSex: '29 yrs · Female',
          locality: 'Boudha',
          address: 'Demo Chowk 7, Boudha, Kathmandu',
          landmark: 'Behind the bus stop, red gate',
          start: '09:30',
          end: '10:30',
          status: 'failed',
          tubes: [_tube(3, 1, 'Whole blood', _purple, ['CBC']), _tube(3, 2, 'Serum', _red, ['TFT'])],
          distanceKm: 1.8,
          etaMin: 9,
        ),
        PreviewVisitSpec(
          n: 4,
          name: 'Dipa Demo',
          ageSex: '34 yrs · Female',
          locality: 'Kirtipur',
          address: 'Demo Marg 21, Kirtipur, Kathmandu',
          landmark: 'Beside the hospital gate, cream building, second floor',
          start: '10:30',
          end: '11:30',
          status: 'assigned',
          tubes: [_tube(4, 1, 'Serum', _red, ['Lipid Profile', 'LFT', 'KFT']), _tube(4, 2, 'Serum', _gold, ['Electrolytes']), _tube(4, 3, 'Plasma', _grey, ['Fasting Glucose'])],
          fasting: const ['Lipid Profile', 'Fasting Glucose'],
          note: 'Ring the bell twice. The patient is expecting the collection.',
          distanceKm: 2.4,
          etaMin: 12,
          amountPaisa: 250000,
        ),
        PreviewVisitSpec(
          n: 5,
          name: 'Ekraj Demo',
          ageSex: '52 yrs · Male',
          locality: 'Balaju',
          address: 'Demo Path 9, Balaju, Kathmandu',
          landmark: 'Opposite the pharmacy, green gate, third floor',
          start: '11:30',
          end: '12:30',
          status: 'assigned',
          kind: 'recollection',
          tubes: [_tube(5, 1, 'Urine', _urine, ['Urine R/E']), _tube(5, 2, 'Whole blood', _purple, ['CBC'])],
          flags: const ['recollection_required'],
          recollectionReason: 'The lab could not use the first sample (clotted). New tube labels were printed at the centre.',
          distanceKm: 1.6,
          etaMin: 8,
        ),
        PreviewVisitSpec(
          n: 6,
          name: 'Gita Demo',
          ageSex: '41 yrs · Female',
          locality: 'Thapathali',
          address: 'Demo Street 3, Thapathali, Kathmandu',
          landmark: 'Above the sweet shop, stairs on the left',
          start: '12:30',
          end: '13:30',
          status: 'assigned',
          kind: 'front_desk',
          tubes: [_tube(6, 1, 'Serum', _gold, ['Vitamin D', 'Vitamin B12', 'Iron Profile'])],
          fasting: const ['Iron Profile'],
          flags: const ['address_missing'],
          distanceKm: 2.9,
          etaMin: 15,
          amountPaisa: 180000,
        ),
        PreviewVisitSpec(
          n: 7,
          name: 'Hari Demo',
          ageSex: '63 yrs · Male',
          locality: 'Chabahil',
          address: 'Demo Gali 5, Chabahil, Kathmandu',
          landmark: 'Near the temple',
          start: '14:00',
          end: '15:00',
          status: 'cancelled',
          tubes: [_tube(7, 1, 'Whole blood', _purple, ['CBC'])],
        ),
      ];

  static List<HistoryDay> history(DateTime today) {
    HistoryDay day(int back, List<HistoryRow> rows) {
      final d = DateTime(today.year, today.month, today.day).subtract(Duration(days: back));
      return HistoryDay(id: 'h$back', date: d, rows: rows);
    }

    return [
      day(1, const [
        HistoryRow(name: 'Nabin Demo', locality: 'Lazimpat', time: '8:10 AM', summary: 'CBC, LFT', status: 'collected'),
        HistoryRow(name: 'Kamana Demo', locality: 'Patan', time: '8:50 AM', summary: 'HbA1c', status: 'collected'),
        HistoryRow(name: 'Suresh Demo', locality: 'Boudha', time: '9:30 AM', summary: 'TFT, CBC', status: 'missed', reason: 'Patient not home'),
        HistoryRow(name: 'Rita Demo', locality: 'Kirtipur', time: '10:15 AM', summary: 'Lipid Profile, Fasting Glucose', status: 'partial'),
        HistoryRow(name: 'Dipesh Demo', locality: 'Balaju', time: '11:00 AM', summary: 'Urine R/E', status: 'collected'),
      ]),
      day(2, const [
        HistoryRow(name: 'Mina Demo', locality: 'Lazimpat', time: '8:05 AM', summary: 'CBC', status: 'collected'),
        HistoryRow(name: 'Gopal Demo', locality: 'Patan', time: '8:45 AM', summary: 'Lipid Profile', status: 'collected'),
        HistoryRow(name: 'Puja Demo', locality: 'Boudha', time: '9:25 AM', summary: 'TFT, HbA1c', status: 'collected'),
        HistoryRow(name: 'Keshav Demo', locality: 'Kirtipur', time: '10:05 AM', summary: 'KFT, LFT', status: 'collected'),
      ]),
      day(3, const [
        HistoryRow(name: 'Alina Demo', locality: 'Lazimpat', time: '8:00 AM', summary: 'CBC, Lipid Profile', status: 'collected'),
        HistoryRow(name: 'Birendra Demo', locality: 'Patan', time: '8:40 AM', summary: 'HbA1c', status: 'collected'),
        HistoryRow(name: 'Sunil Demo', locality: 'Boudha', time: '9:20 AM', summary: 'TFT', status: 'missed', reason: 'Patient declined'),
      ]),
    ];
  }

  static List<PhleboAlert> alerts(DateTime now) => [
        PhleboAlert(id: 'a1', kind: AlertKind.recollection, title: 'Recollection added', body: 'Ekraj Demo needs a new sample. Stop 5, new tube labels printed.', at: now.subtract(const Duration(minutes: 25)), visitId: previewVisitId(5)),
        PhleboAlert(id: 'a2', kind: AlertKind.cancelled, title: 'Visit cancelled', body: 'Hari Demo cancelled. Do not visit.', at: now.subtract(const Duration(hours: 1)), visitId: previewVisitId(7)),
        PhleboAlert(id: 'a3', kind: AlertKind.changed, title: 'Route order changed', body: 'Dispatch moved stop 6 after stop 5.', at: now.subtract(const Duration(hours: 2)), unread: false, visitId: previewVisitId(6)),
        PhleboAlert(id: 'a4', kind: AlertKind.assigned, title: 'New visit assigned', body: 'Gita Demo, 12:30–13:30. The address still needs confirming.', at: now.subtract(const Duration(hours: 3)), unread: false, visitId: previewVisitId(6)),
        PhleboAlert(id: 'a5', kind: AlertKind.handover, title: 'Tubes waiting for handover', body: 'Hand yesterday\'s tubes to the centre before you start.', at: now.subtract(const Duration(days: 1, hours: 2)), unread: false),
      ];

  static const profile = StaffProfile(displayName: 'Sanjay Demo', staffId: 'PHL-DEMO-01', labName: 'Central Lab (demo)', weekCollections: 34, onTimePercent: 92, rejectedSamples: 1);

  static const centres = [HandoverCentre(centreId: 'c1', name: 'Central Lab (demo)'), HandoverCentre(centreId: 'c2', name: 'North Collection Point (demo)')];

  static const dispatch = DispatchContact(name: 'Dispatch desk (demo)', phone: '0000000000');

  static const config = VisitConfig(
    mapHandoffEnabled: true,
    manualBarcodeEntryAllowed: true,
    consentText: 'I agree to a blood sample being taken at my home (synthetic consent text).',
    consentTextVersion: 'demo-consent-v1',
    paymentMethods: [
      PaymentMethodOption(code: 'cash', display: 'Cash', requiresReference: false),
      PaymentMethodOption(code: 'fonepay_qr', display: 'Fonepay QR', requiresReference: true),
      PaymentMethodOption(code: 'card', display: 'Card', requiresReference: true),
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
}
