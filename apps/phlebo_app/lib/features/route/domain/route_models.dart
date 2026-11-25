// HC-T27 M2: one visit on today's route (display only; the patient name never leaves the screen).
class RouteVisit {
  const RouteVisit({
    required this.visitId,
    required this.sequence,
    required this.patientName,
    required this.windowStart,
    required this.windowEnd,
    required this.landmark,
    required this.status,
    required this.expectedTubes,
    required this.collectedTubes,
    this.kind = 'booking',
    this.ageSex,
    this.locality,
    this.fasting = false,
    this.tubeLabels = const [],
    this.distanceKm,
    this.etaMin,
    this.onTheWay = false,
    this.flags = const [],
  });

  final String visitId;
  final int sequence;
  final String patientName;
  final String windowStart;
  final String windowEnd;
  final String landmark;

  /// assigned | in_progress | completed | failed | cancelled
  final String status;
  final int expectedTubes;
  final int collectedTubes;

  /// booking | front_desk | recollection | revisit (visit kind of C17 04-UI-UX §2.1 filter). Drives the small badge on the card.
  final String kind;

  /// "46 yrs · Female": display only, never written to a mutation or label.
  final String? ageSex;
  final String? locality;

  /// At least one ordered test needs a fasting sample.
  final bool fasting;

  /// Container names of the tubes ("Purple · EDTA"): chips on the next-stop card.
  final List<String> tubeLabels;
  final double? distanceKm;
  final int? etaMin;

  /// The collector pressed "On my way" for this visit (live location sharing is on; the patient app shows "On the way").
  final bool onTheWay;

  /// Open flags the phlebotomist should know about: address_missing, recollection_required, specimens_stale.
  final List<String> flags;

  bool get isClosed => status == 'completed' || status == 'failed' || status == 'cancelled';
}
