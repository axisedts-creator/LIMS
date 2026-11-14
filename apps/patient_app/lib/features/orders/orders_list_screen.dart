// A10 Orders list (04-UI-UX A10; 03-APP-FLOW §11 A10; US-EN-07.1). Fetches E20 on open and on pull-to-refresh; infinite scroll by cursor. NOT a polling screen (only A11 polls, US-EN-07.8).
// LD-140: lims_ui components and token names only. REQ-SEC-109: LimsSecureScreen. PHI stays in widget state (never persisted / logged).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import 'order_detail_screen.dart';
import 'orders_api.dart';
import 'orders_format.dart';
import 'orders_providers.dart';

class OrdersListScreen extends ConsumerStatefulWidget {
  const OrdersListScreen({super.key});

  @override
  ConsumerState<OrdersListScreen> createState() => _OrdersListScreenState();
}

class _OrdersListScreenState extends ConsumerState<OrdersListScreen> {
  late final PatientOrdersApi _api = ref.read(patientOrdersApiProvider);
  List<Map<String, Object?>> _rows = const [];
  String? _cursor;
  bool _busy = false, _failed = false, _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    if (_busy) return;
    _busy = true;
    try {
      final body = asMap(await _api.listOrders(cursor: more ? _cursor : null));
      if (!mounted) return;
      final page = asMap(body?['page']);
      final next = page?['next_cursor'];
      setState(() {
        _rows = more ? [..._rows, ...mapList(body?['data'])] : mapList(body?['data']);
        _cursor = next is String ? next : null;
        _failed = false;
        _loaded = true;
      });
    } on Object {
      if (mounted) setState(() => _failed = true); // never show server detail
    } finally {
      _busy = false;
    }
  }

  Future<void> _reload() async {
    _cursor = null;
    await _load();
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: Scaffold(
          appBar: AppBar(title: const Text('Orders')),
          body: _body(context),
        ),
      );

  Widget _body(BuildContext context) {
    if (_rows.isEmpty) {
      if (_failed) return LimsErrorState(title: 'Something went wrong', message: 'We could not load your orders.', onRetry: _reload);
      if (!_loaded) return const Center(child: CircularProgressIndicator());
      return const LimsEmptyState(title: 'No orders yet');
    }
    return RefreshIndicator(
      onRefresh: _reload,
      child: ListView.builder(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(LimsTokens.space4),
        itemCount: _rows.length,
        itemBuilder: (context, i) {
          if (i == _rows.length - 1 && _cursor != null) WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? _load(more: true) : null); // infinite scroll
          return _OrderRow(order: _rows[i]);
        },
      ),
    );
  }
}

class _OrderRow extends StatelessWidget {
  const _OrderRow({required this.order});

  final Map<String, Object?> order;

  @override
  Widget build(BuildContext context) {
    final (tone, label) = stageLook(order['stage']);
    final id = order['order_id'];
    final reports = order['report_count'] is int ? order['report_count'] as int : 0;
    final warn = limsTone('warning');
    return Padding(
      padding: const EdgeInsets.only(bottom: LimsTokens.space3),
      child: InkWell(
        onTap: id is String ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OrderDetailScreen(orderId: id))) : null,
        child: LimsCard(
          title: dateText(order['registered_at']),
          child: Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space1, crossAxisAlignment: WrapCrossAlignment.center, children: [
            LimsStatusChip(kind: 'generic', status: order['stage'] is String ? order['stage']! as String : 'unknown', tone: tone, label: label),
            if (order['payment_due'] == true)
              Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.payments_outlined, color: warn.fg),
                const SizedBox(width: LimsTokens.space1),
                Text('Payment due', style: TextStyle(color: warn.fg)),
              ]),
            Text(reports == 1 ? '1 report' : '$reports reports'),
          ]),
        ),
      ),
    );
  }
}
