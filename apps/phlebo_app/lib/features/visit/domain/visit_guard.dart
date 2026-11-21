// HC-T26: the visit-flow guard (US-07-2/3, review #2, US-08-8 order rule). Pure: no UI, no clock, no DB.
// The mutation log is the source of truth, so a force-close resumes exactly where the visit was (fromMutations).
// Mutation type names are the TRD §6.3 table verbatim.

enum VisitStep { arrive, identity, consent, collect, payment, complete, fail }

enum IdentityState { pending, verified, mismatch }

enum ConsentState { pending, given, refused }

class VisitProgress {
  const VisitProgress({
    this.arrived = false,
    this.identity = IdentityState.pending,
    this.consent = ConsentState.pending,
    this.specimensStale = false,
    this.tubesResolved = false,
    this.paid = false,
    this.finished = false,
    this.failed = false,
  });

  /// Replays the log in order. An entry that arrives before its prerequisite is ignored (it can never open a later step).
  factory VisitProgress.fromMutations(
    List<(String, Map<String, Object?>)> log, {
    required int expectedTubes,
    required bool specimensStale,
  }) {
    var arrived = false;
    var identity = IdentityState.pending;
    var consent = ConsentState.pending;
    var paid = false;
    var finished = false;
    var failed = false;
    final resolved = <String>{};
    for (final (type, p) in log) {
      switch (type) {
        case 'visit.arrived':
          arrived = true;
        case 'visit.identity_checked':
          if (arrived) {
            identity = p['name_check'] == 'matches' && p['second_check'] == 'matches' ? IdentityState.verified : IdentityState.mismatch;
          }
        case 'visit.consent_recorded':
          if (arrived && identity == IdentityState.verified) {
            consent = p['given'] == true ? ConsentState.given : ConsentState.refused;
          }
        case 'specimen.collected' || 'specimen.not_collected':
          final id = p['specimen_id'];
          if (consent == ConsentState.given && id is String) resolved.add(id);
        case 'payment.captured':
          if (consent == ConsentState.given) paid = true;
        case 'visit.completed':
          if (arrived) finished = true;
        case 'visit.failed':
          failed = true;
      }
    }
    return VisitProgress(
      arrived: arrived,
      identity: identity,
      consent: consent,
      specimensStale: specimensStale,
      tubesResolved: !specimensStale && expectedTubes > 0 && resolved.length >= expectedTubes,
      paid: paid,
      finished: finished,
      failed: failed,
    );
  }

  final bool arrived;
  final IdentityState identity;
  final ConsentState consent;
  final bool specimensStale;
  final bool tubesResolved;
  final bool paid;
  final bool finished;
  final bool failed;
}

abstract final class VisitGuard {
  static bool canEnter(VisitStep s, VisitProgress p) {
    if (p.finished || p.failed) return false;
    final ready = p.arrived && p.identity == IdentityState.verified && p.consent == ConsentState.given;
    return switch (s) {
      VisitStep.arrive => !p.arrived,
      VisitStep.identity => p.arrived && p.identity == IdentityState.pending,
      VisitStep.consent => p.arrived && p.identity == IdentityState.verified && p.consent == ConsentState.pending,
      VisitStep.collect => ready && !p.specimensStale,
      VisitStep.payment || VisitStep.complete => ready && !p.specimensStale && p.tubesResolved,
      VisitStep.fail => true,
    };
  }

  static Set<VisitStep> allowed(VisitProgress p) => {for (final s in VisitStep.values) if (canEnter(s, p)) s};

  /// Where the user is. For a stale visit with consent given this is `collect` even though canEnter(collect) is false:
  /// the screen host shows why (specimens_stale) instead of the scan UI.
  static VisitStep resumeAt(VisitProgress p) {
    if (p.finished) return VisitStep.complete;
    if (p.failed) return VisitStep.fail;
    if (!p.arrived) return VisitStep.arrive;
    switch (p.identity) {
      case IdentityState.pending:
        return VisitStep.identity;
      case IdentityState.mismatch:
        return VisitStep.fail;
      case IdentityState.verified:
        break;
    }
    switch (p.consent) {
      case ConsentState.pending:
        return VisitStep.consent;
      case ConsentState.refused:
        return VisitStep.fail;
      case ConsentState.given:
        break;
    }
    if (p.tubesResolved) return p.paid ? VisitStep.complete : VisitStep.payment;
    return VisitStep.collect;
  }
}
