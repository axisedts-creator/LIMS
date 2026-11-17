// All Tests tab: title, search (name, description or category), category grid; with a query: result count and matching tests.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'category_screen.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_test_card.dart';
import 'mhn_theme.dart';

class MhnTestsTab extends ConsumerStatefulWidget {
  const MhnTestsTab({super.key});

  @override
  ConsumerState<MhnTestsTab> createState() => _MhnTestsTabState();
}

class _MhnTestsTabState extends ConsumerState<MhnTestsTab> {
  final _q = TextEditingController();

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  List<MhnTest> _results() {
    final q = _q.text.trim().toLowerCase();
    if (q.isEmpty) return const [];
    return [
      for (final t in kTests)
        if ('${t.name} ${t.desc} ${kCategories.firstWhere((c) => c.id == t.cat).name}'.toLowerCase().contains(q)) t,
    ];
  }

  @override
  Widget build(BuildContext context) {
    final q = _q.text.trim();
    final results = _results();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      children: [
        Text('All tests', style: Mhn.h1),
        const SizedBox(height: 14),
        Semantics(
          label: 'Search tests',
          child: Container(
            height: 54,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(color: Mhn.white, borderRadius: BorderRadius.circular(Mhn.rField), border: Border.all(color: Mhn.line), boxShadow: const [BoxShadow(color: Mhn.shadow, blurRadius: 18, offset: Offset(0, 6))]),
            child: Row(children: [
              const Icon(Icons.search, size: 22, color: Mhn.green),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  controller: _q,
                  onChanged: (_) => setState(() {}),
                  textInputAction: TextInputAction.search,
                  style: Mhn.t(15, w: FontWeight.w600),
                  decoration: InputDecoration(border: InputBorder.none, hintText: 'Search for ‘Thyroid profile’', hintStyle: Mhn.t(15, c: Mhn.muted), isCollapsed: true),
                ),
              ),
              if (q.isNotEmpty)
                IconButton(
                  tooltip: 'Clear search',
                  onPressed: () => setState(_q.clear),
                  icon: const Icon(Icons.close, size: 18, color: Mhn.muted),
                ),
            ]),
          ),
        ),
        const SizedBox(height: 16),
        if (q.isEmpty) ...[
          Text('Browse by category', style: Mhn.h2),
          const SizedBox(height: 12),
          LayoutBuilder(builder: (context, c) {
            final w = (c.maxWidth - 12) / 2;
            return Wrap(spacing: 12, runSpacing: 12, children: [
              for (final cat in kCategories)
                SizedBox(
                  width: w,
                  height: 142,
                  child: Material(
                    color: Mhn.white,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Mhn.rCard), side: const BorderSide(color: Mhn.line)),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(Mhn.rCard),
                      onTap: () => mhnPush<void>(context, MhnCategoryScreen(category: cat)),
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          MhnIconTile(cat.icon),
                          const Spacer(),
                          Text(cat.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: Mhn.t(14, w: FontWeight.w700, h: 1.2)),
                          const SizedBox(height: 2),
                          Text(() {
                            final n = kTests.where((t) => t.cat == cat.id).length;
                            return '$n ${n == 1 ? 'test' : 'tests'}';
                          }(), style: Mhn.t(12, c: Mhn.muted)),
                        ]),
                      ),
                    ),
                  ),
                ),
            ]);
          }),
        ] else ...[
          Text('${results.length} ${results.length == 1 ? 'test' : 'tests'} found', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.muted)),
          const SizedBox(height: 10),
          if (results.isEmpty)
            MhnCard(
              child: Column(children: [
                const Icon(Icons.search_off, size: 32, color: Mhn.mutedSoft),
                const SizedBox(height: 8),
                Text('No tests found', style: Mhn.t(15, w: FontWeight.w700)),
                const SizedBox(height: 4),
                Text('Check the spelling, or browse the categories below.', textAlign: TextAlign.center, style: Mhn.body),
              ]),
            ),
          for (final t in results) Padding(padding: const EdgeInsets.only(bottom: 12), child: MhnTestCard(test: t, showCategory: true)),
        ],
      ],
    );
  }
}
