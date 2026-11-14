// A12 Reports list (04-UI-UX A12; 03-APP-FLOW §11 A12; US-EN-08.1, 08.2). Fetches E22 on open, on pull-to-refresh and when "Show older versions" flips (include_superseded); infinite scroll by cursor. No polling.
// LD-140: lims_ui components and token names only. REQ-SEC-109: LimsSecureScreen. PHI stays in widget state (never persisted / logged); ids and server detail never reach the screen.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';

import '../orders/orders_format.dart';
import 'report_viewer_screen.dart';
import 'reports_api.dart';
import 'reports_providers.dart';

/// kind -> (LimsStatusChip tone, label); an unknown kind is "Report" (x-extensible, the raw code is never shown).
const reportKinds = <String, (String, String)>{
  'final': ('success', 'Final'),
  'partial': ('warning', 'Partial'),
  'preliminary': ('info', 'Preliminary'),
  'amended': ('warning', 'Amended'),
  'addendum': ('info', 'Addendum'),
};

class ReportsListScreen extends ConsumerStatefulWidget {
  const ReportsListScreen({super.key});

  @override
  ConsumerState<ReportsListScreen> createState() => _ReportsListScreenState();
}

class _ReportsListScreenState extends ConsumerState<ReportsListScreen> {
  late final PatientReportsApi _api = ref.read(patientReportsApiProvider);
  List<Map<String, Object?>> _rows = const [];
  String? _cursor;
  bool _older = false, _failed = false, _loaded = false, _busy = false;
  int _gen = 0; // a newer load (toggle / refresh) makes an older answer stale

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    if (more && _busy) return;
    final gen = more ? _gen : ++_gen;
    _busy = true;
    try {
      final body = asMap(await _api.listReports(includeSuperseded: _older, cursor: more ? _cursor : null));
      if (!mounted || gen != _gen) return;
      final next = asMap(body?['page'])?['next_cursor'];
      setState(() {
        _rows = more ? [..._rows, ...mapList(body?['data'])] : mapList(body?['data']);
        _cursor = next is String ? next : null;
        _failed = false;
        _loaded = true;
      });
    } on Object {
      if (mounted && gen == _gen) setState(() => _failed = true); // never show server detail
    } finally {
      if (gen == _gen) _busy = false;
    }
  }

  void _toggle(bool v) {
    setState(() {
      _older = v;
      _rows = const [];
      _cursor = null;
      _failed = false;
      _loaded = false;
    });
    _load();
  }

  Future<void> _reload() {
    _cursor = null;
    return _load();
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: Scaffold(
          appBar: AppBar(title: const Text('Reports')),
          body: Column(children: [
            SwitchListTile(title: const Text('Show older versions'), value: _older, onChanged: _toggle),
            Expanded(child: _body()),
          ]),
        ),
      );

  Widget _body() {
    if (_rows.isEmpty) {
      if (_failed) return LimsErrorState(title: 'Something went wrong', message: 'We could not load your reports.', onRetry: _reload);
      if (!_loaded) return const Center(child: CircularProgressIndicator());
      return const LimsEmptyState(title: "No reports yet. You'll see them here when the lab releases them.");
    }
    return RefreshIndicator(
      onRefresh: _reload,
      // ponytail: plain (non-lazy) list + "Show more" button; a page is <= 50 rows. Lazy infinite scroll if pages grow.
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(LimsTokens.space4),
        child: Column(children: [
          for (final r in _rows) _ReportRow(report: r),
          if (_cursor != null) LimsButton(label: 'Show more', secondary: true, onPressed: () => _load(more: true)),
        ]),
      ),
    );
  }
}

class _ReportRow extends StatelessWidget {
  const _ReportRow({required this.report});

  final Map<String, Object?> report;

  @override
  Widget build(BuildContext context) {
    final id = report['report_id'], version = report['version_no'];
    final (tone, label) = reportKinds[report['kind']] ?? ('neutral', 'Report');
    final panels = report['panel_names'] is List ? [for (final p in report['panel_names']! as List) if (p is String) p] : const <String>[];
    final replaced = report['status'] == 'superseded';
    return Padding(
      padding: const EdgeInsets.only(bottom: LimsTokens.space3),
      child: InkWell(
        onTap: id is String && version is int ? () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ReportViewerScreen(reportId: id, versionNo: version))) : null,
        child: LimsCard(
          title: panels.isEmpty ? 'Lab report' : panels.join(', '),
          child: Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space1, crossAxisAlignment: WrapCrossAlignment.center, children: [
            LimsStatusChip(kind: 'generic', status: report['kind'] is String ? report['kind']! as String : 'unknown', tone: tone, label: label),
            if (report['smart_summary_available'] == true) const LimsStatusChip(kind: 'generic', status: 'smart_summary', tone: 'info', label: 'Smart summary'),
            Text(dateTimeText(report['released_at'])),
            if (replaced) const Text('Replaced by a newer version'),
          ]),
        ),
      ),
    );
  }
}
