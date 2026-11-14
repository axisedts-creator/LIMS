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
}
