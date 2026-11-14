// HC-T26 M7 Payment (US-07-1 / US-07-7; 04-UI-UX §3.7; TRD §6.3 payment.captured). LD-140 (2026-11-13): lims_ui + tokens only.
// Methods and requiresReference come from config (never hard-coded). The amount is integer paisa end to end (LimsMoneyField).
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../visit/data/mutation_sink.dart';
import '../../visit/domain/visit_models.dart';
import '../../visit/ui/save_once.dart';

const _minPaisa = 1; // NPR 0.01
const _maxPaisa = 50000000; // NPR 500,000.00

class PaymentScreen extends StatefulWidget {
  const PaymentScreen({
    super.key,
    required this.visit,
    required this.config,
    required this.sink,
    required this.onRecorded,
    required this.onSkipped,
  });

  final VisitView visit;
  final VisitConfig config;
  final MutationSink sink;
  final VoidCallback onRecorded;
  final VoidCallback onSkipped;

  @override
  State<PaymentScreen> createState() => _PaymentScreenState();
}

class _PaymentScreenState extends State<PaymentScreen> with SaveOnce<PaymentScreen> {
  late final _amountText = TextEditingController(text: paisaToInput(widget.visit.amountDuePaisa));
  final _reference = TextEditingController();
  late int? _paisa = widget.visit.amountDuePaisa;
  PaymentMethodOption? _method;
  String? _amountError;
  String? _referenceError;

  @override
  void dispose() {
    _amountText.dispose();
    _reference.dispose();
    super.dispose();
  }

  Future<void> _record() async {
    final method = _method;
    if (method == null) return;
    final paisa = _paisa;
    final reference = _reference.text.trim();
    final badAmount = paisa == null || paisa < _minPaisa || paisa > _maxPaisa;
    final badReference = method.requiresReference && reference.isEmpty;
    setState(() {
      _amountError = badAmount ? 'Enter an amount from 0.01 to 500,000.00' : null;
      _referenceError = badReference ? 'Enter the transaction / QR reference' : null;
    });
    if (badAmount || badReference) return;
    if (paisa != widget.visit.amountDuePaisa) {
      final go = await LimsConfirmDialog.show(
        context,
        title: 'Check amount',
        message: 'Amount differs from the amount due (NPR ${formatPaisa(widget.visit.amountDuePaisa)}). Continue?',
        confirmLabel: 'Continue',
        cancelLabel: 'Back',
      );
      if (go == null || !mounted) return;
    }
    final ok = await runSave(() => widget.sink.enqueue(
          type: 'payment.captured',
          visitId: widget.visit.visitId,
          visitLabel: widget.visit.label,
          payload: {
            'order_id': widget.visit.orderId,
            'payment_method_code': method.code,
            'amount': {'amount_paisa': paisa, 'currency': 'NPR'},
            if (method.requiresReference) 'reference': reference.length > 100 ? reference.substring(0, 100) : reference,
          },
        ));
    if (ok) widget.onRecorded();
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.visit;
    final method = _method;
    return LimsSecureScreen(
      child: LimsScaffold(
        title: 'Payment',
        body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
          Text('Amount due: NPR ${formatPaisa(v.amountDuePaisa)} as of ${v.amountAsOf}', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: LimsTokens.space3),
          for (final m in widget.config.paymentMethods)
            ChoiceTile(
              title: m.display,
              selected: method == m,
              onTap: saving ? null : () => setState(() => _method = m),
            ),
          const SizedBox(height: LimsTokens.space3),
          LimsMoneyField(
            key: const ValueKey('payment.amount'),
            label: 'Amount (NPR)',
            controller: _amountText,
            errorText: _amountError,
            onChanged: (p) => setState(() {
              _paisa = p;
              _amountError = null;
            }),
          ),
          if (method != null && method.requiresReference)
            LimsTextField(
              key: const ValueKey('payment.reference'),
              label: 'Transaction / QR reference',
              maxLength: 100,
              sensitive: true,
              controller: _reference,
              errorText: _referenceError,
              onChanged: (_) => setState(() => _referenceError = null),
            ),
          const SizedBox(height: LimsTokens.space3),
          saveErrorNotice(),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: 'Record payment', onPressed: method == null || saving ? null : _record),
          const SizedBox(height: LimsTokens.space2),
          Text('This records the payment. The bill receipt is issued by the centre.', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: LimsTokens.space3),
          LimsButton(label: 'Skip — patient pays at centre', secondary: true, onPressed: saving ? null : widget.onSkipped),
        ]),
      ),
    );
  }
}
