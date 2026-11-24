// One category: description and its test cards. Imaging tests are done at the centre, so it carries a note.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_catalog_provider.dart';
import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_test_card.dart';
import 'mhn_theme.dart';

class MhnCategoryScreen extends ConsumerWidget {
  const MhnCategoryScreen({super.key, required this.category});
  final MhnCategory category;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final allTests = ref.watch(mhnCatalogProvider).tests;
    final tests = [for (final t in allTests) if (t.cat == category.id) t];
    return MhnPage(
      title: category.name,
      bottom: const MhnCartBar(),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        children: [
          Text(category.sub, style: Mhn.body),
          if (category.id == 'imaging')
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: MhnCard(
                color: Mhn.warnBg,
                borderColor: Mhn.warnBg,
                padding: const EdgeInsets.all(12),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Icon(Icons.info_outline, size: 18, color: Mhn.warnFg),
                  const SizedBox(width: 8),
                  Expanded(child: Text('Imaging is done at our centre in Baneshwor. Home collection is not available for these tests.', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.warnFg, h: 1.3))),
                ]),
              ),
            ),
          const SizedBox(height: 12),
          for (final t in tests) Padding(padding: const EdgeInsets.only(bottom: 12), child: MhnTestCard(test: t)),
        ],
      ),
    );
  }
}
