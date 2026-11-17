// Reports (sample): who chips when family members exist, report rows with Ready / Processing, and the detail view with Download PDF.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnReportsScreen extends ConsumerStatefulWidget {
  const MhnReportsScreen({super.key});

  @override
  ConsumerState<MhnReportsScreen> createState() => _MhnReportsScreenState();
}

class _MhnReportsScreenState extends ConsumerState<MhnReportsScreen> {
  String _who = 'self';

  @override
  Widget build(BuildContext context) {
    final st = ref.watch(mhnProvider);
    final first = st.profile.name.split(' ').first;
    final rows = _who == 'self'
        ? const <(String, String, bool)>[('Complete Blood Count', '18 Sep 2026', true), ('HbA1c', '18 Sep 2026', false)]
        : const <(String, String, bool)>[];
    final whoName = _who == 'self' ? first : st.members.firstWhere((m) => m.id == _who, orElse: () => st.members.first).name.split(' ').first;
    return MhnPage(
      title: 'Reports',
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (st.members.isNotEmpty) ...[
            Wrap(spacing: 8, runSpacing: 8, children: [
              MhnChip(label: '$first (you)', selected: _who == 'self', radius: 14, onTap: () => setState(() => _who = 'self')),
              for (final m in st.members) MhnChip(label: m.name.split(' ').first, selected: _who == m.id, radius: 14, onTap: () => setState(() => _who = m.id)),
            ]),
            const SizedBox(height: 14),
          ],
          if (rows.isEmpty)
            MhnCard(
              padding: const EdgeInsets.all(22),
              child: Column(children: [
                const MhnIconTile(Icons.description_outlined, size: 60),
                const SizedBox(height: 14),
                Text('No reports yet for $whoName', textAlign: TextAlign.center, style: Mhn.t(16, w: FontWeight.w800)),
                const SizedBox(height: 6),
                Text('Reports appear here as soon as they are ready.', textAlign: TextAlign.center, style: Mhn.body),
              ]),
            )
          else
            for (final r in rows)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: MhnCard(
                  padding: EdgeInsets.zero,
                  child: InkWell(
                    borderRadius: BorderRadius.circular(Mhn.rCard),
                    onTap: () => r.$3 ? mhnPush<void>(context, MhnReportScreen(name: r.$1, date: r.$2)) : mhnToast(context, 'This report is still being processed'),
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Row(children: [
                        const MhnIconTile(Icons.description_outlined, size: 44),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(r.$1, style: Mhn.t(15, w: FontWeight.w800)),
                            Text(r.$2, style: Mhn.t(13, c: Mhn.muted)),
                          ]),
                        ),
                        MhnTag(r.$3 ? 'Ready' : 'Processing', bg: r.$3 ? Mhn.tint : Mhn.warnBg, fg: r.$3 ? Mhn.green : Mhn.warnFg),
                      ]),
                    ),
                  ),
                ),
              ),
        ],
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
      bottom: MhnButton(label: 'Download PDF', secondary: true, onPressed: () => mhnToast(context, 'PDF download starts in the app')),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('$who · $date', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 2),
          Text('Sample values', style: Mhn.t(12, w: FontWeight.w700, c: Mhn.warnFg)),
          const SizedBox(height: 12),
          MhnCard(
            padding: EdgeInsets.zero,
            child: Column(children: [
              for (var i = 0; i < kReportValues.length; i++)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(border: i > 0 ? const Border(top: BorderSide(color: Mhn.rowLine)) : null),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(kReportValues[i].$1, style: Mhn.t(15, w: FontWeight.w800)),
                        Text('Range ${kReportValues[i].$3}', style: Mhn.t(12, c: Mhn.muted)),
                      ]),
                    ),
                    Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                      Text(kReportValues[i].$2, style: Mhn.t(15, w: FontWeight.w800)),
                      const SizedBox(height: 4),
                      MhnTag(kReportValues[i].$4, bg: kReportValues[i].$4 == 'Normal' ? Mhn.tint : Mhn.warnBg, fg: kReportValues[i].$4 == 'Normal' ? Mhn.green : Mhn.warnFg),
                    ]),
                  ]),
                ),
            ]),
          ),
        ],
      ),
    );
  }
}
