// HC-T27: what the app-bar sync chip shows: how many changes wait and when the last upload finished.
class SyncSummary {
  const SyncSummary({required this.waiting, this.lastUpload});

  final int waiting;
  final DateTime? lastUpload;
}
