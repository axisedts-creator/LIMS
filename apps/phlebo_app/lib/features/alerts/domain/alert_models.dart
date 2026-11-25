// Alerts are derived from the sync result and the local clock (the app polls; there is no push, C17 PRD out-of-scope list).

enum AlertKind { assigned, changed, cancelled, recollection, message, handover, sync, wipe }

class PhleboAlert {
  const PhleboAlert({required this.id, required this.kind, required this.title, required this.body, required this.at, this.unread = true, this.visitId});

  final String id;
  final AlertKind kind;
  final String title;
  final String body;
  final DateTime at;
  final bool unread;

  /// Opens this visit when tapped (assigned, changed, cancelled, recollection).
  final String? visitId;
}
