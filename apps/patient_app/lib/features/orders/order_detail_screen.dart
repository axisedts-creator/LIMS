// A11 Order detail (04-UI-UX A11; 03-APP-FLOW §11 A11; US-EN-07.5-8). Polls E21 every 30 s [CONV] (02-TRD §4.6 order_poll_seconds default) with If-None-Match = the last body etag; a 304 (null) changes nothing.
// Polling runs only in the foreground: it stops on hidden / paused / detached, restarts with one refresh on resumed (inactive - a system dialog - does not stop it), stops when the screen
// closes, on 404 (order no longer visible) and when the session ends. At most one E21 is in flight. Polling only, no server push (TRD §4.6).
// LD-140: lims_ui components and token names only. REQ-SEC-109: LimsSecureScreen. PHI stays in widget state (never persisted / logged); server detail is never shown.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../app/providers.dart';
import '../../core/session/session_controller.dart';
import 'orders_api.dart';
import 'orders_format.dart';
import 'orders_providers.dart';

class OrderDetailScreen extends ConsumerStatefulWidget {
  const OrderDetailScreen({super.key, required this.orderId});

  final String orderId;

  @override
  ConsumerState<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends ConsumerState<OrderDetailScreen> {
  static const _interval = Duration(seconds: 30); // [CONV] order_poll_seconds default

  late final PatientOrdersApi _api = ref.read(patientOrdersApiProvider);
  late final SessionController _session = ref.read(sessionControllerProvider);
  late final AppLifecycleListener _life;
  Timer? _timer;
  Map<String, Object?>? _order;
  String? _etag;
  DateTime? _checkedAt;
  bool _busy = false, _failed = false, _gone = false, _ended = false;

  @override
  void initState() {
    super.initState();
    _session.status.addListener(_onSession);
    _life = AppLifecycleListener(onStateChange: _onLifecycle);
    _startPolling();
  }

  @override
  void dispose() {
    _session.status.removeListener(_onSession);
    _life.dispose();
    _timer?.cancel();
    super.dispose();
  }

  void _startPolling() {
    _timer?.cancel();
    _timer = Timer.periodic(_interval, (_) => _fetch());
    _fetch();
  }

  void _stopPolling() {
    _timer?.cancel();
    _timer = null;
  }

  void _onLifecycle(AppLifecycleState s) {
    switch (s) {
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _stopPolling();
      case AppLifecycleState.resumed:
        if (!_ended && _timer == null) _startPolling(); // one refresh now, then the 30 s cadence: no catch-up burst
      case AppLifecycleState.inactive:
        break;
    }
  }

  void _onSession() {
    if (_session.status.value != SessionStatus.signedOut) return;
    _ended = true; // logout / expiry: stop and drop the order from memory (TRD §3.5)
    _stopPolling();
    if (mounted) setState(() => _order = null);
  }

  Future<void> _fetch() async {
    if (_busy || _ended) return;
    _busy = true;
    try {
      final body = await _api.getOrder(orderId: widget.orderId, ifNoneMatch: _etag);
      if (!mounted || _ended) return;
      setState(() {
        _checkedAt = DateTime.now();
        _failed = false;
        final m = asMap(body);
        if (m != null) {
          _order = m;
          _etag = m['etag'] is String ? m['etag']! as String : null;
        } else if (body != null) {
          _failed = true;
        }
      });
    } on LimsException catch (e) {
      if (!mounted || _ended) return;
      if (e.code == LimsErrorCodes.commonNotFound) {
        _ended = true; // revoked link / hidden order: the message replaces the data and nothing polls again
        _stopPolling();
        setState(() {
          _gone = true;
          _order = null;
          _etag = null;
        });
      } else {
        setState(() => _failed = true); // keep the last known state; the next tick tries again
      }
    } on Object {
      if (mounted && !_ended) setState(() => _failed = true);
    } finally {
      _busy = false;
    }
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: Scaffold(
          appBar: AppBar(title: const Text('Order')),
          body: _body(context),
        ),
      );

  Widget _body(BuildContext context) {
    if (_gone) return const LimsEmptyState(title: 'This order is no longer available');
    final o = _order;
    if (o == null) {
      if (_ended) return const SizedBox.shrink();
      if (_failed) return LimsErrorState(title: 'Something went wrong', message: 'We could not load this order.', onRetry: _fetch);
      return const Center(child: CircularProgressIndicator());
    }
    final (tone, label) = stageLook(o['stage']);
    final checked = _checkedAt;
    return ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
      Text(dateTimeText(o['registered_at']), style: Theme.of(context).textTheme.titleMedium),
      if (o['centre_display_name'] is String) Text(o['centre_display_name']! as String),
      const SizedBox(height: LimsTokens.space2),
      Align(alignment: Alignment.centerLeft, child: LimsStatusChip(kind: 'generic', status: o['stage'] is String ? o['stage']! as String : 'unknown', tone: tone, label: label)),
      const SizedBox(height: LimsTokens.space4),
      LimsStageTimeline(steps: _steps(o['stage'])),
      if (o['payment_due'] == true) ...[const SizedBox(height: LimsTokens.space4), _PaymentDue(balance: asMap(o['balance_due']))],
      const SizedBox(height: LimsTokens.space4),
      ..._samples(context, o),
      ..._reports(context, o),
      const SizedBox(height: LimsTokens.space4),
      if (checked != null) Text(updatedText(checked), style: Theme.of(context).textTheme.bodySmall),
      if (_failed) Text('Could not refresh. Showing the last update.', style: Theme.of(context).textTheme.bodySmall),
    ]);
  }

  List<LimsStep> _steps(Object? stage) {
    const names = ['Registered', 'Sample collected', 'In the lab', 'Report ready'];
    if (stage == 'recollection_needed') {
      return [
        (label: names[0], state: LimsStepState.done),
        (label: names[1], state: LimsStepState.done),
        (label: 'New sample needed — the lab will contact you', state: LimsStepState.alert),
        (label: names[3], state: LimsStepState.todo),
      ];
    }
    final cur = switch (stage) { 'registered' => 0, 'sample_collected' => 1, 'in_lab' || 'partial_report' => 2, 'report_ready' => 4, _ => -1 };
    if (cur < 0) return const []; // cancelled / unknown: the chip says it, no progress to draw
    return [for (var i = 0; i < names.length; i++) (label: names[i], state: i < cur ? LimsStepState.done : (i == cur ? LimsStepState.current : LimsStepState.todo))];
  }

  List<Widget> _samples(BuildContext context, Map<String, Object?> o) {
    final list = mapList(o['specimens']);
    if (list.isEmpty) return const [];
    return [
      Text('Samples', style: Theme.of(context).textTheme.titleMedium),
      for (final s in list)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: LimsTokens.space1),
          child: Text(_sampleLine(s)), // no specimen type names, no rejection reasons (PRD US-EN-07.4)
        ),
      const SizedBox(height: LimsTokens.space4),
    ];
  }

  String _sampleLine(Map<String, Object?> s) {
    final received = s['received_at'];
    final collected = s['collected_at'];
    final when = received != null ? ', received ${dateTimeText(received)}' : (collected != null ? ', collected ${dateTimeText(collected)}' : '');
    return 'Sample ${s['specimen_ref']} — ${stageLook(s['stage']).$2}$when';
  }

  List<Widget> _reports(BuildContext context, Map<String, Object?> o) {
    final list = mapList(o['reports']).where((r) => r['status'] != 'superseded').toList();
    if (list.isEmpty) return const [];
    const kinds = {'final': 'Final report', 'partial': 'Partial report', 'preliminary': 'Preliminary report', 'amended': 'Amended report', 'addendum': 'Addendum'};
    return [
      Text('Reports', style: Theme.of(context).textTheme.titleMedium),
      for (final r in list)
        LimsListTile(
          title: kinds[r['kind']] ?? 'Report', // an unknown kind is passed through as "Report" (x-extensible)
          subtitle: [if (r['panel_names'] is List) (r['panel_names']! as List).whereType<String>().join(', '), dateText(r['released_at'])].where((e) => e.isNotEmpty).join(' · '),
        ),
    ];
  }
}

class _PaymentDue extends StatelessWidget {
  const _PaymentDue({required this.balance});

  final Map<String, Object?>? balance;

  @override
  Widget build(BuildContext context) {
    final c = limsTone('warning');
    final amount = balance == null ? '' : ' ${rupees(balance!['amount_paisa'])}';
    return Container(
      width: double.infinity,
      color: c.bg,
      padding: const EdgeInsets.all(LimsTokens.space3),
      child: Row(children: [
        Icon(Icons.payments_outlined, color: c.fg),
        const SizedBox(width: LimsTokens.space2),
        Expanded(child: Text('Payment due$amount — your report will be released after payment', style: TextStyle(color: c.fg))),
      ]),
    );
  }
}
