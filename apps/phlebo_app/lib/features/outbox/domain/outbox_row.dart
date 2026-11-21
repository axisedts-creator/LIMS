// HC-T27 M11: one line of the outbox list. No patient fields: only the visit label (sequence + window), never a name.
class OutboxRow {
  const OutboxRow({
    required this.clientMutationId,
    required this.type,
    required this.visitLabel,
    required this.capturedAt,
    required this.state,
    required this.outcomeCode,
  });

  final String clientMutationId;
  final String type;
  final String? visitLabel;
  final DateTime capturedAt;

  /// mutation_log state: pending | sending | applied | duplicate | held | rejected
  final String state;
  final String? outcomeCode;
}
