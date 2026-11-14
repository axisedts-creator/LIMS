// A14 Smart summary (04-UI-UX A14; 03-APP-FLOW §11 A14: skeleton | error | content + disclaimer | app lock; US-EN-09.2 shown as returned, 09.3 none, 09.4 superseded).
// Fetches E24 ONCE on open (no polling). The app recomputes no number and invents no wording: unknown band / status / trend words are not shown.
// LD-140 (2026-11-13): lims_ui components and token names only; every status shows tone, icon and word. REQ-SEC-109: LimsSecureScreen. Server detail never reaches the screen.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import 'smart_summary_api.dart';
import 'smart_summary_providers.dart';

const _defaultDisclaimer = 'This summary is for information only and does not replace advice from your doctor.';

typedef _Look = (String tone, IconData icon, String word);

const _bands = <String, _Look>{
  'good': ('success', Icons.check_circle_outline, 'Good'),
  'fair': ('warning', Icons.info_outline, 'Fair'),
  'needs_attention': ('danger', Icons.warning_amber_outlined, 'Needs attention'),
};
const _panelStatuses = <String, _Look>{
  'in_range': ('success', Icons.check_circle_outline, 'In range'),
  'borderline': ('warning', Icons.info_outline, 'Borderline'),
  'out_of_range': ('danger', Icons.warning_amber_outlined, 'Out of range'),
  'critical': ('critical', Icons.error_outline, 'Critical — contact your doctor'),
};
const _trends = <String, _Look>{
  'improved': ('success', Icons.trending_up, 'Improved'),
  'worsened': ('warning', Icons.trending_down, 'Worse'),
  'stable': ('neutral', Icons.trending_flat, 'Stable'),
};

typedef _Summary = ({
  ({num value, String? band})? score,
  List<({String name, String? status})> panels,
  List<String> deranged,
  List<String> advice,
  List<({int days, String text})> followUps,
  List<String> trends,
  String disclaimer,
});

/// Strict read of the SmartSummaryView wire body; any wrong shape throws (-> error state, never a crash).
_Summary _parse(Object? body) {
  if (body is! Map) throw const FormatException();
  List<Map<Object?, Object?>> list(String k) {
    final v = body[k];
    if (v == null) return const [];
    if (v is! List || v.any((e) => e is! Map)) throw const FormatException();
    return v.cast<Map<Object?, Object?>>();
  }

  String str(Object? v) => v is String ? v : throw const FormatException();
  final hs = body['health_score'];
  if (hs != null && (hs is! Map || hs['value'] is! num)) throw const FormatException();
  final d = body['disclaimer_text'];
  return (
    score: hs is Map ? (value: hs['value'] as num, band: hs['band'] is String ? hs['band'] as String : null) : null,
    panels: [
      for (final p in list('panels'))
        (name: p['display_name'] is String && (p['display_name'] as String).isNotEmpty ? p['display_name'] as String : str(p['panel_code']), status: p['status'] is String ? p['status'] as String : null)
    ],
    deranged: [for (final e in list('deranged')) str(e['text'])],
    advice: [for (final e in list('advice')) str(e['text'])],
    followUps: [for (final e in list('follow_ups')) (days: e['interval_days'] is int ? e['interval_days'] as int : throw const FormatException(), text: str(e['text']))],
    trends: [for (final e in list('trends')) if (e['direction'] is String) e['direction'] as String],
    disclaimer: d is String && d.isNotEmpty ? d : _defaultDisclaimer,
  );
}

Widget _status(_Look l) => Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(l.$2, size: LimsTokens.space4, color: limsTone(l.$1).fg),
      const SizedBox(width: LimsTokens.space1),
      Flexible(child: LimsStatusChip(kind: 'generic', status: l.$3, tone: l.$1, label: l.$3)),
    ]);

class SmartSummaryScreen extends ConsumerStatefulWidget {
  const SmartSummaryScreen({super.key, required this.reportId, required this.versionNo, this.superseded = false});

  final String reportId;
  final int versionNo;
  final bool superseded;

  @override
  ConsumerState<SmartSummaryScreen> createState() => _SmartSummaryScreenState();
}

class _SmartSummaryScreenState extends ConsumerState<SmartSummaryScreen> {
  late final PatientSmartSummaryApi _api = ref.read(patientSmartSummaryApiProvider);
  _Summary? _summary;
  String? _error; // LimsException code of the last failure
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_busy) return;
    _busy = true;
    if (_error != null) setState(() => _error = null);
    try {
      final s = _parse(await _api.getSmartSummary(reportId: widget.reportId, versionNo: widget.versionNo));
      if (mounted) setState(() => _summary = s);
    } on Object catch (e) {
      if (mounted) setState(() => _error = e is LimsException ? e.code : LimsErrorCodes.commonInternal);
    } finally {
      _busy = false;
    }
  }

  @override
  Widget build(BuildContext context) => LimsSecureScreen(
        child: Scaffold(appBar: AppBar(title: const Text('Smart summary')), body: _body()),
      );

  Widget _body() {
    final s = _summary;
    if (s != null) return _content(s);
    return switch (_error) {
      null => const Center(child: CircularProgressIndicator()),
      LimsErrorCodes.commonNotFound => const LimsEmptyState(title: 'No smart summary', message: 'There is no smart summary for this report.'),
      _ => LimsErrorState(title: "The summary can't be loaded right now", message: 'Please check your connection.', onRetry: _load),
    };
  }

  Widget _content(_Summary s) {
    final band = _bands[s.score?.band];
    Widget texts(List<String> xs) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final t in xs) Padding(padding: const EdgeInsets.only(bottom: LimsTokens.space2), child: Text(t)),
        ]);
    return ListView(padding: const EdgeInsets.all(LimsTokens.space4), children: [
      if (widget.superseded) Align(alignment: Alignment.centerLeft, child: _status(('neutral', Icons.history, 'Replaced by a newer version'))),
      if (s.score case final sc?)
        LimsCard(
          title: 'Health score',
          child: Row(children: [
            Text('${sc.value}/100', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(width: LimsTokens.space3),
            if (band != null) _status(band),
          ]),
        ),
      if (s.panels.isNotEmpty)
        LimsCard(
          title: 'Panels',
          child: Wrap(spacing: LimsTokens.space3, runSpacing: LimsTokens.space3, children: [
            for (final p in s.panels)
              Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(p.name),
                if (_panelStatuses[p.status] case final l?) _status(l),
              ]),
          ]),
        ),
      if (s.deranged.isNotEmpty) LimsCard(title: 'Results that need attention', child: texts(s.deranged)),
      if (s.advice.isNotEmpty) LimsCard(title: 'Advice', child: texts(s.advice)),
      if (s.followUps.isNotEmpty) LimsCard(title: 'Suggested follow-up', child: texts([for (final f in s.followUps) 'In ${f.days} days: ${f.text}'])),
      if (s.trends.any(_trends.containsKey))
        LimsCard(
          title: 'Trends',
          child: Wrap(spacing: LimsTokens.space2, runSpacing: LimsTokens.space2, children: [
            for (final t in s.trends)
              if (_trends[t] case final l?) _status(l),
          ]),
        ),
      const SizedBox(height: LimsTokens.space4),
      Text(s.disclaimer, style: Theme.of(context).textTheme.bodySmall),
    ]);
  }
}
