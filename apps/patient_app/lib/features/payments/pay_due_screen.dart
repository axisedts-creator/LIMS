// A15 Pay due, start view (04-UI-UX A15; 03-APP-FLOW §4.2 + §10.1 A15 row; 02-TRD §4.7; US-EN-10.1 / 10.2 / 10.4 / 10.6).
// The sum is read-only text from the order projection; the app sends the gateway only (REQ-SEC-046). Continue -> E41 (one Idempotency-Key per choice, reused by a retry, P-8) -> E42 every 2 s for up to 30 s
// while queued -> on ready the action url opens ONCE in the system browser and is never shown. Polling only (TRD §4.6); it stops when the screen closes. Failed -> the mapped text of 03-APP-FLOW §10.1; the raw code is never shown.
// LD-140: lims_ui components and token names only. REQ-SEC-109: LimsSecureScreen. Only an https action url is ever opened.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../bookings/bookings_api.dart' show newIdempotencyKey;
import '../orders/orders_format.dart';
import 'payments_api.dart';
import 'payments_providers.dart';

const _gatewayLabels = {'esewa': 'eSewa', 'khalti': 'Khalti'};

/// 03-APP-FLOW §10.1 A15: failure_code -> text. Anything else gets the generic line.
const _failureText = {
  'payments.nothing_due': 'Nothing to pay',
  'payments.intent_open_exists': 'A payment is already in progress',
  'payments.amount_not_supported': "This amount can't be paid online",
  'payments.gateway_not_available': 'This payment method is unavailable',
};
const _generic = 'We could not start the payment. Please try again.';

enum _Phase { choose, preparing, opening, failed }

class PayDueScreen extends ConsumerStatefulWidget {
  const PayDueScreen({super.key, required this.orderId, required this.amountPaisa, required this.gateways});

  final String orderId;
  final int amountPaisa;
  final List<String> gateways;

  @override
  ConsumerState<PayDueScreen> createState() => _PayDueScreenState();
}

class _PayDueScreenState extends ConsumerState<PayDueScreen> {
  static const _interval = Duration(seconds: 2);
  static const _window = Duration(seconds: 30);

  late final PatientPaymentsApi _api = ref.read(patientPaymentsApiProvider);
  late final Future<void> Function(Uri) _open = ref.read(paymentUrlOpenerProvider);
  late String _gateway = widget.gateways.isEmpty ? 'khalti' : widget.gateways.first;
  Timer? _timer;
  String? _key, _requestId, _message;
  _Phase _phase = _Phase.choose;
  int _polls = 0;
  bool _busy = false, _opened = false;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _continue() async {
    if (_busy || _phase == _Phase.preparing || _phase == _Phase.opening) return;
    _busy = true;
    _key ??= newIdempotencyKey(); // a retry of the same choice reuses it (P-8)
    setState(() {
      _phase = _Phase.preparing;
      _message = null;
    });
    try {
      _handle(await _api.createPaymentRequest(orderId: widget.orderId, gateway: _gateway, idempotencyKey: _key!), fromCreate: true);
    } on Object {
      if (mounted) {
        setState(() {
          _phase = _Phase.choose; // same key on the retry
          _message = _generic;
        });
      }
    } finally {
      _busy = false;
    }
  }

  void _handle(Object? body, {bool fromCreate = false}) {
    if (!mounted) return;
    final m = asMap(body);
    final status = m?['status'];
    if (m == null || m['id'] is! String) return _fail(_generic);
    _requestId = m['id']! as String;
    if (status == 'ready') return _ready(asMap(m['action']));
    if (status == 'failed' || status == 'expired') return _fail(_failureText[m['failure_code']] ?? _generic);
    if (status == 'queued' && fromCreate) _startPolling();
  }

  void _ready(Map<String, Object?>? action) {
    _timer?.cancel();
    final url = action?['url'] is String ? Uri.tryParse(action!['url']! as String) : null;
    if (url == null || url.scheme != 'https') return _fail(_generic);
    setState(() => _phase = _Phase.opening);
    if (_opened) return;
    _opened = true; // once, however long the screen stays
    unawaited(_open(url));
  }

  void _fail(String text) {
    _timer?.cancel();
    _key = null; // a terminal request is over: the next Continue is a new request
    setState(() {
      _phase = _Phase.failed;
      _message = text;
    });
  }

  void _startPolling() {
    _timer?.cancel();
    _polls = 0;
    _timer = Timer.periodic(_interval, (_) => _poll());
  }

  Future<void> _poll() async {
    if (_busy || _requestId == null) return;
    if (++_polls * _interval.inSeconds > _window.inSeconds) {
      _timer?.cancel();
      return;
    }
    _busy = true;
    try {
      _handle(await _api.getPaymentRequest(paymentRequestId: _requestId!));
    } on Object {
      // transient: the next tick asks again, inside the window
    } finally {
      _busy = false;
    }
    if (_polls * _interval.inSeconds >= _window.inSeconds && _phase == _Phase.preparing) {
      _timer?.cancel();
      if (mounted) _fail(_generic);
    }
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: Scaffold(
          appBar: AppBar(title: const Text('Pay due')),
          body: ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
            Text(rupees(widget.amountPaisa), style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: LimsTokens.space4),
            ..._choice(),
            if (_inFlight) ..._progress(),
          ]),
        ),
      );

  bool get _inFlight => _phase == _Phase.preparing || _phase == _Phase.opening;

  List<Widget> _progress() => [
        const SizedBox(height: LimsTokens.space4),
        const Center(child: CircularProgressIndicator()),
        const SizedBox(height: LimsTokens.space3),
        Center(child: Text(_phase == _Phase.opening ? 'Opening ${_gatewayLabels[_gateway]}…' : 'Preparing payment…')),
      ];

  List<Widget> _choice() => [
        if (_message != null) ...[
          Align(alignment: Alignment.centerLeft, child: LimsStatusChip(kind: 'generic', status: 'failed', tone: 'danger', label: 'Not started')),
          const SizedBox(height: LimsTokens.space2),
          Text(_message!),
          const SizedBox(height: LimsTokens.space4),
        ],
        Text('Pay with', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: LimsTokens.space2),
        LimsSegmentedControl<String>(
          options: [for (final g in widget.gateways) if (_gatewayLabels.containsKey(g)) (value: g, label: _gatewayLabels[g]!)],
          value: _gateway,
          onChanged: (g) {
            if (_inFlight || g == _gateway) return;
            setState(() {
              _key = null; // another choice is another request
              _gateway = g;
            });
          },
        ),
        const SizedBox(height: LimsTokens.space4),
        LimsButton(label: 'Continue', onPressed: _inFlight ? null : _continue),
      ];
}
