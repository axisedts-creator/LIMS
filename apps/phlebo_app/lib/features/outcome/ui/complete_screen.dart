// HC-T26 M8 Complete (US-07-6; 04-UI-UX §3.8; TRD §6.3 visit.completed). LD-140 (2026-11-13): lims_ui + tokens only.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../visit/data/mutation_sink.dart';
import '../../visit/domain/visit_models.dart';
import '../../visit/ui/save_once.dart';

class PaymentSummary {
  const PaymentSummary({required this.methodDisplay, required this.amountPaisa});

  final String methodDisplay;
  final int amountPaisa;
}

class CompleteScreen extends StatefulWidget {
  const CompleteScreen({
    super.key,
    required this.visit,
    required this.collectedCount,
    required this.notCollectedCount,
    required this.payment,
    required this.sink,
    required this.onFinished,
  });

  final VisitView visit;
  final int collectedCount;
  final int notCollectedCount;
  final PaymentSummary? payment;
  final MutationSink sink;
  final VoidCallback onFinished;

  @override
  State<CompleteScreen> createState() => _CompleteScreenState();
}

class _CompleteScreenState extends State<CompleteScreen> with SaveOnce<CompleteScreen> {
  Future<void> _finish() async {
    ScaffoldMessenger.of(context).clearSnackBars(); // a new attempt must not show an older "Saved on phone"
    final ok = await runSave(() => widget.sink.enqueue(
          type: 'visit.completed',
          visitId: widget.visit.visitId,
          visitLabel: widget.visit.label,
          payload: {'outcome': widget.notCollectedCount > 0 ? 'partial' : 'collected'},
        ));
    if (!ok || !mounted) return;
    LimsSnackbar.show(context, 'Saved on phone. It will upload automatically.', tone: 'success');
    widget.onFinished();
  }

  @override
  Widget build(BuildContext context) {
    final pay = widget.payment;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Visit summary',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          LimsCard(
            title: 'Tubes',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Collected: ${widget.collectedCount}'),
              Text('Not collected: ${widget.notCollectedCount}'),
            ]),
          ),
          const SizedBox(height: LimsTokens.space3),
          LimsCard(
            title: 'Payment',
            child: Text(pay == null ? 'Not recorded: patient pays at centre' : '${pay.methodDisplay} · NPR ${formatPaisa(pay.amountPaisa)}'),
          ),
          const SizedBox(height: LimsTokens.space4),
          saveErrorNotice(),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: 'Finish visit', onPressed: saving ? null : _finish),
        ]),
      ),
    );
  }
}
