// Reports: connected to E22 listMyReports with profile filtering (E13)
// and PDF viewer navigation (E23 ReportViewerScreen). AI Smart Summary held pending clinical approval.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../bookings/bookings_providers.dart';
import '../orders/orders_format.dart';
import '../reports/report_viewer_screen.dart';
import '../reports/reports_api.dart';
import '../reports/reports_list_screen.dart';
import '../reports/reports_providers.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnReportsScreen extends ConsumerStatefulWidget {
  const MhnReportsScreen({super.key, this.isTab = false});
  final bool isTab;

  @override
  ConsumerState<MhnReportsScreen> createState() => _MhnReportsScreenState();
}

class _MhnReportsScreenState extends ConsumerState<MhnReportsScreen> {
  String? _selectedProfileId;
  String _who = 'self';
  bool _includeSuperseded = false;
  List<Map<String, Object?>> _serverRows = const [];
  String? _cursor;
  bool _busy = false, _failed = false, _loaded = false;
  int _gen = 0;

  PatientReportsApi? _getApi() {
    try {
      return ref.read(patientReportsApiProvider);
    } catch (_) {
      return null;
    }
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    final api = _getApi();
    if (api == null) {
      if (mounted) setState(() { _loaded = true; _failed = true; });
      return;
    }
    if (more && _busy) return;
    final gen = more ? _gen : ++_gen;
    _busy = true;
    try {
      final body = asMap(
        await api.listReports(
          profileId: _selectedProfileId,
          includeSuperseded: _includeSuperseded,
          cursor: more ? _cursor : null,
        ),
      );
      if (!mounted || gen != _gen) return;
      final next = asMap(body?['page'])?['next_cursor'];
      setState(() {
        _serverRows = more
            ? [..._serverRows, ...mapList(body?['data'])]
            : mapList(body?['data']);
        _cursor = next is String ? next : null;
        _failed = false;
        _loaded = true;
      });
    } on Object {
      if (mounted && gen == _gen) {
        setState(() {
          _failed = _serverRows.isEmpty;
          _loaded = true;
        });
      }
    } finally {
      if (gen == _gen) _busy = false;
    }
  }

  Future<void> _reload() {
    _cursor = null;
    return _load();
  }

  void _onProfileSelected(String? profileId) {
    if (_selectedProfileId == profileId) return;
    setState(() {
      _selectedProfileId = profileId;
      _cursor = null;
      _serverRows = const [];
      _loaded = false;
      _failed = false;
    });
    _load();
  }

  void _toggleSuperseded(bool val) {
    setState(() {
      _includeSuperseded = val;
      _cursor = null;
      _serverRows = const [];
      _loaded = false;
      _failed = false;
    });
    _load();
  }

  void _openReport(Map<String, Object?> r) {
    final id = r['report_id'];
    final version = r['version_no'];
    if (id is! String || version is! int) return;

    // AI Smart Summary is strictly withheld pending clinical and product-owner signoff.
    // Official signed PDF viewer (E23) opens directly.
    mhnPush<void>(
      context,
      ReportViewerScreen(reportId: id, versionNo: version),
    );
  }

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final first = st.profile.name.split(' ').first;
    List<BookingProfile> profiles = const [];
    try {
      profiles = ref.watch(bookingProfilesProvider).asData?.value ?? const [];
    } catch (_) {
      profiles = const [];
    }

    final hasServer = _serverRows.isNotEmpty;
    final serverEmpty = _loaded && !_failed && _serverRows.isEmpty;
    final isFallback = !hasServer && !serverEmpty && !kReleaseMode;

    final fallbackRows = _who == 'self'
        ? const <(String, String, bool)>[
            ('Complete Blood Count', '18 Sep 2026', true),
            ('HbA1c', '18 Sep 2026', false),
          ]
        : const <(String, String, bool)>[];

    final whoName = _who == 'self'
        ? first
        : st.members.firstWhere((m) => m.id == _who, orElse: () => st.members.first).name.split(' ').first;

    return MhnPage(
      title: 'Reports',
      showBack: !widget.isTab,
      child: Column(
        children: [
          // Profiles row (E13 server profiles if present, otherwise local members)
          if (profiles.length > 1)
            Container(
              color: Mhn.white,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    MhnChip(
                      label: 'All family members',
                      selected: _selectedProfileId == null,
                      radius: 12,
                      onTap: () => _onProfileSelected(null),
                    ),
                    for (final p in profiles) ...[
                      const SizedBox(width: 8),
                      MhnChip(
                        label: p.displayName.isNotEmpty ? p.displayName : 'Family member',
                        selected: _selectedProfileId == p.id,
                        radius: 12,
                        onTap: () => _onProfileSelected(p.id),
                      ),
                    ],
                  ],
                ),
              ),
            )
          else if (st.members.isNotEmpty)
            Container(
              color: Mhn.white,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  MhnChip(
                    label: '$first (you)',
                    selected: _who == 'self',
                    radius: 14,
                    onTap: () => setState(() => _who = 'self'),
                  ),
                  for (final m in st.members)
                    MhnChip(
                      label: m.name.split(' ').first,
                      selected: _who == m.id,
                      radius: 14,
                      onTap: () => setState(() => _who = m.id),
                    ),
                ],
              ),
            ),

          // Older versions switch
          Container(
            color: Mhn.white,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: Row(
              children: [
                Text('Show older versions', style: Mhn.t(13, c: Mhn.muted)),
                const Spacer(),
                Switch.adaptive(
                  value: _includeSuperseded,
                  activeTrackColor: Mhn.green,
                  onChanged: _toggleSuperseded,
                ),
              ],
            ),
          ),

          if (isFallback && _failed)
            Container(
              width: double.infinity,
              color: Mhn.warnBg,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Text(
                'Demo mode: Showing sample reports. Live API unavailable.',
                style: Mhn.t(11, w: FontWeight.w600, c: Mhn.warnFg),
              ),
            ),

          Expanded(
            child: RefreshIndicator(
              onRefresh: _reload,
              child: _buildBody(context, hasServer, serverEmpty, isFallback, fallbackRows, whoName),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBody(
    BuildContext context,
    bool hasServer,
    bool serverEmpty,
    bool isFallback,
    List<(String, String, bool)> fallbackRows,
    String whoName,
  ) {
    if (_busy && !_loaded) {
      return const Center(child: CircularProgressIndicator());
    }

    if (hasServer) {
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (final r in _serverRows) _buildServerReportCard(r),
          if (_cursor != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: MhnButton(
                label: 'Show more reports',
                secondary: true,
                onPressed: () => _load(more: true),
              ),
            ),
        ],
      );
    }

    if (serverEmpty) {
      return ListView(
        padding: const EdgeInsets.all(32),
        children: [
          const SizedBox(height: 40),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const MhnIconTile(Icons.description_outlined, size: 64),
                const SizedBox(height: 16),
                Text('No reports yet', style: Mhn.t(17, w: FontWeight.w700)),
                const SizedBox(height: 6),
                Text(
                  'Reports appear here as soon as they are released by the laboratory.',
                  textAlign: TextAlign.center,
                  style: Mhn.body,
                ),
              ],
            ),
          ),
        ],
      );
    }

    if (isFallback) {
      if (fallbackRows.isEmpty) {
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            MhnCard(
              padding: const EdgeInsets.all(22),
              child: Column(
                children: [
                  const MhnIconTile(Icons.description_outlined, size: 60),
                  const SizedBox(height: 14),
                  Text('No reports yet for $whoName', textAlign: TextAlign.center, style: Mhn.t(16, w: FontWeight.w800)),
                  const SizedBox(height: 6),
                  Text('Reports appear here as soon as they are ready.', textAlign: TextAlign.center, style: Mhn.body),
                ],
              ),
            ),
          ],
        );
      }
      return ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (final f in fallbackRows) _buildFallbackCard(f),
        ],
      );
    }

    return ListView(
      padding: const EdgeInsets.all(32),
      children: [
        const SizedBox(height: 40),
        Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const MhnIconTile(Icons.wifi_off_outlined, size: 64),
              const SizedBox(height: 16),
              Text('Could not load reports', style: Mhn.t(17, w: FontWeight.w700)),
              const SizedBox(height: 6),
              Text('Please check your network connection and retry.', textAlign: TextAlign.center, style: Mhn.body),
              const SizedBox(height: 20),
              MhnButton(label: 'Retry', secondary: true, onPressed: _reload),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildServerReportCard(Map<String, Object?> r) {
    final panels = mapList(r['panel_names']);
    final panelStr = panels.isEmpty
        ? (r['panel_names'] is List ? (r['panel_names']! as List).join(', ') : 'Laboratory Report')
        : panels.map((p) => p['display_name']).whereType<String>().join(', ');
    final title = panelStr.isNotEmpty ? panelStr : 'Laboratory Report';
    final released = dateTimeText(r['released_at']);
    final kind = r['kind'] is String ? r['kind']! as String : 'final';
    final (tone, label) = reportKinds[kind] ?? ('neutral', 'Report');
    final isSuperseded = r['status'] == 'superseded';

    final (bg, fg) = switch (tone) {
      'success' => (const Color(0xFFE8F5E9), const Color(0xFF1B5E20)),
      'warning' => (Mhn.warnBg, Mhn.warnFg),
      'info' => (const Color(0xFFE3F2FD), const Color(0xFF0D47A1)),
      _ => (Mhn.tint, Mhn.tintFg),
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: MhnCard(
        padding: EdgeInsets.zero,
        child: InkWell(
          borderRadius: BorderRadius.circular(Mhn.rCard),
          onTap: () => _openReport(r),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                const MhnIconTile(Icons.description_outlined, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: Mhn.t(15, w: FontWeight.w800)),
                      const SizedBox(height: 2),
                      Text(released.isNotEmpty ? released : 'Released', style: Mhn.t(13, c: Mhn.muted)),
                      if (isSuperseded) ...[
                        const SizedBox(height: 2),
                        Text('Replaced by a newer version', style: Mhn.t(12, c: Mhn.warnFg)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                MhnTag(label, bg: bg, fg: fg),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildFallbackCard((String, String, bool) f) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: MhnCard(
        padding: EdgeInsets.zero,
        child: InkWell(
          borderRadius: BorderRadius.circular(Mhn.rCard),
          onTap: () => f.$3
              ? mhnPush<void>(context, MhnReportScreen(name: f.$1, date: f.$2))
              : mhnToast(context, 'This report is still being processed'),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                const MhnIconTile(Icons.description_outlined, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(f.$1, style: Mhn.t(15, w: FontWeight.w800)),
                      Text(f.$2, style: Mhn.t(13, c: Mhn.muted)),
                    ],
                  ),
                ),
                MhnTag(
                  f.$3 ? 'Ready' : 'Processing',
                  bg: f.$3 ? Mhn.tint : Mhn.warnBg,
                  fg: f.$3 ? Mhn.green : Mhn.warnFg,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class MhnReportScreen extends ConsumerWidget {
  const MhnReportScreen({super.key, required this.name, required this.date});
  final String name;
  final String date;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final who = ref.watch(mhnProvider.select((s) => s.profile.name));
    return MhnPage(
      title: name,
      bottom: MhnButton(
        label: 'Download PDF',
        secondary: true,
        onPressed: () => mhnToast(context, 'PDF download starts in the app'),
      ),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('$who · $date', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 2),
          Text('Sample values', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.warnFg)),
          const SizedBox(height: 12),
          MhnCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                for (var i = 0; i < kReportValues.length; i++)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    decoration: BoxDecoration(
                      border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(kReportValues[i].$1, style: Mhn.t(15, w: FontWeight.w800)),
                              Text('Range ${kReportValues[i].$3}', style: Mhn.t(12, c: Mhn.muted)),
                            ],
                          ),
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(kReportValues[i].$2, style: Mhn.t(15, w: FontWeight.w800)),
                            const SizedBox(height: 4),
                            MhnTag(
                              kReportValues[i].$4,
                              bg: kReportValues[i].$4 == 'Normal' ? Mhn.tint : Mhn.warnBg,
                              fg: kReportValues[i].$4 == 'Normal' ? Mhn.green : Mhn.warnFg,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
