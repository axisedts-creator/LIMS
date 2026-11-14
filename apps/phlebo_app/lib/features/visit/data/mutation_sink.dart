// HC-T26: the one seam through which the visit-flow screens persist a mutation (TRD §6.3). OutboxRepository implements it,
// so a screen never touches the DB: its future completes only after COMMIT, and the UI moves on only after that.
import '../../outbox/data/outbox_repository.dart' show SavedMutation;

export '../../outbox/data/outbox_repository.dart' show SavedMutation;

abstract interface class MutationSink {
  Future<SavedMutation> enqueue({
    required String type,
    String? visitId,
    String? visitLabel,
    required Map<String, Object?> payload,
  });
}
