// HC-T26 host of M3-M9, driven by VisitGuard (US-07-1/2/3; review #2). LD-140 (2026-11-13): lims_ui + tokens only.
// The mutation log is the source of truth: the first step comes from the log (resume after a force-close) and every
// step change is re-checked against the guard, so a step whose prerequisites are not on file can never be shown.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../collect/ui/collect_screen.dart';
import '../../consent/ui/consent_screen.dart';
import '../../identity/ui/identity_screen.dart';
import '../../outcome/ui/complete_screen.dart';
import '../../outcome/ui/fail_visit_screen.dart';
import '../../payment/ui/payment_screen.dart';
import '../data/mutation_sink.dart';
import '../domain/visit_guard.dart';
import '../domain/visit_models.dart';
import 'visit_screen.dart';

typedef LogEntry = (String, Map<String, Object?>);

class VisitFlowScreen extends StatefulWidget {
  const VisitFlowScreen({
    super.key,
    required this.visit,
    required this.config,
    required this.otherVisitBarcodes,
    required this.sink,
    required this.readGps,
    required this.now,
    required this.launchUri,
    required this.onExit,
    this.initialLog = const [],
    this.scannerBuilder,
  });

  final VisitView visit;
  final VisitConfig config;
  final Set<String> otherVisitBarcodes;
  final MutationSink sink;
  final Future<Map<String, Object?>> Function() readGps;
  final DateTime Function() now;
  final Future<void> Function(Uri) launchUri;

  /// This visit's mutations already on the phone (type, payload), oldest first.
  final List<LogEntry> initialLog;
  final Widget Function(ValueChanged<String> onScanned)? scannerBuilder;

  /// 'completed' | 'failed'
  final ValueChanged<String> onExit;

  @override
  State<VisitFlowScreen> createState() => _VisitFlowScreenState();
}

class _VisitFlowScreenState extends State<VisitFlowScreen> implements MutationSink {
  late final List<LogEntry> _log = [...widget.initialLog];
  late VisitStep _step = VisitGuard.resumeAt(_progress);
  String? _failPreselect;

  VisitProgress get _progress => VisitProgress.fromMutations(
        _log,
        expectedTubes: widget.visit.tubes.length,
        specimensStale: widget.visit.specimensStale,
      );

  @override
  void initState() {
    super.initState();
    _failPreselect = _reasonForResume(_progress);
  }

  /// A visit reopened on a dead end (mismatch / refusal) goes straight to M9 with the reason already chosen.
  String? _reasonForResume(VisitProgress p) {
    if (p.identity == IdentityState.mismatch) return 'identity_mismatch';
    if (p.consent == ConsentState.refused) return 'patient_refused';
    return null;
  }

  /// Persist first (the real sink), then remember it in the in-memory view of the log.
  @override
  Future<SavedMutation> enqueue({
    required String type,
    String? visitId,
    String? visitLabel,
    required Map<String, Object?> payload,
  }) async {
    final saved = await widget.sink.enqueue(type: type, visitId: visitId, visitLabel: visitLabel, payload: payload);
    if (mounted) setState(() => _log.add((type, payload)));
    return saved;
  }

  void _go(VisitStep next, {String? failReason}) {
    // collect stays reachable as a step for a stale visit: the host then explains why instead of showing the scan UI.
    final p = _progress;
    final ok = VisitGuard.canEnter(next, p) || (next == VisitStep.collect && p.specimensStale && p.consent == ConsentState.given);
    setState(() {
      _step = ok ? next : VisitGuard.resumeAt(p);
      _failPreselect = failReason;
    });
  }

  Iterable<LogEntry> _of(String type) => _log.where((e) => e.$1 == type);

  PaymentSummary? get _payment {
    final e = _of('payment.captured').lastOrNull;
    if (e == null) return null;
    final code = e.$2['payment_method_code'];
    final display = widget.config.paymentMethods.where((m) => m.code == code).firstOrNull?.display ?? '$code';
    final amount = e.$2['amount'];
    final paisa = amount is Map ? amount['amount_paisa'] : null;
    return PaymentSummary(methodDisplay: display, amountPaisa: paisa is int ? paisa : 0);
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.visit;
    switch (_step) {
      case VisitStep.arrive:
        return VisitScreen(
          visit: v,
          config: widget.config,
          sink: this,
          readGps: widget.readGps,
          launchUri: widget.launchUri,
          onArrived: () => _go(VisitStep.identity),
          onCannotDo: () => _go(VisitStep.fail),
        );
      case VisitStep.identity:
        return IdentityScreen(
          visit: v,
          sink: this,
          onContinue: () => _go(VisitStep.consent),
          onFail: (reason) => _go(VisitStep.fail, failReason: reason),
        );
      case VisitStep.consent:
        return ConsentScreen(
          visit: v,
          config: widget.config,
          sink: this,
          onAgreed: () => _go(VisitStep.collect),
          onRefused: () => _go(VisitStep.fail, failReason: 'patient_refused'),
        );
      case VisitStep.collect:
        if (v.specimensStale) return _StaleBlock(onFail: () => _go(VisitStep.fail));
        return CollectScreen(
          visit: v,
          config: widget.config,
          otherVisitBarcodes: widget.otherVisitBarcodes,
          sink: this,
          readGps: widget.readGps,
          now: widget.now,
          scannerBuilder: widget.scannerBuilder,
          initialCollected: {for (final e in _of('specimen.collected')) e.$2['specimen_id']! as String},
          initialNotCollected: {for (final e in _of('specimen.not_collected')) e.$2['specimen_id']! as String: '${e.$2['reason_code']}'},
          onDone: () => _go(VisitStep.payment),
        );
      case VisitStep.payment:
        return PaymentScreen(
          visit: v,
          config: widget.config,
          sink: this,
          onRecorded: () => _go(VisitStep.complete),
          onSkipped: () => _go(VisitStep.complete),
        );
      case VisitStep.complete:
        return CompleteScreen(
          visit: v,
          collectedCount: _of('specimen.collected').length,
          notCollectedCount: _of('specimen.not_collected').length,
          payment: _payment,
          sink: this,
          onFinished: () => widget.onExit('completed'),
        );
      case VisitStep.fail:
        return FailVisitScreen(
          visit: v,
          config: widget.config,
          sink: this,
          readGps: widget.readGps,
          preselectedReasonCode: _failPreselect,
          onFailed: () => widget.onExit('failed'),
        );
    }
  }
}

/// specimens_stale (review #2): consent is on file but there are no trustworthy tubes, so Collect stays shut.
class _StaleBlock extends StatelessWidget {
  const _StaleBlock({required this.onFail});

  final VoidCallback onFail;

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: LimsScaffold(
          title: 'Collect tubes',
          body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
            const LimsErrorState(title: 'Tubes unavailable — refresh before collecting'),
            LimsButton(label: "Can't do this visit", onPressed: onFail),
          ]),
        ),
      );
}
