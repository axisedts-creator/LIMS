// Test card shared by the category screen and the All Tests search: name + price, description, tags, add-to-cart button.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_shell.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';
import 'test_detail_screen.dart';

class MhnTestCard extends ConsumerWidget {
  const MhnTestCard({super.key, required this.test, this.showCategory = false});
  final MhnTest test;
  final bool showCategory;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inCart = ref.watch(mhnProvider.select((s) => s.cart.contains(test.id)));
    final catMatches = kCategories.where((c) => c.id == test.cat);
    final catName = catMatches.isNotEmpty ? catMatches.first.name : null;
    return MhnCard(
      padding: const EdgeInsets.all(14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => mhnPush<void>(context, MhnTestDetailScreen(test: test)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(child: Text(test.name, style: Mhn.t(16, w: FontWeight.w700))),
                const SizedBox(width: 8),
                Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Text(test.hasIndicativePrice ? rs(test.price) : 'Price on enquiry', style: Mhn.t(15, w: FontWeight.w800)),
                ]),
              ]),
              if (showCategory && catName != null && catName.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(catName, style: Mhn.t(12, w: FontWeight.w600, c: Mhn.mutedSoft)),
                ),
              if (test.desc.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(test.desc, style: Mhn.body),
              ],
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                if (test.kind == 'panel') const MhnTag('Package', bg: Mhn.limeSoft, fg: Mhn.green),
                if (test.bookingKinds.contains('home_collection')) const MhnTag('Home collection'),
                if (test.bookingKinds.contains('centre_visit') || test.centre) const MhnTag('At the centre', bg: Mhn.limeSoft, fg: Mhn.green),
                if (test.sexRestriction != null) MhnTag('${test.sexRestriction == 'female' ? 'Female' : 'Male'} only'),
                if (test.age.isNotEmpty) MhnTag('Age: ${test.age}'),
                if (test.fasting.isNotEmpty && test.fasting != noFast)
                  MhnTag(test.fasting, bg: test.needsFasting ? Mhn.warnBg : Mhn.tint, fg: test.needsFasting ? Mhn.warnFg : Mhn.tintFg),
                if (test.report.isNotEmpty) MhnTag('Report: ${test.report}'),
              ]),
            ],
          ),
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          height: 46,
          child: Material(
            color: inCart ? Mhn.green : Mhn.white,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: const BorderSide(color: Mhn.green, width: 1.2)),
            child: InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: () {
                registerCartItem(MhnCartItem(
                  test.id,
                  test.name,
                  test.price,
                  test.desc.isNotEmpty ? test.desc : (test.bookingKinds.contains('home_collection') ? 'Home collection' : 'Centre visit'),
                  test.centre,
                ));
                ref.read(mhnProvider.notifier).toggleCart(test.id);
              },
              child: Center(
                child: Text(
                  inCart ? 'Added ✓ · Tap to remove' : 'Add to cart',
                  style: Mhn.t(14, w: FontWeight.w700, c: inCart ? Mhn.white : Mhn.green),
                ),
              ),
            ),
          ),
        ),
      ]),
    );
  }
}
