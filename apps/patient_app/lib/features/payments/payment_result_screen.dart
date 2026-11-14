// A15 Payment result, behind the app link /payments/{payment_request_id}/done (04-UI-UX A15; 03-APP-FLOW payment sequence + §10.1; 02-TRD §4.7 step 3; US-EN-10.3; REQ-SEC-059).
// "Paid" is shown only after E42 reports `completed`. Whatever the gateway put on the link is ignored: only the request id of the route is used, and the link is never read for a result.
// E42 on open, then every 3 s for up to 60 s; completed / failed / expired / review stop the polling. Without a result after 60 s, or when held for review: "We are confirming your payment" + [Check again] (one more E42).
// Polling only (TRD §4.6); it stops when the screen closes. LD-140: lims_ui components and token names only. REQ-SEC-109: LimsSecureScreen. Nothing is stored or written out.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../orders/orders_format.dart';
import 'payments_api.dart';
import 'payments_providers.dart';

enum _View { checking, paid, notCompleted, confirming, gone }

class PaymentResultScreen extends ConsumerStatefulWidget {
  /// [returnUri] is the app link that opened the screen; it is accepted for the router's sake and never inspected.
  const PaymentResultScreen({super.key, required this.paymentRequestId, this.returnUri});

  final String paymentRequestId;
  final Uri? returnUri;

  @override
  ConsumerState<PaymentResultScreen> createState() => _PaymentResultScreenState();
}

class _PaymentResultScreenState extends ConsumerState<PaymentResultScreen> {
  static const _interval = Duration(seconds: 3);
  static const _window = Duration(seconds: 60);

  late final PatientPaymentsApi _api = ref.read(patientPaymentsApiProvider);
  Timer? _timer;
  _View _view = _View.checking;
  int _ticks = 0;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(_interval, (_) => _tick());
    unawaited(_check());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _stop() => _timer?.cancel();

  void _tick() {
    if (++_ticks * _interval.inSeconds > _window.inSeconds) return _giveUp();
    unawaited(_check());
  }

  void _giveUp() {
    _stop();
    if (mounted && _view == _View.checking) setState(() => _view = _View.confirming);
  }

  Future<void> _check() async {
    if (_busy) return;
    _busy = true;
    try {
      final m = asMap(await _api.getPaymentRequest(paymentRequestId: widget.paymentRequestId));
      if (!mounted) return;
      final status = m?['status'];
      if (status == 'completed') {
        _stop();
        setState(() => _view = _View.paid);
      } else if (status == 'failed' || status == 'expired') {
        _stop();
        setState(() => _view = _View.notCompleted);
      } else if (m?['review'] == true) {
        _stop();
        setState(() => _view = _View.confirming);
      } else if (_ticks * _interval.inSeconds >= _window.inSeconds) {
        _giveUp(); // the last poll of the window found nothing final
      }
    } on LimsException catch (e) {
      if (!mounted) return;
      if (e.code == LimsErrorCodes.commonNotFound) {
        _stop();
        setState(() => _view = _View.gone);
      }
    } on Object {
      // transient: the next tick asks again, inside the window
    } finally {
      _busy = false;
    }
  }

  Future<void> _checkAgain() async {
    setState(() => _view = _View.checking);
    _ticks = 0;
    _stop();
    await _check();
    if (mounted && _view == _View.checking) setState(() => _view = _View.confirming); // still no result: back to the confirming text, no new polling loop
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: Scaffold(
          appBar: AppBar(title: const Text('Payment')),
          body: Padding(padding: const EdgeInsets.all(LimsTokens.space4), child: _body(context)),
        ),
      );

  Widget _body(BuildContext context) {
    switch (_view) {
      case _View.gone:
        return const LimsEmptyState(title: 'This payment is no longer available');
      case _View.paid:
        return _panel(context, tone: 'success', chip: 'Paid', text: 'Paid — thank you');
      case _View.notCompleted:
        return _panel(context, tone: 'danger', chip: 'Not completed', text: 'Payment not completed', action: LimsButton(label: 'Try again', onPressed: () => Navigator.of(context).maybePop()));
      case _View.confirming:
        return _panel(context, tone: 'warning', chip: 'Confirming', text: 'We are confirming your payment. This can take a few minutes.', action: LimsButton(label: 'Check again', onPressed: _checkAgain, secondary: true));
      case _View.checking:
        return _panel(context, tone: 'info', chip: 'Checking', text: 'Checking your payment…', busy: true);
    }
  }

  Widget _panel(BuildContext context, {required String tone, required String chip, required String text, Widget? action, bool busy = false}) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        LimsStatusChip(kind: 'generic', status: chip, tone: tone, label: chip),
        const SizedBox(height: LimsTokens.space3),
        Text(text, style: Theme.of(context).textTheme.titleLarge),
        if (busy) ...[const SizedBox(height: LimsTokens.space3), const LinearProgressIndicator()],
        if (action != null) ...[const SizedBox(height: LimsTokens.space4), action],
      ]);
}
