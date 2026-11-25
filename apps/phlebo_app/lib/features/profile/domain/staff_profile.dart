// The signed-in phlebotomist as the profile and ID-card screens show them. Display only.
class StaffProfile {
  const StaffProfile({
    required this.displayName,
    required this.staffId,
    required this.labName,
    this.weekCollections = 0,
    this.onTimePercent = 0,
    this.rejectedSamples = 0,
  });

  final String displayName;

  /// The identifier the patient checks at the door (patient app: "Ask for this staff ID and confirm the name").
  final String staffId;
  final String labName;
  final int weekCollections;
  final int onTimePercent;
  final int rejectedSamples;
}
