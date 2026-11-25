// Travel state of one visit: "On my way" until "I've arrived" (patient app stages Assigned > On the way > Arrived > Collected).
// Live location is shown to the patient only between the two taps; the states below are the phone's side of the patient
// app's tracking screens (delayed, lost, unavailable, offline).

enum LocationSharing {
  /// Position is being sent.
  live,

  /// Last position is a little old; still trying.
  delayed,

  /// No GPS fix or no signal; positions are queued.
  noSignal,

  /// The phone's location permission or service is off.
  permissionOff,

  /// The collector paused sharing (not offered by the UI, kept for the host to report).
  paused,
}

class TravelState {
  const TravelState({
    this.onTheWay = false,
    this.sharing = LocationSharing.live,
    this.lastShared,
    this.etaMin,
    this.distanceKm,
  });

  final bool onTheWay;
  final LocationSharing sharing;

  /// "4 s ago": the host formats it.
  final String? lastShared;
  final int? etaMin;
  final double? distanceKm;

  TravelState copyWith({
    bool? onTheWay,
    LocationSharing? sharing,
    String? lastShared,
    int? etaMin,
    double? distanceKm,
  }) => TravelState(
    onTheWay: onTheWay ?? this.onTheWay,
    sharing: sharing ?? this.sharing,
    lastShared: lastShared ?? this.lastShared,
    etaMin: etaMin ?? this.etaMin,
    distanceKm: distanceKm ?? this.distanceKm,
  );
}
