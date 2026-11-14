// HC-T26 unit tests: the visit-flow guard (plan row "Visit flow screens M3-M9 + guard"; US-07-2, US-07-3, review #2, US-08-8 order rule).
// ASSUMED API (features/visit/domain/visit_guard.dart):
//   enum VisitStep { arrive, identity, consent, collect, payment, complete, fail }
//   enum IdentityState { pending, verified, mismatch }   enum ConsentState { pending, given, refused }
//   class VisitProgress { const VisitProgress({arrived = false, identity = IdentityState.pending, consent = ConsentState.pending,
//                           specimensStale = false, tubesResolved = false, finished = false, failed = false});
//     factory VisitProgress.fromMutations(List<(String type, Map<String, Object?> payload)> log,
//                           {required int expectedTubes, required bool specimensStale}); }   // survives a force-close: rebuilt from mutation_log
//   abstract final class VisitGuard { static bool canEnter(VisitStep s, VisitProgress p); static Set<VisitStep> allowed(VisitProgress p);
//                                     static VisitStep resumeAt(VisitProgress p); }
// Unspecified (not tested): a mismatch followed by a corrected identity check (spec: only "Fail visit" or "Back").
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/features/visit/domain/visit_guard.dart';

typedef Log = List<(String, Map<String, Object?>)>;

const _gps = <String, Object?>{'status': 'off'};
const _okId = {'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'matches'};

(String, Map<String, Object?>) arrived() => ('visit.arrived', {'gps': _gps});
(String, Map<String, Object?>) identity([Map<String, Object?> p = _okId]) => ('visit.identity_checked', p);
(String, Map<String, Object?>) consent(bool given) => ('visit.consent_recorded', {'consent_text_version': 'v1', 'given': given});
(String, Map<String, Object?>) collected(String id) => (
      'specimen.collected',
      {'specimen_id': id, 'scanned_barcode': 'HC1', 'scan_method': 'hid', 'specimen_type_code': 'SERUM', 'gps': _gps}
    );
(String, Map<String, Object?>) notCollected(String id) => ('specimen.not_collected', {'specimen_id': id, 'reason_code': 'unable_to_draw'});

VisitProgress from(Log log, {int tubes = 2, bool stale = false}) =>
    VisitProgress.fromMutations(log, expectedTubes: tubes, specimensStale: stale);

void main() {
  group('guard rules', () {
    test('nothing recorded: only Arrive and Fail', () {
      final a = VisitGuard.allowed(const VisitProgress());
      expect(a, containsAll([VisitStep.arrive, VisitStep.fail]));
      expect(a.intersection({VisitStep.identity, VisitStep.consent, VisitStep.collect, VisitStep.payment, VisitStep.complete}), isEmpty);
      expect(VisitGuard.resumeAt(const VisitProgress()), VisitStep.arrive);
    });

    test('arrived: Identity opens, Consent/Collect still shut', () {
      const p = VisitProgress(arrived: true);
      expect(VisitGuard.canEnter(VisitStep.identity, p), isTrue);
      expect(VisitGuard.canEnter(VisitStep.consent, p), isFalse);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isFalse);
      expect(VisitGuard.resumeAt(p), VisitStep.identity);
    });

    test('identity mismatch (US-07-2): Collect, Consent, Payment, Complete all disabled; Fail visit stays', () {
      const p = VisitProgress(arrived: true, identity: IdentityState.mismatch);
      for (final s in [VisitStep.consent, VisitStep.collect, VisitStep.payment, VisitStep.complete]) {
        expect(VisitGuard.canEnter(s, p), isFalse, reason: '$s');
      }
      expect(VisitGuard.canEnter(VisitStep.fail, p), isTrue);
    });

    test('identity verified: Consent opens, Collect does not (consent still missing)', () {
      const p = VisitProgress(arrived: true, identity: IdentityState.verified);
      expect(VisitGuard.canEnter(VisitStep.consent, p), isTrue);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isFalse);
      expect(VisitGuard.resumeAt(p), VisitStep.consent);
    });

    test('consent refused (US-07-3): Collect disabled, Fail visit offered, resume at Fail', () {
      const p = VisitProgress(arrived: true, identity: IdentityState.verified, consent: ConsentState.refused);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isFalse);
      expect(VisitGuard.canEnter(VisitStep.fail, p), isTrue);
      expect(VisitGuard.resumeAt(p), VisitStep.fail);
    });

    test('consent given: Collect opens; Payment/Complete wait for every tube to be resolved', () {
      const p = VisitProgress(arrived: true, identity: IdentityState.verified, consent: ConsentState.given);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isTrue);
      expect(VisitGuard.canEnter(VisitStep.payment, p), isFalse);
      expect(VisitGuard.canEnter(VisitStep.complete, p), isFalse);
      expect(VisitGuard.resumeAt(p), VisitStep.collect);
    });

    test('specimens_stale disables Collect even with identity + consent (review #2)', () {
      const p = VisitProgress(arrived: true, identity: IdentityState.verified, consent: ConsentState.given, specimensStale: true);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isFalse);
      expect(VisitGuard.canEnter(VisitStep.payment, p), isFalse);
      expect(VisitGuard.canEnter(VisitStep.fail, p), isTrue);
    });

    test('all tubes resolved: Payment and Complete open (payment may be skipped)', () {
      const p = VisitProgress(
          arrived: true, identity: IdentityState.verified, consent: ConsentState.given, tubesResolved: true);
      expect(VisitGuard.canEnter(VisitStep.payment, p), isTrue);
      expect(VisitGuard.canEnter(VisitStep.complete, p), isTrue);
    });

    test('finished or failed visit: nothing is allowed any more (terminal)', () {
      const done = VisitProgress(
          arrived: true, identity: IdentityState.verified, consent: ConsentState.given, tubesResolved: true, finished: true);
      const bad = VisitProgress(arrived: true, failed: true);
      expect(VisitGuard.allowed(done), isEmpty);
      expect(VisitGuard.allowed(bad), isEmpty);
    });

    test('a step can never be entered without the previous steps: exhaustive impossible states stay shut', () {
      // consent given but never arrived / identity pending: Collect must not open on a lie.
      const p = VisitProgress(consent: ConsentState.given, tubesResolved: true);
      for (final s in [VisitStep.identity, VisitStep.consent, VisitStep.collect, VisitStep.payment, VisitStep.complete]) {
        expect(VisitGuard.canEnter(s, p), isFalse, reason: '$s');
      }
    });
  });

  group('VisitProgress.fromMutations (rebuilt from the log after a force-close)', () {
    test('empty log', () {
      expect(VisitGuard.resumeAt(from([])), VisitStep.arrive);
    });

    test('arrived + good identity + consent given -> resume at Collect', () {
      final p = from([arrived(), identity(), consent(true)]);
      expect(VisitGuard.resumeAt(p), VisitStep.collect);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isTrue);
    });

    test('a mismatch on EITHER identifier blocks Collect', () {
      for (final bad in [
        {'name_check': 'mismatch', 'second_identifier': 'phone', 'second_check': 'matches'},
        {'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'mismatch'},
        {'name_check': 'matches', 'second_identifier': 'birth_date', 'second_check': 'mismatch'},
      ]) {
        final p = from([arrived(), identity(bad), consent(true)]);
        expect(VisitGuard.canEnter(VisitStep.collect, p), isFalse, reason: '$bad');
        expect(VisitGuard.canEnter(VisitStep.fail, p), isTrue);
      }
    });

    test('consent given:false blocks Collect', () {
      final p = from([arrived(), identity(), consent(false)]);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isFalse);
      expect(VisitGuard.resumeAt(p), VisitStep.fail);
    });

    test('order matters (US-08-8): consent/identity without arrival, or collect before consent, never opens later steps', () {
      expect(VisitGuard.canEnter(VisitStep.collect, from([identity(), consent(true)])), isFalse);
      expect(VisitGuard.canEnter(VisitStep.collect, from([arrived(), consent(true)])), isFalse, reason: 'no identity check');
      expect(VisitGuard.canEnter(VisitStep.payment, from([arrived(), collected('t1'), collected('t2')])), isFalse,
          reason: 'collected without identity + consent is not a valid history');
    });

    test('tubes resolved = every expected specimen_id has a collected OR not_collected mutation', () {
      final base = [arrived(), identity(), consent(true)];
      expect(VisitGuard.canEnter(VisitStep.payment, from([...base, collected('t1')])), isFalse);
      expect(VisitGuard.canEnter(VisitStep.payment, from([...base, collected('t1'), notCollected('t2')])), isTrue);
      expect(VisitGuard.canEnter(VisitStep.complete, from([...base, notCollected('t1'), notCollected('t2')])), isTrue);
    });

    test('the same specimen twice does not count as two tubes', () {
      final base = [arrived(), identity(), consent(true)];
      expect(VisitGuard.canEnter(VisitStep.payment, from([...base, collected('t1'), collected('t1')])), isFalse);
    });

    test('a payment mutation does not finish the visit; visit.completed / visit.failed are terminal', () {
      final base = [arrived(), identity(), consent(true), collected('t1'), collected('t2')];
      final paid = [
        ...base,
        ('payment.captured', {'order_id': 'o', 'payment_method_code': 'cash', 'amount': {'amount_paisa': 1, 'currency': 'NPR'}})
      ];
      expect(VisitGuard.canEnter(VisitStep.complete, from(paid)), isTrue);
      expect(VisitGuard.allowed(from([...paid, ('visit.completed', {'outcome': 'collected'})])), isEmpty);
      expect(VisitGuard.allowed(from([arrived(), ('visit.failed', {'reason_code': 'patient_refused', 'gps': _gps})])), isEmpty);
    });

    test('specimensStale flag is honoured when rebuilding', () {
      final p = from([arrived(), identity(), consent(true)], stale: true);
      expect(VisitGuard.canEnter(VisitStep.collect, p), isFalse);
    });
  });
}
